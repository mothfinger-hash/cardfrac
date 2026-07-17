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
    "magic":         (1,  "mtg"),
    "yugioh":        (2,  "ygo"),
    "pokemon":       (3,  "en"),
    # TCGplayer's "Pokemon Japan" is a SEPARATE category (85) from English
    # Pokemon (3). Our JP sealed rows (id prefix sealed-jp-*) are PriceCharting-
    # sourced white-bg photos that were background-removed in place — this maps
    # them to their clean 1000x1000 shots in the JP category. seg 'jp' both
    # scopes the catalog query to sealed-jp-* AND lifts the *japanese*
    # set_name exclusion below (which exists only to stop English art landing
    # on JP products — moot when the art itself comes from the JP category).
    # Korean/Chinese (sealed-kr-*/sealed-cn-*) are NOT here: TCGplayer has no
    # KR/CN Pokemon sealed category, so those stay uncovered.
    "pokemon_japan": (85, "jp"),
    "onepiece":      (68, "op"),
    "lorcana":       (71, "lor"),
    "gundam":        (86, "gun"),
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

def _san(s):
    """Strip PostgREST .or() structural chars (commas/parens) and ilike
    wildcards so an interpolated group name can't break the clause. Keep
    apostrophes — they're literal in ilike and appear in real set names."""
    return _re.sub(r"[,()*%]", " ", s or "").strip()

# Generic sealed-deck product names our catalog uses (from PriceCharting) that
# carry no set identity — TCGplayer names the same product 'Starter Deck N:
# Name', so match these against the GROUP name instead of the product name.
_GENERIC_DECK = {"sealed deck", "sealed starter deck"}
def _is_generic_deck(name):
    return norm(name) in _GENERIC_DECK

def is_card_product(p):
    """TCGCSV cards carry a 'Number' extendedData field; sealed products don't.
    Also skip digital 'Code Card' products: they're online redemption codes, not
    sealed product, yet their names embed the container ('Code Card - <set>
    Pokemon Center Elite Trainer Box') so they'd otherwise mis-match our real
    ETB/box rows and stamp a code-card thumbnail onto them."""
    if str(p.get("name") or "").strip().lower().startswith("code card"):
        return True
    for ed in p.get("extendedData", []):
        if ed.get("name") == "Number":
            return True
    return False

def upgrade_image(url):
    """TCGplayer thumb -> 1000x1000."""
    if not url:
        return url
    return _re.sub(r"_(200w|in_\d+x\d+)\.", "_in_1000x1000.", url) if "_" in url else url


# Bandai/TCGplayer set codes live in the group 'abbreviation' (OP01, EB-03,
# ST-06, ...). Our catalog set_names use the CODE ('One Piece OP01') OR the
# NAME ('One Piece Paramount War'), so we match on either. Skip promo/event
# sub-groups (Pre-Release / Release Event / Anniversary) — their shared code
# would otherwise steal rows from the main set.
_CODE_RE   = _re.compile(r"(OP\d{2}|EB-?\d{2}|ST-?\d{2}|SD-?\d{2}|PRB-?\d{2}|LT-?\d{2})", _re.I)
_SUFFIX_RE = _re.compile(r"\b(PRE|RE|ANN|DD|PROMO|CS|WS|TR)\b", _re.I)
def _group_code(abbr):
    abbr = abbr or ""
    if _SUFFIX_RE.search(abbr):
        return ""
    m = _CODE_RE.search(abbr.replace(" ", ""))
    return m.group(1).upper().replace("-", "") if m else ""


def group_index(category_id):
    """Return (names, codes): {groupId: set_name}, {groupId: set_code|''}."""
    data = tcg_get(f"/tcgplayer/{category_id}/groups")
    names, codes = {}, {}
    for g in data.get("results", data if isinstance(data, list) else []):
        gid = g.get("groupId")
        names[gid] = g.get("name") or ""
        codes[gid] = _group_code(g.get("abbreviation"))
    return names, codes


