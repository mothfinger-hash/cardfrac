"""
PathBinder — Card Embedding Generator (v2)
==========================================
Uses HuggingFace transformers library — same model implementation as the
browser (Xenova/transformers.js), guaranteeing compatible embeddings.

SETUP:
    pip3 install transformers torch Pillow requests openpyxl supabase

USAGE:
    python3 generate_embeddings.py

You'll be prompted for your Supabase URL and service role key
(Project Settings > API > service_role secret key).
"""

import os, sys, io, time
import requests
from PIL import Image

try:
    import torch
    from transformers import CLIPProcessor, CLIPVisionModelWithProjection
except ImportError:
    sys.exit("Run:  pip3 install transformers torch Pillow requests openpyxl supabase")

try:
    import openpyxl
except ImportError:
    sys.exit("Run:  pip3 install openpyxl")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Run:  pip3 install supabase")


# ══════════════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════════════
XLSX_PATH       = "combined_final.xlsx"
SUPABASE_URL    = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY    = os.environ.get("SUPABASE_SERVICE_KEY")  or input("Service role key (Settings → API → service_role): ").strip()
BATCH_SIZE      = 32
UPSERT_BATCH    = 50
SKIP_EXISTING   = True    # True = skip cards that already have embeddings
REQUEST_TIMEOUT = 12


# ══════════════════════════════════════════════════════════════════════
# LOAD MODEL (HuggingFace — same weights as Xenova/transformers.js)
# ══════════════════════════════════════════════════════════════════════
print("Loading CLIP model (openai/clip-vit-base-patch32)...")
device = "cuda" if torch.cuda.is_available() else "cpu"
processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
model     = CLIPVisionModelWithProjection.from_pretrained("openai/clip-vit-base-patch32").to(device)
model.eval()
print(f"  Running on: {device}")


# ══════════════════════════════════════════════════════════════════════
# CONNECT TO SUPABASE + VERIFY
# ══════════════════════════════════════════════════════════════════════
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

print("\nVerifying Supabase connection...")
try:
    res = sb.table("catalog").select("id", count="exact").limit(1).execute()
    print(f"  ✓ Connected — catalog table exists, current row count: {res.count}")
except Exception as e:
    sys.exit(f"  ✗ Cannot reach catalog table: {e}\n\n"
             "  Make sure you:\n"
             "  1. Ran scanner_setup.sql in Supabase SQL Editor\n"
             "  2. Used the correct Supabase URL (https://...supabase.co)\n"
             "  3. Used the service_role key (NOT the anon key)")


# ══════════════════════════════════════════════════════════════════════
# READ EXCEL
# ══════════════════════════════════════════════════════════════════════
print(f"\nReading {XLSX_PATH}...")
wb = openpyxl.load_workbook(XLSX_PATH, read_only=True, data_only=True)
ws = wb.active

all_cards = []
for row in ws.iter_rows(min_row=2, values_only=True):
    set_code    = str(row[3] or '').strip()
    card_number = str(row[4] or '').strip()
    image_url   = str(row[10] or '').strip()
    if not set_code or not card_number or not image_url:
        continue
    all_cards.append({
        "id":          f"{set_code}-{card_number}",
        "name":        str(row[1] or '').strip(),
        "set_name":    str(row[2] or '').strip(),
        "set_code":    set_code,
        "card_number": card_number,
        "rarity":      str(row[5] or '').strip(),
        "supertype":   str(row[6] or '').strip(),
        "image_url":   image_url,
    })
wb.close()
print(f"  Loaded {len(all_cards):,} cards")


# ══════════════════════════════════════════════════════════════════════
# SKIP ALREADY EMBEDDED (optional)
# ══════════════════════════════════════════════════════════════════════
already_done = set()
if SKIP_EXISTING:
    print("Checking existing embeddings...")
    offset = 0
    while True:
        res = sb.table("catalog").select("id").not_.is_("embedding","null").range(offset, offset+999).execute()
        chunk = res.data or []
        already_done.update(r["id"] for r in chunk)
        if len(chunk) < 1000: break
        offset += 1000
    print(f"  {len(already_done):,} already done — skipping")

cards_to_process = [c for c in all_cards if c["id"] not in already_done]
print(f"  {len(cards_to_process):,} cards to embed\n")

if not cards_to_process:
    print("Nothing to do!")
    sys.exit(0)


# ══════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════
def fetch_image(url):
    try:
        r = requests.get(url, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception as e:
        print(f"\n  ⚠ {url[:60]} — {e}")
        return None

def embed_batch(pil_images):
    inputs = processor(images=pil_images, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        out = model(**inputs)
        embeds = out.image_embeds                                     # (N, 512)
        embeds = embeds / embeds.norm(dim=-1, keepdim=True)           # L2 normalise
    return embeds.cpu().tolist()

_upsert_errors = 0
def upsert(rows):
    global _upsert_errors
    try:
        res = sb.table("catalog").upsert(rows, on_conflict="id").execute()
        # Print first successful upsert so we know writes are working
        if _upsert_errors == 0 and not hasattr(upsert, '_confirmed'):
            upsert._confirmed = True
            print(f"\n  ✓ First upsert confirmed — writes are working")
    except Exception as e:
        _upsert_errors += 1
        print(f"\n  ✗ Upsert error #{_upsert_errors}: {e}")
        if _upsert_errors >= 3:
            sys.exit("\n  Too many upsert errors — check your service_role key and catalog table")


# ══════════════════════════════════════════════════════════════════════
# MAIN LOOP
# ══════════════════════════════════════════════════════════════════════
total      = len(cards_to_process)
succeeded  = 0
failed     = 0
buf        = []
t0         = time.time()

for i in range(0, total, BATCH_SIZE):
    batch = cards_to_process[i : i + BATCH_SIZE]
    elapsed  = time.time() - t0
    per_card = elapsed / max(succeeded + failed, 1)
    eta      = int((total - i) * per_card)
    print(f"  [{i+1:>6}/{total}]  ETA {eta//60}m {eta%60}s", end="\r", flush=True)

    loaded = [(c, img) for c in batch if (img := fetch_image(c["image_url"])) is not None]
    failed += len(batch) - len(loaded)
    if not loaded: continue

    cards_b, imgs_b = zip(*loaded)
    try:
        vectors = embed_batch(list(imgs_b))
    except Exception as e:
        print(f"\n  ✗ Embed failed: {e}")
        failed += len(loaded)
        continue

    for card, vec in zip(cards_b, vectors):
        buf.append({**card, "embedding": vec})
        succeeded += 1

    if len(buf) >= UPSERT_BATCH:
        upsert(buf); buf.clear()

    time.sleep(0.05)

if buf: upsert(buf)

elapsed_total = int(time.time() - t0)
print(f"""

════════════════════════════════════════
  Done!  ({elapsed_total//60}m {elapsed_total%60}s)
  ✓ Embedded:  {succeeded:,}
  ✗ Failed:    {failed:,}
════════════════════════════════════════

If you haven't built the vector index yet, run this in Supabase SQL Editor:
  create index cards_embedding_idx on catalog
    using ivfflat (embedding vector_cosine_ops) with (lists = 100);
""")
