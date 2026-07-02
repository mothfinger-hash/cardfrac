#!/usr/bin/env python3
"""
PathBinder — TCGplayer-CDN Image Mirror (non-Pokemon singles)
=============================================================
Sibling to mirror_singles_images.py. That script mirrors PriceCharting-
sourced Pokemon singles ({lang}-pc-* ids); THIS one mirrors singles whose
image_url points at TCGplayer's CDN — i.e. the rows created by
import_tcgcsv_set.py for Magic / Yu-Gi-Oh / One Piece / Gundam / Lorcana.

Walks catalog SINGLES (product_type in single/tcg_single) whose image_url
still points at tcgplayer-cdn.tcgplayer.com, downloads each, converts to
WebP, uploads to Supabase Storage, generates 200/400px WebP variants, and
rewrites image_url to the local URL.

STORAGE LAYOUT (mirrors the Pokemon script's {lang}/{set}/ shape, using the
catalog id prefix — mtg / ygo / op / gun / lor — as the top segment):

    card-images/mtg/msh/668454.webp        # main
    card-images/mtg/msh/668454-200.webp    # 200px wide
    card-images/mtg/msh/668454-400.webp    # 400px wide

PREREQUISITES:
    pip3 install requests pillow supabase --break-system-packages

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key

USAGE:
    # Dry-run — list target rows + first 5 paths (no download/upload)
    python3 mirror_tcgplayer_images.py --set-code MSH --dry-run

    # Mirror one set
    python3 mirror_tcgplayer_images.py --set-code MSH

    # Mirror several sets in one run
    python3 mirror_tcgplayer_images.py --set-code MSH,BLGG,EB01,ST10

    # Mirror every not-yet-mirrored TCGplayer single (any game)
    python3 mirror_tcgplayer_images.py --all

    # Scope to one game + crank workers
    python3 mirror_tcgplayer_images.py --all --game magic --workers 8
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

# Same variant helper the Pokemon mirror uses — 200/400px WebP siblings.
from image_variants import upload_variants


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

STORAGE_BUCKET = "card-images"
REQUEST_TIMEOUT = 20
TCG_CDN_HOST = "tcgplayer-cdn.tcgplayer.com"
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


_SUFFIX_RE = _re.compile(r'_(in_\d+x\d+|\d+w)\.(jpg|jpeg|png|webp)$', _re.IGNORECASE)

def download_image(url):
    """TCGplayer CDN is a direct URL. Try the stored (1000x1000) URL first,
    then fall back to the 200w thumbnail, then the bare product image, until
    one returns 200."""
    m = _SUFFIX_RE.search(url)
    ext = m.group(2) if m else "jpg"
    base = _SUFFIX_RE.sub('', url)  # strip any _in_WxH / _NNNw suffix
    candidates = [url, f"{base}_in_1000x1000.{ext}", f"{base}_200w.{ext}", f"{base}.{ext}"]
    seen, last_err = set(), None
    for cand in candidates:
        if cand in seen:
            continue
        seen.add(cand)
        try:
            r = _session.get(cand, timeout=REQUEST_TIMEOUT)
            if r.status_code == 200 and r.content:
                return r.content
            last_err = f"HTTP {r.status_code}"
        except Exception as e:
            last_err = str(e)
    raise RuntimeError(f"no TCGplayer variant worked for {url} — last error: {last_err}")


def convert_to_webp(raw_bytes, quality=82):
    im = Image.open(io.BytesIO(raw_bytes))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if im.mode in ("LA", "P") else "RGB")
    out = io.BytesIO()
    im.save(out, format="WEBP", quality=quality, method=6)
    return out.getvalue()


def _target_path(row):
    """card-images/{prefix}/{set_code}/{productid}.webp — prefix is the id's
    leading segment (mtg/ygo/op/gun/lor), matching the {lang}/ shape used by
    the Pokemon mirror."""
    rid = row["id"]
    prefix = rid.split("-", 1)[0] or "misc"
    sc = (row.get("set_code") or "unknown").lower()
    pid = row.get("tcgplayer_product_id") or rid.rsplit("-", 1)[-1]
    return f"{prefix}/{sc}/{pid}.webp"


def load_rows(set_codes, game, limit):
    """Catalog singles still pointing at the TCGplayer CDN."""
    rows, PAGE_SIZE = [], 1000
    base_params = {
        "select":       "id,image_url,set_code,tcgplayer_product_id,game_type",
        "product_type": "in.(single,tcg_single)",
        "image_url":    f"ilike.*{TCG_CDN_HOST}*",
    }
    if game:
        base_params["game_type"] = f"eq.{game}"

    # If specific set codes were given, pull per-code (keeps each query small
    # and the PostgREST filter simple); otherwise paginate the whole match.
    code_batches = [ [c] for c in set_codes ] if set_codes else [ None ]
    for batch in code_batches:
        page = 0
        while True:
            params = dict(base_params, limit=str(PAGE_SIZE), offset=str(page * PAGE_SIZE))
            if batch:
                params["set_code"] = f"eq.{batch[0]}"
            chunk = pg_get("catalog", params=params)
            rows.extend(chunk)
            if len(chunk) < PAGE_SIZE:
                break
            page += 1
    if limit:
        rows = rows[:limit]
    return rows


def main():
    ap = argparse.ArgumentParser(description="Mirror TCGplayer-CDN single images to Supabase Storage as WebP.")
    ap.add_argument("--set-code", default="", help="Comma-separated set_code(s) to mirror, e.g. MSH,BLGG,EB01,ST10.")
    ap.add_argument("--all", action="store_true", help="Mirror every not-yet-mirrored TCGplayer single (ignores --set-code).")
    ap.add_argument("--game", default="", help="Optional game_type filter (magic/yugioh/onepiece/gundam/lorcana).")
    ap.add_argument("--dry-run", action="store_true", help="List targets + first 5 paths; download/upload nothing.")
    ap.add_argument("--limit", type=int, default=0, help="Stop after N rows (debugging).")
    ap.add_argument("--workers", type=int, default=5, help="Parallel download/upload workers (default 5).")
    args = ap.parse_args()

    set_codes = [c.strip() for c in args.set_code.split(",") if c.strip()]
    if not set_codes and not args.all:
        sys.exit("Pass --set-code MSH[,BLGG,…] or --all.")
    if args.all:
        set_codes = []  # whole-match mode

    print("\n  Loading TCGplayer-CDN singles to mirror…")
    rows = load_rows(set_codes, args.game.strip(), args.limit)
    print(f"  {len(rows):,} singles to mirror"
          + (f" (sets: {', '.join(set_codes)})" if set_codes else " (all sets)")
          + (f" [game={args.game}]" if args.game else "") + ".")
    if not rows:
        print("  Nothing to do — matching singles are already mirrored (or none found).")
        return

    est_mb = len(rows) * 45 / 1024  # 1000x1000 source ~ larger than PC thumbs
    print(f"  Estimated download: ~{est_mb:.0f} MB")

    if args.dry_run:
        print("\n  --dry-run — first 5 target paths:")
        for r in rows[:5]:
            print(f"     {r['id']:<28}  {(r.get('image_url') or '')[:58]}…  →  {_target_path(r)}")
        return

    print("\n  Starting in 3s — Ctrl+C to abort\n")
    time.sleep(3)

    _lock = threading.Lock()
    stats = {"mirrored": 0, "failed": 0, "skipped": 0, "completed": 0}

    def mirror_one(row):
        rid = row["id"]
        src = row.get("image_url") or ""
        if not src:
            return (rid, "skipped", "no image_url")
        if TCG_CDN_HOST not in src:
            return (rid, "skipped", "already mirrored / not tcgplayer")

        path = _target_path(row)

        try:
            raw = download_image(src)
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

        # 200/400px WebP siblings — non-fatal (browser onerror falls back).
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
