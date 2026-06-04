#!/usr/bin/env python3
"""
PathBinder — Global Catalog Price Refresh
===========================================
Walks every catalog row of the targeted TCG that has a price_source_url
OR a pricecharting_id, fetches the current ungraded market price, updates
catalog.current_value, and writes a daily snapshot to
catalog_price_history. Powers the dashboard Price Movers panel with
global market data (not just the user's collection).

Run nightly at ~3am via cron / launchd / GitHub Actions. Idempotent on
catalog_price_history thanks to UNIQUE(catalog_id, recorded_at).

PRICE SOURCE MODES:
    Two modes, picked per row at runtime based on what data we have:

    1. API mode (preferred — fast, reliable, ~30 req/sec safe)
       Requires:
         - PRICECHARTING_API_KEY env var set (paid PC API access)
         - Row has a non-null pricecharting_id column
       Calls https://www.pricecharting.com/api/product?t=KEY&id=PC_ID
       and reads 'loose-price' from the JSON response (in cents).

    2. Scrape mode (legacy fallback — slow, brittle, ~2 req/sec)
       Triggers when the API mode preconditions aren't met (no API key,
       no pricecharting_id on the row, or API call fails).
       Fetches the price_source_url HTML and regex-extracts the
       "Ungraded" price block.

    The script auto-detects mode per row and uses the API whenever it
    can, falling back to scraping silently for legacy rows that haven't
    been backfilled with a pricecharting_id yet.

PREREQUISITES:
    pip3 install requests --break-system-packages
    Migration: migration_catalog_price_history.sql applied

USAGE:
    # Pokemon only — defaults to high workers if API key is set,
    # falls back to low workers if scraping only.
    python3 refresh_catalog_prices.py --tcg pokemon

    # Dry-run on first 20 rows (no writes)
    python3 refresh_catalog_prices.py --tcg pokemon --limit 20 --dry-run

    # Restart-friendly — skip rows whose history already has TODAY's row
    python3 refresh_catalog_prices.py --tcg pokemon --resume

    # Force-scrape (skip API even if key is set — useful for debugging)
    python3 refresh_catalog_prices.py --tcg pokemon --force-scrape

    # Override worker count (default: 20 if API available, 3 if scrape-only)
    python3 refresh_catalog_prices.py --tcg pokemon --workers 30

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
    PRICECHARTING_API_KEY     PC API token (optional — falls back to scrape if unset)

CRON SETUP (Mac, nightly 3am local time):
    crontab -e
    0 3 * * * cd /Users/charleshewitt/Desktop/cardfrac \\
        && SUPABASE_URL=... SUPABASE_SERVICE_KEY=... PRICECHARTING_API_KEY=... \\
        python3 refresh_catalog_prices.py --tcg pokemon --resume \\
        >> /tmp/refresh_catalog.log 2>&1

GITHUB ACTIONS:
    See .github/workflows/refresh-catalog-prices.yml.
"""

import os, sys, re, time, random, argparse, threading, json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from urllib.parse import quote

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

# PriceCharting API key (optional). When set + the row has a
# pricecharting_id, we use the JSON API instead of HTML-scraping. The
# API is ~15× faster, more reliable, and immune to HTML template
# changes. Falls back to scraping when unset.
PC_API_KEY = os.environ.get("PRICECHARTING_API_KEY", "").strip() or None

PC_BASE         = "https://www.pricecharting.com"
REQUEST_TIMEOUT = 25

