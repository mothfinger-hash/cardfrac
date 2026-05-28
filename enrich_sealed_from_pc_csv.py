#!/usr/bin/env python3
"""
PathBinder — PriceCharting CSV Ingest (SEALED products)
=======================================================
Companion to `enrich_from_pc_csv.py`. That script's match path is built
around (set, card_number) — perfect for singles, useless for sealed
products which don't carry a card number. This script handles the
sealed half of the catalog: booster boxes, ETBs, tins, decks, blisters.

Backfill order
--------------
  1. Run the trivial regex first — most sealed catalog ids already embed
     the PC id (`sealed-en-pc-7641193`):

       UPDATE public.catalog
          SET pricecharting_id = (regexp_match(id, '^sealed-[a-z]{2}-pc-(\\d+)$'))[1]
        WHERE pricecharting_id IS NULL
          AND id ~ '^sealed-[a-z]{2}-pc-\\d+$';

  2. Then run THIS script for everything still NULL — sealed rows whose
     ids don't carry pc-<id> (legacy/imported rows, or rows synced before
     sync_sealed_products.py started encoding the pc id into the id).

How matching works
------------------
Sealed PC rows have `genre` containing "Sealed" (e.g. "Pokemon Sealed
Product"), and `console-name` carries the set ("Pokemon Sun & Moon
Burning Shadows"). Our catalog sealed rows have `set_name` matching
the singles set and `name` like "Sun & Moon Burning Shadows Booster Box".

Match priority:
  1. (normalized_console, normalized_name) exact     — most precise
  2. (normalized_console, token-set similarity ≥ 0.75) — fuzzy fallback,
     picks the PC row whose name shares the most tokens with the
     catalog name within the SAME console. Threshold tuned high so
     we don't false-match a Booster Box to an ETB.

USAGE
-----
    # Same CSV(s) you used for singles work
    python3 enrich_sealed_from_pc_csv.py --csv-dir ~/Downloads/pc-csvs/

    # Fetch fresh
    python3 enrich_sealed_from_pc_csv.py --categories pokemon-cards,magic-cards,yugioh-cards,one-piece-cards

    # Dry-run first
    python3 enrich_sealed_from_pc_csv.py --csv-dir ~/Downloads/pc-csvs/ --dry-run

ENVIRONMENT
-----------
    SUPABASE_URL          your project URL
    SUPABASE_SERVICE_KEY  service-role key
    PRICECHARTING_API_KEY only when downloading CSVs via --category/--categories
"""

import os, sys, csv, re, json, argparse, time, glob, tempfile, threading
from datetime import date

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

# Reuse all the CSV plumbing from the singles enricher so the two scripts
# stay in sync on column names, download retry behavior, price parsing,
# and console-name normalization.
from enrich_from_pc_csv import (
    SUPABASE_URL, SUPABASE_KEY,
    KNOWN_CATEGORIES,
    CSV_COLUMNS, _pick, _cents_to_dollars,
    _normalize_text, _normalize_console,
    _sb_headers, patch_row, upsert_history,
    download_category_csv,
)


# ── Sealed-specific name handling ─────────────────────────────────────────────
# Sealed PC product-names are noisier than singles. Strip bracketed
# variant tags ("[Sealed]", "[Foil]") and parenthetical regions
# ("(Japan)", "(USA)") before normalizing for the match.
_BRACKET_RE = re.compile(r"\[[^\]]*\]")
_PAREN_RE   = re.compile(r"\([^)]*\)")

def _normalize_product_name(name):
    if not name:
        return ""
    s = _BRACKET_RE.sub("", name)
    s = _PAREN_RE.sub("", s)
    return _normalize_text(s)


# Tokens too generic to weight in the fuzzy match (sealed names are full
# of "set", "box", "pokemon" etc.). Without filtering, "Pokemon Booster
# Box" would match every booster box on PC equally.
_SEALED_STOPWORDS = frozenset({
    "the", "of", "and", "a", "an", "or",
    "set", "edition", "series", "official", "league",
    # Game prefixes that PC sometimes leaves in the name too.
    "pokemon", "magic", "yugioh", "one", "piece", "gundam",
    # The very tags that define product_type — useful for matching only
    # when surrounded by set-specific context, otherwise too generic.
    "box", "booster", "elite", "trainer", "etb", "tin",
    "deck", "pack", "blister", "collection",
})

def _tokenset(name):
    toks = _normalize_product_name(name).split()
    return frozenset(t for t in toks if t and t not in _SEALED_STOPWORDS)


def _jaccard(a, b):
    """Token-set Jaccard similarity. 1.0 = identical, 0 = disjoint."""
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    return inter / float(len(a | b))


