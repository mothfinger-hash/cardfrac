#!/usr/bin/env python3
"""
PathBinder — Bulk-CSV Catalog Price Refresh
=============================================
Replaces the per-row API approach in `refresh_catalog_prices.py`
with PriceCharting's bulk CSV exports. Refreshes the entire
catalog in ~4 HTTP requests instead of ~50,000.

Why this exists
---------------
The legacy `refresh_catalog_prices.py` script makes one API call
per catalog row. With ~48,000 Pokemon rows plus retries on PC's
Cloudflare WAF, a single nightly run can take **14+ hours** and
still only finish half the catalog before failing. CSV exports
collapse that into a handful of large downloads.

Trade-offs
----------
PRO  | 4 HTTP requests per run vs 48,000+. Finishes in minutes.
PRO  | Cloudflare WAF risk is essentially zero — only the downloads
     | matter, and they're identical to what a logged-in PC user
     | hits when clicking "Download CSV" in the dashboard.
PRO  | No per-row backoff / retry / circuit breaker logic needed.
CON  | Only refreshes catalog rows whose `pricecharting_id` matches
     | a row in PC's bulk export. Niche / unindexed products get
     | skipped. The old per-row scraper occasionally caught these
     | via `price_source_url` lookups. Acceptable trade-off for the
     | reliability + speed gain.
CON  | PC's bulk CSVs include singles AND sealed in one file per
     | category. We handle both; field priority differs per type
     | (loose for singles, cib/new for sealed).

PREREQUISITES
-------------
    pip3 install requests --break-system-packages

USAGE
-----
    # Refresh all 4 TCG categories
    python3 refresh_catalog_prices_csv.py

    # Just Pokemon (most common)
    python3 refresh_catalog_prices_csv.py --categories pokemon-cards

    # Dry-run — fetch CSVs + match catalog, no DB writes
    python3 refresh_catalog_prices_csv.py --dry-run

    # Use local CSVs you've already downloaded (skip PC fetch)
    python3 refresh_catalog_prices_csv.py --csv-dir ~/Downloads/pc-csvs/

    # Limit catalog scan for testing
    python3 refresh_catalog_prices_csv.py --limit 200

ENVIRONMENT
-----------
    SUPABASE_URL            your project URL
    SUPABASE_SERVICE_KEY    service-role key
    PRICECHARTING_API_KEY   for fetching CSVs from PC's download endpoint
"""

import os
import sys
import csv
import re
import time
import json
import argparse
import tempfile
import glob
from datetime import date
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

# Reuse the CSV download + column lookup helpers from the singles
# enricher. The download endpoint, retry behavior, and column variant
# matching are identical between resolution-by-CSV and refresh-by-CSV.
from enrich_from_pc_csv import (
    download_category_csv, KNOWN_CATEGORIES, CSV_COLUMNS, _pick,
    _cents_to_dollars,
)


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

PC_API_KEY = os.environ.get("PRICECHARTING_API_KEY", "").strip() or None


# ─── PC bulk-CSV parse → pc_id → price map ──────────────────────────────────
def _is_sealed_genre(row):
    """PC's CSV has a `genre` column distinguishing singles from
    sealed product ("Pokemon Sealed Product" vs "Pokemon TCG").
    Price field priority differs between the two."""
    g = (row.get("genre") or row.get("Genre") or "").lower()
    return "sealed" in g if g else False