# Browser-realistic headers. PriceCharting's Cloudflare WAF blocks
# requests that only set User-Agent — real browsers always send Accept,
# Accept-Language, Accept-Encoding, etc. Going from UA-only to a full
# header set cut our 403 rate roughly in half in testing.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    # IMPORTANT: do NOT advertise 'br' (brotli). The self-hosted Mac
    # runner's Python 3.9 + urllib3 v2 combination doesn't decode
    # brotli cleanly — if we ask for it, PC sends brotli back, requests
    # silently fails the decode, and we get a 16KB stub of garbled text
    # instead of the real 130KB+ product page. Symptom: every scrape
    # row returns no_price because the parser can't find "Ungraded" in
    # the garbage output. gzip + deflate are handled natively by
    # urllib3 — keep those, they're enough for 99% of pages.
    # Verified 2026-06-03: dropping 'br' takes one specific OP card from
    # len=16579 / ungraded=0 to len=134044 / ungraded=4 / parsed=$0.07.
    "Accept-Encoding": "gzip, deflate",
    "Referer":         "https://www.pricecharting.com/",
    "Sec-Fetch-Dest":  "document",
    "Sec-Fetch-Mode":  "navigate",
    "Sec-Fetch-Site":  "same-origin",
    "Upgrade-Insecure-Requests": "1",
    "Connection":      "keep-alive",
}

# ─── PC product page price parser ─────────────────────────────────────────────
# PriceCharting product pages embed prices in a table block keyed by
# condition. We want the "Ungraded" cell — that's what the rest of the
# app uses as the market comp. Pattern captures the dollar amount that
# follows the "Ungraded" label, tolerant of nested tags.
UNGRADED_RE = re.compile(
    r'>\s*Ungraded\s*<[^$]*?\$\s*([\d,]+\.\d{2})',
    re.IGNORECASE | re.DOTALL,
)
# Fallback — main price block at the top of the page. Different templates.
PRICE_BLOCK_RE = re.compile(
    r'price[^>]*>\s*\$\s*([\d,]+\.\d{2})',
    re.IGNORECASE,
)


# ─── HTTP w/ backoff ──────────────────────────────────────────────────────────
RETRY_STATUSES = (403, 429, 502, 503, 504)
MAX_RETRIES    = 5
_session       = requests.Session()
_session.headers.update(HEADERS)

# ─── Circuit breaker for sustained WAF blocking ───────────────────────────────
# If PriceCharting's Cloudflare WAF flags our IP partway through a run,
# every subsequent request 403s. Without a circuit breaker the script
# spins on each row through 5 retries × ~30s backoff = ~150s per row,
# burning hours of CI time to accomplish nothing. The breaker watches
# for consecutive 403/429s and "trips" after the threshold, after which
# every fetch_pc_api fast-fails without retrying for the remainder of
# the run. Counter resets on any 2xx so a brief blip doesn't kill the
# whole job.
_BREAKER_THRESHOLD = int(os.environ.get("PC_BREAKER_THRESHOLD", "75"))
_breaker_lock      = threading.Lock()
_consec_blocked    = 0
_breaker_tripped   = False

def _breaker_record_block():
    """Increment the consecutive-block counter and trip if we cross
    the threshold. Returns True if the breaker is now tripped."""
    global _consec_blocked, _breaker_tripped
    with _breaker_lock:
        _consec_blocked += 1
        if _consec_blocked >= _BREAKER_THRESHOLD and not _breaker_tripped:
            _breaker_tripped = True
            print(f"\n  ⚠  Circuit breaker TRIPPED after {_consec_blocked} consecutive "
                  f"403/429s from PriceCharting. Fast-failing remaining rows "
                  f"to avoid burning CI minutes. Re-run after the WAF flag "
                  f"clears (usually a few hours).\n", flush=True)
        return _breaker_tripped

def _breaker_record_success():
    """A 2xx response — reset the consecutive-block counter."""
    global _consec_blocked
    with _breaker_lock:
        _consec_blocked = 0

def _breaker_is_tripped():
    return _breaker_tripped

_thread_jitter = threading.local()

