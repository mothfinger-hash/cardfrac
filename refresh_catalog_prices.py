#!/usr/bin/env python3
"""
PathBinder — Global Catalog Price Refresh
===========================================
Walks every catalog row of the targeted TCG that has a price_source_url,
fetches the current ungraded market price from PriceCharting, updates
catalog.current_value, and writes a daily snapshot to
catalog_price_history. Powers the dashboard Price Movers panel with
global market data (not just the user's collection).

Run nightly at ~3am via cron / launchd / GitHub Actions. Idempotent on
catalog_price_history thanks to UNIQUE(catalog_id, recorded_at).

PREREQUISITES:
    pip3 install requests --break-system-packages
    Migration: migration_catalog_price_history.sql applied

USAGE:
    # Pokemon only (~50K rows). Default workers + pacing — about 4-6h.
    python3 refresh_catalog_prices.py --tcg pokemon

    # Dry-run on first 20 rows (no writes)
    python3 refresh_catalog_prices.py --tcg pokemon --limit 20 --dry-run

    # Restart-friendly — skip rows whose history already has TODAY's row
    python3 refresh_catalog_prices.py --tcg pokemon --resume

    # Crank workers (PC will 429 if too aggressive — start at 3)
    python3 refresh_catalog_prices.py --tcg pokemon --workers 4

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key

CRON SETUP (Mac, nightly 3am local time):
    crontab -e
    0 3 * * * cd /Users/charleshewitt/Desktop/cardfrac \\
        && SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \\
        python3 refresh_catalog_prices.py --tcg pokemon --resume \\
        >> /tmp/refresh_catalog.log 2>&1

GITHUB ACTIONS:
    See .github/workflows/refresh-prices.yml example in repo notes.
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
    """Per-worker sleep to avoid synchronized bursts."""
    last = getattr(_thread_jitter, "last", 0)
    now  = time.time()
    delay = random.uniform(min_s, max_s)
    if now - last < delay:
        time.sleep(delay - (now - last))
    _thread_jitter.last = time.time()


def fetch_pc_page(url):
    """GET the PC product page with exponential backoff on 403/429."""
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
def load_catalog(game_type, only_pokemon, resume):
    """Pull every catalog row of the target TCG with a price_source_url.
    With --resume, skips rows that already have today's history entry."""
    print(f"\n  Loading catalog rows for game_type='{game_type}'…")
    rows = []
    offset = 0
    PAGE = 1000
    while True:
        # Catalog has TWO URL columns depending on schema vintage:
        #   - market_price_source  (older Pokemon catalog rows)
        #   - price_source_url     (newer TCG syncs: sealed / pc_singles_enrich)
        # SELECT both, filter with PostgREST OR so a row qualifies if
        # EITHER is non-null.
        params = {
            "select":           "id,name,game_type,set_code,price_source_url,market_price_source",
            "or":               "(price_source_url.not.is.null,market_price_source.not.is.null)",
            "limit":            str(PAGE),
            "offset":           str(offset),
        }
        if only_pokemon:
            params["game_type"] = "eq.pokemon"
        elif game_type:
            params["game_type"] = f"eq.{game_type}"
        chunk = pg_get("catalog", params=params)
        rows.extend(chunk)
        if len(chunk) < PAGE:
            break
        offset += PAGE
    print(f"  {len(rows):,} catalog rows with price_source_url.")

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


def process_row(row, dry_run=False):
    """Fetch PC, parse price, write back to catalog + history.
    Prefers price_source_url when present (newer schema); falls back to
    market_price_source (older Pokemon schema)."""
    rid = row["id"]
    url = row.get("price_source_url") or row.get("market_price_source")
    if not url:
        return (rid, "skipped", "no price URL", None)

    try:
        html = fetch_pc_page(url)
    except Exception as e:
        return (rid, "failed", f"fetch: {e}", None)

    price = parse_price(html)
    if price is None:
        return (rid, "failed", "no price found in page", None)

    if dry_run:
        return (rid, "dry", f"would set ${price:.2f}", price)

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
                         "Pass 'magic' / 'yugioh' / 'op' / etc. when ready to extend.")
    ap.add_argument("--workers", type=int, default=3,
                    help="Parallel HTTP workers (default 3 — PC rate-limits aggressively).")
    ap.add_argument("--limit",   type=int, default=0, help="Stop after N rows (debug).")
    ap.add_argument("--dry-run", action="store_true", help="Fetch + parse, but don't write.")
    ap.add_argument("--resume",  action="store_true",
                    help="Skip rows already in catalog_price_history for today's date.")
    args = ap.parse_args()

    only_pokemon = args.tcg.lower() == "pokemon"
    rows = load_catalog(args.tcg, only_pokemon, args.resume)
    if args.limit:
        rows = rows[:args.limit]
    if not rows:
        print("  Nothing to do.")
        return

    eta_min = len(rows) * 1.2 / args.workers / 60
    print(f"  Processing {len(rows):,} rows with {args.workers} workers — ETA ~{eta_min:.0f} min")
    print(f"  {'DRY RUN' if args.dry_run else 'WRITING TO catalog + catalog_price_history'}")
    print(f"  Starting in 3s — Ctrl+C to abort\n")
    time.sleep(3)

    _lock = threading.Lock()
    stats = {"done": 0, "failed": 0, "skipped": 0, "dry": 0, "completed": 0}
    started = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_row, r, args.dry_run): r for r in rows}
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