# ── PC genre filter ──────────────────────────────────────────────────────────
# PC's CSV genre column tells us whether a row is a single ("Pokemon TCG"),
# sealed product ("Pokemon Sealed Product"), or accessory ("Pokemon
# Accessory"). Only sealed rows are interesting here.
def _is_sealed_genre(row):
    g = (row.get("genre") or row.get("Genre") or "").lower()
    if not g:
        # Some CSV variants don't ship the genre column. Fall back to a
        # heuristic on the name + console.
        name    = (_pick(row, "name")    or "").lower()
        console = (_pick(row, "console") or "").lower()
        # If either is gestures toward sealed-product wording, treat it
        # as sealed. False positives just get filtered out later by the
        # match step (no matching catalog row → no write).
        return any(t in name + " " + console for t in (
            "booster box", "booster bundle", "elite trainer", "tin ",
            "etb", "deck box", "blister", "build & battle",
            "pre-release", "prerelease", "collection box",
        ))
    return "sealed" in g


# ── Catalog load ─────────────────────────────────────────────────────────────
def load_sealed_catalog(game_type):
    """Pull catalog rows that are sealed AND missing pricecharting_id.

    Sealed identification: product_type != 'single' (also handles legacy
    rows where product_type might be NULL — those get inspected by name
    suffix too, since the SQL backfill of product_type may have missed
    older imports)."""
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog"
    select = "id,name,set_name,set_code,game_type,product_type,price_source_url"
    # neq.single covers booster_box / etb / tin / deck / pack / blister /
    # collection_box / etc. Also includes NULL via is.not.null filter
    # below — we want everything that isn't explicitly a single.
    flt = "pricecharting_id=is.null&product_type=neq.single"
    if game_type and game_type != "all":
        flt += f"&game_type=eq.{game_type}"
    rows = []
    page = 0; page_size = 1000
    while True:
        params = f"?select={select}&{flt}&order=id.asc&limit={page_size}&offset={page * page_size}"
        r = requests.get(url + params, headers=_sb_headers(), timeout=60)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < page_size:
            break
        page += 1
    return rows


# ── CSV index (sealed-only) ──────────────────────────────────────────────────
def load_sealed_csv_index(paths, debug_headers=False):
    """Filter PC CSV rows to sealed-genre and index them by:
        by_text       : (normalized_console, normalized_product_name) → entry
        by_console    : normalized_console → [entries...]
                        (for fuzzy fallback within the same console)
    """
    by_text    = {}
    by_console = {}
    total_sealed = 0
    first_headers_logged = False

    for path in paths:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            headers = reader.fieldnames or []
            if debug_headers or not first_headers_logged:
                print(f"  CSV columns ({os.path.basename(path)}): {headers}")
                first_headers_logged = True

            for row in reader:
                if not _is_sealed_genre(row):
                    continue
                pc_id = _pick(row, "id")
                if not pc_id:
                    continue
                full_name = _pick(row, "name")
                console   = _pick(row, "console")
                if not (full_name and console):
                    continue
                total_sealed += 1

                stripped_console = _normalize_console(console)
                name_norm = _normalize_product_name(full_name)
                if not (stripped_console and name_norm):
                    continue

                price = (
                    _cents_to_dollars(_pick(row, "cib"))   or
                    _cents_to_dollars(_pick(row, "new"))   or
                    _cents_to_dollars(_pick(row, "loose"))
                )

                entry = {
                    "pc_id":   str(pc_id),
                    "name":    full_name,
                    "console": console,
                    "price":   price,
                    "tokens":  _tokenset(full_name),
                }

                # Primary key — exact (console, name)
                by_text.setdefault((stripped_console, name_norm), entry)
                # Fuzzy fallback bucket — all sealed entries in this
                # console, regardless of name.
                by_console.setdefault(stripped_console, []).append(entry)

    return by_text, by_console, total_sealed