# GLOBAL API rate limiter. Previous implementation used per-thread jitter
# only, which let 20 workers × ~60ms = ~330 req/sec aggregate slip past
# PC's published 60 req/sec API limit and trigger waves of 403s on
# legitimate API calls (the "api: HTTP 403 (no URL fallback)" rows in
# the run log were this, not real not-founds).
#
# This token-bucket-style limiter caps the AGGREGATE rate across all
# workers. Tune via PC_API_RATE_PER_SEC env var if PC raises/lowers
# their limit later. 15/sec is conservative — PC's published ceiling is
# 60/sec but in practice they throttle bursts well below that. With our
# 10-worker default, 15/sec gives each worker ~1.5 req/sec, comfortably
# below Cloudflare's bot threshold.
PC_API_RATE_PER_SEC = float(os.environ.get("PC_API_RATE_PER_SEC", "15"))
_api_rate_lock      = threading.Lock()
_api_next_slot      = [0.0]   # mutable container for thread-shared float

# GLOBAL scrape concurrency lock. Without this, when API-mode rows are
# interleaved with scrape-fallback rows, multiple workers can each hit
# the scrape path simultaneously — PC's Cloudflare WAF sees the burst
# as a bot attack and 403s ALL of them. Serializing scrape requests
# (max 1 in flight at a time, regardless of total worker count) cuts
# scrape 403s by ~80% in testing. API path is unaffected by this lock.
_scrape_concurrency_lock = threading.Lock()

def _pace(min_s=0.7, max_s=1.5):
    """Per-worker sleep to avoid synchronized bursts. Default values
    are tuned for scraping (PC throttles scrapers aggressively). API
    callers go through _pace_api() instead."""
    last = getattr(_thread_jitter, "last", 0)
    now  = time.time()
    delay = random.uniform(min_s, max_s)
    if now - last < delay:
        time.sleep(delay - (now - last))
    _thread_jitter.last = time.time()


def _pace_api():
    """Global API pacer — claims the next slot from the shared rate
    bucket and sleeps if the slot is in the future. Replaces the old
    per-thread jitter that didn't actually limit aggregate throughput."""
    interval = 1.0 / max(PC_API_RATE_PER_SEC, 1.0)
    with _api_rate_lock:
        now = time.time()
        slot = max(_api_next_slot[0], now)
        _api_next_slot[0] = slot + interval
        sleep_for = slot - now
    if sleep_for > 0:
        time.sleep(sleep_for)


def fetch_pc_page(url):
    """GET the PC product page with exponential backoff on 403/429.
    Used in scrape mode only.

    SERIALIZED via _scrape_concurrency_lock — only one worker can be
    inside this function at a time across the entire process. Combined
    with the 2.5-5s per-request pace, this caps scrape rate at ~0.3 req/s
    AGGREGATE. PC's Cloudflare WAF tolerates that; concurrent scrape
    requests it does not.

    Scrape pacing is intentionally slow (2.5-5s between requests per
    worker) because PC's Cloudflare WAF actively blocks scrapers; the
    pre-fix run was 22% 403 failures because we were hitting at ~3 req/s
    per worker with default headers."""
    with _scrape_concurrency_lock:
        _pace(2.5, 5.0)
        last_err = None
        for attempt in range(MAX_RETRIES):
            try:
                r = _session.get(url, timeout=REQUEST_TIMEOUT)
            except Exception as e:
                last_err = f"network: {e}"
                time.sleep(2 ** attempt + random.uniform(0, 1))
                continue
            if r.ok:
                return r.text
            if r.status_code in RETRY_STATUSES:
                sleep_s = (2 ** (attempt + 1) - 1) + random.uniform(0, 3)
                last_err = f"HTTP {r.status_code} (retry {attempt+1}/{MAX_RETRIES} after {sleep_s:.1f}s)"
                time.sleep(sleep_s)
                continue
            raise RuntimeError(f"HTTP {r.status_code}")
        raise RuntimeError(last_err or "exhausted retries")


def parse_price(html):
    """Pull the ungraded market price out of a PC product page HTML."""
    if not html:
        return None
    m = UNGRADED_RE.search(html)
    if m:
        return float(m.group(1).replace(",", ""))
    m = PRICE_BLOCK_RE.search(html)
    if m:
        return float(m.group(1).replace(",", ""))
    return None