def sealed_products(category_id, group_id, group_name):
    """Return [(remainder_name, productId, imageUrl, full_name)] for sealed rows.
    remainder = product name with the set/brand prefix stripped, for matching
    against our short PC names ('Booster Box')."""
    data = tcg_get(f"/tcgplayer/{category_id}/{group_id}/products")
    prods = data.get("results", data if isinstance(data, list) else [])
    gn = norm(group_name)
    # tcgcsv group names may carry a 'CODE: ' prefix (Pokemon Japan:
    # 'S4a: Shiny Star V') that never appears in the product names, so also try
    # the core name with the prefix stripped — otherwise 'Shiny Star V Booster
    # Box' never reduces to 'Booster Box' and can't match our short PC name.
    gn_core = norm(_re.sub(r"^[^:]{1,10}:\s*", "", group_name))
    out = []
    for p in prods:
        if is_card_product(p):
            continue
        full = p.get("name") or ""
        nfull = norm(full)
        # strip everything up to & including the group name (full, then core)
        rem = nfull
        for _g in (gn, gn_core):
            idx = nfull.find(_g) if _g else -1
            if _g and idx != -1:
                rem = nfull[idx + len(_g):].strip()
                break
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


# Container / format tokens. A Booster BOX and a Booster PACK are different
# products at very different prices, yet 'booster box' vs 'booster pack' scores
# ~0.70 — above threshold. Never let a row take a photo whose container type
# conflicts (box<->pack<->tin<->deck...). Only rejects when BOTH names name a
# container and the sets are disjoint; identical-container matches ('booster
# box' -> 'booster box') and no-container matches are unaffected.
_CONTAINERS = {"box", "pack", "case", "tin", "display", "blister", "deck", "bundle"}
def _container_conflict(a, b):
    ca = _CONTAINERS & set(a.split())
    cb = _CONTAINERS & set(b.split())
    return bool(ca and cb and not (ca & cb))