def parse_pc_csvs(paths):
    """Read every PC CSV and build a single { pc_id: {price, is_sealed} }
    map keyed by the integer PC product id. We carry the sealed flag so
    the caller can apply the right field-priority later if needed (e.g.
    if a sealed catalog row's pricecharting_id resolves to a PC row
    whose loose-price is zero but cib-price is real, we'd take cib)."""
    pmap = {}
    total_rows = 0
    for path in paths:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                total_rows += 1
                pc_id = _pick(row, "id")
                if not pc_id:
                    continue
                is_sealed = _is_sealed_genre(row)
                # Field priority — same logic as the legacy API fetcher.
                if is_sealed:
                    price = (
                        _cents_to_dollars(_pick(row, "cib"))   or
                        _cents_to_dollars(_pick(row, "new"))   or
                        _cents_to_dollars(_pick(row, "loose")) or
                        _cents_to_dollars(row.get("box-only-price")) or
                        _cents_to_dollars(row.get("box_only_price"))
                    )
                else:
                    price = (
                        _cents_to_dollars(_pick(row, "loose")) or
                        _cents_to_dollars(_pick(row, "cib"))   or
                        _cents_to_dollars(_pick(row, "new"))
                    )
                if price is None or price <= 0:
                    continue
                # Last write wins on duplicate ids (extremely rare).
                pmap[str(pc_id)] = {"price": price, "is_sealed": is_sealed}
    return pmap, total_rows


# ─── Supabase REST helpers ──────────────────────────────────────────────────
_sb_session = requests.Session()
_sb_session.headers.update({
    "apikey":        SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept":        "application/json",
})


# ─── Post-run sanity check ──────────────────────────────────────────────────
# Verifies that today's catalog_price_history writes actually landed at
# scale across each game_type that should be refreshed. Catches the exact
# failure mode we just hit: workflow returns green checkmark because the
# script "succeeded", but zero history rows were actually written for one
# or more games (CSV download silently corrupted, matcher returned empty,
# etc.). Compares today vs the most recent prior day; if today is below
# a configurable fraction of the prior day's count for any expected game,
# raises so the workflow exits non-zero and you get a notification.
def _count_history(date_str, game_type):
    """Return the count of catalog_price_history rows for a given date
    + game_type, using PostgREST's count=exact header (cheap HEAD)."""
    r = _sb_session.head(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog_price_history"
        f"?game_type=eq.{game_type}&recorded_at=eq.{date_str}",
        headers={"Prefer": "count=exact"}, timeout=30,
    )
    rng = r.headers.get("Content-Range", "*/0")
    try:
        return int(rng.split("/")[-1])
    except ValueError:
        return 0


def verify_history_writes(games, min_pct_of_prior=0.50, min_absolute=100):
    """Fail loudly if today's history row count for any expected game is
    suspiciously low. `games` is the list of game_type values the run
    was supposed to update. `min_pct_of_prior` is the floor below the
    most-recent-prior-day's count that triggers an alarm. `min_absolute`
    is a hard floor — a game with <100 rows today is always suspicious
    regardless of yesterday's count.

    Raises RuntimeError on failure (so the calling main() can sys.exit
    non-zero and GitHub Actions marks the workflow red)."""
    from datetime import date, timedelta
    today = date.today().isoformat()
    failures = []

    print(f"\n  Verifying history writes for {today}…", flush=True)
    for g in games:
        today_n = _count_history(today, g)
        # Find the most recent prior day with data (skip days where this
        # game wasn't refreshed for unrelated reasons).
        prior_n = 0
        prior_date = None
        for delta in range(1, 8):
            d = (date.today() - timedelta(days=delta)).isoformat()
            n = _count_history(d, g)
            if n > 0:
                prior_n = n
                prior_date = d
                break

        floor_pct = int(prior_n * min_pct_of_prior)
        floor_abs = min_absolute
        ok = (today_n >= floor_pct) and (today_n >= floor_abs)

        status = "OK" if ok else "FAIL"
        print(
            f"    {g:<16s} today={today_n:>7,}  "
            f"prior({prior_date or '-'})={prior_n:>7,}  "
            f"floor(50%)={floor_pct:>7,}  → {status}",
            flush=True,
        )
        if not ok:
            failures.append((g, today_n, prior_n, prior_date))

    if failures:
        msg_lines = ["History write verification FAILED for one or more games:"]
        for g, t, p, pd in failures:
            msg_lines.append(
                f"  {g}: today={t:,}  prior({pd or 'none'})={p:,}  "
                f"(< {int(min_pct_of_prior*100)}% of prior OR < {min_absolute} absolute)"
            )
        msg_lines.append(
            "This usually means the CSV download for one category returned garbage "
            "(brotli, Cloudflare challenge, slug mismatch) and the matcher silently "
            "matched zero rows. Check the per-category bytes/match counts above. "
            "Workflow exits non-zero so GitHub Actions surfaces the alert."
        )
        raise RuntimeError("\n".join(msg_lines))
    print(f"  All games verified OK.", flush=True)