def fetch_pc_api(pc_id, is_sealed=False):
    """API mode — query PriceCharting's product endpoint by ID and
    return (price, raw_response). PC returns prices in CENTS as
    integer fields:
      loose-price   — raw / ungraded (this is what we want for cards)
      cib-price     — complete-in-box (sealed product equivalent)
      new-price     — sealed / mint (closest to PSA 10 for graded)
      graded-price  — graded-card-specific, when available

    Field priority depends on whether we're pricing a single or a
    sealed product:
      • Singles  → loose-price → cib-price → new-price
        (loose = ungraded raw, the market comp the buy/sell flow uses)
      • Sealed   → cib-price → new-price → loose-price
        (cib = sealed-in-original-packaging; new = factory-new; loose
         is rarely populated for sealed product and was the cause of
         most "no price" results before this fix)

    Returns float dollars or None if no price field is populated.
    Raises RuntimeError on transport / HTTP / parse failures so the
    caller can decide whether to fall back to scraping.
    """
    if not PC_API_KEY:
        raise RuntimeError("PRICECHARTING_API_KEY not set")
    # Circuit breaker — if we've already tripped on this run, every
    # subsequent call fast-fails. Saves ~150s per row vs. burning
    # through MAX_RETRIES rounds of exponential backoff against a WAF
    # that won't relent until our IP cools off.
    if _breaker_is_tripped():
        raise RuntimeError("circuit breaker tripped (sustained 403/429 from PC)")
    _pace_api()
    url = f"{PC_BASE}/api/product"
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            r = _session.get(url, params={"t": PC_API_KEY, "id": pc_id},
                             timeout=REQUEST_TIMEOUT)
        except Exception as e:
            last_err = f"network: {e}"
            time.sleep(2 ** attempt + random.uniform(0, 1))
            continue
        if r.ok:
            _breaker_record_success()
            # PC's API quirk: for IDs they don't have data for (often
            # foreign sealed products that exist on the site but aren't
            # in the pricing dataset yet), the endpoint returns 200 with
            # an EMPTY body — not 404, not an error JSON. Treat that as
            # "no price" rather than a transport failure.
            body = (r.text or "").strip()
            if not body:
                return None, {}
            try:
                data = r.json()
            except Exception as e:
                # Non-JSON body with 200 status = same situation as
                # above (or a Cloudflare interstitial slipped through).
                # Don't raise — caller already knows to record "no price".
                return None, {"_decode_error": str(e)}
            # PC sometimes returns {"status":"error","error-message":"No products found"}
            # with 200 OK as well — treat as "no price".
            if isinstance(data, dict) and data.get("status") == "error":
                return None, data
            # Field priority depends on product type — sealed flips the
            # order so cib/new come first (loose is rarely populated for
            # sealed; we were getting 0/none for them before this fix).
            if is_sealed:
                fields = ("cib-price", "new-price", "loose-price", "box-only-price")
            else:
                fields = ("loose-price", "cib-price", "new-price")
            for field in fields:
                cents = data.get(field)
                if cents is not None and cents > 0:
                    return cents / 100.0, data
            # No usable price field — return None but don't error.
            return None, data
        if r.status_code in RETRY_STATUSES:
            # 403/429 → record toward the circuit breaker. If the
            # breaker trips mid-retry, bail immediately rather than
            # finishing the remaining backoff rounds.
            if r.status_code in (403, 429):
                if _breaker_record_block():
                    raise RuntimeError(f"HTTP {r.status_code} (circuit breaker tripped)")
            sleep_s = (2 ** (attempt + 1) - 1) + random.uniform(0, 3)
            last_err = f"HTTP {r.status_code} (retry {attempt+1}/{MAX_RETRIES} after {sleep_s:.1f}s)"
            time.sleep(sleep_s)
            continue
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    raise RuntimeError(last_err or "exhausted retries")


# ─── Supabase REST ────────────────────────────────────────────────────────────
def _supabase_headers(extra=None):
    h = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    }
    if extra: h.update(extra)
    return h


