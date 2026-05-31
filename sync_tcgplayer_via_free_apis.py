#!/usr/bin/env python3
"""
PathBinder — TCGplayer prices via bulk-download intermediary APIs
==================================================================
Pulls TCGplayer market prices for the catalog by downloading bulk
card data from the three free APIs that expose TCGplayer pricing:

    Pokemon EN  →  pokemontcg.io     paginate /v2/cards (~212 reqs)
    Magic       →  Scryfall          /bulk-data/default-cards (1 file)
    Yu-Gi-Oh    →  YGOPRODeck        /api/v7/cardinfo.php (1 response)

The previous per-row approach made ~80,000 HTTP requests across the
three APIs. The bulk approach makes < 220 total. Pokemon EN drops
from ~60 minutes runtime to ~3 minutes; Magic from ~40 to ~30 sec;
YGO from ~15 to ~10 sec.

How matching works
------------------
For each game, we build an in-memory map keyed by:
    Pokemon → pokemontcg.io card id           (e.g. "swsh1-1")
    Magic   → (set_code lower, collector_num)  (e.g. ("neo", "100"))
    Yu-Gi-Oh → lowercase canonical name        (e.g. "dark magician")

Then we walk catalog rows (singles only — none of these APIs index
sealed product) and look up each one. Match hit → upsert into the
card_prices table with source='tcgplayer'.

PREREQUISITES
-------------
    pip3 install requests --break-system-packages

USAGE
-----
    # Full sync (all three games)
    python3 sync_tcgplayer_via_free_apis.py --game all

    # Per-game
    python3 sync_tcgplayer_via_free_apis.py --game pokemon
    python3 sync_tcgplayer_via_free_apis.py --game magic
    python3 sync_tcgplayer_via_free_apis.py --game yugioh

    # Dry-run (build map, match catalog, no DB writes)
    python3 sync_tcgplayer_via_free_apis.py --game all --dry-run

    # Limit for testing
    python3 sync_tcgplayer_via_free_apis.py --game pokemon --limit 100

ENVIRONMENT
-----------
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
    POKEMONTCG_IO_API_KEY     optional, bumps quota on pokemontcg.io
"""

import os
import sys
import re
import time
import json
import argparse
import threading
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

POKEMONTCG_IO_API_KEY = os.environ.get("POKEMONTCG_IO_API_KEY", "").strip() or None

_print_lock = threading.Lock()
def _log(*args):
    with _print_lock:
        print(*args, flush=True)


# ─── Supabase REST helpers ──────────────────────────────────────────────────
_sb = requests.Session()
_sb.headers.update({
    "apikey":        SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept":        "application/json",
})


def load_catalog(game_type, limit=None):
    """Pull catalog SINGLES rows for one TCG using keyset pagination
    (id > last_id ORDER BY id). Same filter as before: product_type=
    'single' + id NOT LIKE 'sealed-%' belt-and-suspenders against
    sealed-product rows that none of the bulk APIs index."""
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog"
    select = "id,name,set_code,card_number,game_type"
    rows = []
    page_size = 500
    last_id = None
    while True:
        cursor = f"&id=gt.{requests.utils.quote(last_id, safe='')}" if last_id else ""
        params = (
            f"?select={select}"
            f"&game_type=eq.{game_type}"
            f"&product_type=eq.single"
            f"&id=not.like.sealed-*"
            f"{cursor}&order=id.asc&limit={page_size}"
        )
        r = _sb.get(url + params, timeout=60)
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


