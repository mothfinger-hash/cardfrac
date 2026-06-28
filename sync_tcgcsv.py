#!/usr/bin/env python3
"""
PathBinder — TCGCSV sync (Phase 1: product IDs + URLs, no prices)
=================================================================
Ingests TCGplayer product linkage from tcgcsv.com (a once-daily,
server-side cache of TCGplayer's own API — no Partner API approval
needed). Phase 1 backfills two things and writes NO prices:

    catalog.tcgplayer_product_id   stable TCGplayer PK
    catalog.tcgplayer_url          canonical product page URL

…plus it maintains a persisted set-map so we never re-fuzzy groups:

    tcgplayer_group_map            TCGCSV group (set) -> catalog set_code

Pricing (card_prices: source='tcgplayer' / 'tcgplayer_reverse_holo' /
sealed) lands in a later phase. This script intentionally does not
touch card_prices.

HOW MATCHING WORKS
------------------
1. Category  -> game_type   (resolved by name from /tcgplayer/categories
                             against CATEGORY_MATCHERS below).
2. Group     -> set_code    (fuzzy match group name to catalog set_name
                             within the game; cached in tcgplayer_group_map
                             so later runs skip the fuzzing).
3. Product   -> catalog row (set_code + normalized card number, name as a
                             tiebreaker). Sealed products — those with no
                             Number/Rarity in extendedData — are skipped in
                             Phase 1.

ETIQUETTE (per tcgcsv.com/docs — respected here)
------------------------------------------------
  * Checks last-updated.txt first; no-ops if nothing rebuilt since the
    last successful run (override with --force).
  * Custom User-Agent (USER_AGENT below).
  * 100ms sleep between TCGCSV requests.
  * A full run is a few hundred requests for our games — well under the
    10,000/24h ceiling.

PREREQUISITES
-------------
    pip3 install requests --break-system-packages
    Run migration_tcgcsv_phase1.sql first (adds the columns + group map).

USAGE
-----
    # All configured games
    python3 sync_tcgcsv.py --tcg all

    # One game
    python3 sync_tcgcsv.py --tcg pokemon

    # Dry run — match + report, no DB writes
    python3 sync_tcgcsv.py --tcg pokemon --dry-run

    # Only (re)build the group map, skip product backfill
    python3 sync_tcgcsv.py --tcg all --groups-only

    # Force even if last-updated.txt hasn't advanced
    python3 sync_tcgcsv.py --tcg all --force

    # Cap products per group (testing)
    python3 sync_tcgcsv.py --tcg pokemon --limit 50

ENVIRONMENT
-----------
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
"""

import os
import sys
import re
import time
import json
import argparse
from difflib import SequenceMatcher
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

# ── Config ──────────────────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

TCGCSV_BASE = "https://tcgcsv.com"
USER_AGENT  = "PathBinderSync/1.0 (+https://pathbinder.gg)"
REQ_SLEEP   = 0.10  # 100ms between TCGCSV requests, per their guidelines
STATE_FILE  = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".tcgcsv_last_sync.txt")

# PathBinder game_type  ->  substrings that identify the TCGplayer category.
# Resolved against the live categories list by name, so we never hardcode a
# category id that TCGplayer might renumber.
#
# CRITICAL: each left-side key MUST equal catalog.game_type EXACTLY — these
# are the values get_game_type() in pokedata_sync.py writes, NOT the id
# prefixes (which differ: prefix 'mtg' but game_type 'magic', prefix 'op' but
# game_type 'onepiece', etc.). Mismatch = zero catalog sets, silent no-op.
CATEGORY_MATCHERS = {
    "pokemon":  ["pokemon"],
    "magic":    ["magic"],                 # "Magic: The Gathering"
    "yugioh":   ["yugioh", "yu-gi-oh"],
    "onepiece": ["one piece"],
    "digimon":  ["digimon"],
    "gundam":   ["gundam"],
    "dbz":      ["dragon ball z"],
    "dbfusion": ["fusion world"],          # "Dragon Ball Super: Fusion World"
    "fab":      ["flesh"],                  # "Flesh & Blood"
    "lorcana":  ["lorcana"],
}

# Fuzzy-match acceptance thresholds (SequenceMatcher ratio on normalized names)
EXACT_AT = 0.97
FUZZY_AT = 0.84

# ── HTTP sessions ───────────────────────────────────────────────────────────
_tcg = requests.Session()
_tcg.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})

_sb = requests.Session()
_sb.headers.update({
    "apikey":        SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
})

_last_req = [0.0]


def _log(msg):
    print(msg, flush=True)


