#!/usr/bin/env python3
"""
PathBinder — JP Card Catalog Builder
=====================================
Fetches card data from TCGdex (https://api.tcgdex.net/v2/en/) set-by-set,
generates CLIP embeddings using the same model as the browser scanner, and
upserts into the Supabase catalog table.

JP cards use a 'jp-' id prefix so they coexist with EN cards in the catalog.
The scanner automatically detects the prefix and tags matched cards as JA.

SETUP:
    pip3 install transformers torch Pillow requests supabase

USAGE:
    python3 generate_jp_catalog.py                    # embed all sets
    python3 generate_jp_catalog.py --resume           # skip already-embedded cards
    python3 generate_jp_catalog.py --series "Scarlet & Violet"  # one series only
    python3 generate_jp_catalog.py --set sv1          # one set only
    python3 generate_jp_catalog.py --list-series      # print available series names

Notes:
  • Images come from TCGdex CDN: {card.image}/high.png
  • Cards without an image URL are skipped (no image = no embedding)
  • Checkpoint file (jp_catalog_checkpoint.txt) is written after each set so
    you can safely Ctrl+C and resume with --resume
"""

import os, sys, io, time, json, argparse
import requests
from PIL import Image

# ── Dependency checks ─────────────────────────────────────────────────────────
try:
    import torch
    from transformers import CLIPProcessor, CLIPVisionModelWithProjection
except ImportError:
    sys.exit("Missing dependencies. Run:\n  pip3 install transformers torch Pillow requests supabase")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing supabase. Run:\n  pip3 install supabase")


# ══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════════════════════
SUPABASE_URL     = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY     = os.environ.get("SUPABASE_SERVICE_KEY") or input("Service role key (Settings → API → service_role): ").strip()
TCGDEX_BASE      = "https://api.tcgdex.net/v2/en"
CHECKPOINT_FILE  = "jp_catalog_checkpoint.txt"
BATCH_SIZE       = 16      # cards per CLIP forward pass (reduce if OOM)
UPSERT_BATCH     = 50      # rows per Supabase upsert call
REQUEST_TIMEOUT  = 20
SKIP_EXISTING    = True    # skip cards already in catalog (--no-skip to disable)
IMAGE_QUALITY    = "high"  # "high" or "low"


# ══════════════════════════════════════════════════════════════════════════════
# ARGUMENT PARSING
# ══════════════════════════════════════════════════════════════════════════════
parser = argparse.ArgumentParser(description="Build PathBinder JP card catalog from TCGdex")
parser.add_argument("--resume",       action="store_true", help="Skip sets already in checkpoint")
parser.add_argument("--no-skip",      action="store_true", help="Re-embed cards that already have embeddings")
parser.add_argument("--series",       type=str,  default=None, help="Only process sets in this series (e.g. 'Scarlet & Violet')")
parser.add_argument("--set",          type=str,  default=None, help="Only process this set id (e.g. 'sv1')")
parser.add_argument("--list-series",  action="store_true", help="Print all available series names and exit")
parser.add_argument("--low",          action="store_true", help="Use low-quality images (faster, smaller)")
args = parser.parse_args()

if args.no_skip:
    SKIP_EXISTING = False
if args.low:
    IMAGE_QUALITY = "low"


# ══════════════════════════════════════════════════════════════════════════════
# LOAD CLIP MODEL
# ══════════════════════════════════════════════════════════════════════════════
print("Loading CLIP model (openai/clip-vit-base-patch32)…")
device    = "cuda" if torch.cuda.is_available() else "cpu"
processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
model     = CLIPVisionModelWithProjection.from_pretrained("openai/clip-vit-base-patch32").to(device)
model.eval()
print(f"  Running on: {device}\n")


# ══════════════════════════════════════════════════════════════════════════════
# SUPABASE CONNECTION
# ══════════════════════════════════════════════════════════════════════════════
sb = create_client(SUPABASE_URL, SUPABASE_KEY)
try:
    res = sb.table("catalog").select("id", count="exact").limit(1).execute()
    print(f"✓ Supabase connected — catalog has {res.count:,} rows\n")
except Exception as e:
    sys.exit(f"✗ Cannot reach catalog table: {e}\n"
             "  Check your service_role key and that scanner_setup.sql has been run.")


# ══════════════════════════════════════════════════════════════════════════════
# TCGDEX HELPERS
# ══════════════════════════════════════════════════════════════════════════════
_session = requests.Session()
_session.headers.update({"Accept": "application/json"})