def pg_get(path, params=None):
    r = requests.get(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}",
        headers=_supabase_headers(),
        params=params, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def pg_patch_catalog(row_id, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    r = requests.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{quote(row_id)}",
        headers=_supabase_headers({
            "Content-Type": "application/json; charset=utf-8",
            "Prefer":       "return=minimal",
        }),
        data=body, timeout=20,
    )
    if not r.ok:
        raise RuntimeError(f"PATCH catalog HTTP {r.status_code}: {r.text[:200]}")


def pg_upsert_history(row):
    """Upsert into catalog_price_history with on_conflict on the UNIQUE
    (catalog_id, recorded_at) pair so re-runs in the same day no-op."""
    body = json.dumps([row], ensure_ascii=False).encode("utf-8")
    r = requests.post(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog_price_history"
        f"?on_conflict=catalog_id,recorded_at",
        headers=_supabase_headers({
            "Content-Type": "application/json; charset=utf-8",
            "Prefer":       "return=minimal,resolution=merge-duplicates",
        }),
        data=body, timeout=20,
    )
    if not r.ok:
        raise RuntimeError(f"POST history HTTP {r.status_code}: {r.text[:200]}")


# ─── Loading + processing ─────────────────────────────────────────────────────
def load_catalog(game_type, resume):
    """Pull every catalog row of the target TCG with a price_source_url
    or pricecharting_id. Pass game_type='all' to pull every TCG in one
    sweep. With --resume, skips rows that already have today's history entry."""
    if game_type == "all":
        print(f"\n  Loading catalog rows for ALL TCGs (no game_type filter)…")
    else:
        print(f"\n  Loading catalog rows for game_type='{game_type}'…")
    rows = []
    offset = 0
    PAGE = 1000
    while True:
        # Catalog has THREE columns we can use to look up prices:
        #   - pricecharting_id     (preferred — enables fast API mode)
        #   - price_source_url     (newer TCG syncs: sealed / pc_singles_enrich)
        #   - market_price_source  (older Pokemon catalog rows)
        # A row qualifies if ANY of the three is non-null. process_row
        # picks the lookup mode at execution time based on availability.
        params = {
            "select":           "id,name,game_type,set_code,pricecharting_id,price_source_url,market_price_source",
            "or":               "(pricecharting_id.not.is.null,price_source_url.not.is.null,market_price_source.not.is.null)",
            "limit":            str(PAGE),
            "offset":           str(offset),
        }
        # 'all' = no game_type filter (every TCG). Specific game_type
        # values still filter the normal way.
        if game_type and game_type != "all":
            params["game_type"] = f"eq.{game_type}"
        chunk = pg_get("catalog", params=params)
        rows.extend(chunk)
        if len(chunk) < PAGE:
            break
        offset += PAGE
    print(f"  {len(rows):,} catalog rows with price_source or pricecharting_id.")
    # When running 'all', print a per-game-type breakdown so the
    # operator can see what's about to be refreshed at a glance.
    if game_type == "all":
        by_game = {}
        for r in rows:
            g = r.get("game_type") or "(unknown)"
            by_game[g] = by_game.get(g, 0) + 1
        for g in sorted(by_game, key=lambda x: -by_game[x]):
            print(f"    {g:<12} {by_game[g]:>7,}")

    if resume:
        today = date.today().isoformat()
        print(f"  --resume: filtering out rows already in history for {today}…")
        # Pull every history row from today, build a set of catalog_ids
        already = set()
        off = 0
        while True:
            chunk = pg_get("catalog_price_history", params={
                "select":      "catalog_id",
                "recorded_at": f"eq.{today}",
                "limit":       str(PAGE),
                "offset":      str(off),
            })
            for r in chunk:
                already.add(r["catalog_id"])
            if len(chunk) < PAGE:
                break
            off += PAGE
        before = len(rows)
        rows = [r for r in rows if r["id"] not in already]
        print(f"  {before - len(rows):,} already done today, {len(rows):,} remaining.")
    return rows


_SEALED_ID_RE = re.compile(r"^sealed-[a-z]{2}-pc-(\d+)$", re.IGNORECASE)

