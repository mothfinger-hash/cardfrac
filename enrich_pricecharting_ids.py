#!/usr/bin/env python3
"""
PathBinder — PriceCharting ID Backfill
========================================
Resolves catalog.pricecharting_id for every row that has a
catalog.price_source_url but no pricecharting_id yet.

RESOLUTION STRATEGY
-------------------
Tried API URL-lookup first (?url=...) — turns out PC's public API
doesn't expose URL-keyed lookup; first test run got 49/50 "notfound".
Switched to a hybrid approach:

  1. Scrape the product page (one-time, slowly) and extract the
     numeric product ID from the embedded HTML — PC product pages
     carry the ID in a hidden form input + as data-product-id
     attributes on the offers buttons.
  2. Optionally verify by calling /api/product?t=KEY&id=<id> and
     confirming we got valid product data back. Verification is
     skipped by default to keep the run fast — pass --verify to opt in.

This is a one-time-ish cost (~80 min for the full catalog at our
scrape rate). Subsequent enrichment runs only touch newly-added rows
that don't have an id yet, so they finish in minutes.

Why this matters
----------------
The nightly refresh_catalog_prices.py has two modes per row:
  - API mode  (requires pricecharting_id) — fast, reliable, ~30 req/s
  - Scrape mode (URL fallback)            — slow, brittle, blocked by
                                            Cloudflare half the time

Every row we backfill an ID onto moves out of the scrape path and into
the API path. The last refresh run had ~22% scrape failures; every ID
we add here directly reduces tomorrow's failure count.

USAGE
-----
    # Pokemon only, all langs, with sensible defaults
    python3 enrich_pricecharting_ids.py --tcg pokemon

    # Probe / sanity-check the first 50 rows without writing
    python3 enrich_pricecharting_ids.py --tcg pokemon --limit 50 --dry-run

    # Scope by single game_type prefix
    python3 enrich_pricecharting_ids.py --tcg mtg
    python3 enrich_pricecharting_ids.py --tcg yugioh

    # All TCGs in one sweep
    python3 enrich_pricecharting_ids.py --tcg all

    # Restart-friendly — skip rows that already have an id
    # (this is the DEFAULT behaviour; flag is for documentation)
    python3 enrich_pricecharting_ids.py --tcg pokemon --resume

ENVIRONMENT
-----------
    SUPABASE_URL             your project URL
    SUPABASE_SERVICE_KEY     service-role key (bypasses RLS for catalog writes)
    PRICECHARTING_API_KEY    only required if --verify is passed; the ID
                             extraction itself doesn't use the API
    PC_API_RATE_PER_SEC      optional, default 30 (only used by --verify)

ONE-TIME COST
-------------
This is bound by PC's Cloudflare tolerance for the scrape path (~3.5s
per row per worker, single-digit workers max). For a 150k-row catalog
at 3 workers expect roughly 24 hours of wall clock — run it overnight
in chunks (--tcg pokemon, then --tcg mtg, etc.) or leave the GitHub
Actions cron to chip away weekly. Subsequent runs are fast because
they only touch newly-added rows.
"""

import os, sys, re, time, random, argparse, threading, json
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
PC_API_KEY   = os.environ.get("PRICECHARTING_API_KEY", "").strip() or None

if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")
# PC_API_KEY is only needed when --verify is passed; the default extract-
# from-HTML path is API-key-free. We don't sys.exit here — the verify
# function returns False fast if the key is missing.

PC_BASE         = "https://www.pricecharting.com"
REQUEST_TIMEOUT = 25

# Same browser-realistic headers as refresh_catalog_prices.py — PC's
# API endpoint also runs behind Cloudflare and a thin User-Agent will
# get bot-flagged eventually.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer":         "https://www.pricecharting.com/",
    "Sec-Fetch-Dest":  "document",
    "Sec-Fetch-Mode":  "navigate",
    "Sec-Fetch-Site":  "same-origin",
    "Upgrade-Insecure-Requests": "1",
    "Connection":      "keep-alive",
}

# Three places PC product pages embed the numeric product ID. Tried in
# order — first match wins. Confirmed on real PC product pages (sampled
# Pokemon, MTG, sealed product pages 2025-Q4).
#   1. <input type="hidden" name="product" value="6910">
#      Lives inside the "Add to collection" / offers form. Most reliable.
#   2. data-product-id="6910"
#      Various button attributes on the price grid.
#   3. /offers?product=6910 in any href on the page.
#      Last-resort fallback.
PRODUCT_ID_RES = [
    re.compile(r'name=["\']product["\']\s+value=["\'](\d+)["\']', re.IGNORECASE),
    re.compile(r'data-product-id=["\'](\d+)["\']',                  re.IGNORECASE),
    re.compile(r'/offers\?product=(\d+)',                            re.IGNORECASE),
]

_session = requests.Session()
_session.headers.update(HEADERS)


