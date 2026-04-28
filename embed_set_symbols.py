"""
PathBinder — Set Symbol Embedder
=================================
Downloads every Pokemon TCG set symbol from the official API,
generates CLIP embeddings, and upserts them into Supabase.

This powers the set-symbol zone classifier in the card scanner.

SETUP (same env as generate_embeddings.py):
    pip3 install transformers torch Pillow requests supabase

USAGE:
    python3 embed_set_symbols.py
"""

import os, sys, io, time, requests
from PIL import Image

try:
    import torch
    from transformers import CLIPProcessor, CLIPVisionModelWithProjection
except ImportError:
    sys.exit("Run: pip3 install transformers torch Pillow requests supabase")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Run: pip3 install supabase")

# ══════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════
SUPABASE_URL = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or input("Service role key: ").strip()
TCG_API_KEY  = os.environ.get("POKEMONTCG_API_KEY") or ""   # optional — raises rate limit
REQUEST_TIMEOUT = 12

# ══════════════════════════════════════════════════════════════
# LOAD MODEL
# ══════════════════════════════════════════════════════════════
print("Loading CLIP model...")
device    = "cuda" if torch.cuda.is_available() else "cpu"
processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
model     = CLIPVisionModelWithProjection.from_pretrained("openai/clip-vit-base-patch32").to(device)
model.eval()
print(f"  Running on: {device}")

# ══════════════════════════════════════════════════════════════
# CONNECT TO SUPABASE
# ══════════════════════════════════════════════════════════════
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

print("\nVerifying connection...")
try:
    res = sb.table("set_symbols").select("set_code", count="exact").execute()
    print(f"  ✓ set_symbols table exists — current rows: {res.count}")
except Exception as e:
    sys.exit(f"  ✗ Cannot reach set_symbols table: {e}\n"
             "  Make sure you ran the updated scanner_setup.sql first.")

# ══════════════════════════════════════════════════════════════
# FETCH ALL SETS FROM POKEMON TCG API
# ══════════════════════════════════════════════════════════════
print("\nFetching sets from Pokemon TCG API...")
headers = {"X-Api-Key": TCG_API_KEY} if TCG_API_KEY else {}
try:
    r = requests.get(
        "https://api.pokemontcg.io/v2/sets?pageSize=500",
        headers=headers, timeout=20
    )
    r.raise_for_status()
    sets = r.json().get("data", [])
    print(f"  Found {len(sets)} sets")
except Exception as e:
    sys.exit(f"  ✗ Failed to fetch sets: {e}")

# ══════════════════════════════════════════════════════════════
# CHECK WHICH SETS ALREADY HAVE EMBEDDINGS
# ══════════════════════════════════════════════════════════════
done_res = sb.table("set_symbols").select("set_code").not_.is_("embedding", "null").execute()
already_done = {r["set_code"] for r in (done_res.data or [])}
print(f"  {len(already_done)} sets already embedded — skipping")

to_process = [s for s in sets if s["id"] not in already_done]
print(f"  {len(to_process)} sets to embed\n")

if not to_process:
    print("All sets already embedded!")
    sys.exit(0)

# ══════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════
def fetch_image(url, size=(224, 224)):
    """Download image and resize to square for CLIP input."""
    try:
        r = requests.get(url, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
        # Pad to square then resize — preserves symbol aspect ratio
        w, h = img.size
        side = max(w, h)
        padded = Image.new("RGB", (side, side), (255, 255, 255))
        padded.paste(img, ((side - w) // 2, (side - h) // 2))
        return padded.resize(size, Image.LANCZOS)
    except Exception as e:
        print(f"  ⚠ {url[:70]} — {e}")
        return None

def embed_image(pil_image):
    """Generate L2-normalized 512-dim CLIP embedding."""
    inputs = processor(images=[pil_image], return_tensors="pt").to(device)
    with torch.no_grad():
        out    = model(**inputs)
        embeds = out.image_embeds          # (1, 512)
        embeds = embeds / embeds.norm(dim=-1, keepdim=True)
    return embeds.cpu().tolist()[0]

# ══════════════════════════════════════════════════════════════
# MAIN LOOP
# ══════════════════════════════════════════════════════════════
succeeded = 0
failed    = 0
t0        = time.time()

for i, s in enumerate(to_process):
    set_code   = s["id"]
    set_name   = s.get("name", "")
    series     = s.get("series", "")
    symbol_url = s.get("images", {}).get("symbol", "")
    logo_url   = s.get("images", {}).get("logo", "")

    elapsed  = time.time() - t0
    per_item = elapsed / max(i, 1)
    eta      = int((len(to_process) - i) * per_item)
    print(f"  [{i+1:>3}/{len(to_process)}] {set_code:<12} {set_name[:30]:<30}  ETA {eta//60}m {eta%60}s", end="\r", flush=True)

    # Try symbol image first, fall back to logo
    img = fetch_image(symbol_url) if symbol_url else None
    if img is None and logo_url:
        img = fetch_image(logo_url)

    if img is None:
        failed += 1
        continue

    try:
        embedding = embed_image(img)
    except Exception as e:
        print(f"\n  ✗ Embed failed for {set_code}: {e}")
        failed += 1
        continue

    try:
        sb.table("set_symbols").upsert({
            "set_code":   set_code,
            "set_name":   set_name,
            "series":     series,
            "symbol_url": symbol_url or logo_url,
            "embedding":  embedding
        }, on_conflict="set_code").execute()
        succeeded += 1
    except Exception as e:
        print(f"\n  ✗ Upsert failed for {set_code}: {e}")
        failed += 1

    time.sleep(0.1)   # be polite to the TCG API

elapsed_total = int(time.time() - t0)
print(f"""

════════════════════════════════════════
  Done!  ({elapsed_total//60}m {elapsed_total%60}s)
  ✓ Embedded:  {succeeded}
  ✗ Failed:    {failed}
════════════════════════════════════════

Next steps:
  1. Build the index in Supabase SQL Editor:
     create index set_symbols_embedding_idx on set_symbols
       using ivfflat (embedding vector_cosine_ops) with (lists = 10);

  2. Verify:
     select count(*) from set_symbols;
     select set_code, set_name from set_symbols order by set_name limit 20;
""")