def load_catalog_rows(game_type, limit=None):
    """Pull every catalog row that has a pricecharting_id we can look
    up. Pages with keyset (id > last_seen) so we don't hit Supabase
    statement timeouts on deep offset scans."""
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog"
    select = "id,name,game_type,pricecharting_id"
    flt = "pricecharting_id=not.is.null"
    if game_type and game_type != "all":
        flt += f"&game_type=eq.{game_type}"
    rows = []
    page_size = 1000
    last_id = None
    while True:
        cursor = ""
        if last_id is not None:
            cursor = f"&id=gt.{requests.utils.quote(last_id, safe='')}"
        params = f"?select={select}&{flt}{cursor}&order=id.asc&limit={page_size}"
        r = _sb_session.get(url + params, timeout=60)
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


def patch_catalog(catalog_id, current_value):
    """PATCH catalog.current_value only. Doesn't touch any other
    columns (pricecharting_id, image_url, etc. all stay put)."""
    r = _sb_session.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{requests.utils.quote(catalog_id, safe='')}",
        headers={"Content-Type": "application/json", "Prefer": "return=minimal"},
        data=json.dumps({"current_value": current_value}),
        timeout=30,
    )
    r.raise_for_status()


def upsert_history(row):
    """Same upsert pattern as the legacy script — keyed by
    (catalog_id, recorded_at). One snapshot per row per day."""
    r = _sb_session.post(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog_price_history?on_conflict=catalog_id,recorded_at",
        headers={
            "Content-Type":  "application/json",
            "Prefer":        "resolution=merge-duplicates,return=minimal",
        },
        data=json.dumps(row),
        timeout=30,
    )
    r.raise_for_status()


# ─── Per-row processor ──────────────────────────────────────────────────────
def process_row(row, pmap, today_iso, dry_run):
    """Look up the row's pricecharting_id in the bulk map and write
    the new price + history snapshot."""
    rid = row.get("id") or "?"
    pcid = str(row.get("pricecharting_id") or "")
    if not pcid:
        return ("skipped", rid, "no pricecharting_id")
    entry = pmap.get(pcid)
    if not entry:
        return ("not_in_csv", rid, f"pc_id {pcid} not in any CSV (niche / new release / un-indexed)")
    price = entry["price"]

    if dry_run:
        return ("would_update", rid, f"${price:.2f}")

    try:
        patch_catalog(rid, price)
    except Exception as e:
        return ("failed", rid, f"patch: {e}")

    try:
        upsert_history({
            "catalog_id":     rid,
            "recorded_value": price,
            "recorded_at":    today_iso,
            "source":         "pricecharting_csv_refresh",
            "game_type":      row.get("game_type"),
        })
    except Exception as e:
        # history write failure isn't fatal — current_value is what
        # the marketplace reads. History fuels the dashboard chart.
        return ("updated_history_warn", rid, f"history: {e}")

    return ("updated", rid, f"${price:.2f}")


