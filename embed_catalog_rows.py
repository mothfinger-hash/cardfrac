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
from concurrent.futures import ThreadPoolExecutor, as_completed

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
ap.add_argument("--download-workers", type=int, default=8, help="Parallel image-fetch threads (default 8). Lower if your bandwidth is constrained.")
args = ap.parse_args()


# ── Config ──────────────────────────────────────────────────────────────
SUPABASE_URL    = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY    = os.environ.get("SUPABASE_SERVICE_KEY") or input("Supabase service-role key: ").strip()
BATCH_SIZE      = args.batch_size
UPSERT_BATCH    = 50
REQUEST_TIMEOUT = 12


# ── Model ───────────────────────────────────────────────────────────────
print("Loading CLIP model (openai/clip-vit-base-patch32)...")
# Device picking: NVIDIA CUDA > Apple Silicon MPS > CPU. MPS gives a
# 5-10x speedup over CPU on M1/M2/M3 Macs without any extra setup.
if torch.cuda.is_available():
    device = "cuda"
elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
    device = "mps"
else:
    device = "cpu"
processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
# use_safetensors=True avoids CVE-2025-32434 in torch.load() that
# affects torch < 2.6. The safetensors format is safe regardless of
# torch version. Transformers will auto-download model.safetensors
# the first time this runs; subsequent runs use the local cache.
model     = CLIPVisionModelWithProjection.from_pretrained(
    "openai/clip-vit-base-patch32",
    use_safetensors=True,
).to(device)
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
def fetch_image(url, retries=2):
    """Download + decode a card image. Retries on transient network
    errors (connection refused, timeout, DNS hiccup) which are common
    during long unattended runs. HTTP 4xx / 5xx are NOT retried — the
    image is just missing or banned."""
    last_err = None
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            return Image.open(io.BytesIO(r.content)).convert("RGB")
        except (requests.ConnectionError, requests.Timeout) as e:
            last_err = e
            if attempt < retries:
                time.sleep(1 + attempt * 2)  # 1s, 3s back-off
                continue
        except Exception as e:
            last_err = e
            break
    print(f"\n  ! {url[:70]} — {last_err}")
    return None


def fetch_batch_parallel(batch, workers):
    """Fetch every image in `batch` concurrently. Returns a list of
    (card, image) tuples in original order, plus a count of failures.
    Parallel I/O is the biggest single speedup for this script — going
    from 1 worker (~300ms/card) to 8 workers (~50ms/card) shrinks an
    overnight 100K-row run from ~12h to ~2-3h."""
    loaded_by_idx = [None] * len(batch)
    failed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_image, c["image_url"]): i
                   for i, c in enumerate(batch)}
        for fut in as_completed(futures):
            idx = futures[fut]
            img = fut.result()
            if img is not None:
                loaded_by_idx[idx] = (batch[idx], img)
            else:
                failed += 1
    loaded = [pair for pair in loaded_by_idx if pair is not None]
    return loaded, failed

def embed_batch(pil_images):
    inputs = processor(images=pil_images, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        out = model(**inputs)
        embeds = out.image_embeds
        embeds = embeds / embeds.norm(dim=-1, keepdim=True)
    return embeds.cpu().tolist()

_upsert_errors = 0
_abort_threshold = 500  # high tolerance for overnight runs. Transient
                        # 'Server disconnected' errors auto-retry now,
                        # so most won't reach this counter at all.
_UPDATE_WORKERS  = 8    # parallel UPDATEs per batch. Reduced from 12 —
                        # 12 was tripping Supabase's connection pool
                        # ('Server disconnected'). 8 + retries is more
                        # stable for long unattended runs.

def _is_transient_error(err_str):
    """Errors that should be retried (network/connection blips)."""
    s = str(err_str).lower()
    return any(token in s for token in [
        "server disconnected",
        "connection reset",
        "connection aborted",
        "remote end closed",
        "timed out",
        "timeout",
        "broken pipe",
        "max retries exceeded",
    ])

def upsert(rows):
    """Write embeddings back to catalog. Parallel per-row UPDATE with
    auto-retry on transient connection errors.

    Why not batched upsert? supabase-py's default_to_null=False kwarg
    didn't reliably suppress NULL clobbering on the UPDATE side, so
    batched upserts tripped NOT NULL constraints when any row in the
    batch had a quirky id. UPDATE has no INSERT path, so phantom ids
    no-op silently.

    Why retries? Supabase's REST endpoint occasionally drops in-flight
    connections (pool churn, keep-alive timeout). A 200-500ms retry
    almost always succeeds. Without retries, we lose embeddings that
    were already computed."""
    global _upsert_errors
    if args.dry_run or not rows:
        return

    def do_update(row):
        last_err = None
        for attempt in range(3):  # 1 initial + 2 retries
            try:
                sb.table("catalog").update({"embedding": row["embedding"]}).eq("id", row["id"]).execute()
                return None
            except Exception as e:
                last_err = e
                if _is_transient_error(e) and attempt < 2:
                    time.sleep(0.2 + attempt * 0.3)  # 0.2s, 0.5s back-off
                    continue
                break
        return (row.get("id", "?"), str(last_err))

    with ThreadPoolExecutor(max_workers=_UPDATE_WORKERS) as pool:
        futures = [pool.submit(do_update, row) for row in rows]
        for fut in as_completed(futures):
            err = fut.result()
            if err is not None:
                _upsert_errors += 1
                if _upsert_errors <= 5 or _upsert_errors % 50 == 0:
                    print(f"\n  Update error #{_upsert_errors} on {err[0]}: {err[1]}")
                if _upsert_errors >= _abort_threshold:
                    sys.exit(f"\n  {_abort_threshold} update errors — aborting (check connection).")


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
    rate    = (succeeded + failed) / elapsed if elapsed else 0
    print(f"  [{i+1:>6}/{total}]  ETA {eta//3600}h {(eta%3600)//60}m  ({rate:.1f}/s)", end="\r", flush=True)

    # Parallel image downloads — was the slowest part of the previous
    # loop. 8 workers default; tunable via --download-workers.
    loaded, batch_failed = fetch_batch_parallel(batch, args.download_workers)
    failed += batch_failed
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
