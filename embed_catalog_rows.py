"""
PathBinder — Catalog-driven CLIP Embedding Generator
=====================================================
Sibling to generate_embeddings.py. The original script reads from
combined_final.xlsx, which only contains the original English Pokemon
catalog. This script reads candidate rows DIRECTLY from the Supabase
`catalog` table, so it works for any subset — Chinese, Korean, Pokemon
Topps, Gundam, DBZ, etc.

Generates the same CLIP image embeddings (openai/clip-vit-base-patch32)
so the scanner's `match_cards` RPC can do visual matching against the
newly embedded rows.

SETUP:
    pip3 install transformers torch Pillow requests supabase

USAGE:
    # Embed all Chinese Pokemon singles (1,359 rows ~ 30-60 min on CPU)
    SUPABASE_SERVICE_KEY=... python3 embed_catalog_rows.py --id-prefix cn-pc-

    # Embed Korean Pokemon singles
    SUPABASE_SERVICE_KEY=... python3 embed_catalog_rows.py --id-prefix kr-pc-

    # Embed everything with a non-NULL image_url and no embedding yet
    SUPABASE_SERVICE_KEY=... python3 embed_catalog_rows.py --all-missing

    # Smoke test (first 20 only, no writes)
    SUPABASE_SERVICE_KEY=... python3 embed_catalog_rows.py \\
        --id-prefix cn-pc- --limit 20 --dry-run

    # Force re-embed (override SKIP_EXISTING)
    SUPABASE_SERVICE_KEY=... python3 embed_catalog_rows.py \\
        --id-prefix cn-pc- --reembed

ENVIRONMENT:
    SUPABASE_SERVICE_KEY    service-role key (bypasses RLS)
"""

import os, sys, io, time, argparse

try:
    import requests
    from PIL import Image
except ImportError:
    sys.exit("Run:  pip3 install requests Pillow")

try:
    import torch
    from transformers import CLIPProcessor, CLIPVisionModelWithProjection
except ImportError:
    sys.exit("Run:  pip3 install transformers torch")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Run:  pip3 install supabase")


# ── Args ────────────────────────────────────────────────────────────────
ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
src = ap.add_mutually_exclusive_group(required=True)
src.add_argument("--id-prefix", help="Only catalog rows whose id starts with this string (e.g. 'cn-pc-')")
src.add_argument("--all-missing", action="store_true", help="Every catalog row with an image_url and NULL embedding")
ap.add_argument("--limit",   type=int, default=0, help="Stop after N rows (debug). 0 = no limit.")
ap.add_argument("--dry-run", action="store_true", help="Fetch+embed but don't write back to Supabase.")
ap.add_argument("--reembed", action="store_true", help="Re-embed rows that already have an embedding. Default skips them.")
ap.add_argument("--batch-size", type=int, default=32, help="CLIP batch size (default 32). Lower if VRAM-bound.")
args = ap.parse_args()


# ── Config ──────────────────────────────────────────────────────────────
SUPABASE_URL    = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY    = os.environ.get("SUPABASE_SERVICE_KEY") or input("Supabase service-role key: ").strip()
BATCH_SIZE      = args.batch_size
UPSERT_BATCH    = 50
REQUEST_TIMEOUT = 12


# ── Model ───────────────────────────────────────────────────────────────
print("Loading CLIP model (openai/clip-vit-base-patch32)...")
device    = "cuda" if torch.cuda.is_available() else "cpu"
processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
model     = CLIPVisionModelWithProjection.from_pretrained("openai/clip-vit-base-patch32").to(device)
model.eval()
print(f"  Running on: {device}")


# ── Supabase ────────────────────────────────────────────────────────────
sb = create_client(SUPABASE_URL, SUPABASE_KEY)
print("\nVerifying Supabase connection...")
try:
    res = sb.table("catalog").select("id", count="exact").limit(1).execute()
    print(f"  Connected — catalog has {res.count:,} total rows")
