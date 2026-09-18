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

import os, sys, io, time, json, argparse, threading, collections
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
ap.add_argument("--retry-passes", type=int, default=1,
                help="After the main pass, re-try rows that failed on rate limiting (429/5xx) this many "
                     "more times at reduced concurrency (default 1). 0 disables.")
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
# Download throttling. Supabase Storage rate-limits by client IP and the
# TCGplayer CDN can too. A 429 is "slow down", not "missing image" — the
# previous version treated every non-200 as permanent and skipped the row,
# so one throttled window silently left thousands of rows un-embedded
# (2026-09-15: a 74K-row --all-missing run failed most rows this way).
# Now: honor Retry-After, back off exponentially, pause EVERY worker during
# the cool-down (one 429 means the others are about to get one too), halve
# the worker count when a batch keeps hitting 429, and re-queue throttled
# rows for a slower pass at the end. 400 / 403 / 404 stay permanent — the
# object is missing or the CDN refuses it — and are written to a JSON
# report so they can be fixed as data, not retried forever.
_UA = {"User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")}
_http = requests.Session()
_http.headers.update(_UA)
_cooldown_until = [0.0]
_cooldown_lock = threading.Lock()
_stats = collections.Counter()      # outcome class -> count (for the final summary)
_permanent = []                     # {"id","url","status"} — 4xx other than 429
_retry_queue = []                   # cards that gave up after repeated 429/5xx


def _wait_cooldown():
    while True:
        wait = _cooldown_until[0] - time.time()
        if wait <= 0:
            return
        time.sleep(min(wait, 5))


def _set_cooldown(seconds):
    with _cooldown_lock:
        _cooldown_until[0] = max(_cooldown_until[0], time.time() + seconds)


def fetch_image(card, retries=5):
    """Download + decode one card image.
    Returns (image, None) on success, (None, reason) on failure, where
    reason is 'throttled' (re-queued), 'permanent' (4xx, reported) or a
    network/decode error string."""
    url = card["image_url"]
    backoff = 2.0
    for attempt in range(retries + 1):
        _wait_cooldown()
        try:
            r = _http.get(url, timeout=REQUEST_TIMEOUT)
        except (requests.ConnectionError, requests.Timeout) as e:
            _stats["network error"] += 1
            if attempt < retries:
                time.sleep(1 + attempt * 2)
                continue
            return None, f"network: {type(e).__name__}"
        if r.status_code == 200:
            try:
                return Image.open(io.BytesIO(r.content)).convert("RGB"), None
            except Exception as e:
                _stats["undecodable image"] += 1
                _permanent.append({"id": card["id"], "url": url, "status": f"decode: {e}"})
                return None, "permanent"
        if r.status_code == 429 or r.status_code >= 500:
            ra = r.headers.get("Retry-After")
            try:
                wait = float(ra) if ra else backoff
            except ValueError:
                wait = backoff
            _set_cooldown(min(max(wait, 1.0), 60.0))
            _stats[f"http {r.status_code} (backed off)"] += 1
            backoff = min(backoff * 2, 60.0)
            continue
        # 400 / 403 / 404 / anything else: object missing or refused. Permanent.
        _stats[f"http {r.status_code} (permanent)"] += 1
        _permanent.append({"id": card["id"], "url": url, "status": r.status_code})
        return None, "permanent"
    _stats["throttled, re-queued"] += 1
    return None, "throttled"