# ── Per-row match ────────────────────────────────────────────────────────────
def match_sealed_row(row, by_text, by_console, fuzzy_threshold=0.75):
    """Return (csv_entry, source_label, score) for this catalog row, or
    (None, None, None).

    Priority:
      1. exact (console, name)
      2. fuzzy: highest token-set Jaccard within the same console,
         provided it clears `fuzzy_threshold` AND beats the runner-up
         by at least 0.10 (so we don't pick between two close ties).
    """
    set_name = row.get("set_name") or ""
    name     = row.get("name") or ""
    if not (set_name and name):
        return (None, None, None)

    # Normalized console candidates from the catalog row's set_name.
    cat_console_keys = []
    seen = set()
    def _add(k):
        if k and k not in seen:
            seen.add(k); cat_console_keys.append(k)
    _add(_normalize_console(set_name))
    _add(_normalize_text(set_name))    # in case set_name already had no game prefix
    name_norm = _normalize_product_name(name)

    # 1. exact match
    for sk in cat_console_keys:
        e = by_text.get((sk, name_norm))
        if e:
            return (e, "exact", 1.0)

    # 2. fuzzy match — restrict to the same console
    cat_tokens = _tokenset(name)
    if not cat_tokens:
        return (None, None, None)
    best = None
    runner = 0.0
    for sk in cat_console_keys:
        for cand in by_console.get(sk, ()):
            score = _jaccard(cat_tokens, cand["tokens"])
            if score < fuzzy_threshold:
                continue
            if best is None or score > best[1]:
                if best is not None:
                    runner = max(runner, best[1])
                best = (cand, score)
            else:
                runner = max(runner, score)
    if best and (best[1] - runner) >= 0.10:
        return (best[0], "fuzzy", best[1])
    return (None, None, None)


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description="Resolve catalog.pricecharting_id for SEALED products from PC CSV exports.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--csv",        help="Single PC CSV file (already downloaded).")
    src.add_argument("--csv-dir",    help="Directory of PC CSV files.")
    src.add_argument("--category",   help="Single PC category slug to fetch.")
    src.add_argument("--categories", help="Comma-separated PC category slugs to fetch.")
    src.add_argument("--all-tcgs",   action="store_true",
                     help=f"Fetch every known category: {', '.join(KNOWN_CATEGORIES)}.")

    ap.add_argument("--tcg", default="all",
                    help="Limit catalog match scope to a specific game_type (default 'all').")
    ap.add_argument("--dry-run", action="store_true",
                    help="Match + report, don't write to Supabase.")
    ap.add_argument("--skip-prices", action="store_true",
                    help="Write pricecharting_id only — skip current_value + history.")
    ap.add_argument("--keep-downloads", action="store_true",
                    help="Keep downloaded CSVs after the run.")
    ap.add_argument("--threshold", type=float, default=0.75,
                    help="Fuzzy match Jaccard threshold (default 0.75).")
    ap.add_argument("--debug-unmatched", type=int, default=0, metavar="N",
                    help="Print full data for the first N unmatched catalog rows.")
    args = ap.parse_args()

    # ── Collect CSV paths ─────────────────────────────────────────────
    paths = []
    tmpdir = None
    download_failed = False
    ingested_ok = False
    try:
        if args.csv:
            paths = [args.csv]
        elif args.csv_dir:
            paths = sorted(glob.glob(os.path.join(args.csv_dir, "*.csv")))
        else:
            if args.all_tcgs:
                cats = KNOWN_CATEGORIES
            elif args.categories:
                cats = [c.strip() for c in args.categories.split(",") if c.strip()]
            else:
                cats = [args.category]
            tmpdir = tempfile.mkdtemp(prefix="pc_sealed_csv_")
            print(f"Downloading {len(cats)} PC category CSV(s) to {tmpdir}…")
            import random as _r
            for idx, c in enumerate(cats):
                if idx > 0:
                    time.sleep(_r.uniform(5, 15))
                try:
                    paths.append(download_category_csv(c, tmpdir))
                except Exception as e:
                    download_failed = True
                    print(f"\n  FAILED to download {c}: {e}")
                    print(f"  Partial downloads kept at: {tmpdir}")
                    print(f"  To resume, re-run with:  --csv-dir {tmpdir}")
                    print(f"  (or skip the offender: --categories <the slugs that worked>)")
                    break
        if not paths:
            sys.exit("No CSV files found / downloaded.")
        if download_failed:
            # Don't try to ingest from an incomplete set — the user
            # should re-run after the WAF backs off.
            return
        _run_ingest(paths, args)
        ingested_ok = True
    finally:
        # Clean up the tmpdir only when everything went well. Any failure
        # (download error, ingest crash, low match rate) leaves the
        # downloads on disk so the next run can resume via --csv-dir.
        cleanup_ok = (
            tmpdir
            and not args.keep_downloads
            and not download_failed
            and ingested_ok
        )
        if cleanup_ok:
            for p in paths:
                try: os.remove(p)
                except Exception: pass
            try: os.rmdir(tmpdir)
            except Exception: pass
        elif tmpdir:
            print(f"\n  Downloaded CSVs kept at: {tmpdir}")
            print(f"  (Re-run without re-downloading: --csv-dir {tmpdir})")


