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

Phase 2 also writes prices into card_prices from TCGCSV /prices, matched by
the linked tcgplayer_product_id:
    source='tcgplayer'               the card's main market price
    source='tcgplayer_reverse_holo'  the Reverse Holofoil subtype, when present
The price pass runs every sync (prices change daily) and is NOT subject to the
resume filter. Skip it with --no-prices; run only prices with --prices-only.
Sealed-product pricing is still a later phase.

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
            _log(f"    (slow/failed {path}: {type(e).__name__}; retry {attempt + 1}/3)")
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
# Every call retries on transient timeouts / 5xx so a single network blip can't
# kill a long backfill (Supabase occasionally read-times-out under load).
def _sb_send(method, path, **kwargs):
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}"
    kwargs.setdefault("timeout", 60)
    last = None
    for attempt in range(5):
        try:
            r = _sb.request(method, url, **kwargs)
        except requests.RequestException as e:
            last = type(e).__name__
            if attempt == 4:
                raise
            _log(f"    (Supabase {last}; retry {attempt + 1}/5)")
            time.sleep(2 * (attempt + 1))
            continue
        # Only transient statuses are worth retrying.
        if r.status_code in (429, 500, 502, 503, 504):
            last = f"HTTP {r.status_code}"
            if attempt == 4:
                raise RuntimeError(f"Supabase {last} after retries: {r.text[:300]}")
            _log(f"    (Supabase {last}; retry {attempt + 1}/5)")
            time.sleep(2 * (attempt + 1))
            continue
        if not r.ok:
            # Permanent client error (4xx) — don't retry; surface the body.
            raise RuntimeError(f"Supabase {r.status_code} on {method} {path}: {r.text[:400]}")
        return r
    raise RuntimeError(f"Supabase request failed after retries: {last}")


def sb_get(path):
    return _sb_send("GET", path).json()


def sb_upsert_catalog_links(rows):
    """Batch-write tcgplayer_product_id + tcgplayer_url for many catalog rows
    via the apply_tcgplayer_links() RPC — a true partial UPDATE, so it doesn't
    trip PostgREST upsert's NOT-NULL requirements. One request per ~500 rows.
    Requires migration_tcgcsv_apply_links_rpc.sql."""
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        _sb_send(
            "POST", "rpc/apply_tcgplayer_links",
            headers={"Content-Type": "application/json", "Prefer": "return=minimal"},
            data=json.dumps({"p": chunk}),
        )


def sb_upsert_group_map(row):
    _sb_send(
        "POST", "tcgplayer_group_map?on_conflict=group_id",
        headers={"Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"},
        data=json.dumps(row),
    )


def sb_upsert_card_prices(rows):
    """Batch upsert into card_prices, keyed (catalog_id, source). Unlike the
    catalog link write, these rows are fully specified so a plain PostgREST
    upsert works (insert-or-update). One request per ~500 rows."""
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        _sb_send(
            "POST", "card_prices?on_conflict=catalog_id,source",
            headers={"Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"},
            data=json.dumps(chunk),
        )


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


