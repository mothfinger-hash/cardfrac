#!/usr/bin/env python3
"""
PathBinder — Sealed Image Upgrade from TCGplayer
================================================
Our sealed rows come from PriceCharting (sync_sealed_products.py), so their
images are PC's eBay-style photos — white corners, 480px, inconsistent.
TCGplayer hosts clean 1000x1000 product shots for the SAME sealed products
(they're the "sealed-skipped" rows from import_tcgcsv_set.py).

This script, per TCGplayer group (set):
  1. Fetches the group's SEALED products from TCGCSV (name + productId + image).
  2. Loads our PC-sourced sealed catalog rows for that set (matched by set_name).
  3. Fuzzy-matches each catalog row to a TCGplayer product by name.
  4. Downloads the TCGplayer image (upgraded to 1000x1000), converts to WebP,
     uploads to Supabase Storage with 200/400 variants, and rewrites image_url.
  5. Also stamps the sealed row's tcgplayer_product_id + tcgplayer_url (so the
     app's affiliate wrapper monetizes sealed links too, and future re-mirrors
     don't need to re-match).

PriceCharting stays the PRICE source (price_source_url is untouched); only the
IMAGE is upgraded.

STORAGE LAYOUT:
    card-images/sealed/{seg}/{set_code}/{tcgplayer_product_id}.webp
        e.g. card-images/sealed/lor/wilds-unknown/678165.webp

PREREQUISITES:
    pip3 install requests pillow supabase --break-system-packages
ENVIRONMENT:
    SUPABASE_URL, SUPABASE_SERVICE_KEY

USAGE:
    # Dry-run — show matches for one set (no download/upload/write)
    python3 mirror_sealed_from_tcgplayer.py --group 24553 --game magic --dry-run

    # One set, live
    python3 mirror_sealed_from_tcgplayer.py --group 24553 --game magic

    # Several groups (same game) in one run
    python3 mirror_sealed_from_tcgplayer.py --group 24693,24692 --game gundam

    # Loosen/tighten the fuzzy match threshold (default 0.62)
    python3 mirror_sealed_from_tcgplayer.py --group 24617 --game lorcana --min-ratio 0.7
"""

import os, sys, io, time, json, argparse, threading
import re as _re
from difflib import SequenceMatcher
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

from image_variants import upload_variants

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

STORAGE_BUCKET = "card-images"
TCGCSV_BASE = "https://tcgcsv.com"
UA = "PathBinderSync/1.0 (+https://pathbinder.gg)"

# game_type -> (TCGplayer categoryId, catalog id segment used by sealed rows)
GAME = {
    "magic":    (1,  "mtg"),
    "yugioh":   (2,  "ygo"),
    "pokemon":  (3,  "en"),
    "onepiece": (68, "op"),
    "lorcana":  (71, "lor"),
    "gundam":   (86, "gun"),
}

_tcg = requests.Session(); _tcg.headers.update({"User-Agent": UA, "Accept": "application/json"})
_img = requests.Session(); _img.headers.update({"User-Agent": UA})
sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def tcg_get(path):
    time.sleep(0.4)
    r = _tcg.get(f"{TCGCSV_BASE}{path}", timeout=60); r.raise_for_status(); return r.json()


def pg_get(path, params=None):
    r = requests.get(f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}", headers={
        "apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Accept": "application/json",
    }, params=params, timeout=30)
    r.raise_for_status(); return r.json()


def pg_patch(row_id, payload):
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{requests.utils.quote(row_id)}"
    r = requests.patch(url, headers={
        "apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json; charset=utf-8", "Prefer": "return=minimal",
    }, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout=30)
    if not r.ok:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")


_PUNCT = _re.compile(r"[^a-z0-9]+")
def norm(s):
    return _PUNCT.sub(" ", (s or "").lower()).strip()

def is_card_product(p):
    """TCGCSV cards carry a 'Number' extendedData field; sealed products don't."""
    for ed in p.get("extendedData", []):
        if ed.get("name") == "Number":
            return True
    return False