# ─── Main ───────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description="Refresh catalog prices from PriceCharting's bulk CSV exports.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--csv-dir",    help="Use pre-downloaded CSVs in this directory.")
    src.add_argument("--categories", help="Comma-separated PC category slugs to fetch.")
    src.add_argument("--all-tcgs",   action="store_true",
                     help=f"Fetch every known category: {', '.join(KNOWN_CATEGORIES)}.")
    ap.add_argument("--game",     default="all",
                    help="catalog.game_type filter (pokemon, magic, yugioh, …) or 'all'. "
                         "Independent of which CSVs you ingest.")
    ap.add_argument("--limit",    type=int, default=None,
                    help="Stop after N catalog rows. Useful for testing.")
    ap.add_argument("--workers",  type=int, default=10,
                    help="Parallel Supabase write workers (default 10). "
                         "Supabase tolerates 20+ easily.")
    ap.add_argument("--dry-run",  action="store_true",
                    help="Match catalog rows against CSVs, don't write.")
    ap.add_argument("--keep-downloads", action="store_true",
                    help="Keep downloaded CSVs after the run (default: delete).")
    args = ap.parse_args()

    # Default to all known categories if nothing specified.
    if not (args.csv_dir or args.categories or args.all_tcgs):
        args.all_tcgs = True

    # ── Collect CSV paths ─────────────────────────────────────────
    paths = []
    tmpdir = None
    try:
        if args.csv_dir:
            paths = sorted(glob.glob(os.path.join(args.csv_dir, "*.csv")))
        else:
            cats = KNOWN_CATEGORIES if args.all_tcgs else \
                   [c.strip() for c in args.categories.split(",") if c.strip()]
            tmpdir = tempfile.mkdtemp(prefix="pc_refresh_csv_")
            print(f"Downloading {len(cats)} PC category CSV(s) to {tmpdir}…", flush=True)
            for c in cats:
                try:
                    paths.append(download_category_csv(c, tmpdir))
                except Exception as e:
                    print(f"  FAILED to download {c}: {e}", flush=True)
                    print(f"  Partial downloads kept at: {tmpdir}", flush=True)
                    print(f"  Resume: --csv-dir {tmpdir}", flush=True)
                    return

        if not paths:
            sys.exit("No CSV files found / downloaded.")

        # ── Build price map ───────────────────────────────────────
        print(f"\nParsing {len(paths)} CSV(s)…", flush=True)
        pmap, csv_total = parse_pc_csvs(paths)
        print(f"  {csv_total:,} CSV rows scanned.", flush=True)
        print(f"  {len(pmap):,} priceable products in the map.", flush=True)

        # ── Load catalog rows ─────────────────────────────────────
        print(f"\nLoading catalog rows (game={args.game})…", flush=True)
        cat_rows = load_catalog_rows(args.game, args.limit)
        print(f"  {len(cat_rows):,} rows with pricecharting_id in scope.", flush=True)
        if not cat_rows:
            print("Nothing to refresh.")
            return

        if args.dry_run:
            print("\nDRY-RUN — no writes will happen.\n", flush=True)
        else:
            print(f"\nWriting price updates with {args.workers} workers…\n", flush=True)
            time.sleep(1)

        # ── Process ───────────────────────────────────────────────
        today_iso = date.today().isoformat()
        stats = {"updated": 0, "would_update": 0, "not_in_csv": 0,
                 "skipped": 0, "failed": 0, "updated_history_warn": 0}

        # Track unmatched rows by game_type so the summary can show
        # where the gap is. If the gap is concentrated in one TCG, that
        # usually means a missing CSV category download.
        unmatched_by_game = {}
        # Also keep a few sample unmatched ids per game_type so the
        # operator can manually check them in PC's UI to see if they
        # exist at all.
        unmatched_samples = {}

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = [pool.submit(process_row, r, pmap, today_iso, args.dry_run) for r in cat_rows]
            futs_by_idx = {f: cat_rows[i] for i, f in enumerate(futs)}
            for i, fut in enumerate(as_completed(futs), start=1):
                row = futs_by_idx[fut]
                status, rid, detail = fut.result()
                stats[status] = stats.get(status, 0) + 1
                # Tally per-game gap data for the not_in_csv class.
                if status == "not_in_csv":
                    g = row.get("game_type") or "(unknown)"
                    unmatched_by_game[g] = unmatched_by_game.get(g, 0) + 1
                    if len(unmatched_samples.setdefault(g, [])) < 5:
                        unmatched_samples[g].append((rid, row.get("pricecharting_id")))
                # Log noisy classes only — "updated" and "not_in_csv"
                # are the volume cases.
                if status in ("failed", "updated_history_warn"):
                    print(f"  [{i:>6}/{len(cat_rows)}] {status:<22s} {rid:<28s} {detail}", flush=True)
                elif i % 2000 == 0:
                    print(f"  [{i:>6}/{len(cat_rows)}] processed — "
                          f"updated:{stats['updated']:,}  "
                          f"not_in_csv:{stats['not_in_csv']:,}  "
                          f"failed:{stats['failed']:,}", flush=True)

        # ── Summary ───────────────────────────────────────────────
        print(f"\n{'─' * 60}", flush=True)
        print(f"  Catalog rows scanned    : {len(cat_rows):,}", flush=True)
        if args.dry_run:
            print(f"  Would update            : {stats['would_update']:,}", flush=True)
        else:
            print(f"  Updated                 : {stats['updated']:,}", flush=True)
            print(f"  History write warning   : {stats['updated_history_warn']:,}", flush=True)
        print(f"  Not in CSV (niche / new): {stats['not_in_csv']:,}", flush=True)
        print(f"  Skipped (no pc id)      : {stats['skipped']:,}", flush=True)
        print(f"  Failed                  : {stats['failed']:,}", flush=True)
        match_rate = (stats['updated'] + stats['would_update']) / len(cat_rows) * 100.0
        print(f"  Match rate              : {match_rate:.1f}%", flush=True)

        # ── Diagnostic breakdown ─────────────────────────────────────
        # When the "not in CSV" bucket is big, this view tells you
        # whether the gap is concentrated in one TCG (missing category
        # download) or scattered across all of them (CSV format
        # mismatch / PC not indexing those products).
        if unmatched_by_game:
            print(f"\n  Unmatched by game_type:", flush=True)
            for g in sorted(unmatched_by_game, key=lambda x: -unmatched_by_game[x]):
                pct = unmatched_by_game[g] / max(stats['not_in_csv'], 1) * 100.0
                print(f"    {g:<14s} {unmatched_by_game[g]:>7,}  ({pct:5.1f}%)", flush=True)
            print(f"\n  Sample unmatched ids (rid -> pricecharting_id):", flush=True)
            for g in sorted(unmatched_samples, key=lambda x: -unmatched_by_game.get(x, 0)):
                print(f"    [{g}]", flush=True)
                for rid, pcid in unmatched_samples[g][:5]:
                    print(f"      {rid:<28s} pc_id={pcid}", flush=True)

        # ── Verify writes actually landed ────────────────────────────
        # Skip in dry-run (no writes to verify). Only check games we
        # were supposed to refresh on this invocation — anything else
        # may have stale-by-design data.
        if not args.dry_run:
            # Map --game arg to the set of game_type values we expect
            # to see writes for. 'all' = every game with catalog rows.
            if args.game and args.game != "all":
                expected_games = [args.game]
            else:
                # Pull distinct game_type values from catalog so we
                # check whatever exists, not a hardcoded list. Cheap.
                expected_games = ['pokemon', 'magic', 'yugioh', 'onepiece']
            try:
                verify_history_writes(expected_games)
            except RuntimeError as e:
                # Print the error AND re-raise so the workflow fails red.
                print(f"\n  {'='*60}", flush=True)
                print(f"  ALERT: {e}", flush=True)
                print(f"  {'='*60}", flush=True)
                raise

    finally:
        # Tidy up downloaded CSVs unless asked to keep them.
        if tmpdir and not args.keep_downloads:
            for p in paths:
                try: os.remove(p)
                except Exception: pass
            try: os.rmdir(tmpdir)
            except Exception: pass
        elif tmpdir:
            print(f"\n  Downloaded CSVs kept at: {tmpdir}", flush=True)


if __name__ == "__main__":
    main()