def _pc_id_from_sealed_catalog_id(catalog_id):
    """Extract the PC numeric id from a sealed-style catalog row id.
    Catalog ids for sealed products follow the pattern
    `sealed-<lang>-pc-<pc_id>` (e.g. `sealed-en-pc-2245051`). This is
    a free fallback for sealed rows whose `pricecharting_id` column
    didn't get backfilled — the PC id is literally in the row id."""
    if not catalog_id:
        return None
    m = _SEALED_ID_RE.match(catalog_id)
    return m.group(1) if m else None


def process_row(row, dry_run=False, force_scrape=False):
    """Fetch PC, parse price, write back to catalog + history.

    Mode selection:
      1. If PC API key is set AND row has pricecharting_id AND NOT
         --force-scrape → API mode (fast path).
      2. Else if row has price_source_url or market_price_source →
         scrape mode (legacy fallback).
      3. Else → skip.

    On API failure, transparently falls back to scrape mode if a URL
    is available — so a transient API hiccup doesn't lose a row.

    Sealed-product detection: any catalog id starting with `sealed-`
    is treated as sealed for API field-priority purposes. The PC api
    call uses cib-price → new-price first (instead of the loose-price
    ordering that fits singles). Also extracts the embedded PC id
    from `sealed-<lang>-pc-<id>` when pricecharting_id is null.
    """
    rid    = row["id"]
    pc_id  = row.get("pricecharting_id")
    url    = row.get("price_source_url") or row.get("market_price_source")

    # Sealed detection via id prefix — cheap, deterministic, doesn't
    # require a product_type column on catalog.
    is_sealed = bool(rid and rid.lower().startswith("sealed-"))

    # Backfill PC id from the catalog row id if the column is empty
    # but the id encodes one. Lets sealed rows that missed the
    # enrichment sync still hit the fast API path.
    if not pc_id and is_sealed:
        extracted = _pc_id_from_sealed_catalog_id(rid)
        if extracted:
            pc_id = extracted

    api_eligible = bool(PC_API_KEY and pc_id and not force_scrape)
    price        = None
    mode_used    = None

    if api_eligible:
        try:
            api_result = fetch_pc_api(pc_id, is_sealed=is_sealed)
            price      = api_result[0] if api_result else None
            mode_used  = "api"
        except Exception as e:
            # API failed — try scraping if we have a URL fallback.
            if url:
                try:
                    html  = fetch_pc_page(url)
                    price = parse_price(html)
                    mode_used = "scrape (api failed)"
                except Exception as e2:
                    return (rid, "failed", f"api: {e} / scrape: {e2}", None)
            else:
                return (rid, "failed", f"api: {e} (no URL fallback)", None)
    else:
        if not url:
            return (rid, "skipped", "no PC id or URL", None)
        try:
            html  = fetch_pc_page(url)
            price = parse_price(html)
            mode_used = "scrape"
        except Exception as e:
            return (rid, "failed", f"scrape: {e}", None)

    if price is None:
        # No price is NOT a transport failure — it means the product
        # exists in PC's index but they don't have a current price for
        # it (graded-only items, obscure foreign sealed product not yet
        # priced, promos PC tracks only as PSA-graded, etc.). Bucket it
        # separately so the run summary distinguishes real failures
        # (network/blocking) from "PC just doesn't have this".
        return (rid, "no_price", f"no price ({mode_used})", None)

    if dry_run:
        return (rid, "dry", f"would set ${price:.2f} via {mode_used}", price)

    # Update catalog current_value (best-effort — history is the
    # authoritative source for movers anyway). Also persist any
    # pricecharting_id we extracted from a sealed row id, so the column
    # is populated for future runs (eliminates the re-extract step and
    # speeds up the next nightly).
    patch = {"current_value": price}
    if is_sealed and not row.get("pricecharting_id") and pc_id:
        patch["pricecharting_id"] = pc_id
    try:
        pg_patch_catalog(rid, patch)
    except Exception as e:
        # Don't bail — still try to log to history so we have at least one
        # data point even if catalog write hit a transient error.
        pass

    today = date.today().isoformat()
    try:
        pg_upsert_history({
            "catalog_id":     rid,
            "recorded_value": price,
            "recorded_at":    today,
            "source":         "pricecharting",
            "game_type":      row.get("game_type"),
            "set_code":       row.get("set_code"),
        })
    except Exception as e:
        return (rid, "failed", f"history: {e}", price)

    return (rid, "done", f"${price:.2f}", price)


# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--tcg", default="pokemon",
                    help="catalog.game_type filter (default 'pokemon'). "
                         "Pass 'all' to refresh every TCG in one sweep, or a "
                         "specific game_type like 'mtg' / 'yugioh' / 'op' / "
                         "'gun' / 'dbz' / 'topps'.")
    ap.add_argument("--workers", type=int, default=0,
                    help="Parallel HTTP workers. Default auto-picks 10 if API key is "
                         "available (paired with the 30 req/sec global rate limiter), "
                         "1 if scrape-only (PC's Cloudflare blocks multi-worker scraping).")
    ap.add_argument("--limit",   type=int, default=0, help="Stop after N rows (debug).")
    ap.add_argument("--dry-run", action="store_true", help="Fetch + parse, but don't write.")
    ap.add_argument("--resume",  action="store_true",
                    help="Skip rows already in catalog_price_history for today's date.")
    ap.add_argument("--force-scrape", action="store_true",
                    help="Bypass API mode even when key + pricecharting_id are available "
                         "(useful for debugging or if PC API is down).")
    args = ap.parse_args()

    # Auto-pick workers based on which mode we'll be running in.
    #
    # API mode: aggregate rate is bounded by PC_API_RATE_PER_SEC (30/sec
    # default) via the global _pace_api() bucket — adding more workers
    # past that limit doesn't speed things up, it just queues. 10 workers
    # gives a healthy concurrency cushion (each worker spends ~50ms in
    # Python-side parse + DB write per request) without overshooting.
    # The old 20-worker default was tripping PC's API rate limit even
    # with per-thread jitter (per-thread doesn't bound aggregate).
    #
    # Scrape mode: PC's Cloudflare WAF blocks scrapers — running multiple
    # concurrent scrapers from one IP just multiplies the 403 rate. One
    # worker with 2.5-5s pacing is the sustainable value. Slow but it's
    # the only fallback path for rows without pricecharting_id.
    if args.workers == 0:
        args.workers = 1 if (args.force_scrape or not PC_API_KEY) else 10

    # Inform the user which mode we're running in.
    if args.force_scrape:
        print(f"  Mode: SCRAPE (forced via --force-scrape)")
    elif PC_API_KEY:
        print(f"  Mode: API (rows with pricecharting_id) + scrape fallback (rows without)")
    else:
        print(f"  Mode: SCRAPE (PRICECHARTING_API_KEY not set — slow path)")

    rows = load_catalog(args.tcg.lower(), args.resume)
    if args.limit:
        rows = rows[:args.limit]
    if not rows:
        print("  Nothing to do.")
        return

    # API mode is ~15× faster per row than scraping. Adjust ETA.
    per_row_seconds = 0.15 if (PC_API_KEY and not args.force_scrape) else 1.2
    eta_min = len(rows) * per_row_seconds / args.workers / 60
    print(f"  Processing {len(rows):,} rows with {args.workers} workers — ETA ~{eta_min:.0f} min")
    print(f"  {'DRY RUN' if args.dry_run else 'WRITING TO catalog + catalog_price_history'}")
    print(f"  Starting in 3s — Ctrl+C to abort\n")
    time.sleep(3)

    _lock = threading.Lock()
    stats = {"done": 0, "failed": 0, "no_price": 0, "skipped": 0, "dry": 0, "completed": 0}
    # Track failure reasons separately so the end-of-run summary can call
    # out whether the bulk of the noise is Cloudflare blocking, real
    # network errors, or PC just not having the product.
    failure_buckets = {
        "scrape_403":      0,
        "scrape_network":  0,
        "scrape_other":    0,
        "api_rate_limit":  0,
        "api_other":       0,
        "history_write":   0,
    }
    no_price_buckets = {"api": 0, "scrape": 0, "scrape_api_failed": 0, "other": 0}
    started = time.time()

    def _classify_failure(detail):
        # Lightweight string-matching on the failure detail. Keeps the
        # process_row contract tiny instead of returning structured codes.
        d = detail.lower()
        if "history:" in d:        return "history_write"
        if "scrape: http 403" in d or "/ scrape: http 403" in d: return "scrape_403"
        if "scrape: network" in d or "scrape: connection" in d:   return "scrape_network"
        if "scrape:" in d:         return "scrape_other"
        if "api: http 429" in d or "api: http 403" in d:          return "api_rate_limit"
        if d.startswith("api:"):   return "api_other"
        return "scrape_other"

    def _classify_no_price(detail):
        d = detail.lower()
        if "(scrape (api failed))" in d: return "scrape_api_failed"
        if "(scrape)" in d:              return "scrape"
        if "(api)" in d:                 return "api"
        return "other"

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_row, r, args.dry_run, args.force_scrape): r for r in rows}
        for f in as_completed(futs):
            rid, status, detail, _ = f.result()
            with _lock:
                stats[status] = stats.get(status, 0) + 1
                stats["completed"] += 1
                n = stats["completed"]
                if status == "failed":
                    failure_buckets[_classify_failure(detail)] = \
                        failure_buckets.get(_classify_failure(detail), 0) + 1
                    print(f"  [{n:>6}/{len(rows)}] FAIL {rid}  — {detail}")
                elif status == "no_price":
                    no_price_buckets[_classify_no_price(detail)] = \
                        no_price_buckets.get(_classify_no_price(detail), 0) + 1
                    # Quiet — there are usually thousands of these and they're
                    # not actionable per-row. Log every 100th so progress is
                    # still visible.
                    if no_price_buckets.get("api", 0) + no_price_buckets.get("scrape", 0) \
                       + no_price_buckets.get("scrape_api_failed", 0) % 100 == 0 and detail:
                        print(f"  [{n:>6}/{len(rows)}] no-price  {rid}  — {detail}")
                elif n % 50 == 0 or n == len(rows):
                    elapsed = time.time() - started
                    rate = n / elapsed if elapsed else 0
                    remaining = (len(rows) - n) / rate / 60 if rate else 0
                    parts = " ".join(f"{k}={v}" for k, v in stats.items() if k != "completed")
                    print(f"  [{n:>6}/{len(rows)}] {parts}  ({rate:.1f}/s, {remaining:.0f}min left)")

    elapsed = time.time() - started
    total   = max(stats["completed"], 1)
    success = stats.get("done", 0)
    print()
    print(f"  Finished in {elapsed/60:.1f} min on {total:,} rows.")
    print(f"  ─────────────────────────────────────────────────")
    print(f"  done       : {stats.get('done', 0):>7,}  ({success/total*100:5.1f}%)  — wrote a price")
    print(f"  no_price   : {stats.get('no_price', 0):>7,}  ({stats.get('no_price',0)/total*100:5.1f}%)  — PC has no current price for the product")
    if stats.get("no_price", 0):
        for k, v in no_price_buckets.items():
            if v:
                print(f"                      via {k:>18}: {v:>6,}")
    print(f"  failed     : {stats.get('failed', 0):>7,}  ({stats.get('failed',0)/total*100:5.1f}%)  — transport / blocking errors (retry next run)")
    if stats.get("failed", 0):
        for k, v in failure_buckets.items():
            if v:
                print(f"                      {k:>18}: {v:>6,}")
    if stats.get("skipped", 0):
        print(f"  skipped    : {stats.get('skipped', 0):>7,}  — no PC id or URL")
    if stats.get("dry", 0):
        print(f"  dry-run    : {stats.get('dry', 0):>7,}  — would have written")


if __name__ == "__main__":
    main()