def upgrade_image(url):
    """TCGplayer thumb -> 1000x1000."""
    if not url:
        return url
    return _re.sub(r"_(200w|in_\d+x\d+)\.", "_in_1000x1000.", url) if "_" in url else url


def group_index(category_id):
    data = tcg_get(f"/tcgplayer/{category_id}/groups")
    out = {}
    for g in data.get("results", data if isinstance(data, list) else []):
        out[g.get("groupId")] = g.get("name") or ""
    return out


def sealed_products(category_id, group_id, group_name):
    """Return [(remainder_name, productId, imageUrl, full_name)] for sealed rows.
    remainder = product name with the set/brand prefix stripped, for matching
    against our short PC names ('Booster Box')."""
    data = tcg_get(f"/tcgplayer/{category_id}/{group_id}/products")
    prods = data.get("results", data if isinstance(data, list) else [])
    gn = norm(group_name)
    out = []
    for p in prods:
        if is_card_product(p):
            continue
        full = p.get("name") or ""
        nfull = norm(full)
        # strip everything up to & including the group name if present
        rem = nfull
        idx = nfull.find(gn)
        if gn and idx != -1:
            rem = nfull[idx + len(gn):].strip()
        rem = rem or nfull
        out.append((rem, p.get("productId"), p.get("imageUrl"), full))
    return out


def _score(a, b):
    """Blend of raw, token-sort, and token-set (Dice) similarity so word-order
    and subset differences still match, e.g. PC 'Booster Pack - Collector' vs
    TCGplayer 'Collector Booster Pack' (both normalize to the same token set)."""
    ra = SequenceMatcher(None, a, b).ratio()
    ta, tb = a.split(), b.split()
    rs = SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio()
    sa, sb = set(ta), set(tb)
    dice = (2 * len(sa & sb) / (len(sa) + len(sb))) if (sa and sb) else 0.0
    return max(ra, rs, dice)


def best_match(our_name, tcg_list, min_ratio):
    target = norm(our_name)
    best, best_r = None, 0.0
    for rem, pid, img, full in tcg_list:
        r = _score(target, rem)
        if r > best_r:
            best, best_r = (rem, pid, img, full), r
    if best and best_r >= min_ratio:
        return best, best_r
    return None, best_r


def convert_to_webp(raw, quality=82):
    im = Image.open(io.BytesIO(raw))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if im.mode in ("LA", "P") else "RGB")
    out = io.BytesIO(); im.save(out, format="WEBP", quality=quality, method=6)
    return out.getvalue()


def download(url):
    for cand in (upgrade_image(url), url):
        try:
            r = _img.get(cand, timeout=25)
            if r.status_code == 200 and r.content:
                return r.content
        except Exception:
            pass
    raise RuntimeError(f"download failed for {url}")


