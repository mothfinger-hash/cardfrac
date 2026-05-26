#!/usr/bin/env python3
"""
PathBinder — Singles Image Mirror (non-EN/JP Pokémon)
========================================================
Walks every catalog row that's a SINGLE CARD (product_type='single')
whose id has a `{lang}-pc-…` prefix and whose image_url still points
at PriceCharting's CDN. Downloads, converts to WebP, uploads to
Supabase Storage, rewrites image_url to the new local URL.

Sister script to mirror_sealed_images.py — same machinery, different
filter (singles instead of sealed) and different storage layout
(per-set-code instead of per-product-id under sealed/).

PREREQUISITES:
    pip3 install requests pillow supabase --break-system-packages
    (Pillow handles JPG/PNG → WebP conversion.)

USAGE:
    # Dry-run — print first 5 paths that WOULD be mirrored
    python3 mirror_singles_images.py --dry-run

    # Mirror every non-EN/JP single (Chinese, Korean, German, etc.)
    python3 mirror_singles_images.py

    # Only one language family
    python3 mirror_singles_images.py --lang cn

    # Crank up parallelism
    python3 mirror_singles_images.py --workers 8

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key

STORAGE LAYOUT:
    card-images/{lang}/{set_code}/{pricecharting_id}.webp
        e.g. card-images/cn/chinese-151-collect/8709229.webp
             card-images/kr/korean-eevee-heroes/9681329.webp
"""

import os, sys, io, time, argparse, threading
import re as _re
from concurrent.futures import ThreadPoolExecutor, as_completed

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

# Variant helper — generates 200/400px WebP thumbnails alongside each
# main image. See image_variants.py for the why; tldr: avoids Supabase's
# metered image-transformation quota.
from image_variants import upload_variants


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

STORAGE_BUCKET = "card-images"
REQUEST_TIMEOUT = 20
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
}

# Which id prefixes count as "non-EN/JP Pokémon singles". Matches
# the LANG_MAP used by sync_pokemon_singles_by_lang.py.
NON_EN_JP_LANGS = ("cn", "kr", "de", "fr", "it", "es", "pt", "nl", "ru")

sb = create_client(SUPABASE_URL, SUPABASE_KEY)
_session = requests.Session()
_session.headers.update(HEADERS)