def upsert_card_price(catalog_id, source, value, source_url=None):
    payload = {
        "catalog_id":  catalog_id,
        "source":      source,
        "value":       value,
        "currency":    "USD",
        "source_url":  source_url,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    r = _sb.post(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/card_prices?on_conflict=catalog_id,source",
        headers={
            "Content-Type":  "application/json",
            "Prefer":        "resolution=merge-duplicates,return=minimal",
        },
        data=json.dumps(payload),
        timeout=30,
    )
    r.raise_for_status()


# ─── pokemontcg.io — paginate /v2/cards ─────────────────────────────────────
# Returns a map: { pokemontcg_id → {value, source_url} }
# Pokemon EN is ~25k cards. At 250/page that's ~100 paginated requests.
def bulk_fetch_pokemon():
    _log("  Downloading pokemontcg.io card list (paginated)…")
    if not POKEMONTCG_IO_API_KEY:
        _log("  WARN: POKEMONTCG_IO_API_KEY not set. The unauthenticated tier")
        _log("        is severely rate-limited (~30 reqs/hour). Get a free key")
        _log("        from https://dev.pokemontcg.io/ and set it in your env.")
    sess = requests.Session()
    if POKEMONTCG_IO_API_KEY:
        sess.headers.update({"X-Api-Key": POKEMONTCG_IO_API_KEY})
    pmap = {}
    page = 1
    PAGE_SIZE = 250
    while True:
        url = f"https://api.pokemontcg.io/v2/cards?page={page}&pageSize={PAGE_SIZE}"
        # 5 attempts with exponential backoff. Sets last_err on EVERY
        # failure path (including 429), so the failure log always has
        # a meaningful explanation instead of "None".
        last_err = None
        cards = None
        for attempt in range(5):
            try:
                r = sess.get(url, timeout=60)
                if r.status_code == 429:
                    last_err = f"HTTP 429 rate-limited (attempt {attempt+1}/5)"
                    backoff = (2 ** attempt) + 1   # 2, 3, 5, 9, 17 sec
                    time.sleep(backoff)
                    continue
                if r.status_code >= 500:
                    last_err = f"HTTP {r.status_code} server error (attempt {attempt+1}/5)"
                    time.sleep(2 ** attempt)
                    continue
                r.raise_for_status()
                cards = (r.json() or {}).get("data") or []
                break
            except Exception as e:
                last_err = f"{type(e).__name__}: {e}"
                if attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
        if cards is None:
            _log(f"    Page {page} failed permanently: {last_err}.")
            if "429" in str(last_err):
                _log(f"    pokemontcg.io is rate-limiting. Possible causes:")
                _log(f"      - Daily quota exhausted (free tier: 1000 reqs/day)")
                _log(f"      - No POKEMONTCG_IO_API_KEY set in env (much lower quota)")
                _log(f"      - Too many parallel runs from your IP")
                _log(f"    Wait a few hours and retry, or get/set an API key.")
            _log(f"    Stopping at page {page}; partial map has {len(pmap):,} entries.")
            break
        if not cards:
            break
        for c in cards:
            cid = c.get("id")
            if not cid:
                continue
            prices = (c.get("tcgplayer") or {}).get("prices") or {}
            # Pick the price that matches what TCGplayer's product page
            # shows by default — i.e. the base (normal) printing if
            # available, otherwise the only finish that exists.
            #
            # Old priority (holofoil → reverseHolofoil → … → normal) was
            # inverted for common cards. Common rarity cards typically
            # exist in BOTH `normal` and `reverseHolofoil` finishes on
            # pokemontcg.io; the reverse-holo "market" is easily spiked
            # by a single graded sale ($100+ for an otherwise-$1 common),
            # which our priority then stored as THE price. Users saw
            # "Magikarp Deoxys #64 → $112" while TCGplayer's product
            # page shows the normal printing at ~$1.
            #
            # New priority: normal-tier finishes first (what the product
            # page shows by default), then holo finishes as fallback for
            # holo-only printings (most Rare Holo Charizards etc. don't
            # have a `normal` entry — they fall through naturally).
            best = None
            for finish in ("normal", "unlimited",
                           "1stEditionNormal",
                           "holofoil", "reverseHolofoil", "1stEditionHolofoil"):
                if finish in prices:
                    mkt = (prices[finish] or {}).get("market")
                    if mkt and mkt > 0:
                        best = float(mkt)
                        break
            if best is not None:
                pmap[cid] = {
                    "value":      best,
                    "source_url": (c.get("tcgplayer") or {}).get("url") or None,
                }
        if page % 10 == 0:
            _log(f"    …pulled {page * PAGE_SIZE:,} cards so far ({len(pmap):,} with prices)")
        if len(cards) < PAGE_SIZE:
            break
        page += 1
    _log(f"  pokemontcg.io map: {len(pmap):,} cards with tcgplayer market price.")
    return pmap


def _ptcg_id_from_catalog(catalog_id):
    return catalog_id[3:] if catalog_id.startswith("en-") else catalog_id


# ─── Scryfall — bulk default-cards JSON download ────────────────────────────
# Returns a map keyed by (set_code lower, collector_number).
# Bulk default-cards is ~150-200 MB JSON containing every Magic card
# (current and historical). One download replaces ~25k API calls.
def bulk_fetch_magic():
    _log("  Resolving Scryfall bulk-data manifest…")
    headers = {"User-Agent": "PathBinder/1.0", "Accept": "application/json"}
    r = requests.get("https://api.scryfall.com/bulk-data", timeout=60, headers=headers)
    r.raise_for_status()
    manifest = (r.json() or {}).get("data") or []
    default_meta = next((m for m in manifest if m.get("type") == "default_cards"), None)
    if not default_meta:
        _log("  WARN: no 'default_cards' entry in Scryfall bulk manifest.")
        return {}
    dl_url = default_meta.get("download_uri")
    if not dl_url:
        _log("  WARN: Scryfall default_cards has no download_uri.")
        return {}
    size_mb = (default_meta.get("size") or 0) / 1024 / 1024
    _log(f"  Downloading Scryfall default-cards ({size_mb:.1f} MB)…")
    r = requests.get(dl_url, timeout=300, headers=headers)
    r.raise_for_status()
    cards = r.json() or []
    _log(f"  Scryfall: {len(cards):,} card variants in bulk file.")
    pmap = {}
    for c in cards:
        set_code = (c.get("set") or "").lower().strip()
        num      = str(c.get("collector_number") or "").strip()
        if not (set_code and num):
            continue
        prices = c.get("prices") or {}
        val = prices.get("usd") or prices.get("usd_foil") or prices.get("usd_etched")
        if not val:
            continue
        try:
            v = float(val)
        except (TypeError, ValueError):
            continue
        if v <= 0:
            continue
        key = (set_code, num)
        pmap[key] = {
            "value":      v,
            "source_url": (c.get("purchase_uris") or {}).get("tcgplayer") or c.get("scryfall_uri"),
        }
    _log(f"  Magic map: {len(pmap):,} (set, number) entries with USD price.")
    return pmap


# ─── YGOPRODeck — single /cardinfo endpoint ─────────────────────────────────
# Returns a map keyed by lowercase canonical name. The /cardinfo
# endpoint without params returns the entire YGO database (~13k cards,
# ~7 MB JSON). One request replaces ~3k per-card lookups.
def bulk_fetch_yugioh():
    _log("  Downloading YGOPRODeck full card index…")
    headers = {"User-Agent": "PathBinder/1.0"}
    r = requests.get("https://db.ygoprodeck.com/api/v7/cardinfo.php",
                     timeout=300, headers=headers)
    r.raise_for_status()
    cards = (r.json() or {}).get("data") or []
    _log(f"  YGOPRODeck: {len(cards):,} cards returned.")
    pmap = {}
    for c in cards:
        name = (c.get("name") or "").strip().lower()
        if not name:
            continue
        cp_list = c.get("card_prices") or []
        best = None
        for cp in cp_list:
            try:
                v = float(cp.get("tcgplayer_price") or 0)
                if v > 0:
                    best = v
                    break
            except (TypeError, ValueError):
                continue
        if best is not None:
            pmap[name] = {
                "value":      best,
                "source_url": c.get("ygoprodeck_url"),
            }
    _log(f"  YGO map: {len(pmap):,} cards with tcgplayer_price.")
    return pmap


# ─── YGO name normalisation (kept from previous version) ────────────────────
_YGO_NAME_NOISE_RE = re.compile(
    r"\s*[\[\(](?:reprint|errata|qcse|limited|10000\s*serial|prerelease|"
    r"foil|alt\s*art|alternate\s*art|special|preview|tokens?|chinese|japanese|"
    r"korean|asian|english|european)[^\]\)]*[\]\)]\s*",
    re.IGNORECASE,
)
_YGO_RARITY_PAREN_RE = re.compile(r"\s*[\[\(]\d{0,2}[A-Za-z]{1,6}[\]\)]\s*")
_YGO_TRAILING_NOISE_RE = re.compile(
    r"\s+(?:1st\s*Edition|2nd\s*Edition|Limited|Unlimited|Foil|Reprint|"
    r"Promo|Holo|Holofoil|Tournament|Promotional|Sealed)\s*$",
    re.IGNORECASE,
)
_YGO_TRAILING_CODE_RE = re.compile(
    r"\s*[-–—]\s*[A-Z0-9]{2,6}-[A-Z]{0,3}\d{1,3}[A-Z]?\s*$"
)
_YGO_BRACKET_CODE_RE = re.compile(
    r"\s*\[[A-Z0-9]{2,8}-[A-Z]{0,4}\d{1,4}[A-Z]?\]\s*"
)

def _ygo_clean_name(raw):
    s = (raw or "").strip()
    for _ in range(4):
        prev = s
        s = _YGO_NAME_NOISE_RE.sub(" ", s)
        s = _YGO_RARITY_PAREN_RE.sub(" ", s)
        s = _YGO_BRACKET_CODE_RE.sub(" ", s)
        s = re.sub(r"\s+", " ", s).strip()
        s = _YGO_TRAILING_NOISE_RE.sub("", s)
        s = _YGO_TRAILING_CODE_RE.sub("", s)
        s = re.sub(r"\s+", " ", s).strip()
        if s == prev:
            break
    return s


# ─── Per-row lookups (use the bulk maps) ────────────────────────────────────
def match_pokemon_row(row, pmap):
    cat_id  = row["id"]
    ptcg_id = _ptcg_id_from_catalog(cat_id)
    e = pmap.get(ptcg_id)
    if not e: return ("not_found", cat_id, f"pokemontcg.io has no {ptcg_id}")
    return ("ok", cat_id, e)


def match_magic_row(row, pmap):
    cat_id   = row["id"]
    set_code = (row.get("set_code") or "").lower().strip()
    num      = (row.get("card_number") or "").strip()
    if not (set_code and num):
        return ("not_found", cat_id, "missing set_code or card_number")
    e = pmap.get((set_code, num))
    if not e:
        return ("not_found", cat_id, f"scryfall has no ({set_code}, {num})")
    return ("ok", cat_id, e)


def match_yugioh_row(row, pmap):
    cat_id = row["id"]
    raw    = (row.get("name") or "").strip()
    if not raw:
        return ("not_found", cat_id, "missing name")
    base = _ygo_clean_name(raw).lower()
    # Try cleaned, then raw, then first 3 words.
    for k in (base, raw.lower(), " ".join(base.split()[:3])):
        if not k: continue
        e = pmap.get(k)
        if e:
            return ("ok", cat_id, e)
    return ("not_found", cat_id, f"no ygoprodeck match for name={raw!r}")


# ─── Game runner ────────────────────────────────────────────────────────────
GAME_CONFIG = {
    "pokemon": {
        "bulk_fetch":  bulk_fetch_pokemon,
        "match":       match_pokemon_row,
        "description": "Pokemon EN via pokemontcg.io",
    },
    "magic":   {
        "bulk_fetch":  bulk_fetch_magic,
        "match":       match_magic_row,
        "description": "Magic via Scryfall bulk-data",
    },
    "yugioh":  {
        "bulk_fetch":  bulk_fetch_yugioh,
        "match":       match_yugioh_row,
        "description": "Yu-Gi-Oh via YGOPRODeck full index",
    },
}


def process_row(row, match_func, pmap, dry_run):
    status, cat_id, payload = match_func(row, pmap)
    if status != "ok":
        return (status, cat_id, str(payload))
    if dry_run:
        return ("would_update", cat_id, f"${payload['value']:.2f}")
    try:
        upsert_card_price(cat_id, "tcgplayer", payload["value"],
                          source_url=payload.get("source_url"))
    except Exception as e:
        return ("failed", cat_id, f"upsert: {e}")
    return ("updated", cat_id, f"${payload['value']:.2f}")


def run_game(game, limit, dry_run):
    cfg = GAME_CONFIG[game]
    _log(f"\n  === {cfg['description']} ===")
    started = time.time()

    pmap = cfg["bulk_fetch"]()
    if not pmap:
        _log("  Bulk fetch returned empty. Skipping.")
        return

    rows = load_catalog(game, limit)
    _log(f"  {len(rows):,} catalog rows in scope.")
    if not rows:
        return

    stats = {"updated": 0, "would_update": 0, "not_found": 0,
             "failed": 0}
    not_found_logged = 0
    NF_CAP = 15

    _log(f"  Matching against bulk map "
         f"({'dry run' if dry_run else 'writing to card_prices'})…")
    # Supabase writes can be parallelised because the work is just
    # network round-trips. No third-party API rate limit applies
    # since we already have the prices in memory.
    workers = 1 if dry_run else 15
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(process_row, r, cfg["match"], pmap, dry_run) for r in rows]
        for i, fut in enumerate(as_completed(futs), start=1):
            status, cat_id, detail = fut.result()
            stats[status] = stats.get(status, 0) + 1
            if status == "failed":
                _log(f"    [{i:>6}/{len(rows)}] FAIL {cat_id:<28s} {detail}")
            elif status == "not_found" and not_found_logged < NF_CAP:
                not_found_logged += 1
                _log(f"    [{i:>6}/{len(rows)}] not_found {cat_id:<28s} {detail}")
                if not_found_logged == NF_CAP:
                    _log(f"    (further not_found rows suppressed)")
            elif i % 5000 == 0:
                _log(f"    [{i:>6}/{len(rows)}] updated:{stats['updated']:,}  "
                     f"not_found:{stats['not_found']:,}")

    elapsed = time.time() - started
    _log(f"\n  {game} summary  ({elapsed:.0f}s):")
    _log(f"    Updated     : {stats['updated']:,}")
    if dry_run:
        _log(f"    Would update: {stats['would_update']:,}")
    _log(f"    Not found   : {stats['not_found']:,}")
    _log(f"    Failed      : {stats['failed']:,}")
    if rows:
        match_rate = (stats['updated'] + stats['would_update']) / len(rows) * 100.0
        _log(f"    Match rate  : {match_rate:.1f}%")


def main():
    ap = argparse.ArgumentParser(
        description="Sync TCGplayer prices into card_prices via bulk-download APIs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--game",    default="all",
                    help="pokemon, magic, yugioh, or all.")
    ap.add_argument("--limit",   type=int, default=None,
                    help="Cap catalog rows per game.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Build bulk maps + match, but don't write to DB.")
    args = ap.parse_args()

    games = list(GAME_CONFIG.keys()) if args.game == "all" else [args.game]
    for g in games:
        if g not in GAME_CONFIG:
            _log(f"  Unknown game '{g}'. Valid: pokemon, magic, yugioh, all.")
            continue
        run_game(g, args.limit, args.dry_run)


if __name__ == "__main__":
    main()