def tcgdex_get(path, retries=4):
    """GET a TCGdex endpoint with retry + back-off."""
    url = f"{TCGDEX_BASE}{path}"
    for attempt in range(retries):
        try:
            r = _session.get(url, timeout=REQUEST_TIMEOUT)
            if r.status_code == 404:
                return None
            if r.status_code == 429:
                wait = 20 * (attempt + 1)
                print(f"  Rate limited, waiting {wait}s…")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        except requests.exceptions.RequestException as e:
            if attempt < retries - 1:
                time.sleep(8 * (attempt + 1))
            else:
                print(f"  ⚠ Failed: {url} — {e}")
                return None
    return None


def fetch_image(url, retries=3):
    for attempt in range(retries):
        try:
            r = _session.get(url, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            return Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(4)
            else:
                print(f"\n  ⚠ Image failed: {url[:70]} — {e}")
    return None


# ══════════════════════════════════════════════════════════════════════════════
# EMBEDDING + UPSERT
# ══════════════════════════════════════════════════════════════════════════════
def embed_batch(pil_images):
    inputs = processor(images=pil_images, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        out    = model(**inputs)
        embeds = out.image_embeds
        embeds = embeds / embeds.norm(dim=-1, keepdim=True)   # L2 normalise
    return embeds.cpu().tolist()


_upsert_errors = 0
def upsert(rows):
    global _upsert_errors
    try:
        sb.table("catalog").upsert(rows, on_conflict="id").execute()
    except Exception as e:
        _upsert_errors += 1
        print(f"\n  ✗ Upsert error #{_upsert_errors}: {e}")
        if _upsert_errors >= 5:
            sys.exit("\n  Too many upsert errors — aborting.")


# ══════════════════════════════════════════════════════════════════════════════
# FETCH ALL SETS
# ══════════════════════════════════════════════════════════════════════════════
print("Fetching set list from TCGdex…")
sets_raw = tcgdex_get("/sets")
if not sets_raw:
    sys.exit("✗ Could not fetch sets from TCGdex. Check your internet connection.")

# TCGdex returns either a bare array or {data: [...]}
all_sets = sets_raw if isinstance(sets_raw, list) else sets_raw.get("data", sets_raw.get("sets", []))
print(f"  Found {len(all_sets)} sets")

# --list-series: print unique series names and exit
if args.list_series:
    series_names = sorted(set(
        (s.get("serie", {}) or {}).get("name", "") or s.get("series", "") or "Unknown"
        for s in all_sets
    ))
    print("\nAvailable series:")
    for name in series_names:
        if name:
            print(f"  {name}")
    sys.exit(0)

# Apply --set or --series filter
if args.set:
    all_sets = [s for s in all_sets if s.get("id") == args.set]
    if not all_sets:
        sys.exit(f"✗ Set '{args.set}' not found in TCGdex. Use --list-series to see available sets.")
elif args.series:
    def _set_series(s):
        sr = s.get("serie") or {}
        return sr.get("name", "") if isinstance(sr, dict) else str(sr)
    all_sets = [s for s in all_sets if args.series.lower() in _set_series(s).lower()]
    if not all_sets:
        sys.exit(f"✗ No sets found for series '{args.series}'. Use --list-series to see available series.")
    print(f"  Filtered to {len(all_sets)} sets in series '{args.series}'")


# ══════════════════════════════════════════════════════════════════════════════
# LOAD CHECKPOINT (resume support)
# ══════════════════════════════════════════════════════════════════════════════
done_sets = set()
if args.resume and os.path.exists(CHECKPOINT_FILE):
    with open(CHECKPOINT_FILE) as f:
        done_sets = {line.strip() for line in f if line.strip()}
    print(f"  Resuming — {len(done_sets)} sets already processed\n")


# ══════════════════════════════════════════════════════════════════════════════
# LOAD ALREADY-EMBEDDED IDs (skip existing)
# ══════════════════════════════════════════════════════════════════════════════
already_embedded = set()
if SKIP_EXISTING:
    print("Checking existing JP embeddings…")
    offset = 0
    while True:
        res = (sb.table("catalog")
               .select("id")
               .like("id", "jp-%")
               .not_.is_("embedding", "null")
               .range(offset, offset + 999)
               .execute())
        chunk = res.data or []
        already_embedded.update(r["id"] for r in chunk)
        if len(chunk) < 1000:
            break
        offset += 1000
    print(f"  {len(already_embedded):,} JP cards already embedded — skipping\n")


# ══════════════════════════════════════════════════════════════════════════════
# MAIN LOOP — set by set
# ══════════════════════════════════════════════════════════════════════════════
total_sets     = len(all_sets)
total_embedded = 0
total_skipped  = 0
total_failed   = 0
buf            = []   # pending upsert rows
t0             = time.time()

for set_idx, set_stub in enumerate(all_sets, 1):
    set_id   = set_stub.get("id", "")
    set_name = set_stub.get("name", set_id)

    if set_id in done_sets:
        print(f"[{set_idx:>4}/{total_sets}] {set_id:20s} — skipped (checkpoint)")
        continue

    # Fetch full set details (includes cards array)
    set_detail = tcgdex_get(f"/sets/{set_id}")
    if not set_detail:
        print(f"[{set_idx:>4}/{total_sets}] {set_id:20s} — ✗ could not fetch set detail")
        continue

    cards_in_set = set_detail.get("cards", [])
    if not cards_in_set:
        print(f"[{set_idx:>4}/{total_sets}] {set_id:20s} — 0 cards, skipping")
        continue

    serie_name = ""
    if isinstance(set_detail.get("serie"), dict):
        serie_name = set_detail["serie"].get("name", "")
    elif isinstance(set_detail.get("serie"), str):
        serie_name = set_detail["serie"]

    print(f"[{set_idx:>4}/{total_sets}] {set_id:20s} {set_name[:30]:30s}  {len(cards_in_set)} cards", end="", flush=True)

    # Build card records for this set
    cards_to_embed = []
    for card_stub in cards_in_set:
        # card_stub has: {id, localId, name, image}
        local_id   = str(card_stub.get("localId", "")).strip()
        card_name  = str(card_stub.get("name",    "")).strip()
        image_base = str(card_stub.get("image",   "")).strip()

        if not local_id or not image_base:
            total_skipped += 1
            continue

        catalog_id  = f"jp-{set_id}-{local_id}"
        image_url   = f"{image_base}/{IMAGE_QUALITY}.png"

        if catalog_id in already_embedded:
            total_skipped += 1
            continue

        cards_to_embed.append({
            "id":          catalog_id,
            "name":        card_name,
            "set_name":    set_name,
            "set_code":    set_id,
            "card_number": local_id,
            "rarity":      card_stub.get("rarity", ""),
            "supertype":   card_stub.get("category", card_stub.get("supertype", "")),
            "image_url":   image_url,
        })

    if not cards_to_embed:
        print(f"  (all already done)")
        # Still mark set done in checkpoint
        with open(CHECKPOINT_FILE, "a") as f:
            f.write(set_id + "\n")
        done_sets.add(set_id)
        continue

    print(f"  → {len(cards_to_embed)} to embed", end="", flush=True)

    # Process in batches of BATCH_SIZE
    set_embedded = 0
    set_failed   = 0

    for i in range(0, len(cards_to_embed), BATCH_SIZE):
        batch = cards_to_embed[i : i + BATCH_SIZE]

        # Download images
        loaded = []
        for card in batch:
            img = fetch_image(card["image_url"])
            if img:
                loaded.append((card, img))
            else:
                set_failed += 1

        if not loaded:
            continue

        # Generate embeddings
        try:
            cards_b, imgs_b = zip(*loaded)
            vectors = embed_batch(list(imgs_b))
        except Exception as e:
            print(f"\n  ✗ Embed failed: {e}")
            set_failed += len(loaded)
            continue

        for card, vec in zip(cards_b, vectors):
            buf.append({**card, "embedding": vec})
            set_embedded += 1

        if len(buf) >= UPSERT_BATCH:
            upsert(buf)
            buf.clear()

        time.sleep(0.03)   # be polite to TCGdex CDN

    total_embedded += set_embedded
    total_failed   += set_failed
    print(f"  ✓ {set_embedded} done" + (f"  ✗ {set_failed} failed" if set_failed else ""))

    # Flush remaining buffer
    if buf:
        upsert(buf)
        buf.clear()

    # Write checkpoint
    with open(CHECKPOINT_FILE, "a") as f:
        f.write(set_id + "\n")
    done_sets.add(set_id)

    time.sleep(0.5)   # pause between sets


# ══════════════════════════════════════════════════════════════════════════════
# FINAL FLUSH + SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
if buf:
    upsert(buf)

elapsed = int(time.time() - t0)
print(f"""
════════════════════════════════════════
  Done!  ({elapsed // 60}m {elapsed % 60}s)
  ✓ Embedded:  {total_embedded:,}
  ⏭ Skipped:   {total_skipped:,} (already done or no image)
  ✗ Failed:    {total_failed:,}
════════════════════════════════════════

If you added JP cards for the first time, rebuild the vector index in Supabase
SQL Editor so searches stay fast:

  drop index if exists cards_embedding_idx;
  create index cards_embedding_idx on catalog
    using ivfflat (embedding vector_cosine_ops) with (lists = 100);

Verify with:
  select count(*) from catalog where id like 'jp-%%';
  select count(*) from catalog where id like 'jp-%%' and embedding is not null;
""")

# Clean up checkpoint file if we processed everything without filtering
if not args.set and not args.series and os.path.exists(CHECKPOINT_FILE):
    os.remove(CHECKPOINT_FILE)
    print("Checkpoint file removed (full run complete).")