def best_match(our_name, tcg_list, min_ratio):
    target = norm(our_name)
    best, best_r = None, 0.0
    for rem, pid, img, full in tcg_list:
        if _container_conflict(target, rem):
            continue
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
                         "category. Idempotent: a row already pointing at its computed TCGplayer "
                         "dest URL is skipped. ALWAYS --dry-run this first; it can touch a lot of sets.")
    ap.add_argument("--replace-hosted", action="store_true",
                    help="Also re-photo sealed rows whose image is ALREADY self-hosted on our "
                         "Supabase storage (or any non-PriceCharting source), not just the "
                         "PriceCharting-sourced ones. Use this to swap self-hosted sealed art for "
                         "TCGplayer's. Rows already pointing at their TCGplayer dest URL are "
                         "skipped, so it stays re-runnable. --dry-run first.")
    ap.add_argument("--min-ratio", type=float, default=0.66,
                    help="Fuzzy name-match threshold (default 0.66). Token-aware scoring means "
                         "true word-order variants score ~1.0; 0.66 filters weak/ambiguous "
                         "matches like 'Bundle Box' vs 'Bundle Case'. Lower to catch more, "
                         "raise to be stricter.")
    ap.add_argument("--dry-run", action="store_true", help="Show matches; download/upload/write nothing.")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--log-unmatched", default=None, metavar="PATH",
                    help="Write a JSON audit of what this run couldn't handle: OUR sealed rows that "
                         "found no TCGplayer match (fix name / manual-match later) AND TCGplayer "
                         "sealed products no row of ours matched (missing-product candidates for a "
                         "future insert-missing importer). Populated even on --dry-run.")
    args = ap.parse_args()
    if not args.group and not args.all:
        ap.error("pass --group <ids> or --all")

    cat, seg = GAME[args.game]
    gidx, gcodes = group_index(cat)
    groups = sorted(gidx.keys()) if args.all else [int(g) for g in args.group.split(",") if g.strip()]

    plan = []   # (our_row, tcg_match)
    unmatched = []          # OUR sealed rows that matched nothing (audit)
    tcg_missing = []        # TCGplayer products no row matched = missing candidates
    already = 0   # rows already sitting on their computed TCGplayer dest URL
    for gid in groups:
        gname = gidx.get(gid, "")
        if not gname:
            print(f"  ! group {gid} not found in category {cat}; skipping"); continue
        gcode = gcodes.get(gid, "")
        tcg_list = sealed_products(cat, gid, gname)
        # Our sealed rows for this set. Scope by group NAME or set CODE (our
        # catalog uses both — 'One Piece Paramount War' vs 'One Piece OP01').
        # Exclude Japanese rows: this TCGplayer category is English, and we must
        # never stamp English art onto a Japanese product. By default only
        # PriceCharting-sourced rows; with --replace-hosted, any source.
        _or_terms = [f"set_name.ilike.*{_san(gname)}*"]
        # tcgcsv group names are often 'CODE: Name' — especially Pokemon Japan
        # ('S4a: Shiny Star V', 'SM3+: Shining Legends') — while our set_name is
        # 'Pokemon Japanese Shiny Star V'. The code prefix breaks the ilike, so
        # also scope by the core name with any leading 'CODE: ' stripped.
        _core = _re.sub(r"^[^:]{1,10}:\s*", "", gname).strip()
        if _core and _core != gname:
            _or_terms.append(f"set_name.ilike.*{_san(_core)}*")
        if gcode:
            _or_terms.append(f"set_name.ilike.*{gcode}*")
        _params = {
            "select": "id,name,set_code,set_name,image_url",
            "id": f"like.sealed-{seg}-*",
            "or": "(" + ",".join(_or_terms) + ")",
        }
        # English categories must never stamp English art onto a Japanese
        # product, so English runs exclude *japanese* set_names. The Pokemon
        # Japan category (seg 'jp') is the exception — there we WANT the
        # Japanese products and the art comes from the JP category itself.
        if seg != "jp":
            _params["set_name"] = "not.ilike.*japanese*"
        if not args.replace_hosted:
            _params["image_url"] = "ilike.*pricecharting*"
        rows = pg_get("catalog", params=_params)
        print(f"\n  {args.game} group {gid} '{gname}'{(' [' + gcode + ']') if gcode else ''}: "
              f"{len(tcg_list)} TCGplayer sealed, {len(rows)} sealed rows to consider")
        _matched_pids = set()
        for row in rows:
            our_name = row.get("name") or ""
            # A generic 'Sealed Deck' can't match TCGplayer's 'Starter Deck N:
            # Name' by product name — the deck IS the set, so match the GROUP
            # name instead.
            target = gname if _is_generic_deck(our_name) else our_name
            match, r = best_match(target, tcg_list, args.min_ratio)
            if not match:
                unmatched.append({"game": args.game, "group_id": gid, "group_name": gname,
                                  "code": gcode, "id": row.get("id"), "name": our_name,
                                  "set_name": row.get("set_name"), "best_ratio": round(r, 3)})
                print(f"    ----   {our_name!r:38} -> no match >= {args.min_ratio} (best r={r:.2f})")
                continue
            _matched_pids.add(match[1])
            # Skip a row already pointing at the dest URL it would be given —
            # keeps --replace-hosted re-runnable. In default mode a PriceCharting
            # url never equals dest, so nothing is spuriously skipped.
            pid = match[1]
            sc = (row.get("set_code") or "unknown").lower()
            dest_url = f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/sealed/{seg}/{sc}/{pid}.webp"
            if (row.get("image_url") or "") == dest_url:
                already += 1
                continue
            plan.append((row, match))
            print(f"    MATCH  {our_name!r:38} -> {match[3]!r}  (r={r:.2f}, pid={match[1]})")

        # TCGplayer sealed in this group that NO row of ours matched — missing-
        # product candidates (also catches junk like promo singles; review before
        # importing). Only meaningful in --replace-hosted (full row coverage).
        for _rem, _pid, _img, _full in tcg_list:
            if _pid not in _matched_pids:
                tcg_missing.append({"game": args.game, "group_id": gid, "group_name": gname,
                                    "code": gcode, "tcg_name": _full, "tcg_pid": _pid})

    print(f"\n  {len(plan)} to replace, {already} already on TCGplayer, {len(unmatched)} unmatched.")
    if args.log_unmatched:
        with open(args.log_unmatched, "w", encoding="utf-8") as _f:
            json.dump({"game": args.game, "our_unmatched": unmatched,
                       "tcg_missing_candidates": tcg_missing}, _f, indent=2, ensure_ascii=False)
        print(f"  Logged {len(unmatched)} unmatched + {len(tcg_missing)} missing candidates -> {args.log_unmatched}")
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
