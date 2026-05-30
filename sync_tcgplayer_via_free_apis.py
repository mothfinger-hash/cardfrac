#!/usr/bin/env python3
"""
PathBinder — TCGplayer prices via free-tier intermediary APIs
==============================================================
Pulls TCGplayer market prices for catalog rows by hitting three
public APIs that already index TCGplayer data:

    Pokemon EN  →  pokemontcg.io   (tcgplayer.prices.<finish>.market)
    Magic       →  Scryfall        (prices.usd / prices.usd_foil)
    Yu-Gi-Oh    →  YGOPRODeck      (card_prices[0].tcgplayer_price)

All three are free, no auth required (pokemontcg.io has an optional
key for higher quota), and explicitly carry TCGplayer prices in their
card response. This sidesteps both scraping (ToS-violating, IP-bannable)
and the TCGplayer Partner API approval gate (1-4 weeks).

What this script writes
-----------------------
Rows are upserted into the public.card_prices table:
    (catalog_id, source='tcgplayer', value, currency='USD',
     source_url, recorded_at=now())
The existing catalog.current_value is untouched. The UI reads
card_prices alongside catalog.current_value to display side-by-side
comps.

What it doesn't cover
---------------------
    One Piece, Gundam, DBZ, Topps   →  no free TCGplayer-aware API
    Pokemon JP / CN / KR            →  pokemontcg.io is EN-only

For those, the TCGplayer Partner API is the path. Apply at
https://developer.tcgplayer.com — once approved, write a sibling
script (sync_tcgplayer_via_partner_api.py) that covers the remaining
TCGs and replaces this one's Pokemon EN coverage.

PREREQUISITES
-------------
    pip3 install requests --break-system-packages

USAGE
-----
    # Dry-run for each TCG (no DB writes)
    python3 sync_tcgplayer_via_free_apis.py --game pokemon --dry-run
    python3 sync_tcgplayer_via_free_apis.py --game magic   --dry-run
    python3 sync_tcgplayer_via_free_apis.py --game yugioh  --dry-run

    # All three in one pass
    python3 sync_tcgplayer_via_free_apis.py --game all

    # Limit for smoke testing
    python3 sync_tcgplayer_via_free_apis.py --game pokemon --limit 50

ENVIRONMENT
-----------
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
    POKEMONTCG_IO_API_KEY     optional — bumps daily quota on pokemontcg.io
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
    """Pull catalog rows for one TCG using keyset pagination (id > last).
    Singles only — none of the three intermediary APIs (pokemontcg.io,
    Scryfall, YGOPRODeck) index sealed product (booster boxes, tins,
    ETBs, etc.). Sending sealed rows to YGOPRODeck for a `Booster Box`
    or `Sealed Tin` name match guarantees a not_found and burns API
    quota on something we can't ever resolve here. Sealed product
    prices come from PriceCharting (which DOES carry them) — see
    refresh_catalog_prices_csv.py.

    Two filters guard against sealed rows:
      • product_type='single' — covers rows where the column is set
      • id NOT LIKE 'sealed-%' — belt-and-suspenders for legacy rows
        with NULL product_type that pre-date the column being added"""
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
    """Insert or update one card_prices row. on_conflict ensures
    re-runs replace the previous value cleanly."""
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


# ─── pokemontcg.io (Pokemon EN) ─────────────────────────────────────────────
# Catalog ids for Pokemon EN look like:
#   en-base1-4          (current convention — strip 'en-' to get pokemontcg id)
#   base1-4             (legacy bare-prefix rows, already match the API id)
_PTCG_SESSION = requests.Session()
if POKEMONTCG_IO_API_KEY:
    _PTCG_SESSION.headers.update({"X-Api-Key": POKEMONTCG_IO_API_KEY})

def _ptcg_id_from_catalog(catalog_id):
    """Strip the 'en-' prefix added by newer syncs. Legacy rows that
    are already bare (base1-4) pass through untouched."""
    return catalog_id[3:] if catalog_id.startswith("en-") else catalog_id

def fetch_pokemon_price(catalog_row):
    cat_id = catalog_row["id"]
    ptcg_id = _ptcg_id_from_catalog(cat_id)
    url = f"https://api.pokemontcg.io/v2/cards/{ptcg_id}"
    # pokemontcg.io occasionally takes 15-25s under load (their CDN
    # caches per-card responses and cold ones are slow). 15s was too
    # tight; 30s + one retry on timeout absorbs the slow ones without
    # falsely marking them as unreachable.
    last_err = None
    for attempt in range(2):
        try:
            r = _PTCG_SESSION.get(url, timeout=30)
            if r.status_code == 404:
                return ("not_found", cat_id, "card id not in pokemontcg.io")
            if r.status_code == 429:
                time.sleep(1.5)
                continue
            r.raise_for_status()
            data = (r.json() or {}).get("data") or {}
            break
        except requests.exceptions.Timeout as e:
            last_err = e
            if attempt == 0:
                time.sleep(0.5)
                continue
            return ("failed", cat_id, f"http: timeout after retry")
        except Exception as e:
            return ("failed", cat_id, f"http: {e}")
    else:
        return ("failed", cat_id, f"http: {last_err}")

    prices = (data.get("tcgplayer") or {}).get("prices") or {}
    if not prices:
        return ("no_price", cat_id, "pokemontcg.io returned no tcgplayer.prices")

    # Pick the best "market" value across finish variants. pokemontcg.io's
    # tcgplayer.prices has subkeys like normal, holofoil, reverseHolofoil,
    # 1stEditionHolofoil — each with low/mid/high/market/directLow. We
    # prefer holofoil > normal > whatever — matching what TCGplayer's UI
    # shows by default for a card listing.
    for finish in ("holofoil", "reverseHolofoil", "1stEditionHolofoil",
                   "1stEditionNormal", "normal", "unlimited"):
        if finish in prices:
            mkt = (prices[finish] or {}).get("market")
            if mkt and mkt > 0:
                source_url = (data.get("tcgplayer") or {}).get("url") or None
                return ("ok", cat_id, {"value": float(mkt), "source_url": source_url})

    return ("no_price", cat_id, "no usable market price across finishes")


# ─── Scryfall (Magic) ───────────────────────────────────────────────────────
# Scryfall's set codes are 3-letter lowercase ("mom", "neo"). Our
# catalog stores them similarly under set_code. card_number maps to
# collector_number.
def fetch_magic_price(catalog_row):
    cat_id   = catalog_row["id"]
    set_code = (catalog_row.get("set_code") or "").lower().strip()
    num      = (catalog_row.get("card_number") or "").strip()
    if not (set_code and num):
        return ("not_found", cat_id, "missing set_code or card_number")
    # Scryfall accepts collector_number with leading zeros stripped
    # OR present; either works. We pass as-is.
    url = f"https://api.scryfall.com/cards/{set_code}/{num}"
    try:
        r = requests.get(url, timeout=15, headers={"User-Agent": "PathBinder/1.0"})
        # Scryfall rate limits at 10 req/sec; back off briefly on 429.
        if r.status_code == 429:
            time.sleep(1.5)
            r = requests.get(url, timeout=15, headers={"User-Agent": "PathBinder/1.0"})
        if r.status_code == 404:
            return ("not_found", cat_id, f"scryfall has no {set_code}/{num}")
        r.raise_for_status()
        data = r.json() or {}
    except Exception as e:
        return ("failed", cat_id, f"http: {e}")

    prices = data.get("prices") or {}
    # Prefer non-foil USD; fall back to foil if nonfoil is missing.
    val = prices.get("usd") or prices.get("usd_foil") or prices.get("usd_etched")
    if not val:
        return ("no_price", cat_id, "scryfall has no usd price")
    try:
        val = float(val)
    except Exception:
        return ("no_price", cat_id, f"unparseable price: {val!r}")
    if val <= 0:
        return ("no_price", cat_id, "zero price")
    source_url = data.get("purchase_uris", {}).get("tcgplayer") or data.get("scryfall_uri")
    return ("ok", cat_id, {"value": val, "source_url": source_url})


# ─── YGOPRODeck (Yu-Gi-Oh) ──────────────────────────────────────────────────
# YGOPRODeck's card data is name-keyed. Our catalog ids look like
# "ygo-sgx2-SGX2-ENE05". We try matching by name with a fallback
# chain because catalog names often carry set / variant / errata
# markers that YGOPRODeck's canonical names don't.
#
# Match strategy (first hit wins):
#   1. Exact name=<cleaned name>          (handles canonical cases)
#   2. Exact name=<bracket/paren-stripped> (strips "(Reprint)" / "[QCSE]")
#   3. fname=<base name first 3 words>     (fuzzy fallback)
#
# Each step keeps the catalog row's pricecharting_id as ground-truth
# context, but YGOPRODeck doesn't index by PC id so we can't shortcut
# the lookup.

# Common suffixes / annotations that appear in catalog names but not
# in YGOPRODeck's canonical card names. Strip before querying.
#
# Three flavors of noise:
#   1. Bracketed/parenthesized words — (Reprint), [QCSE], (Errata)
#   2. Parenthesized rarity markers — (ESR), (UR), (QCScR), (25ScR)
#      Yu-Gi-Oh has ~25 rarity codes; rather than enumerating each, we
#      match any short paren'd token of letters + optional leading digits.
#   3. Bare trailing print-run / status words — "Limited", "1st Edition",
#      "Unlimited", "Foil". These can appear without brackets.
#
# We apply them iteratively so "Snake-Eyes Poplar (ESR) Limited" goes
# (ESR) Limited → Limited → "" through three reductions.
_YGO_NAME_NOISE_RE = re.compile(
    r"\s*[\[\(](?:reprint|errata|qcse|limited|10000\s*serial|prerelease|"
    r"foil|alt\s*art|alternate\s*art|special|preview|tokens?|chinese|japanese|"
    r"korean|asian|english|european)[^\]\)]*[\]\)]\s*",
    re.IGNORECASE,
)
# Parenthesized rarity codes like (ESR), (UR), (SR), (QCScR), (25ScR),
# (PScR), (PUR), (UtR), (GR), (StR). Up to 6 alphanumeric chars in
# parens / brackets, optionally with a leading 1-2 digit number prefix.
_YGO_RARITY_PAREN_RE = re.compile(
    r"\s*[\[\(]\d{0,2}[A-Za-z]{1,6}[\]\)]\s*"
)
# Bare trailing annotations — no brackets, just space-prefixed words
# at the very end of the name. Order-sensitive: handle multi-word
# variants (1st Edition / 2nd Edition) before single-word (Limited).
_YGO_TRAILING_NOISE_RE = re.compile(
    r"\s+(?:1st\s*Edition|2nd\s*Edition|Limited|Unlimited|Foil|Reprint|"
    r"Promo|Holo|Holofoil|Tournament|Promotional|Sealed)\s*$",
    re.IGNORECASE,
)
# Trim trailing " - SET-CODE" annotations like "Dark Magician - DCR-EN083".
_YGO_TRAILING_CODE_RE = re.compile(
    r"\s*[-–—]\s*[A-Z0-9]{2,6}-[A-Z]{0,3}\d{1,3}[A-Z]?\s*$"
)

# Bracketed set-code annotations like "[DCR-EN083]" or "[QCSE-EN001]"
# that some imports embed in the name field. Different format than the
# dash-separated variant (_YGO_TRAILING_CODE_RE) — this one has
# brackets and can appear mid-name as well as at the end.
_YGO_BRACKET_CODE_RE = re.compile(
    r"\s*\[[A-Z0-9]{2,8}-[A-Z]{0,4}\d{1,4}[A-Z]?\]\s*"
)

def _ygo_clean_name(raw):
    s = (raw or "").strip()
    # Iteratively peel suffixes — "(ESR) Limited" stacks two distinct
    # patterns at the end. Each stripper substitutes a space (not the
    # empty string) so adjacent words stay separated; the final
    # whitespace-collapse step inside the loop normalizes runs of
    # spaces and trims edges before the next pass evaluates trailing
    # patterns.
    for _ in range(4):
        prev = s
        s = _YGO_NAME_NOISE_RE.sub(" ", s)
        s = _YGO_RARITY_PAREN_RE.sub(" ", s)
        s = _YGO_BRACKET_CODE_RE.sub(" ", s)
        # Collapse whitespace BEFORE checking trailing patterns so
        # "PoplarLimited" never appears and the trailing matcher
        # actually sees the " Limited" suffix.
        s = re.sub(r"\s+", " ", s).strip()
        s = _YGO_TRAILING_NOISE_RE.sub("", s)
        s = _YGO_TRAILING_CODE_RE.sub("", s)
        s = re.sub(r"\s+", " ", s).strip()
        if s == prev:
            break
    return s


def _ygo_query(url, headers={"User-Agent": "PathBinder/1.0"}):
    r = requests.get(url, timeout=15, headers=headers)
    if r.status_code in (400, 404):
        return None
    if r.status_code == 429:
        time.sleep(1.0)
        r = requests.get(url, timeout=15, headers=headers)
    r.raise_for_status()
    payload = r.json() or {}
    cards = payload.get("data") or []
    return cards or None


def fetch_yugioh_price(catalog_row):
    cat_id = catalog_row["id"]
    raw_name = (catalog_row.get("name") or "").strip()
    if not raw_name:
        return ("not_found", cat_id, "missing name")

    base   = _ygo_clean_name(raw_name)
    # Stage 1: exact name lookup with the cleaned name.
    # Stage 2: if cleaning changed anything, retry exact with raw name too.
    # Stage 3: fuzzy fname on first 3 words of base name (handles archetype
    #          versioning like "Number 39: Utopia").
    attempts = []
    if base:
        attempts.append(("name", base))
    if raw_name and raw_name != base:
        attempts.append(("name", raw_name))
    base_first_words = " ".join(base.split()[:3]) if base else ""
    if base_first_words and base_first_words != base:
        attempts.append(("fname", base_first_words))

    cards = None
    last_err = None
    used_query = None
    for param, qval in attempts:
        url = f"https://db.ygoprodeck.com/api/v7/cardinfo.php?{param}={requests.utils.quote(qval)}"
        try:
            cards = _ygo_query(url)
        except Exception as e:
            last_err = e
            continue
        if cards:
            used_query = f"{param}={qval}"
            break

    if not cards:
        if last_err:
            return ("failed", cat_id, f"http: {last_err}")
        return ("not_found", cat_id, f"no ygoprodeck match for name={raw_name!r}")

    # Pick the closest-named card if fname returned multiple. Exact-name
    # lookups return 1 result; fname can return many.
    target_lower = base.lower()
    best_card = cards[0]
    if len(cards) > 1 and target_lower:
        for c in cards:
            if (c.get("name") or "").lower() == target_lower:
                best_card = c
                break

    cp_list = (best_card.get("card_prices") or [])
    for cp in cp_list:
        raw = cp.get("tcgplayer_price")
        try:
            val = float(raw)
            if val > 0:
                source_url = best_card.get("ygoprodeck_url")
                return ("ok", cat_id, {"value": val, "source_url": source_url})
        except (TypeError, ValueError):
            continue
    return ("no_price", cat_id, f"matched {best_card.get('name')!r} via {used_query} but no tcgplayer_price")


# ─── Game runner ────────────────────────────────────────────────────────────
# Each game has a fetch func + a rate limit to respect.
GAME_CONFIG = {
    "pokemon": {
        "fetch":      fetch_pokemon_price,
        "rate":       20,   # pokemontcg.io allows 20 req/sec on default tier
        "workers":    8,
        "description": "Pokemon EN via pokemontcg.io",
    },
    "magic":   {
        "fetch":      fetch_magic_price,
        "rate":       10,   # Scryfall asks for 10 req/sec max, no auth needed
        "workers":    6,
        "description": "Magic via Scryfall",
    },
    "yugioh":  {
        "fetch":      fetch_yugioh_price,
        "rate":       15,   # YGOPRODeck tolerates ~20/sec, leave headroom
        "workers":    6,
        "description": "Yu-Gi-Oh via YGOPRODeck",
    },
}

# Token-bucket-style rate limiter per game.
_rate_locks = {}
_last_request = {}
def _pace(game, rate_per_sec):
    """Block briefly so the aggregate request rate stays under
    `rate_per_sec`. Implemented as a strict min-interval gate, which
    is easier to reason about than token buckets when you only care
    about the steady-state ceiling."""
    lock = _rate_locks.setdefault(game, threading.Lock())
    min_interval = 1.0 / max(rate_per_sec, 1)
    with lock:
        last = _last_request.get(game, 0.0)
        wait = (last + min_interval) - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_request[game] = time.time()


def process_row(row, game, fetch_func, rate, dry_run):
    """Fetch one price and write it. Each thread paces itself through
    _pace() so the aggregate rate across workers stays under `rate`."""
    _pace(game, rate)
    status, cat_id, payload = fetch_func(row)
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

    rows = load_catalog(game, limit)
    _log(f"  {len(rows):,} catalog rows in scope.")
    if not rows:
        _log("  Nothing to do.")
        return

    stats = {"updated": 0, "would_update": 0, "not_found": 0,
             "no_price": 0, "failed": 0}

    # Cap the number of inline-logged not_found rows so the output
    # stays readable on big runs but the first batch is visible for
    # diagnosing matcher misses (essential while we're tuning).
    not_found_log_cap = 15
    not_found_logged = 0

    with ThreadPoolExecutor(max_workers=cfg["workers"]) as pool:
        futs = [pool.submit(process_row, r, game, cfg["fetch"], cfg["rate"], dry_run) for r in rows]
        for i, fut in enumerate(as_completed(futs), start=1):
            status, cat_id, detail = fut.result()
            stats[status] = stats.get(status, 0) + 1
            if status == "failed":
                _log(f"    [{i:>5}/{len(rows)}] FAIL {cat_id:<28s} {detail}")
            elif status in ("not_found", "no_price") and not_found_logged < not_found_log_cap:
                not_found_logged += 1
                _log(f"    [{i:>5}/{len(rows)}] {status:<10s} {cat_id:<28s} {detail}")
                if not_found_logged == not_found_log_cap:
                    _log(f"    (further not_found/no_price rows suppressed; "
                         f"see summary below for totals)")
            elif i % 500 == 0:
                _log(f"    [{i:>5}/{len(rows)}] updated:{stats['updated']:,}  "
                     f"no_price:{stats['no_price']:,}  not_found:{stats['not_found']:,}")

    _log(f"\n  {game} summary:")
    _log(f"    Updated     : {stats['updated']:,}")
    if dry_run:
        _log(f"    Would update: {stats['would_update']:,}")
    _log(f"    No price    : {stats['no_price']:,}")
    _log(f"    Not found   : {stats['not_found']:,}")
    _log(f"    Failed      : {stats['failed']:,}")


# ─── Main ───────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description="Sync TCGplayer prices into card_prices via free-tier APIs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--game",    default="all",
                    help="Which TCG to sync: pokemon, magic, yugioh, or all.")
    ap.add_argument("--limit",   type=int, default=None,
                    help="Cap catalog rows per game (smoke testing).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Fetch prices, don't write to card_prices.")
    args = ap.parse_args()

    games = list(GAME_CONFIG.keys()) if args.game == "all" else [args.game]
    for g in games:
        if g not in GAME_CONFIG:
            _log(f"  Unknown game '{g}'. Valid: pokemon, magic, yugioh, all.")
            continue
        run_game(g, args.limit, args.dry_run)


if __name__ == "__main__":
    main()
