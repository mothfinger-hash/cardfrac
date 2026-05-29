#!/usr/bin/env python3
"""
PathBinder — Image-variant backfill
=====================================
Walks catalog rows whose image_url already points at a Supabase Storage
bucket (i.e. previously mirrored from pokedata / PriceCharting), checks
whether the -200.webp and -400.webp variants exist, and generates any
missing ones.

Why this exists
---------------
mirror_singles_images.py / mirror_sealed_images.py call upload_variants()
inline as they upload each main image. But rows that were mirrored
BEFORE image_variants.py was wired into the upload pipeline still have
only the main file in storage — no -200.webp, no -400.webp.

The browser-side `_pickThumbVariant()` helper rewrites URLs like
`card-images/cn/foo/123.webp` to `card-images/cn/foo/123-200.webp`.
When that variant 404s, the onerror cascade falls back to the original,
which works visually but bleeds bandwidth — Lighthouse measured 235 KB
images displayed at 36x50 px (the Chinese 151 set rows). Generating
the missing variants drops each thumbnail to ~10-15 KB.

PREREQUISITES
-------------
    pip3 install requests pillow supabase --break-system-packages

USAGE
-----
    # Dry-run — list rows that would need variants generated
    python3 backfill_image_variants.py --dry-run

    # Backfill every catalog row whose image_url is on Supabase Storage
    python3 backfill_image_variants.py

    # Scope to a TCG / language
    python3 backfill_image_variants.py --game pokemon --lang cn
    python3 backfill_image_variants.py --game magic

    # Crank up parallelism
    python3 backfill_image_variants.py --workers 8

    # Limit for testing
    python3 backfill_image_variants.py --limit 50

ENVIRONMENT
-----------
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
"""

import os
import sys
import re
import time
import random
import argparse
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

try:
    from PIL import Image  # noqa: F401  — imported transitively via image_variants
except ImportError:
    sys.exit("Missing 'pillow'. Run: pip3 install pillow --break-system-packages")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing 'supabase'. Run: pip3 install supabase --break-system-packages")

# Shared variant helper. VARIANT_SIZES = (200, 400) lives there.
from image_variants import upload_variants, VARIANT_SIZES, _variant_path


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# Storage URL pattern matcher. Supabase serves public objects as:
#   https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
# We extract (bucket, path) from any catalog.image_url that matches.
_STORAGE_URL_RE = re.compile(
    r"/storage/v1/object/public/(?P<bucket>[^/]+)/(?P<path>.+?)(?:\?.*)?$"
)

_print_lock = threading.Lock()
def _log(*args):
    with _print_lock:
        print(*args, flush=True)


# ─── Catalog scan ────────────────────────────────────────────────────────────
def _build_filter(game, lang):
    """Build the PostgREST `image_url=like.*storage*` filter plus
    optional game_type / id-prefix filters."""
    flt = "image_url=like.*storage/v1/object/public/*"
    if game and game != "all":
        flt += f"&game_type=eq.{game}"
    if lang:
        # Language prefix lives in the id (e.g. `cn-`, `kr-`, `jp-`).
        # ilike for case-insensitive match. Quote the % via PostgREST's
        # standard syntax.
        flt += f"&id=ilike.{lang}-*"
    return flt


def load_catalog(game, lang, limit=None):
    """Page through every catalog row that has a Supabase Storage URL
    in image_url and (optionally) matches the game_type / lang filters.

    Uses keyset pagination (id > last_seen_id ORDER BY id) instead of
    OFFSET/LIMIT. PostgREST + Postgres times out on deep offsets when
    the filter set includes a leading-wildcard LIKE (image_url LIKE
    '%storage%') because the planner has to seq-scan + discard each
    page before returning. Keyset doesn't degrade with depth — each
    page is a fresh index range scan from the last id forward."""
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog"
    select = "id,name,game_type,image_url"
    flt    = _build_filter(game, lang)
    rows   = []
    page_size = 500  # smaller than before (1000) — keeps per-page cost low
    last_id = None
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    }
    while True:
        # PostgREST gt filter: id=gt.<last_id>. URL-encode the id value
        # since some ids contain shell-/URL-meaningful characters.
        cursor = ""
        if last_id is not None:
            cursor = f"&id=gt.{requests.utils.quote(last_id, safe='')}"
        params = f"?select={select}&{flt}{cursor}&order=id.asc&limit={page_size}"
        r = requests.get(url + params, headers=headers, timeout=60)
        # Retry once on transient 5xx (Supabase occasionally hiccups
        # mid-scan) before giving up.
        if r.status_code in (500, 502, 503, 504):
            time.sleep(1.5 + random.uniform(0, 1))
            r = requests.get(url + params, headers=headers, timeout=60)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        last_id = batch[-1]["id"]
        if limit and len(rows) >= limit:
            return rows[:limit]
        if len(batch) < page_size:
            break
    return rows