def main():
    ap = argparse.ArgumentParser(description="Upgrade sealed images from PriceCharting to TCGplayer.")
    ap.add_argument("--group", default=None, help="TCGplayer groupId(s), comma-separated. Omit when using --all.")
    ap.add_argument("--game", required=True, choices=sorted(GAME), help="game_type of the group(s).")
    ap.add_argument("--all", action="store_true",
                    help="Upgrade EVERY set for this game — iterates all TCGplayer groups in the "
                         "category. Idempotent: rows already on a TCGplayer image are skipped "
                         "(the catalog query only matches PriceCharting image_urls). ALWAYS "
                         "--dry-run this first; it can touch a lot of sets.")
    ap.add_argument("--min-ratio", type=float, default=0.66,
                    help="Fuzzy name-match threshold (default 0.66). Token-aware scoring means "
                         "true word-order variants score ~1.0; 0.66 filters weak/ambiguous "
                         "matches like 'Bundle Box' vs 'Bundle Case'. Lower to catch more, "
                         "raise to be stricter.")
    ap.add_argument("--dry-run", action="store_true", help="Show matches; download/upload/write nothing.")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    if not args.group and not args.all:
        ap.error("pass --group <ids> or --all")

    cat, seg = GAME[args.game]
    gidx = group_index(cat)
    groups = sorted(gidx.keys()) if args.all else [int(g) for g in args.group.split(",") if g.strip()]

    plan = []   # (our_row, tcg_match)
    unmatched = []
    for gid in groups:
        gname = gidx.get(gid, "")
        if not gname:
            print(f"  ! group {gid} not found in category {cat}; skipping"); continue
        tcg_list = sealed_products(cat, gid, gname)
        # Our PC sealed rows for this set, still on PriceCharting's CDN.
        rows = pg_get("catalog", params={
            "select": "id,name,set_code,set_name,image_url",
            "id": f"like.sealed-{seg}-*",
            "set_name": f"ilike.*{gname}*",
            "image_url": "ilike.*pricecharting*",
        })
        print(f"\n  {args.game} group {gid} '{gname}': "
              f"{len(tcg_list)} TCGplayer sealed, {len(rows)} PC sealed rows to upgrade")
        for row in rows:
            match, r = best_match(row.get("name") or "", tcg_list, args.min_ratio)
            if match:
                plan.append((row, match))
                print(f"    MATCH  {row['name']!r:38} -> {match[3]!r}  (r={r:.2f}, pid={match[1]})")
            else:
                unmatched.append(row)
                print(f"    ----   {row['name']!r:38} -> no match >= {args.min_ratio} (best r={r:.2f})")

    print(f"\n  {len(plan)} matched, {len(unmatched)} unmatched.")
    if args.dry_run:
        print("  --dry-run — nothing written. Re-run without --dry-run to upgrade.")
        return
    if not plan:
        print("  Nothing to do."); return

    print("\n  Starting in 3s — Ctrl+C to abort\n"); time.sleep(3)
    _lock = threading.Lock()
    stats = {"done": 0, "failed": 0, "completed": 0}

    def one(item):
        row, match = item
        rid = row["id"]
        _rem, pid, img, _full = match
        sc = (row.get("set_code") or "unknown").lower()
        path = f"sealed/{seg}/{sc}/{pid}.webp"
        try:
            raw = download(img)
            webp = convert_to_webp(raw)
        except Exception as e:
            return (rid, "failed", f"image: {e}")
        last = None
        for attempt in range(3):
            try:
                sb.storage.from_(STORAGE_BUCKET).upload(
                    path, webp, file_options={"content-type": "image/webp", "upsert": "true"})
                last = None; break
            except Exception as e:
                last = e; time.sleep(2 * (attempt + 1))
        if last:
            return (rid, "failed", f"upload: {last}")
        try:
            for vw, ok, detail in upload_variants(sb, STORAGE_BUCKET, path, webp):
                if not ok and "not wider than" not in str(detail):
                    print(f"     [variant {vw}px] {rid}: {detail}")
        except Exception as e:
            print(f"     [variants] {rid}: {e}")
        new_url = f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{path}"
        try:
            pg_patch(rid, {
                "image_url": new_url,
                "tcgplayer_product_id": pid,
                "tcgplayer_url": f"https://www.tcgplayer.com/product/{pid}",
            })
        except Exception as e:
            return (rid, "failed", f"db: {e}")
        return (rid, "done", new_url)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(one, it): it for it in plan}
        for f in as_completed(futs):
            rid, status, detail = f.result()
            with _lock:
                stats[status] = stats.get(status, 0) + 1
                stats["completed"] += 1
                n = stats["completed"]
                if status == "failed":
                    print(f"  [{n:>3}/{len(plan)}] FAIL {rid} — {detail}")
                elif n % 20 == 0 or n == len(plan):
                    print(f"  [{n:>3}/{len(plan)}] done={stats['done']} failed={stats['failed']}")

    print(f"\n  Done. upgraded={stats['done']} failed={stats['failed']} unmatched={len(unmatched)}")


if __name__ == "__main__":
    main()
