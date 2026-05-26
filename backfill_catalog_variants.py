#!/usr/bin/env python3
"""
PathBinder — Backfill catalog variants
========================================
Generates 200/400px WebP thumbnail variants for catalog rows whose
images are already mirrored to Supabase Storage (i.e. image_url
already points at /storage/v1/object/public/card-images/...).

The going-forward variant generation lives in mirror_singles_images.py
and mirror_sealed_images.py — both call image_variants.upload_variants
on every NEW mirror. This script handles the one-time backfill for
rows mirrored before that pipeline existed.

Idempotent. Variants that already exist in Storage are skipped (HEAD
check first). Failures on individual rows are logged but don't abort
the run — safe to Ctrl+C and rerun.

PREREQUISITES:
    pip3 install requests pillow supabase --break-system-packages

USAGE:
    # Dry-run — count + show first 5 target paths, no work done
    python3 backfill_catalog_variants.py --dry-run

    # Default: SINGLES ONLY. Sealed products are skipped because some
    # of them have automated-bg-removal artifacts that need to be
    # flagged/replaced manually before variant generation. Once the
    # sealed image queue is clean, opt in with --product-type:
    python3 backfill_catalog_variants.py

    # Only one product type (sealed, booster_box, etb, tin, etc.)
    python3 backfill_catalog_variants.py --product-type sealed

    # Every catalog row regardless of type (use AFTER reviewing
    # the sealed image-review queue):
    python3 backfill_catalog_variants.py --product-type all

    # Crank up parallelism
    python3 backfill_catalog_variants.py --workers 8

    # Cap for a tiny smoke test
    python3 backfill_catalog_variants.py --limit 20

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
"""

import os, sys, io, time, argparse, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

try:
    from PIL import Image
except ImportError:
    sys.exit("Missing 'pillow'. Run: pip3 install pillow --break-system-packages")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing 'supabase'. Run: pip3 install supabase --break-system-packages")

from image_variants import upload_variants, VARIANT_SIZES


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

STORAGE_BUCKET = "card-images"
REQUEST_TIMEOUT = 20

sb = create_client(SUPABASE_URL, SUPABASE_KEY)
_session = requests.Session()