def _parse_storage_url(image_url):
    """Return (bucket, path) from a Supabase public storage URL, or
    (None, None) if the URL doesn't match the public-object pattern."""
    try:
        u = urlparse(image_url)
        m = _STORAGE_URL_RE.search(u.path)
        if not m:
            return (None, None)
        return (m.group("bucket"), m.group("path"))
    except Exception:
        return (None, None)


# ─── Variant existence check (HEAD via public URL) ───────────────────────────
_head_session = requests.Session()
_head_session.headers.update({"User-Agent": "PathBinder-VariantBackfill/1.0"})


def _is_transient(err):
    """Detect macOS / Linux EAGAIN-style errors that resolve on retry.
    Same set as mirror_set_logos.py — keeps the script resilient to
    socket pool exhaustion on macOS's 256-FD default limit."""
    s = str(err).lower()
    return any(t in s for t in (
        "resource temporarily unavailable",
        "errno 35",
        "errno 11",                  # Linux EAGAIN
        "connection reset",
        "broken pipe",
        "timed out",
        "remoteprotocolerror",
        "503",
    ))

def _public_url(bucket, path):
    return f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/public/{bucket}/{path}"

def variant_exists(bucket, base_path, width):
    """HEAD the variant URL — if 200, it exists. Anything else (404,
    403 with empty body, network error) → treat as missing."""
    vpath = _variant_path(base_path, width)
    url = _public_url(bucket, vpath)
    try:
        r = _head_session.head(url, timeout=10, allow_redirects=True)
        return r.status_code == 200
    except Exception:
        return False


# ─── Per-row processor ───────────────────────────────────────────────────────
def process_row(row, dry_run=False):
    """For one catalog row: identify the bucket+path, check which
    variants exist, generate the missing ones. Returns
    (status, row_id, detail)."""
    rid = row.get("id") or "?"
    image_url = row.get("image_url")
    if not image_url:
        return ("skipped", rid, "no image_url")

    bucket, base_path = _parse_storage_url(image_url)
    if not bucket or not base_path:
        return ("skipped", rid, "not a Supabase Storage URL")

    # Which variants are missing?
    missing_sizes = []
    for w in VARIANT_SIZES:
        if not variant_exists(bucket, base_path, w):
            missing_sizes.append(w)
    if not missing_sizes:
        return ("ok", rid, "all variants present")

    if dry_run:
        return ("would_backfill", rid,
                f"missing: {','.join(str(s) for s in missing_sizes)} ({bucket}/{base_path})")

    # Download original (with retry on transient OS errors)
    body = None
    last_err = None
    for attempt in range(5):
        try:
            r = _head_session.get(_public_url(bucket, base_path), timeout=30)
            if not r.ok:
                return ("failed", rid, f"download original HTTP {r.status_code}")
            body = r.content
            break
        except Exception as e:
            last_err = e
            if attempt < 4 and _is_transient(e):
                time.sleep((2 ** attempt) * 0.3 + random.uniform(0, 0.4))
                continue
            return ("failed", rid, f"download error: {e}")

    # Generate + upload the missing widths. upload_variants returns
    # a per-size result tuple; if any individual variant upload hit
    # EAGAIN we retry the whole call (cheap because we already have
    # the source bytes in memory, and uploads use upsert=true so
    # successful ones are idempotent).
    last_err = None
    results = []
    for attempt in range(5):
        try:
            results = upload_variants(sb, bucket, base_path, body, sizes=tuple(missing_sizes))
            # Retry if any of the per-size results came back with an
            # EAGAIN-style upload error.
            transient_failures = [
                (w, d) for (w, ok, d) in results
                if not ok and isinstance(d, str) and _is_transient(d)
            ]
            if transient_failures and attempt < 4:
                time.sleep((2 ** attempt) * 0.5 + random.uniform(0, 0.5))
                last_err = f"{len(transient_failures)} transient failure(s), retrying"
                continue
            break
        except Exception as e:
            last_err = e
            if attempt < 4 and _is_transient(e):
                time.sleep((2 ** attempt) * 0.5 + random.uniform(0, 0.5))
                continue
            return ("failed", rid, f"upload_variants: {e}")

    # Categorize results. upload_variants refuses to upscale, so
    # "source XXXpx not wider than YYYpx" comes back as ok=False
    # with that detail string. That isn't a failure — the source
    # IS already smaller than the requested variant width, so the
    # browser fallback chain ends up at the original which is
    # already thumbnail-sized. Treat those rows as "ok, nothing
    # to do here" rather than poisoning the run summary.
    real_uploads      = [r for r in results if r[1]]
    upscale_skipped   = [r for r in results
                         if not r[1] and isinstance(r[2], str)
                         and "not wider than" in r[2]]
    real_failures     = [r for r in results
                         if not r[1] and r not in upscale_skipped]

    if real_failures and not real_uploads:
        details = "; ".join(f"{w}={d}" for (w, _ok, d) in real_failures)
        return ("failed", rid, f"no variants uploaded: {details}")
    if not real_uploads and upscale_skipped:
        # All "missing" variants were sizes the source can't satisfy.
        # No work was needed; report it accurately.
        sizes_str = ",".join(str(w) for (w, _ok, _d) in upscale_skipped)
        return ("source_too_small", rid, f"original is smaller than variant size(s) {sizes_str}")

    # Mixed: some variants uploaded, others skipped because source
    # too small for those widths. Successful uploads still get credit.
    if real_uploads:
        return ("backfilled", rid,
                f"generated {len(real_uploads)}/{len(missing_sizes)} variants")
    # Defensive fall-through — shouldn't be reached, but be safe.
    return ("failed", rid, "no variants uploaded (unexpected state)")


# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description="Backfill missing -200.webp/-400.webp variants for already-mirrored catalog images.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--game",   default="all",
                    help="catalog.game_type filter (pokemon, magic, yugioh, …) or 'all'.")
    ap.add_argument("--lang",   default=None,
                    help="id prefix filter (en, jp, cn, kr, …). Optional.")
    ap.add_argument("--limit",  type=int, default=None,
                    help="Cap the number of rows scanned. Useful for testing.")
    ap.add_argument("--workers", type=int, default=2,
                    help="Parallel processing workers (default 2 — macOS's "
                         "low FD limit means more workers risk EAGAIN "
                         "errors on the upload path; the retry handler "
                         "absorbs them but smaller default is faster).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what's missing, don't actually generate variants.")
    args = ap.parse_args()

    _log(f"Loading catalog rows (game={args.game}, lang={args.lang or '*'})…")
    rows = load_catalog(args.game, args.lang, args.limit)
    _log(f"  {len(rows):,} rows with Supabase Storage image_urls in scope.")
    if not rows:
        _log("Nothing to do.")
        return

    _log(f"Checking variant presence + backfilling with {args.workers} workers"
         f"{' (DRY RUN)' if args.dry_run else ''}…")
    stats = {"ok": 0, "would_backfill": 0, "backfilled": 0,
             "source_too_small": 0, "skipped": 0, "failed": 0}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(process_row, r, args.dry_run) for r in rows]
        for i, fut in enumerate(as_completed(futs), start=1):
            status, rid, detail = fut.result()
            stats[status] = stats.get(status, 0) + 1
            # Don't spam the log with every "ok" — just the actionable ones.
            if status in ("would_backfill", "backfilled", "failed"):
                _log(f"  [{i:>5}/{len(rows)}] {status:<14s} {rid:<28s} {detail}")
            elif i % 500 == 0:
                _log(f"  [{i:>5}/{len(rows)}] … {stats['ok']:,} already complete, "
                     f"{stats['backfilled'] + stats['would_backfill']:,} touched")

    _log("")
    _log(f"  Already had all variants : {stats.get('ok', 0):,}")
    if args.dry_run:
        _log(f"  Would backfill           : {stats.get('would_backfill', 0):,}")
    else:
        _log(f"  Backfilled               : {stats.get('backfilled', 0):,}")
    _log(f"  Source too small (no-op) : {stats.get('source_too_small', 0):,}")
    _log(f"  Skipped (non-storage URL): {stats.get('skipped', 0):,}")
    _log(f"  Failed                   : {stats.get('failed', 0):,}")
    if args.dry_run:
        _log("")
        _log("  (DRY RUN — nothing written. Re-run without --dry-run to commit.)")


if __name__ == "__main__":
    main()