def tcg_get(path):
    """GET a TCGCSV JSON endpoint with rate-limit spacing + retry."""
    # space requests at least REQ_SLEEP apart
    dt = time.time() - _last_req[0]
    if dt < REQ_SLEEP:
        time.sleep(REQ_SLEEP - dt)
    url = f"{TCGCSV_BASE}{path}"
    for attempt in range(4):
        try:
            r = _tcg.get(url, timeout=60)
            _last_req[0] = time.time()
            if r.status_code == 429:
                wait = 10 * (attempt + 1)
                _log(f"    throttled (429), backing off {wait}s…")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    return None


# ── Normalization helpers ───────────────────────────────────────────────────
_PUNCT = re.compile(r"[^a-z0-9]+")
_CODE_LIKE = re.compile(r"^[A-Za-z]{1,5}\d{0,3}$")


def norm_name(s):
    """Lowercase, drop punctuation/spaces for fuzzy set/card name compares."""
    return _PUNCT.sub("", (s or "").lower())


def is_code_like(s):
    """
    True for TCGplayer set-abbreviation codes (SWSH12, SM, XY, ME05, HGSS) —
    short letter+digit tokens with no spaces. Used to decide whether a colon
    segment is a code to ignore or a real (parent) set name to match against.
    """
    return bool(_CODE_LIKE.match((s or "").replace(" ", "")))


def group_name_candidates(group_name):
    """
    Candidate name strings to fuzzy-match a group against catalog sets.

    TCGplayer overloads the colon:
        'SWSH12: Silver Tempest'              code : name
        'Shining Fates: Shiny Vault'          parent : subset
        'SWSH: Crown Zenith: Galarian Gallery' code : parent : subset

    We emit the whole string plus every non-code colon segment, so a subset
    folds into its parent set (whose cards already live under one catalog
    set_code) while a real 'code: name' still resolves to the name.
    """
    cands = {group_name}
    for seg in (group_name or "").split(":"):
        seg = seg.strip()
        if seg and not is_code_like(seg):
            cands.add(seg)
    return cands


def set_name_from_group(group_name):
    """
    TCGplayer group names are often 'ABBR: Real Set Name'. The part after the
    colon is the human set name we want to match against catalog.set_name; the
    part before is the abbreviation. Returns (clean_name, abbreviation|None).
    """
    g = (group_name or "").strip()
    if ":" in g:
        abbr, name = g.split(":", 1)
        return name.strip(), abbr.strip()
    return g, None


def norm_number(s):
    """
    Normalize a card number for matching. '139/195' -> '139', 'TG12/TG30' ->
    'TG12', strips leading zeros on pure-numeric, uppercases alphanumerics.
    """
    if s is None:
        return None
    n = str(s).strip().upper()
    if "/" in n:
        n = n.split("/", 1)[0].strip()
    n = n.replace(" ", "")
    if n.isdigit():
        n = str(int(n))  # drop leading zeros
    return n or None


def ratio(a, b):
    return SequenceMatcher(None, a, b).ratio()


# ── Supabase REST helpers ───────────────────────────────────────────────────
def sb_get(path):
    r = _sb.get(f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}", timeout=60)
    r.raise_for_status()
    return r.json()


def sb_patch_catalog(cat_id, fields):
    q = requests.utils.quote(cat_id, safe="")
    r = _sb.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{q}",
        headers={"Content-Type": "application/json", "Prefer": "return=minimal"},
        data=json.dumps(fields),
        timeout=30,
    )
    r.raise_for_status()