def fetch_catalog_cards_in_set(game_type, set_code, set_name, relink=False):
    """
    Singles in a set still NEEDING a link, number-keyed for matching.

    Prefer matching by set_NAME, not set_code: the catalog carries duplicate
    set_codes for the same real set (a few promo rows under one code, the bulk
    under another), so a single set_code misses most cards. The set_name groups
    them. Falls back to set_code if the name yields nothing.

    By default this returns only rows where tcgplayer_product_id IS NULL, so a
    re-run resumes — already-linked cards are skipped. Pass relink=True to
    re-process everything (e.g. after upstream productId changes).
    """
    nullf = "" if relink else "&tcgplayer_product_id=is.null"
    rows = []
    if set_name:
        q = requests.utils.quote(set_name, safe="")
        rows = sb_get(
            f"catalog?select=id,name,card_number,product_type"
            f"&game_type=eq.{game_type}&set_name=eq.{q}{nullf}&limit=4000"
        )
    if not rows and set_code:
        q = requests.utils.quote(set_code, safe="")
        rows = sb_get(
            f"catalog?select=id,name,card_number,product_type"
            f"&game_type=eq.{game_type}&set_code=eq.{q}{nullf}&limit=4000"
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
        matches = []
        for c in cats:
            blob = f"{c.get('name','')} {c.get('displayName','')}".lower()
            if any(m in blob for m in matchers):
                matches.append(c)
        if not matches:
            _log(f"  ! no TCGplayer category matched game_type '{gt}' — skipping")
            continue
        # 'pokemon' matches BOTH 'Pokemon' (3) and 'Pokemon Japan' (85). We want
        # the base English category — Japanese is enriched separately from
        # category 85 (enrich_tcgcsv_existing.py). Prefer the most specific
        # match: shortest category name (base 'Pokemon' < 'Pokemon Japan').
        # Don't rely on TCGplayer's list order, which can change.
        matches.sort(key=lambda c: len(c.get("name", "")))
        found = matches[0]["categoryId"]
        if len(matches) > 1:
            _log(f"    {gt}: matched {len(matches)} categories "
                 f"{[(c['categoryId'], c['name']) for c in matches]}; using {found}.")
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
        for row in sb_get(f"tcgplayer_group_map?select=group_id,set_code,set_name,confidence"
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
            if lr.get("confidence") == "manual" and (lr.get("set_code") or lr.get("set_name")):
                result[gid] = (lr.get("set_code"), lr.get("set_name"))
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

        if set_code or set_name:
            result[gid] = (set_code, set_name)

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


def backfill_products(game_type, category_id, group_to_setcode, dry_run, limit, relink):
    linked, skipped_sealed, no_match, ambiguous, skipped_done = 0, 0, 0, 0, 0
    set_cache = {}  # set_code -> number index

    # Batched writes: collect link updates and flush every 500 rows via one
    # upsert, rather than a PATCH per card. De-dupe by catalog id within a
    # flush (a card can only carry one product id).
    pending = {}

    def flush():
        if pending and not dry_run:
            sb_upsert_catalog_links(list(pending.values()))
        pending.clear()

    total_groups = len(group_to_setcode)
    _log(f"  Backfilling products across {total_groups} mapped group(s) "
         f"(~1 request each)…")

    for gi, (gid, sc_sn) in enumerate(group_to_setcode.items(), 1):
        set_code, set_name = sc_sn
        cache_key = set_name or set_code
        if cache_key not in set_cache:
            set_cache[cache_key] = fetch_catalog_cards_in_set(game_type, set_code, set_name, relink)
        by_num = set_cache[cache_key]
        # Nothing left to link in this set (all already linked, or no rows) —
        # skip the TCGCSV product fetch entirely. This is what makes a re-run
        # resume fast instead of re-fetching every group.
        if not by_num:
            skipped_done += 1
            if gi == 1 or gi % 5 == 0 or gi == total_groups:
                _log(f"    …{gi}/{total_groups} groups ({linked} linked so far)")
            continue
        prods = tcg_get(f"/tcgplayer/{category_id}/{gid}/products").get("results", [])
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
            pending[target["id"]] = {
                "id":                   target["id"],
                "tcgplayer_product_id": p["productId"],
                "tcgplayer_url":        p.get("url"),
            }
            linked += 1
            if len(pending) >= 500:
                flush()

        if gi == 1 or gi % 5 == 0 or gi == total_groups:
            _log(f"    …{gi}/{total_groups} groups ({linked} linked so far)")

    flush()  # write the final partial batch
    done_note = f", {skipped_done} groups already done" if skipped_done else ""
    _log(f"  products: {linked} linked, {no_match} no-match, "
         f"{ambiguous} ambiguous, {skipped_sealed} sealed-skipped{done_note}")


# ── Price backfill (Phase 2) ────────────────────────────────────────────────
# TCGCSV /prices returns one row per (productId, subTypeName). We capture EVERY
# finish so nothing is dropped: the card's base finish is written as
# source='tcgplayer' (the headline), and each other finish gets its own source
# (tcgplayer_foil, tcgplayer_reverse_holo, tcgplayer_holo, ...). That fixes
# foil/holo cards reading the cheap non-foil price.
_BASE_SUBTYPE_PRIORITY = [
    "Normal", "Holofoil", "1st Edition Holofoil", "1st Edition",
    "Unlimited Holofoil", "Unlimited",
]
# Stable source slugs for the common finishes; anything else gets a generated
# tcgplayer_<slug> source.
_SUBTYPE_SOURCE = {
    "Reverse Holofoil":     "tcgplayer_reverse_holo",
    "Foil":                 "tcgplayer_foil",
    "Holofoil":             "tcgplayer_holo",
    "1st Edition":          "tcgplayer_1st_edition",
    "1st Edition Holofoil": "tcgplayer_1st_edition_holo",
    "Unlimited":            "tcgplayer_unlimited",
    "Unlimited Holofoil":   "tcgplayer_unlimited_holo",
}


def _subtype_source(sub):
    s = (sub or "").strip()
    if s in _SUBTYPE_SOURCE:
        return _SUBTYPE_SOURCE[s]
    slug = re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")
    return "tcgplayer_" + slug if slug else "tcgplayer"


def fetch_set_product_map(game_type, set_code, set_name):
    """{ tcgplayer_product_id : (catalog_id, tcgplayer_url) } for a set's linked rows."""
    rows = []
    if set_name:
        q = requests.utils.quote(set_name, safe="")
        rows = sb_get(
            f"catalog?select=id,tcgplayer_product_id,tcgplayer_url"
            f"&game_type=eq.{game_type}&set_name=eq.{q}"
            f"&tcgplayer_product_id=not.is.null&limit=4000"
        )
    if not rows and set_code:
        q = requests.utils.quote(set_code, safe="")
        rows = sb_get(
            f"catalog?select=id,tcgplayer_product_id,tcgplayer_url"
            f"&game_type=eq.{game_type}&set_code=eq.{q}"
            f"&tcgplayer_product_id=not.is.null&limit=4000"
        )
    return {r["tcgplayer_product_id"]: (r["id"], r.get("tcgplayer_url")) for r in rows}


def backfill_prices(game_type, category_id, group_to_setcode, dry_run):
    written, groups_priced = 0, 0
    pending = []

    def flush():
        nonlocal written
        if pending and not dry_run:
            sb_upsert_card_prices(pending)
        written += len(pending)
        pending.clear()

    total = len(group_to_setcode)
    _log(f"  Pricing {total} mapped group(s) from TCGCSV /prices…")
    now = datetime.now(timezone.utc).isoformat()

    for gi, (gid, sc_sn) in enumerate(group_to_setcode.items(), 1):
        set_code, set_name = sc_sn
        pid_map = fetch_set_product_map(game_type, set_code, set_name)
        if pid_map:
            groups_priced += 1
            prices = tcg_get(f"/tcgplayer/{category_id}/{gid}/prices").get("results", [])
            # collapse to { productId: { subType: marketPrice } }
            by_pid = {}
            for pr in prices:
                mp = pr.get("marketPrice")
                if mp is None:
                    continue
                by_pid.setdefault(pr.get("productId"), {})[(pr.get("subTypeName") or "").strip()] = mp

            for pid, subs in by_pid.items():
                tgt = pid_map.get(pid)
                if not tgt:
                    continue
                cat_id, url = tgt
                # Pick the base finish for the headline 'tcgplayer' source.
                base_sub = None
                for s in _BASE_SUBTYPE_PRIORITY:
                    if s in subs:
                        base_sub = s
                        break
                if base_sub is None:
                    base_sub = next(iter(subs), None)  # holo-only / unusual
                if base_sub is not None:
                    pending.append({"catalog_id": cat_id, "source": "tcgplayer",
                                    "value": subs[base_sub], "currency": "USD",
                                    "source_url": url, "recorded_at": now})
                # Every OTHER finish gets its own source so nothing is lost.
                for sub, mp in subs.items():
                    if sub == base_sub:
                        continue
                    pending.append({"catalog_id": cat_id, "source": _subtype_source(sub),
                                    "value": mp, "currency": "USD",
                                    "source_url": url, "recorded_at": now})
                if len(pending) >= 500:
                    flush()

        if gi == 1 or gi % 5 == 0 or gi == total:
            _log(f"    …{gi}/{total} groups ({written + len(pending)} prices)")

    flush()
    _log(f"  prices: {written} written across {groups_priced} priced group(s)")


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
    ap.add_argument("--relink", action="store_true",
                    help="re-process ALL cards, not just unlinked ones (default: resume)")
    ap.add_argument("--no-prices", action="store_true",
                    help="skip the price pass (links/IDs only)")
    ap.add_argument("--prices-only", action="store_true",
                    help="skip linking, only refresh card_prices from TCGCSV")
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
        if not args.prices_only:
            backfill_products(game_type, category_id, group_to_setcode,
                              args.dry_run, args.limit, args.relink)
        if not args.no_prices:
            backfill_prices(game_type, category_id, group_to_setcode, args.dry_run)

    if not args.dry_run:
        write_local_last_updated(remote_ts)
    _log("\nDone.")


if __name__ == "__main__":
    main()
