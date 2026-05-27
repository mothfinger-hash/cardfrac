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

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
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

_thread_jitter = threading.local()

def _pace(min_s=0.7, max_s=1.5):
    """Per-worker sleep to avoid synchronized bursts. Default values
    are tuned for scraping (PC throttles scrapers aggressively). API
    callers pass much smaller values via _pace_api()."""
    last = getattr(_thread_jitter, "last", 0)
    now  = time.time()
    delay = random.uniform(min_s, max_s)
    if now - last < delay:
        time.sleep(delay - (now - last))
    _thread_jitter.last = time.time()


def _pace_api():
    """Lighter pacing for API mode — PC's published rate limit is
    generous (60 req/sec on the paid tier as of 2026), so we only
    need a small jitter to avoid synchronized bursts across workers."""
    _pace(0.03, 0.08)


def fetch_pc_page(url):
    """GET the PC product page with exponential backoff on 403/429.
    Used in scrape mode only."""
    _pace()
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


def fetch_pc_api(pc_id):
    """API mode — query PriceCharting's product endpoint by ID and
    return (price, raw_response). PC returns prices in CENTS as
    integer fields:
      loose-price   — raw / ungraded (this is what we want for cards)
      cib-price     — complete-in-box (sealed product equivalent)
      new-price     — sealed / mint (closest to PSA 10 for graded)
      graded-price  — graded-card-specific, when available

    For TCG singles, loose-price IS the ungraded market price (matches
    what the scrape was reading). For sealed products, loose-price is
    typically zero — fall back to cib-price for those.

    Returns float dollars or None if no price field is populated.
    Raises RuntimeError on transport / HTTP / parse failures so the
    caller can decide whether to fall back to scraping.
    """
    if not PC_API_KEY:
        raise RuntimeError("PRICECHARTING_API_KEY not set")
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
            try:
                data = r.json()
            except Exception as e:
                raise RuntimeError(f"json decode: {e}")
            # Prefer loose-price; fall back to cib-price (sealed product
            # case where loose isn't meaningful); finally new-price.
            for field in ("loose-price", "cib-price", "new-price"):
                cents = data.get(field)
                if cents is not None and cents > 0:
                    return cents / 100.0, data
            # No usable price field — return None but don't error.
            return None, data
        if r.status_code in RETRY_STATUSES:
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
    """
    rid    = row["id"]
    pc_id  = row.get("pricecharting_id")
    url    = row.get("price_source_url") or row.get("market_price_source")

    api_eligible = bool(PC_API_KEY and pc_id and not force_scrape)
    price        = None
    mode_used    = None

    if api_eligible:
        try:
            api_result = fetch_pc_api(pc_id)
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
        return (rid, "failed", f"no price ({mode_used})", None)

    if dry_run:
        return (rid, "dry", f"would set ${price:.2f} via {mode_used}", price)

    # Update catalog current_value (best-effort — history is the
    # authoritative source for movers anyway).
    try:
        pg_patch_catalog(rid, {"current_value": price})
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
                    help="Parallel HTTP workers. Default auto-picks 20 if API key is "
                         "available (fast path), 3 if scrape-only (PC rate-limits).")
    ap.add_argument("--limit",   type=int, default=0, help="Stop after N rows (debug).")
    ap.add_argument("--dry-run", action="store_true", help="Fetch + parse, but don't write.")
    ap.add_argument("--resume",  action="store_true",
                    help="Skip rows already in catalog_price_history for today's date.")
    ap.add_argument("--force-scrape", action="store_true",
                    help="Bypass API mode even when key + pricecharting_id are available "
                         "(useful for debugging or if PC API is down).")
    args = ap.parse_args()

    # Auto-pick workers based on which mode we'll be running in.
    # API mode: PC's published rate limit on the paid tier handles
    # ~30-60 req/sec comfortably; 20 workers with light pacing is
    # safe. Scrape mode: PC actively rate-limits scrapers, 3 is the
    # historical sustainable value.
    if args.workers == 0:
        args.workers = 3 if (args.force_scrape or not PC_API_KEY) else 20

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
    stats = {"done": 0, "failed": 0, "skipped": 0, "dry": 0, "completed": 0}
    started = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_row, r, args.dry_run, args.force_scrape): r for r in rows}
        for f in as_completed(futs):
            rid, status, detail, _ = f.result()
            with _lock:
                stats[status] = stats.get(status, 0) + 1
                stats["completed"] += 1
                n = stats["completed"]
                if status == "failed":
                    print(f"  [{n:>6}/{len(rows)}] FAIL {rid}  — {detail}")
                elif n % 50 == 0 or n == len(rows):
                    elapsed = time.time() - started
                    rate = n / elapsed if elapsed else 0
                    remaining = (len(rows) - n) / rate / 60 if rate else 0
                    parts = " ".join(f"{k}={v}" for k, v in stats.items() if k != "completed")
                    print(f"  [{n:>6}/{len(rows)}] {parts}  ({rate:.1f}/s, {remaining:.0f}min left)")

    elapsed = time.time() - started
    print(f"\n  Finished in {elapsed/60:.1f} min. " +
          " ".join(f"{k}={v}" for k, v in stats.items() if k != "completed"))


if __name__ == "__main__":
    main()