def sb_upsert_group_map(row):
    r = _sb.post(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/tcgplayer_group_map?on_conflict=group_id",
        headers={
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        data=json.dumps(row),
        timeout=30,
    )
    r.raise_for_status()


def fetch_catalog_sets(game_type):
    """Distinct (set_code, set_name) for a game, deduped in Python."""
    rows, page, last = {}, 1000, None
    base = (
        f"catalog?select=set_code,set_name&game_type=eq.{game_type}"
        f"&set_code=not.is.null&order=set_code.asc&limit={page}"
    )
    while True:
        url = base + (f"&set_code=gt.{requests.utils.quote(last, safe='')}" if last else "")
        batch = sb_get(url)
        if not batch:
            break
        for b in batch:
            sc = b.get("set_code")
            if sc and sc not in rows:
                rows[sc] = b.get("set_name") or ""
        last = batch[-1]["set_code"]
        if len(batch) < page:
            break
    return rows  # { set_code: set_name }


def fetch_catalog_cards_in_set(game_type, set_code):
    """All singles in a set, returned as a number-keyed match index."""
    q = requests.utils.quote(set_code, safe="")
    rows = sb_get(
        f"catalog?select=id,name,card_number,product_type"
        f"&game_type=eq.{game_type}&set_code=eq.{q}&limit=2000"
    )
    by_num = {}
    for r in rows:
        pt = str(r.get("product_type") or "").lower()
        if pt not in ("", "single", "tcg_single"):
            continue  # singles only in Phase 1
        nn = norm_number(r.get("card_number"))
        if nn is None:
            continue
        by_num.setdefault(nn, []).append(r)
    return by_num


# ── Category resolution ─────────────────────────────────────────────────────
def resolve_categories(wanted_games):
    """Return { game_type: category_id } for the games we can place."""
    data = tcg_get("/tcgplayer/categories")
    cats = data.get("results", [])
    out = {}
    for gt in wanted_games:
        matchers = CATEGORY_MATCHERS.get(gt, [])
        found = None
        for c in cats:
            blob = f"{c.get('name','')} {c.get('displayName','')}".lower()
            if any(m in blob for m in matchers):
                found = c["categoryId"]
                break
        if not found:
            _log(f"  ! no TCGplayer category matched game_type '{gt}' — skipping")
            continue
        # Verify the game actually exists in the catalog — the key must equal
        # catalog.game_type, so a 0-row result means a naming mismatch, not an
        # empty game. Skip loudly rather than silently match nothing.
        try:
            probe = sb_get(f"catalog?select=id&game_type=eq.{gt}&limit=1")
        except Exception:
            probe = [1]  # on probe error, don't block the run
        if not probe:
            _log(f"  ! game_type '{gt}' matched TCGplayer category {found} but has "
                 f"0 catalog rows — check the key matches catalog.game_type. Skipping.")
            continue
        out[gt] = found
    return out


# ── Group mapping ───────────────────────────────────────────────────────────
def build_group_map(game_type, category_id, dry_run):
    """Fuzzy-match every TCGCSV group in this category to a catalog set_code."""
    _log(f"  Loading catalog sets for {game_type}…")
    catalog_sets = fetch_catalog_sets(game_type)            # set_code -> set_name
    norm_index = [(sc, sn, norm_name(sn)) for sc, sn in catalog_sets.items()]
    # exact set_code lookup for when a group abbreviation IS the set_code
    by_code = {sc.upper(): sc for sc in catalog_sets}

    _log(f"  Fetching TCGplayer groups for category {category_id}…")
    groups = tcg_get(f"/tcgplayer/{category_id}/groups").get("results", [])
    _log(f"    {len(groups)} groups; {len(catalog_sets)} catalog sets")

    # Human review is sticky: rows the review tool marked 'manual', 'skip', or
    # 'missing' are never re-fuzzed or overwritten here.
    locked_rows = {}
    try:
        for row in sb_get(f"tcgplayer_group_map?select=group_id,set_code,confidence"
                          f"&category_id=eq.{category_id}"
                          f"&confidence=in.(manual,skip,missing)"):
            locked_rows[row["group_id"]] = row
    except Exception as e:
        _log(f"  (could not load locked group_map rows: {e})")

    mapped, fuzzy, unmatched, locked = 0, 0, 0, 0
    result = {}  # group_id -> set_code (only confident ones, for product pass)

    for g in groups:
        gid   = g["groupId"]
        gname = g.get("name", "")

        # Preserve human decisions across runs.
        lr = locked_rows.get(gid)
        if lr:
            locked += 1
            # 'manual' drives product backfill; 'skip'/'missing' are excluded.
            if lr.get("confidence") == "manual" and lr.get("set_code"):
                result[gid] = lr["set_code"]
            continue

        clean, abbr = set_name_from_group(gname)
        norm_cands = [c for c in (norm_name(x) for x in group_name_candidates(gname)) if c]

        set_code, set_name, confidence = None, None, "unmatched"

        # 1) abbreviation == a known set_code → exact
        if abbr and abbr.upper() in by_code:
            set_code = by_code[abbr.upper()]
            set_name = catalog_sets[set_code]
            confidence = "exact"
        else:
            # 2) best fuzzy across every candidate name x every catalog set
            best_sc, best_sn, best_r = None, None, 0.0
            for sc, sn, nsn in norm_index:
                if not nsn:
                    continue
                for ncand in norm_cands:
                    r = ratio(ncand, nsn)
                    if r > best_r:
                        best_sc, best_sn, best_r = sc, sn, r
            if best_r >= EXACT_AT:
                set_code, set_name, confidence = best_sc, best_sn, "exact"
            elif best_r >= FUZZY_AT:
                set_code, set_name, confidence = best_sc, best_sn, "fuzzy"

        row = {
            "group_id":     gid,
            "category_id":  category_id,
            "game_type":    game_type,
            "abbreviation": abbr,
            "group_name":   gname,
            "set_code":     set_code,
            "set_name":     set_name,
            "confidence":   confidence,
            "mapped_at":    datetime.now(timezone.utc).isoformat(),
        }
        if not dry_run:
            sb_upsert_group_map(row)

        if confidence == "exact":
            mapped += 1
        elif confidence == "fuzzy":
            fuzzy += 1
        else:
            unmatched += 1
            _log(f"    UNMATCHED group {gid}: '{gname}'")

        if set_code:
            result[gid] = set_code

    locked_note = f", {locked} locked (manual/skip)" if locked else ""
    _log(f"  group map: {mapped} exact, {fuzzy} fuzzy, {unmatched} unmatched{locked_note}")
    return result


# ── Product backfill ────────────────────────────────────────────────────────
def is_card_product(product):
    """A product is a single card if extendedData carries Number or Rarity."""
    for ed in product.get("extendedData", []):
        if ed.get("name") in ("Number", "Rarity"):
            return True
    return False


def product_number(product):
    for ed in product.get("extendedData", []):
        if ed.get("name") == "Number":
            return ed.get("value")
    return None


def backfill_products(game_type, category_id, group_to_setcode, dry_run, limit):
    linked, skipped_sealed, no_match, ambiguous = 0, 0, 0, 0
    set_cache = {}  # set_code -> number index

    total_groups = len(group_to_setcode)
    _log(f"  Backfilling products across {total_groups} mapped group(s) "
         f"(~1 request each)…")

    for gi, (gid, set_code) in enumerate(group_to_setcode.items(), 1):
        prods = tcg_get(f"/tcgplayer/{category_id}/{gid}/products").get("results", [])
        if set_code not in set_cache:
            set_cache[set_code] = fetch_catalog_cards_in_set(game_type, set_code)
        by_num = set_cache[set_code]
        seen = 0

        for p in prods:
            if limit and seen >= limit:
                break
            if not is_card_product(p):
                skipped_sealed += 1
                continue
            seen += 1
            nn = norm_number(product_number(p))
            cands = by_num.get(nn, []) if nn else []
            if not cands:
                no_match += 1
                continue
            if len(cands) == 1:
                target = cands[0]
            else:
                # disambiguate by name
                pn = norm_name(p.get("cleanName") or p.get("name"))
                target, best = None, 0.0
                for c in cands:
                    r = ratio(pn, norm_name(c.get("name")))
                    if r > best:
                        target, best = c, r
                if best < 0.6:
                    ambiguous += 1
                    continue
            fields = {
                "tcgplayer_product_id": p["productId"],
                "tcgplayer_url":        p.get("url"),
            }
            if not dry_run:
                sb_patch_catalog(target["id"], fields)
            linked += 1

        if gi % 20 == 0 or gi == total_groups:
            _log(f"    …{gi}/{total_groups} groups ({linked} linked so far)")

    _log(f"  products: {linked} linked, {no_match} no-match, "
         f"{ambiguous} ambiguous, {skipped_sealed} sealed-skipped")


# ── last-updated guard ──────────────────────────────────────────────────────
def remote_last_updated():
    dt = time.time() - _last_req[0]
    if dt < REQ_SLEEP:
        time.sleep(REQ_SLEEP - dt)
    r = _tcg.get(f"{TCGCSV_BASE}/last-updated.txt", timeout=30)
    _last_req[0] = time.time()
    r.raise_for_status()
    return r.text.strip()


def local_last_updated():
    try:
        with open(STATE_FILE) as f:
            return f.read().strip()
    except OSError:
        return None


def write_local_last_updated(ts):
    try:
        with open(STATE_FILE, "w") as f:
            f.write(ts)
    except OSError as e:
        _log(f"  (could not write state file: {e})")


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="TCGCSV sync — Phase 1 (IDs/URLs)")
    ap.add_argument("--tcg", default="all",
                    help="game_type to sync, or 'all' (default)")
    ap.add_argument("--dry-run", action="store_true",
                    help="match + report, no DB writes")
    ap.add_argument("--groups-only", action="store_true",
                    help="only (re)build the group map")
    ap.add_argument("--force", action="store_true",
                    help="run even if last-updated.txt hasn't advanced")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap products per group (testing)")
    args = ap.parse_args()

    remote_ts = remote_last_updated()
    local_ts  = local_last_updated()
    _log(f"TCGCSV last-updated: {remote_ts}  (local: {local_ts or 'never'})")
    if remote_ts == local_ts and not args.force:
        _log("Already in sync with the latest TCGCSV build. Use --force to override.")
        return

    if args.tcg == "all":
        wanted = list(CATEGORY_MATCHERS.keys())
    else:
        wanted = [args.tcg]

    cats = resolve_categories(wanted)
    if not cats:
        _log("No categories resolved — nothing to do.")
        return

    for game_type, category_id in cats.items():
        _log(f"\n=== {game_type} (TCGplayer category {category_id}) ===")
        group_to_setcode = build_group_map(game_type, category_id, args.dry_run)
        if args.groups_only:
            continue
        backfill_products(game_type, category_id, group_to_setcode,
                          args.dry_run, args.limit)

    if not args.dry_run:
        write_local_last_updated(remote_ts)
    _log("\nDone.")


if __name__ == "__main__":
    main()