except Exception as e:
    sys.exit(f"  Cannot reach catalog table: {e}")


# ── Source row selection ────────────────────────────────────────────────
print("\nLoading candidate rows from catalog...")
candidates = []
PAGE = 1000
offset = 0
while True:
    q = sb.table("catalog").select("id,name,image_url").not_.is_("image_url", "null").neq("image_url", "")
    if args.id_prefix:
        q = q.like("id", f"{args.id_prefix}%")
    if not args.reembed:
        q = q.is_("embedding", "null")
    q = q.range(offset, offset + PAGE - 1)
    res = q.execute()
    chunk = res.data or []
    candidates.extend(chunk)
    if len(chunk) < PAGE:
        break
    offset += PAGE

if args.limit and len(candidates) > args.limit:
    candidates = candidates[:args.limit]

print(f"  {len(candidates):,} rows to embed"
      f"{' (DRY RUN — no writes)' if args.dry_run else ''}")
if not candidates:
    print("  Nothing to do.")
    sys.exit(0)


# ── Helpers ─────────────────────────────────────────────────────────────
def fetch_image(url):
    try:
        r = requests.get(url, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception as e:
        print(f"\n  ! {url[:70]} — {e}")
        return None

def embed_batch(pil_images):
    inputs = processor(images=pil_images, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        out = model(**inputs)
        embeds = out.image_embeds
        embeds = embeds / embeds.norm(dim=-1, keepdim=True)
    return embeds.cpu().tolist()

_upsert_errors = 0
def upsert(rows):
    """Write embeddings back to catalog. Uses UPDATE per row (not upsert)
    so we never disturb any other columns — supabase-py's upsert defaults
    to nulling unspecified fields, which violated NOT NULL on `name` and
    killed entire batches at a time."""
    global _upsert_errors
    if args.dry_run:
        return
    for row in rows:
        try:
            sb.table("catalog").update({"embedding": row["embedding"]}).eq("id", row["id"]).execute()
        except Exception as e:
            _upsert_errors += 1
            print(f"\n  Update error #{_upsert_errors} on {row['id']}: {e}")
            if _upsert_errors >= 10:
                sys.exit("\n  Too many update errors — aborting.")


# ── Main loop ───────────────────────────────────────────────────────────
total     = len(candidates)
succeeded = 0
failed    = 0
buf       = []
t0        = time.time()

for i in range(0, total, BATCH_SIZE):
    batch = candidates[i : i + BATCH_SIZE]
    elapsed = time.time() - t0
    per     = elapsed / max(succeeded + failed, 1)
    eta     = int((total - i) * per)
    print(f"  [{i+1:>6}/{total}]  ETA {eta//60}m {eta%60}s", end="\r", flush=True)

    loaded = [(c, img) for c in batch if (img := fetch_image(c["image_url"])) is not None]
    failed += len(batch) - len(loaded)
    if not loaded:
        continue

    cards_b, imgs_b = zip(*loaded)
    try:
        vectors = embed_batch(list(imgs_b))
    except Exception as e:
        print(f"\n  Embed failed: {e}")
        failed += len(loaded)
        continue

    for card, vec in zip(cards_b, vectors):
        # Only carry id + embedding into the upsert — never overwrite
        # other catalog fields like name / image_url etc.
        buf.append({"id": card["id"], "embedding": vec})
        succeeded += 1

    if len(buf) >= UPSERT_BATCH:
        upsert(buf)
        buf.clear()

    time.sleep(0.05)

if buf:
    upsert(buf)

elapsed_total = int(time.time() - t0)
print(f"""

════════════════════════════════════════
  Done!  ({elapsed_total//60}m {elapsed_total%60}s)
  Embedded:  {succeeded:,}
  Failed:    {failed:,}{'  (DRY RUN — nothing written)' if args.dry_run else ''}
════════════════════════════════════════
""")