# ─── Global API rate limiter ──────────────────────────────────────────────────
# Token-bucket cap across all workers. PC's published limit is 60/s on
# the paid tier; 30/s leaves headroom and plays nice if the nightly
# refresh kicks off mid-enrichment on the same key.
PC_API_RATE_PER_SEC = float(os.environ.get("PC_API_RATE_PER_SEC", "30"))
_rate_lock          = threading.Lock()
_next_slot          = [0.0]

def _pace_api():
    interval = 1.0 / max(PC_API_RATE_PER_SEC, 1.0)
    with _rate_lock:
        now  = time.time()
        slot = max(_next_slot[0], now)
        _next_slot[0] = slot + interval
        sleep_for = slot - now
    if sleep_for > 0:
        time.sleep(sleep_for)


RETRY_STATUSES = (403, 429, 502, 503, 504)
MAX_RETRIES    = 5

# Scrape pacing (PER WORKER). PC's Cloudflare WAF will block aggressive
# scrapers; ~2.5-5s between requests per worker + a single worker is the
# sustainable shape. Matches the pacing in refresh_catalog_prices.py.
SCRAPE_MIN_S = 2.5
SCRAPE_MAX_S = 5.0
_thread_jitter = threading.local()

def _pace_scrape():
    last = getattr(_thread_jitter, "last", 0)
    now  = time.time()
    delay = random.uniform(SCRAPE_MIN_S, SCRAPE_MAX_S)
    if now - last < delay:
        time.sleep(delay - (now - last))
    _thread_jitter.last = time.time()


def extract_product_id(html):
    """Pull the PC numeric product ID out of a product page's HTML.
    Tries three patterns in order — see PRODUCT_ID_RES at module top."""
    if not html:
        return None
    for rx in PRODUCT_ID_RES:
        m = rx.search(html)
        if m:
            return m.group(1)
    return None


def fetch_pc_page(url):
    """GET the PC product page with exponential backoff on 403/429.
    Returns the response body text on success.
    Raises RuntimeError on transport / retry-exhausted failure."""
    _pace_scrape()
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
        # 404 / 410 / etc. — no point retrying.
        raise RuntimeError(f"HTTP {r.status_code}")
    raise RuntimeError(last_err or "exhausted retries")


def verify_api_has_product(pc_id):
    """Optional check — confirm /api/product?t=KEY&id=X returns real
    product data (not just an error stub). Helps catch cases where we
    scraped an ID but PC's pricing dataset doesn't include it."""
    _pace_api()
    try:
        r = _session.get(
            f"{PC_BASE}/api/product",
            params={"t": PC_API_KEY, "id": pc_id},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return False
    if not r.ok:
        return False
    body = (r.text or "").strip()
    if not body:
        return False
    try:
        data = r.json()
    except Exception:
        return False
    if isinstance(data, dict) and data.get("status") == "error":
        return False
    # If we got back ANY identifying field, the product exists in PC.
    return bool(data.get("id") or data.get("product-name") or data.get("console-name"))


def resolve_url_to_id(url, verify):
    """Scrape the PC product page, pull the numeric product ID from the
    HTML, optionally verify by querying the API.

    Returns:
      ('ok',       pc_id_str)      — clean resolve
      ('notfound', None)           — page loaded but no ID extractable
      ('error',    err_message)    — transport / retry-exhausted failure
    """
    try:
        html = fetch_pc_page(url)
    except Exception as e:
        return ("error", str(e))

    pc_id = extract_product_id(html)
    if not pc_id:
        return ("notfound", None)

    if verify and not verify_api_has_product(pc_id):
        # ID extracted but the API rejects it — rare but happens on
        # discontinued / removed products. Don't persist a stale ID.
        return ("notfound", None)

    return ("ok", pc_id)


# ─── Supabase REST helpers ────────────────────────────────────────────────────
def _sb_headers(extra=None):
    h = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    }
    if extra:
        h.update(extra)
    return h


def load_rows(game_type, limit):
    """Pull every catalog row with a price_source_url but NO
    pricecharting_id yet. Game-type filter is applied client-side via
    the standard catalog prefix conventions when --tcg != 'all'."""
    base_url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog"
    select   = "id,name,set_code,price_source_url,game_type"
    # PostgREST filters:
    #   pricecharting_id=is.null              — no id yet
    #   price_source_url=not.is.null          — has a URL we can resolve
    flt = "pricecharting_id=is.null&price_source_url=not.is.null"
    if game_type and game_type != "all":
        # Match either the explicit game_type column OR the catalog id prefix
        # so legacy rows without game_type still get included for Pokemon
        # (en-/jp-/pd- prefixes).
        flt += f"&game_type=eq.{quote(game_type)}"

    rows  = []
    page  = 0
    page_size = 1000
    while True:
        offset = page * page_size
        params = f"?select={select}&{flt}&order=id.asc&limit={page_size}&offset={offset}"
        r = requests.get(base_url + params, headers=_sb_headers(), timeout=60)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if limit and len(rows) >= limit:
            rows = rows[:limit]
            break
        if len(batch) < page_size:
            break
        page += 1
    return rows