def pg_get(path, params=None):
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}"
    r = requests.get(url, headers={
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    }, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def pg_patch(table, row_id, payload):
    import json as _json
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{table}?id=eq.{requests.utils.quote(row_id)}"
    body = _json.dumps(payload, ensure_ascii=False).encode("utf-8")
    r = requests.patch(url, headers={
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json; charset=utf-8",
        "Prefer":        "return=minimal",
    }, data=body, timeout=30)
    if not r.ok:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")


_SIZE_RE = _re.compile(r'/(60|160|240|320|480|640|1600)\.(jpg|jpeg|png|webp)$', _re.IGNORECASE)

def download_image(url):
    """Same fallback chain as mirror_sealed_images.py — try /480 → /320
    → /240 → /160 → /60 until one returns 200."""
    base = _SIZE_RE.sub('', url)
    m = _SIZE_RE.search(url)
    ext = m.group(2) if m else "jpg"
    last_err = None
    for size in (480, 320, 240, 160, 60):
        candidate = f"{base}/{size}.{ext}"
        try:
            r = _session.get(candidate, timeout=REQUEST_TIMEOUT)
            if r.status_code == 200 and r.content:
                return r.content, size
            last_err = f"HTTP {r.status_code}"
        except Exception as e:
            last_err = str(e)
    raise RuntimeError(f"no PriceCharting size worked for {url} — last error: {last_err}")


def convert_to_webp(raw_bytes, quality=82):
    im = Image.open(io.BytesIO(raw_bytes))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if im.mode in ("LA", "P") else "RGB")
    out = io.BytesIO()
    im.save(out, format="WEBP", quality=quality, method=6)
    return out.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="List target rows + first 5 target paths; don't download or upload.")
    ap.add_argument("--lang", choices=NON_EN_JP_LANGS + ("all",), default="all",
                    help="Only mirror one language family (default 'all').")
    ap.add_argument("--limit", type=int, default=0,
                    help="Stop after N rows (debugging).")
    ap.add_argument("--workers", type=int, default=5,
                    help="Parallel download/upload workers (default 5).")
    args = ap.parse_args()

    print("\n  Loading non-EN/JP singles with off-Supabase images…")
    rows = []
    page = 0
    PAGE_SIZE = 1000

    # Build a `id=in.(…)` style filter for the requested lang(s).
    if args.lang == "all":
        # PostgREST doesn't support OR across multiple ilike on the
        # same column via params nicely, so we paginate per-lang.
        langs_to_pull = NON_EN_JP_LANGS
    else:
        langs_to_pull = (args.lang,)

    for lang in langs_to_pull:
        page = 0
        while True:
            chunk = pg_get("catalog", params={
                "select":       "id,image_url,set_code,pricecharting_id,card_number",
                "product_type": "eq.single",
                "id":           f"like.{lang}-pc-*",
                "image_url":    "ilike.*pricecharting*",
                "limit":        str(PAGE_SIZE),
                "offset":       str(page * PAGE_SIZE),
            })
            rows.extend(chunk)
            if len(chunk) < PAGE_SIZE:
                break
            page += 1

    if args.limit:
        rows = rows[:args.limit]
    print(f"  {len(rows):,} singles to mirror.")
    if not rows:
        print("  Nothing to do — all matching singles already mirrored.")
        return

    est_mb  = len(rows) * 30 / 1024
    est_sec = len(rows) * (1.0 / args.workers)
    print(f"  Estimated transfer: ~{est_mb:.0f} MB")
    print(f"  Estimated time:     ~{est_sec/60:.1f} min with {args.workers} workers")

    if args.dry_run:
        print("\n  --dry-run — first 5 target paths:")
        for r in rows[:5]:
            # id format: {lang}-pc-{pricecharting_id}
            parts = r["id"].split("-", 2)
            lang  = parts[0] if len(parts) >= 1 else "xx"
            sc    = (r.get("set_code") or "unknown").lower()
            pid   = r.get("pricecharting_id") or (r["id"].rsplit("-", 1)[-1])
            path  = f"{lang}/{sc}/{pid}.webp"
            print(f"     {r['id']:<28}  {r['image_url'][:60]}…  →  {path}")
        return

    print(f"\n  Starting in 3s — Ctrl+C to abort\n")
    time.sleep(3)

    _lock = threading.Lock()
    stats = {"mirrored": 0, "failed": 0, "skipped": 0, "completed": 0}

    def mirror_one(row):
        rid = row["id"]
        src = row.get("image_url") or ""
        sc  = (row.get("set_code") or "unknown").lower()
        pid = row.get("pricecharting_id") or rid.rsplit("-", 1)[-1]
        parts = rid.split("-", 2)
        lang  = parts[0] if len(parts) >= 1 else "xx"

        if not src:
            return (rid, "skipped", "no image_url")
        if "no-image-available" in src:
            return (rid, "skipped", "placeholder image")

        path = f"{lang}/{sc}/{pid}.webp"

        try:
            raw, _size = download_image(src)
        except Exception as e:
            return (rid, "failed", f"download: {e}")

        try:
            webp_bytes = convert_to_webp(raw)
        except Exception as e:
            return (rid, "failed", f"convert: {e}")

        last_err = None
        for attempt in range(3):
            try:
                sb.storage.from_(STORAGE_BUCKET).upload(
                    path, webp_bytes,
                    file_options={"content-type": "image/webp", "upsert": "true"}
                )
                last_err = None
                break
            except Exception as e:
                last_err = e
                if attempt < 2:
                    time.sleep(2 * (attempt + 1))
        if last_err:
            return (rid, "failed", f"upload: {last_err}")

        # Variants: 200px + 400px WebP siblings. Non-fatal — variant
        # failures are logged but don't fail the whole row, because the
        # browser's onerror fallback uses the main image when variants
        # are missing.
        try:
            v_results = upload_variants(sb, STORAGE_BUCKET, path, webp_bytes)
            for vw, ok, detail in v_results:
                if not ok and "not wider than" not in str(detail):
                    print(f"     [variant {vw}px] {rid}: {detail}")
        except Exception as e:
            print(f"     [variants] {rid}: {e}")

        new_url = f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{path}"
        try:
            pg_patch("catalog", rid, {"image_url": new_url})
        except Exception as e:
            return (rid, "failed", f"db: {e}")

        return (rid, "mirrored", new_url)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(mirror_one, r): r for r in rows}
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
                          f"mirrored={stats['mirrored']} "
                          f"skipped={stats['skipped']} "
                          f"failed={stats['failed']}")

    print(f"\n  Done. mirrored={stats['mirrored']} "
          f"skipped={stats['skipped']} failed={stats['failed']}")


if __name__ == "__main__":
    main()
