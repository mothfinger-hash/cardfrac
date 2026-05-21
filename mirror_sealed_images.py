#!/usr/bin/env python3
"""
PathBinder — Sealed Product Image Mirror
==========================================
Walks every sealed-product catalog row whose image_url still points at
PriceCharting's CDN (storage.googleapis.com/images.pricecharting.com),
downloads the image, converts to WebP, uploads to Supabase Storage,
and rewrites image_url to the local CDN URL.

Idempotent: skips rows already on supabase.co. Ctrl-C safe — re-runs
pick up where they left off.

PREREQUISITES:
    pip3 install requests pillow supabase --break-system-packages
    (Pillow handles the JPG/PNG → WebP conversion.)

USAGE:
    # Dry-run — print first 5 paths that WOULD be mirrored
    python3 mirror_sealed_images.py --dry-run

    # Real mirror
    python3 mirror_sealed_images.py

    # Limit to N rows (debugging)
    python3 mirror_sealed_images.py --limit 10

    # Crank up parallelism (default 5 workers)
    python3 mirror_sealed_images.py --workers 8

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key

STORAGE LAYOUT:
    card-images/sealed/{lang}/{set_code}/{pricecharting_id}.webp
        e.g. card-images/sealed/en/mew/5826208.webp
             card-images/sealed/jp/japanese-stellar-miracle/7029836.webp
"""

import os, sys, io, time, argparse, threading
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

sb = create_client(SUPABASE_URL, SUPABASE_KEY)
_session = requests.Session()
_session.headers.update(HEADERS)


# ─── DB queries (direct PostgREST — avoids supabase-py upsert bug) ──────────