def patch_row(row_id, pc_id):
    """PATCH catalog.pricecharting_id for a single row."""
    r = requests.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{quote(row_id)}",
        headers=_sb_headers({
            "Content-Type":  "application/json",
            "Prefer":        "return=minimal",
        }),
        data=json.dumps({"pricecharting_id": pc_id}),
        timeout=30,
    )
    r.raise_for_status()


# ─── Per-row worker ───────────────────────────────────────────────────────────
def process_row(row, dry_run, verify):
    rid = row["id"]
    url = row.get("price_source_url")
    if not url:
        return (rid, "skipped", "no url")

    status, val = resolve_url_to_id(url, verify)
    if status == "ok":
        if dry_run:
            return (rid, "would-set", val)
        try:
            patch_row(rid, val)
        except Exception as e:
            return (rid, "failed", f"patch: {e}")
        return (rid, "ok", val)
    elif status == "notfound":
        return (rid, "notfound", None)
    else:
        return (rid, "failed", val)


# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description="Resolve catalog.pricecharting_id from price_source_url via PC API."
    )
    ap.add_argument("--tcg", default="pokemon",
                    help="catalog.game_type filter (default 'pokemon'). 'all' = every TCG.")
    ap.add_argument("--workers", type=int, default=3,
                    help="Parallel HTTP workers (default 3). Higher = more 403s from "
                         "PC's Cloudflare WAF — even 3 is on the edge. Drop to 1 if "
                         "you start seeing scrape failures.")
    ap.add_argument("--limit",   type=int, default=0, help="Stop after N rows (debug).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Resolve IDs but DON'T patch the catalog. Prints what would change.")
    ap.add_argument("--verify",  action="store_true",
                    help="After scraping an ID, call /api/product?id=X to confirm PC's "
                         "pricing dataset actually has it. Roughly doubles run time, "
                         "useful if you suspect stale URLs.")
    ap.add_argument("--resume",  action="store_true",
                    help="(no-op flag for symmetry; this script always skips rows with an id).")
    args = ap.parse_args()

    print(f"Loading catalog rows for game_type={args.tcg!r} missing pricecharting_id…")
    rows = load_rows(args.tcg, args.limit)
    total = len(rows)
    if total == 0:
        print("Nothing to do — every in-scope row already has a pricecharting_id.")
        return
    # ETA: scrape-bound. Average ~3.5s per page per worker (sleep + fetch
    # + parse), so total time ≈ total * 3.5 / workers seconds.
    eta_min = total * 3.5 / max(args.workers, 1) / 60
    print(f"  {total:,} rows need a pricecharting_id resolved.")
    print(f"  Mode: scrape product page → extract numeric ID from HTML")
    print(f"  Workers: {args.workers} (Cloudflare-tolerant pacing: {SCRAPE_MIN_S}-{SCRAPE_MAX_S}s per worker)")
    if args.verify:
        print(f"  Verify: ON — each ID also confirmed via API (slower)")
    print(f"  ETA: ~{eta_min:.0f} min")
    if args.dry_run:
        print("  DRY-RUN — no catalog writes will happen.")
    print("  Starting in 3s — Ctrl+C to abort")
    time.sleep(3)

    n_ok = 0; n_notfound = 0; n_failed = 0; n_dry = 0
    started = time.time()

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(process_row, r, args.dry_run, args.verify): r for r in rows}
        for i, fut in enumerate(as_completed(futs), start=1):
            rid, status, val = fut.result()
            if status == "ok":
                n_ok += 1
            elif status == "would-set":
                n_dry += 1
            elif status == "notfound":
                n_notfound += 1
                # Quiet — these are the long tail of "PC doesn't have this product"
                # rows; surface only every 50th so the log isn't drowned.
                if n_notfound % 50 == 0:
                    print(f"  [{i:>6}/{total}] notfound: {rid}")
            elif status == "failed":
                n_failed += 1
                print(f"  [{i:>6}/{total}] FAIL {rid} — {val}")

            if i % 250 == 0:
                elapsed = time.time() - started
                rate = i / elapsed if elapsed > 0 else 0
                eta_s = (total - i) / rate if rate > 0 else 0
                print(f"  [{i:>6}/{total}] ok={n_ok} notfound={n_notfound} failed={n_failed} dry={n_dry}  ({rate:.1f}/s, {eta_s/60:.0f}min left)")

    elapsed = time.time() - started
    print(f"\nFinished in {elapsed/60:.1f} min.")
    print(f"  ok        : {n_ok:,}   ({n_ok / max(total,1) * 100:.1f}%)")
    print(f"  notfound  : {n_notfound:,}   (PC didn't recognize the URL — usually obscure / removed listings)")
    print(f"  failed    : {n_failed:,}   (network / API errors — re-run to retry)")
    print(f"  would-set : {n_dry:,}   (dry-run only)")


if __name__ == "__main__":
    main()