def fetch_batch_parallel(batch, workers):
    """Fetch every image in `batch` concurrently. Returns (loaded, failed,
    throttled): loaded = [(card, image)] in original order; failed = count
    of rows that will not be retried this pass; throttled = count re-queued
    for the retry pass. Parallel I/O is the biggest single speedup for this
    script, but the worker count is now adaptive (see main loop)."""
    loaded_by_idx = [None] * len(batch)
    failed = throttled = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_image, c): i for i, c in enumerate(batch)}
        for fut in as_completed(futures):
            idx = futures[fut]
            img, reason = fut.result()
            if img is not None:
                loaded_by_idx[idx] = (batch[idx], img)
            elif reason == "throttled":
                throttled += 1
                _retry_queue.append(batch[idx])
            else:
                failed += 1
    loaded = [pair for pair in loaded_by_idx if pair is not None]
    return loaded, failed, throttled

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
_UPDATE_WORKERS  = 4    # parallel UPDATEs per batch. Was 12, then 8 —
                        # 12 tripped Supabase's connection pool ('Server
                        # disconnected'); 8 produced '[Errno 35] Resource
                        # temporarily unavailable' (EAGAIN — too many
                        # sockets in flight from one client) on the
                        # 2026-09-15 backlog run. 4 + retries is stable.

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
        "temporarily unavailable",   # EAGAIN / errno 35
        "errno 35",
        "too many requests",         # PostgREST 429
        "429",
        "502", "503", "504",
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
        for attempt in range(5):  # 1 initial + 4 retries
            try:
                sb.table("catalog").update({"embedding": row["embedding"]}).eq("id", row["id"]).execute()
                return None
            except Exception as e:
                last_err = e
                if _is_transient_error(e) and attempt < 4:
                    time.sleep(0.5 * (2 ** attempt))  # 0.5, 1, 2, 4s back-off
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
succeeded = 0
failed    = 0
buf       = []
t0        = time.time()


def run_pass(cards, workers, label):
    """Embed every card in `cards`. Worker count adapts: halve it when a
    batch keeps getting throttled (floor 2), creep back up after a run of
    clean batches. Throttled rows land in _retry_queue for the next pass."""
    global succeeded, failed
    total = len(cards)
    clean_batches = 0
    for i in range(0, total, BATCH_SIZE):
        batch = cards[i : i + BATCH_SIZE]
        elapsed = time.time() - t0
        done = succeeded + failed + len(_retry_queue)
        per  = elapsed / max(done, 1)
        eta  = int((total - i) * per)
        rate = done / elapsed if elapsed else 0
        print(f"  [{label} {i+1:>6}/{total}]  ETA {eta//3600}h {(eta%3600)//60}m  ({rate:.1f}/s, {workers} workers)",
              end="\r", flush=True)

        loaded, batch_failed, batch_throttled = fetch_batch_parallel(batch, workers)
        failed += batch_failed
        if batch_throttled >= max(2, len(batch) // 8):
            workers = max(2, workers // 2)
            clean_batches = 0
        elif batch_throttled == 0:
            clean_batches += 1
            if clean_batches >= 25 and workers < args.download_workers:
                workers += 1
                clean_batches = 0
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


try:
    run_pass(candidates, args.download_workers, "pass 1")
    # Rows that gave up on 429/5xx get another go at low concurrency once
    # the rate-limit window has had time to clear.
    for n in range(args.retry_passes):
        if not _retry_queue:
            break
        again, _retry_queue[:] = list(_retry_queue), []
        print(f"\n  {len(again):,} rows were throttled — waiting 60s, then retry pass {n + 1} at 2 workers…")
        time.sleep(60)
        run_pass(again, 2, f"retry {n + 1}")
except KeyboardInterrupt:
    # Flush embeddings already computed but not yet written, so a Ctrl-C
    # never throws away finished work. Failed / queued rows stay NULL and
    # are picked up by the next --all-missing run.
    print(f"\n  Interrupted — writing {len(buf)} pending embeddings before exit…")
    upsert(buf)
    buf.clear()
    print("  Pending rows will be picked up by the next --all-missing run.")

if buf:
    upsert(buf)

still_throttled = len(_retry_queue)
report_path = None
if _permanent:
    report_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               f"embed_failures_{time.strftime('%Y%m%d_%H%M%S')}.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(_permanent, f, indent=2)

elapsed_total = int(time.time() - t0)
print(f"""

════════════════════════════════════════
  Done!  ({elapsed_total//60}m {elapsed_total%60}s)
  Embedded:   {succeeded:,}
  Failed:     {failed:,}  (permanent — missing / refused images){'  (DRY RUN — nothing written)' if args.dry_run else ''}
  Throttled:  {still_throttled:,}  (still NULL; re-run --all-missing later)
════════════════════════════════════════""")
if _stats:
    print("  Download outcomes:")
    for k, v in sorted(_stats.items(), key=lambda kv: -kv[1]):
        print(f"    {v:>7,}  {k}")
if report_path:
    print(f"  Permanent failures written to {report_path}")
    print("  (400 = object missing from the bucket, 403 = TCGplayer has no image for that product.)")