def pg_get(path, params=None):
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}"
    r = requests.get(url, headers={
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    }, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


# Marker that identifies a Supabase Storage URL for our card-images
# bucket. URLs not matching this pattern are skipped (PriceCharting
# direct, pokemontcg.io, etc.). When the mirror scripts upload to
# Supabase, the resulting public URL contains this substring.
_STORAGE_MARKER = f"/storage/v1/object/public/{STORAGE_BUCKET}/"


def storage_path_from_url(url):
    """
    Given a public URL like
        https://<proj>.supabase.co/storage/v1/object/public/card-images/cn/set/123.webp
    return just the path within the bucket: 'cn/set/123.webp'.
    Returns None if the URL doesn't look like a card-images storage URL.
    """
    if not url or _STORAGE_MARKER not in url:
        return None
    return url.split(_STORAGE_MARKER, 1)[1].split("?", 1)[0]


def variant_exists(path, width):
    """
    HEAD-check the variant URL to skip work that's already done. Uses
    the public URL because Supabase Storage anon GETs are cheap and
    HEAD doesn't transfer the body.
    """
    import re as _re
    m = _re.search(r'(\.[^./]+)$', path)
    if m:
        vpath = path[: m.start()] + f'-{width}.webp'
    else:
        vpath = path + f'-{width}.webp'
    url = f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{vpath}"
    try:
        r = _session.head(url, timeout=10)
        return r.status_code == 200
    except Exception:
        return False


def download_main(url):
    r = _session.get(url, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    return r.content


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Count rows, show first 5 targets; no downloads or uploads.")
    ap.add_argument("--product-type", default="single",
                    help="Filter by catalog.product_type. Defaults to 'single' (skip sealed for now — sealed images need a manual bg-removal review pass before variants are useful). Pass 'all' for no filter, or a specific type like 'sealed' / 'booster_box' / 'etb'.")
    ap.add_argument("--limit", type=int, default=0,
                    help="Stop after N rows (debugging).")
    ap.add_argument("--workers", type=int, default=5,
                    help="Parallel download/upload workers (default 5).")
    ap.add_argument("--no-skip-existing", action="store_true",
                    help="Re-encode + re-upload variants even if they already exist.")
    args = ap.parse_args()

    _filter_note = ("all product types" if args.product_type == "all"
                    else f"product_type = '{args.product_type}'"
                         + (" (sealed products skipped — pass --product-type all to include them)"
                            if args.product_type == "single" else ""))
    print(f"\n  Loading catalog rows with mirrored images ({_filter_note})…")
    rows = []
    page = 0
    PAGE_SIZE = 1000
    while True:
        params = {
            "select":    "id,image_url,product_type",
            "image_url": f"like.*{_STORAGE_MARKER}*",
            "limit":     str(PAGE_SIZE),
            "offset":    str(page * PAGE_SIZE),
        }
        if args.product_type != "all":
            params["product_type"] = f"eq.{args.product_type}"
        chunk = pg_get("catalog", params=params)
        rows.extend(chunk)
        if len(chunk) < PAGE_SIZE:
            break
        page += 1
        if args.limit and len(rows) >= args.limit:
            break

    if args.limit:
        rows = rows[: args.limit]

    print(f"  {len(rows):,} mirrored catalog rows.")
    if not rows:
        print("  Nothing to do.")
        return

    est_sec = len(rows) * (1.0 / max(args.workers, 1))
    print(f"  Estimated time: ~{est_sec/60:.1f} min with {args.workers} workers")

    if args.dry_run:
        print("\n  --dry-run — first 5 target paths:")
        for r in rows[:5]:
            sp = storage_path_from_url(r["image_url"]) or "(no path)"
            print(f"     {r['id']:<28}  {sp}")
        return

    print(f"\n  Starting in 3s — Ctrl+C to abort\n")
    time.sleep(3)

    _lock = threading.Lock()
    stats = {"variants_made": 0, "skipped_existing": 0, "failed": 0, "completed": 0}
    skip_existing = not args.no_skip_existing

    def backfill_one(row):
        rid = row["id"]
        src_url = row.get("image_url") or ""
        sp = storage_path_from_url(src_url)
        if not sp:
            return (rid, "failed", "url not a card-images storage url")

        # Skip if BOTH variants already exist (the common case after the
        # first backfill pass). If only one is missing, we still
        # regenerate both for simplicity — costs negligibly more.
        if skip_existing:
            all_exist = all(variant_exists(sp, w) for w in VARIANT_SIZES)
            if all_exist:
                return (rid, "skipped_existing", "")

        try:
            raw = download_main(src_url)
        except Exception as e:
            return (rid, "failed", f"download: {e}")

        try:
            results = upload_variants(sb, STORAGE_BUCKET, sp, raw)
        except Exception as e:
            return (rid, "failed", f"variants: {e}")

        # Surface any per-width failures that weren't "source too small"
        problems = [
            f"{w}px: {detail}"
            for (w, ok, detail) in results
            if not ok and "not wider than" not in str(detail)
        ]
        if problems:
            return (rid, "failed", "; ".join(problems))
        made = sum(1 for (_w, ok, _d) in results if ok)
        return (rid, "variants_made", f"{made} variants")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(backfill_one, r): r for r in rows}
        for f in as_completed(futs):
            rid, status, detail = f.result()
            with _lock:
                stats[status] = stats.get(status, 0) + 1
                stats["completed"] += 1
                n = stats["completed"]
                if status == "failed":
                    print(f"  [{n:>4}/{len(rows)}] FAIL  {rid}  — {detail}")
                elif n % 50 == 0 or n == len(rows):
                    print(f"  [{n:>4}/{len(rows)}] "
                          f"variants_made={stats['variants_made']} "
                          f"skipped_existing={stats['skipped_existing']} "
                          f"failed={stats['failed']}")

    print(f"\n  Done. "
          f"variants_made={stats['variants_made']} "
          f"skipped_existing={stats['skipped_existing']} "
          f"failed={stats['failed']}")


if __name__ == "__main__":
    main()