def pg_get(path, params=None):
    """GET against PostgREST. path like 'catalog?select=id,image_url'."""
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}"
    r = requests.get(url, headers={
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    }, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def pg_patch(table, row_id, payload):
    """PATCH a single row by id."""
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{table}?id=eq.{requests.utils.quote(row_id)}"
    body = __import__("json").dumps(payload, ensure_ascii=False).encode("utf-8")
    r = requests.patch(url, headers={
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json; charset=utf-8",
        "Prefer":        "return=minimal",
    }, data=body, timeout=30)
    if not r.ok:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")


# ─── Image fetch + convert ──────────────────────────────────────────────────

import re as _re_dl
_SIZE_RE = _re_dl.compile(r'/(60|160|240|320|480|640|1600)\.(jpg|jpeg|png|webp)$', _re_dl.IGNORECASE)

def download_image(url):
    """Download a PriceCharting product image at the largest available
    size. PriceCharting's CDN exposes multiple variants per hash:
        /60.jpg /160.jpg /240.jpg /320.jpg /480.jpg /640.jpg /1600.jpg
    Not every product has every size pre-generated. Brand-new products
    (e.g. fresh Gundam set releases) often have ONLY /1600 available
    until PC's background job pre-generates the smaller sizes —
    older products may max out at /240. We start at the size that
    was in the source URL, then fall back through every size in
    decreasing-then-ascending order so we hit whichever PC actually
    serves first. convert_to_webp downsizes anything bigger than
    480px wide so the catalog stays uniform.
    """
    base = _SIZE_RE.sub('', url)
    m = _SIZE_RE.search(url)
    ext = m.group(2) if m else "jpg"
    # Try /1600 first (newest products only have this), then standard
    # downsized ladder. /640 and /1600 added since some Gundam product
    # rows are only published at those sizes.
    sizes_to_try = (1600, 640, 480, 320, 240, 160, 60)
    last_err = None
    for size in sizes_to_try:
        candidate = f"{base}/{size}.{ext}"
        try:
            r = _session.get(candidate, timeout=REQUEST_TIMEOUT)
            if r.status_code == 200 and r.content:
                return r.content, size
            last_err = f"HTTP {r.status_code}"
        except Exception as e:
            last_err = str(e)
    raise RuntimeError(f"no PriceCharting size worked for {url} — last error: {last_err}")


# Downscale source images bigger than this width before WebP-encoding,
# so /1600 originals don't bloat Supabase Storage. 480 is the size the
# rest of the catalog standardizes on.
_MAX_WEBP_WIDTH = 480

def convert_to_webp(raw_bytes, quality=82):
    """Convert any PIL-supported source format to WebP, downscaled
    to _MAX_WEBP_WIDTH if the source is wider (e.g. when we had to
    fall back to /1600 because PC hadn't published /480 yet)."""
    im = Image.open(io.BytesIO(raw_bytes))
    # WebP doesn't love palette-mode PNGs, normalise to RGB(A).
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if im.mode in ("LA", "P") else "RGB")
    # Downscale if needed — preserves aspect ratio.
    if im.width > _MAX_WEBP_WIDTH:
        new_h = round(im.height * _MAX_WEBP_WIDTH / im.width)
        im = im.resize((_MAX_WEBP_WIDTH, new_h), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, format="WEBP", quality=quality, method=6)
    return out.getvalue()


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="List target rows + print first 5 storage paths; don't download or upload.")
    ap.add_argument("--limit", type=int, default=0,
                    help="Stop after N rows (debugging).")
    ap.add_argument("--workers", type=int, default=5,
                    help="Parallel download/upload workers (default 5).")
    ap.add_argument("--tcg", type=str, default=None,
                    help="Scope to a single TCG. Matches catalog ids by "
                         "prefix: pokemon=sealed-en-/sealed-jp-/sealed-kr-/sealed-cn-, "
                         "magic=sealed-mtg-, yugioh=sealed-ygo-, onepiece=sealed-op-, "
                         "gundam=sealed-gun-, dbz=sealed-dbz-.")
    args = ap.parse_args()

    # Map --tcg to the catalog-id prefix(es) the mirror should consider.
    # Pokemon is the only multi-prefix TCG (per-language). Others are 1:1.
    tcg_id_prefixes = None
    if args.tcg:
        tcg = args.tcg.lower().strip()
        # Prefix map covers BOTH sealed product (sealed-{tcg}-) AND
        # PriceCharting-sourced singles ({tcg}-pc-) for Gundam/DBZ.
        # Earlier TCGs (Pokemon EN/JP, MTG, YGO, OP) have their singles
        # mirrored via pokedata_sync's --mirror-images flow so they're
        # not duplicated here.
        prefix_map = {
            "pokemon":   ["sealed-en-", "sealed-jp-", "sealed-kr-", "sealed-cn-",
                          "sealed-de-", "sealed-fr-", "sealed-it-", "sealed-es-",
                          "sealed-pt-", "sealed-nl-", "sealed-ru-",
                          # CN/KR singles from PC
                          "cn-pc-", "kr-pc-"],
            "magic":     ["sealed-mtg-"],
            "mtg":       ["sealed-mtg-"],
            "yugioh":    ["sealed-ygo-"],
            "ygo":       ["sealed-ygo-"],
            "onepiece":  ["sealed-op-"],
            "op":        ["sealed-op-"],
            "gundam":    ["sealed-gun-", "gun-pc-"],
            "dbz":       ["sealed-dbz-", "dbz-pc-"],
            # Vintage Topps Pokemon — distinct game_type ('pokemon_topps')
            # so frontend can silo, but mirror still by id prefix.
            "pokemon_topps": ["sealed-topps-", "topps-pc-"],
            "topps":         ["sealed-topps-", "topps-pc-"],   # alias
        }
        tcg_id_prefixes = prefix_map.get(tcg)
        if not tcg_id_prefixes:
            sys.exit(f"  Unknown --tcg '{args.tcg}'. Known: {sorted(prefix_map)}")
        print(f"  Scoping mirror to --tcg '{args.tcg}' (id prefixes: {tcg_id_prefixes})")

    # Fetch ALL catalog rows whose image_url is still on PriceCharting's CDN.
    # `pricecharting` in URL covers both googleapis.com hosts (with hash IDs)
    # AND any direct pricecharting.com URLs (e.g. no-image-available.png).
    # Includes BOTH sealed (product_type<>single) AND singles — Chinese
    # and Korean Pokemon singles also live on PriceCharting and need
    # the same mirror treatment.
    print("\n  Loading catalog rows that still have off-Supabase images…")
    rows = []
    page = 0
    PAGE_SIZE = 1000
    # Build PostgREST `or` filter for tcg id-prefix scoping. Format:
    # or=(id.like.sealed-mtg-*,id.like.sealed-en-*) — single param, no
    # spaces. Empty if --tcg not set.
    or_filter = None
    if tcg_id_prefixes:
        or_filter = "(" + ",".join(f"id.like.{p}*" for p in tcg_id_prefixes) + ")"
    while True:
        params = {
            "select": "id,image_url,set_code,pricecharting_id,product_type",
            "image_url": "ilike.*pricecharting*",
            "limit":   str(PAGE_SIZE),
            "offset":  str(page * PAGE_SIZE),
        }
        if or_filter:
            params["or"] = or_filter
        chunk = pg_get("catalog", params=params)
        rows.extend(chunk)
        if len(chunk) < PAGE_SIZE:
            break
        page += 1

    if args.limit:
        rows = rows[:args.limit]
    print(f"  {len(rows):,} sealed images to mirror.")
    if not rows:
        print("  Nothing to do — all sealed images already mirrored.")
        return

    # Estimate: avg ~30KB per WebP, ~150ms/img sequential, ~30ms/img with workers
    est_mb = len(rows) * 30 / 1024
    est_sec = len(rows) * (1.0 / args.workers)
    print(f"  Estimated transfer: ~{est_mb:.0f} MB")
    print(f"  Estimated time:     ~{est_sec/60:.1f} min with {args.workers} workers")

    if args.dry_run:
        print("\n  --dry-run — first 5 target paths:")
        for r in rows[:5]:
            lang = (r["id"].split("-") + [""])[1] if r["id"].startswith("sealed-") else "en"
            sc = (r.get("set_code") or "unknown").lower()
            pid = r.get("pricecharting_id") or r["id"].rsplit("-", 1)[-1]
            path = f"sealed/{lang}/{sc}/{pid}.webp"
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
        is_sealed = (row.get("product_type") or "single") != "single"

        # Derive language from id prefix:
        #   sealed-en-… / sealed-jp-… → take 2nd segment
        #   en-pc-… / cn-pc-… / kr-pc-… (singles) → take 1st segment
        parts = rid.split("-")
        if parts and parts[0] == "sealed" and len(parts) >= 3:
            lang = parts[1]
        elif parts and parts[0] in ("en", "jp", "cn", "kr", "de", "fr",
                                    "it", "es", "pt", "nl", "ru",
                                    "mtg", "ygo", "op"):
            lang = parts[0]
        else:
            lang = "en"

        if not src:
            return (rid, "skipped", "no image_url")
        # PriceCharting's "no image available" placeholder — skip cleanly.
        if "no-image-available" in src:
            return (rid, "skipped", "placeholder image")

        # Storage path branch:
        #   sealed:  card-images/sealed/{lang}/{set_code}/{pc_id}.webp
        #   singles: card-images/{lang}/{set_code}/{pc_id}.webp
        # Matches pokedata_sync's existing per-language path for cards,
        # and keeps sealed under its own subtree.
        path = (f"sealed/{lang}/{sc}/{pid}.webp"
                if is_sealed
                else f"{lang}/{sc}/{pid}.webp")

        # 1. Download (falling back through PriceCharting's available
        #    size variants until one returns 200)
        try:
            raw, size_got = download_image(src)
        except Exception as e:
            return (rid, "failed", f"download: {e}")

        # 2. Convert to WebP
        try:
            webp_bytes = convert_to_webp(raw)
        except Exception as e:
            return (rid, "failed", f"convert: {e}")

        # 3. Upload to Supabase Storage (upsert=true so re-runs overwrite)
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

        # 4. Rewrite the catalog row's image_url to the new public URL
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
                elif n % 20 == 0 or n == len(rows):
                    print(f"  [{n:>4}/{len(rows)}] "
                          f"mirrored={stats['mirrored']} "
                          f"skipped={stats['skipped']} "
                          f"failed={stats['failed']}")

    print(f"\n  Done. mirrored={stats['mirrored']} "
          f"skipped={stats['skipped']} failed={stats['failed']}")


if __name__ == "__main__":
    main()