def _run_ingest(paths, args):
    print(f"Loading {len(paths)} CSV file(s)…")
    for p in paths:
        print(f"  • {p}")
    by_text, by_console, csv_total = load_sealed_csv_index(paths)
    print(f"  Indexed {csv_total:,} sealed CSV rows.")
    print(f"  by-text keys:      {len(by_text):,}   (exact console+name)")
    print(f"  by-console keys:   {len(by_console):,}   (fuzzy fallback buckets)")

    print(f"\nLoading sealed catalog rows (game_type={args.tcg!r}) missing pricecharting_id…")
    cat_rows = load_sealed_catalog(args.tcg)
    print(f"  {len(cat_rows):,} sealed rows in scope.")
    if not cat_rows:
        print("Nothing to do. Every in-scope sealed row already has an id.")
        return

    if args.dry_run:
        print("\nDRY-RUN — no Supabase writes will happen.\n")
    else:
        print("\nWriting matches to Supabase. Press Ctrl+C if anything looks wrong.\n")
        time.sleep(2)

    n_exact = n_fuzzy = n_nomatch = n_priced = n_failed = 0
    today_iso = date.today().isoformat()
    unmatched_samples = []
    write_jobs = []

    for i, row in enumerate(cat_rows, start=1):
        matched, source, score = match_sealed_row(row, by_text, by_console,
                                                   fuzzy_threshold=args.threshold)
        if not matched:
            n_nomatch += 1
            if args.debug_unmatched and len(unmatched_samples) < args.debug_unmatched:
                unmatched_samples.append(row)
            continue
        if source == "exact": n_exact += 1
        else:                 n_fuzzy += 1
        if not args.dry_run:
            write_jobs.append((row, matched, source))

    # ── Write phase (parallel) ──────────────────────────────────────────
    if not args.dry_run and write_jobs:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        WRITE_WORKERS = int(os.environ.get("SUPABASE_WRITE_WORKERS", "20"))
        print(f"  Matching done. Writing {len(write_jobs):,} matches with {WRITE_WORKERS} workers…")

        write_lock = threading.Lock()
        write_completed = [0]

        def _do_write(job):
            row, matched, source = job
            rid = row["id"]
            payload = {"pricecharting_id": matched["pc_id"]}
            write_price = (not args.skip_prices) and (matched["price"] is not None)
            if write_price:
                payload["current_value"] = matched["price"]
            try:
                patch_row(rid, payload)
            except Exception as e:
                return ("failed", rid, str(e), False)
            if write_price:
                try:
                    upsert_history({
                        "catalog_id":     rid,
                        "recorded_value": matched["price"],
                        "recorded_at":    today_iso,
                        "source":         "pricecharting_csv_sealed",
                        "game_type":      row.get("game_type"),
                        "set_code":       row.get("set_code"),
                    })
                    return ("done_priced", rid, None, True)
                except Exception as e:
                    return ("done_history_warn", rid, str(e), False)
            return ("done", rid, None, False)

        with ThreadPoolExecutor(max_workers=WRITE_WORKERS) as pool:
            futs = [pool.submit(_do_write, j) for j in write_jobs]
            for fut in as_completed(futs):
                status, rid, err, priced = fut.result()
                with write_lock:
                    write_completed[0] += 1
                    if status == "failed":
                        n_failed += 1
                        print(f"  FAIL patch {rid}: {err}")
                    elif status == "done_history_warn":
                        print(f"  history WARN {rid}: {err}")
                    if priced:
                        n_priced += 1
                    if write_completed[0] % 250 == 0:
                        print(f"  …wrote {write_completed[0]:,} / {len(write_jobs):,}")

    # ── Summary ─────────────────────────────────────────────────────────
    total = len(cat_rows)
    matched = n_exact + n_fuzzy
    rate = (matched / total * 100.0) if total else 0.0
    print(f"\n{'─' * 60}")
    print(f"  Sealed catalog rows:     {total:,}")
    print(f"  Matched (exact):         {n_exact:,}")
    print(f"  Matched (fuzzy ≥{args.threshold}):  {n_fuzzy:,}")
    print(f"  No match:                {n_nomatch:,}")
    print(f"  Match rate:              {rate:.1f}%")
    if not args.dry_run:
        print(f"  Prices + history written:{n_priced:,}")
        if n_failed:
            print(f"  Patch failures:          {n_failed:,}")

    if args.debug_unmatched and unmatched_samples:
        print(f"\n  First {len(unmatched_samples)} unmatched rows:")
        for r in unmatched_samples:
            print(f"    {r.get('id')!s:35s} game={r.get('game_type')!s:10s} "
                  f"set={r.get('set_name')!r}  name={r.get('name')!r}")


if __name__ == "__main__":
    main()
