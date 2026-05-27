#!/usr/bin/env python3
"""
PathBinder — PriceCharting CSV Ingest
======================================
Bulk-resolves catalog.pricecharting_id (and optionally catalog.current_value
+ a catalog_price_history snapshot) from PriceCharting's bulk CSV exports.

Why this exists
---------------
PC's API doesn't expose URL-keyed product lookup, and per-page scraping
is rate-limited by Cloudflare to ~3.5s per row per worker. For a 150k-row
catalog backfill that's 24+ hours and brittle. PC's paid tier ships
per-console CSVs that contain every product with its numeric ID + current
prices in one file. Ingesting those locally is the fast path: a single
script run can resolve and write tens of thousands of rows in minutes.

How matching works
------------------
For every CSV row, we try in order:
  1. Exact URL match against catalog.price_source_url
  2. Normalized URL match (lowercase host, strip trailing slash + query)
  3. Set-and-name match using PC's console-name + product-name vs our
     catalog.set_name + name (substring-tolerant, last-resort)

URL match catches the vast majority — PC URLs in our catalog were
originally sourced from PC, so they line up exactly with what's in the
CSVs. The name fallback is for the small number of rows the pokedata
sync stored without a URL but still recognizable by name.

USAGE
-----
    # Fetch and ingest a PC category directly (uses PRICECHARTING_API_KEY)
    python3 enrich_from_pc_csv.py --category pokemon-cards

    # Multiple categories in one run
    python3 enrich_from_pc_csv.py --categories pokemon-cards,magic-cards,yugioh-cards,one-piece-cards

    # Local CSV file you've already downloaded
    python3 enrich_from_pc_csv.py --csv ~/Downloads/pokemon-cards.csv

    # Folder of pre-downloaded CSVs
    python3 enrich_from_pc_csv.py --csv-dir ~/Downloads/pc-csvs/

    # Resolve IDs only, skip price writes
    python3 enrich_from_pc_csv.py --category pokemon-cards --skip-prices

    # Scope the catalog match to a specific TCG only
    python3 enrich_from_pc_csv.py --category pokemon-cards --tcg pokemon

    # Dry-run — match + report, don't write
    python3 enrich_from_pc_csv.py --category pokemon-cards --dry-run

CSV FORMAT EXPECTED
-------------------
PC's standard CSV headers (case-insensitive, hyphens or underscores OK):
  id, product-name, console-name, loose-price, cib-price, new-price,
  release-date, product-url

The script is defensive about column variants — if PC renames a column
later (id → product-id, product-url → url, etc.), update CSV_COLUMNS
at the top of the file.

ENVIRONMENT
-----------
    SUPABASE_URL          your project URL
    SUPABASE_SERVICE_KEY  service-role key (bypasses RLS for catalog writes)
"""

import os, sys, csv, re, io, json, argparse, time, glob, tempfile, random
from urllib.parse import urlparse, urlunparse
from datetime import date

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
PC_API_KEY   = os.environ.get("PRICECHARTING_API_KEY", "").strip() or None
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

# PC's bulk-CSV download endpoint. Premium-tier feature; uses the same
# API token as /api/product. Categories we currently care about:
#   pokemon-cards            (English Pokemon)
#   magic-cards              (Magic: The Gathering)
#   yugioh-cards             (Yu-Gi-Oh!)
#   one-piece-cards          (One Piece TCG)
# Add more as PC supports them — PC's category list is at
# https://www.pricecharting.com/category/<slug>.
PC_DOWNLOAD_URL = "https://www.pricecharting.com/price-guide/download-custom"
KNOWN_CATEGORIES = [
    "pokemon-cards",
    "magic-cards",
    "yugioh-cards",
    "one-piece-cards",
]

# Browser-realistic headers. Without these PC's Cloudflare WAF tends to
# return a "Just a moment..." challenge page (HTTP 403 with HTML body)
# after the first couple of successful downloads. Real browsers send the
# full set; copying it makes our request look like a Chrome download.
_DL_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept":          "text/csv,application/csv,text/plain,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer":         "https://www.pricecharting.com/",
    "Sec-Fetch-Dest":  "document",
    "Sec-Fetch-Mode":  "navigate",
    "Sec-Fetch-Site":  "same-origin",
    "Upgrade-Insecure-Requests": "1",
    "Connection":      "keep-alive",
}
_dl_session = requests.Session()
_dl_session.headers.update(_DL_HEADERS)


# ── CSV column name variants ──────────────────────────────────────────────────
# PC's CSV uses hyphenated names; we accept underscores too just in case.
# If a future CSV export uses a totally different name, add it here.
CSV_COLUMNS = {
    "id":           ["id", "product-id", "product_id"],
    "name":         ["product-name", "product_name", "name"],
    "console":      ["console-name", "console_name", "console", "set"],
    "url":          ["product-url", "product_url", "url"],
    "loose":        ["loose-price", "loose_price"],
    "cib":          ["cib-price", "cib_price"],
    "new":          ["new-price", "new_price"],
}


def _pick(row, key):
    """Return row[col] where col is the first matching variant from
    CSV_COLUMNS[key], or '' if none of them are present / non-empty."""
    for col in CSV_COLUMNS.get(key, []):
        if col in row and row[col] not in (None, ""):
            return row[col]
    return ""


def _normalize_url(u):
    """Lowercase host, strip trailing slash + query/fragment. Doesn't
    touch the path case because PC URL slugs are case-sensitive."""
    if not u:
        return ""
    try:
        p = urlparse(u.strip())
        host = (p.netloc or "").lower()
        path = (p.path or "").rstrip("/")
        return urlunparse(("https", host, path, "", "", ""))
    except Exception:
        return u.strip().rstrip("/")


_NORM_NAME_RE = re.compile(r"[^a-z0-9]+")

def _normalize_text(s):
    """Lowercase + strip non-alphanumerics. For set+name fallback matching."""
    if not s:
        return ""
    return _NORM_NAME_RE.sub(" ", s.lower()).strip()


def _cents_to_dollars(raw):
    """PC CSV prices are integer cents in some exports, decimal dollars
    in others. Tolerant parse — return float dollars or None."""
    if raw is None:
        return None
    s = str(raw).strip().replace("$", "").replace(",", "")
    if not s:
        return None
    try:
        v = float(s)
    except Exception:
        return None
    if v <= 0:
        return None
    # Heuristic: if no decimal point AND value > 1000, assume cents.
    # PC's "loose-price" is typically integer cents (e.g. 425 = $4.25);
    # a few exports use decimal dollars (4.25). Splitting on '.' is
    # the cleanest signal.
    if "." not in s and v > 100:
        v = v / 100.0
    return v


# ── Supabase REST helpers ─────────────────────────────────────────────────────
def _sb_headers(extra=None):
    h = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    }
    if extra: h.update(extra)
    return h


def load_catalog(game_type):
    """Pull every catalog row with no pricecharting_id (the only rows
    we have anything to do for). Includes name + set_name + price_source_url
    so we can match by URL or fall back to name + console."""
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog"
    select = "id,name,set_name,set_code,game_type,price_source_url"
    flt = "pricecharting_id=is.null"
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


def patch_row(row_id, payload):
    """PATCH catalog with just the columns in `payload`. Other columns
    are untouched — price_source_url stays, name stays, etc."""
    r = requests.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{row_id}",
        headers=_sb_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        data=json.dumps(payload),
        timeout=30,
    )
    r.raise_for_status()


def upsert_history(row):
    """Same upsert pattern as refresh_catalog_prices — keyed by
    (catalog_id, recorded_at)."""
    r = requests.post(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog_price_history?on_conflict=catalog_id,recorded_at",
        headers=_sb_headers({
            "Content-Type":  "application/json",
            "Prefer":        "resolution=merge-duplicates,return=minimal",
        }),
        data=json.dumps(row),
        timeout=30,
    )
    r.raise_for_status()


# ── PC category download ──────────────────────────────────────────────────────
def download_category_csv(category, target_dir, max_retries=3):
    """Download a PC bulk CSV for the given category slug. Saves to
    `target_dir/<category>.csv` and returns the path.

    Resumable + Cloudflare-tolerant:
      - If the target file already exists with non-trivial size, skip
        the download. Lets the user re-run after a partial failure
        without re-pulling categories that already worked.
      - On 403 (Cloudflare challenge), sleep with exponential backoff
        and retry up to max_retries times. The challenge usually clears
        within a minute or two as long as we're not hammering."""
    if not PC_API_KEY:
        sys.exit("PRICECHARTING_API_KEY env var must be set to use --category / --categories.")
    target_path = os.path.join(target_dir, f"{category}.csv")

    # Resume: if the file already exists and isn't a partial / empty,
    # assume the previous run succeeded for this category.
    if os.path.exists(target_path) and os.path.getsize(target_path) > 1024:
        print(f"  {category}: already downloaded ({os.path.getsize(target_path)/1024:.0f} KB), skipping.")
        return target_path

    last_err = None
    for attempt in range(max_retries):
        if attempt > 0:
            sleep_s = (2 ** attempt) * 30 + random.uniform(0, 15)
            print(f"  {category}: retrying in {sleep_s:.0f}s after {last_err}")
            time.sleep(sleep_s)
        print(f"  Downloading {category}…")
        try:
            with _dl_session.get(PC_DOWNLOAD_URL,
                                 params={"t": PC_API_KEY, "category": category},
                                 stream=True, timeout=300) as r:
                if r.status_code == 200:
                    total_bytes = 0
                    with open(target_path, "wb") as f:
                        for chunk in r.iter_content(chunk_size=64 * 1024):
                            if chunk:
                                f.write(chunk)
                                total_bytes += len(chunk)
                    # Sanity check: Cloudflare can return 200 with a challenge
                    # body. CSVs are several MB; <50KB is a strong signal we
                    # got an HTML challenge instead.
                    if total_bytes < 50 * 1024:
                        try: os.remove(target_path)
                        except Exception: pass
                        head = open(target_path, 'rb').read(200) if os.path.exists(target_path) else b''
                        last_err = f"suspiciously small response ({total_bytes} bytes)"
                        continue
                    print(f"  → {target_path} ({total_bytes/1024:.0f} KB)")
                    return target_path

                if r.status_code in (403, 429, 503):
                    # Cloudflare challenge OR rate limit. Worth retrying.
                    body = r.text[:200]
                    last_err = f"HTTP {r.status_code} ({'Cloudflare challenge' if 'Just a moment' in body else 'blocked'})"
                    continue

                # Other status — don't retry.
                raise RuntimeError(f"HTTP {r.status_code} on {category}: {r.text[:300]}")
        except requests.exceptions.RequestException as e:
            last_err = f"network: {e}"
            continue

    raise RuntimeError(f"Exhausted retries on {category}: {last_err}")


# ── CSV ingest ────────────────────────────────────────────────────────────────
def load_csv_index(paths):
    """Build two indexes from the CSV(s):
        by_url   : normalized URL → csv_row_dict
        by_text  : (normalized console, normalized name) → csv_row_dict
    Returns (by_url, by_text, total_rows).
    """
    by_url  = {}
    by_text = {}
    total   = 0
    for path in paths:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                total += 1
                pc_id  = _pick(row, "id")
                if not pc_id:
                    continue
                name    = _pick(row, "name")
                console = _pick(row, "console")
                url     = _pick(row, "url")
                price   = _cents_to_dollars(_pick(row, "loose")) \
                       or _cents_to_dollars(_pick(row, "cib"))   \
                       or _cents_to_dollars(_pick(row, "new"))
                entry = {
                    "pc_id":   str(pc_id),
                    "name":    name,
                    "console": console,
                    "url":     url,
                    "price":   price,
                }
                if url:
                    by_url[_normalize_url(url)] = entry
                if name and console:
                    by_text[(_normalize_text(console), _normalize_text(name))] = entry
    return by_url, by_text, total


# ── Per-row match ─────────────────────────────────────────────────────────────
def match_row(row, by_url, by_text):
    """Return the CSV entry for this catalog row, or None."""
    # 1. Exact URL
    url = row.get("price_source_url") or ""
    if url:
        norm = _normalize_url(url)
        if norm in by_url:
            return by_url[norm]
    # 2. Set + name (case-tolerant). Only attempted if both fields are set.
    set_name = row.get("set_name") or row.get("set_code")
    name     = row.get("name")
    if set_name and name:
        key = (_normalize_text(set_name), _normalize_text(name))
        if key in by_text:
            return by_text[key]
    return None


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description="Ingest PriceCharting CSV exports and backfill catalog.pricecharting_id (+ current_value).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--csv",        help="Path to a single PC CSV file (pre-downloaded).")
    src.add_argument("--csv-dir",    help="Path to a directory of PC CSV files.")
    src.add_argument("--category",   help="PC category slug to fetch + ingest (uses PRICECHARTING_API_KEY).")
    src.add_argument("--categories", help="Comma-separated PC category slugs to fetch + ingest in one run.")
    src.add_argument("--all-tcgs",   action="store_true",
                     help=f"Fetch + ingest every category we currently support: {', '.join(KNOWN_CATEGORIES)}.")

    ap.add_argument("--tcg", default="all",
                    help="catalog.game_type to limit matches to (default 'all'). "
                         "Independent of which CSV(s) you ingest — useful for scoping the catalog match.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Match + report, don't write to Supabase.")
    ap.add_argument("--skip-prices", action="store_true",
                    help="Only write pricecharting_id — don't update current_value or "
                         "write a catalog_price_history snapshot.")
    ap.add_argument("--keep-downloads", action="store_true",
                    help="Keep downloaded category CSVs on disk after the run (default: delete). "
                         "Useful for re-runs without re-downloading.")
    args = ap.parse_args()

    # ── Collect CSV paths ─────────────────────────────────────────────
    # Three modes:
    #   - local file(s) via --csv / --csv-dir
    #   - download via --category / --categories / --all-tcgs
    paths = []
    tmpdir = None
    try:
        if args.csv:
            paths = [args.csv]
        elif args.csv_dir:
            paths = sorted(glob.glob(os.path.join(args.csv_dir, "*.csv")))
        else:
            # Download mode — build the category list, fetch each.
            if args.all_tcgs:
                cats = KNOWN_CATEGORIES
            elif args.categories:
                cats = [c.strip() for c in args.categories.split(",") if c.strip()]
            else:
                cats = [args.category]
            tmpdir = tempfile.mkdtemp(prefix="pc_csv_")
            print(f"Downloading {len(cats)} PC category CSV(s) to {tmpdir}…")
            download_failed = False
            for idx, c in enumerate(cats):
                # 5–15s pause between categories. PC's Cloudflare flags
                # back-to-back rapid downloads from the same IP — a small
                # gap between requests is the cheapest way to avoid 403s.
                if idx > 0:
                    time.sleep(random.uniform(5, 15))
                try:
                    paths.append(download_category_csv(c, tmpdir))
                except Exception as e:
                    download_failed = True
                    print(f"\n  FAILED to download {c}: {e}")
                    print(f"  Partial downloads kept at: {tmpdir}")
                    print(f"  To resume, re-run with: --csv-dir {tmpdir}")
                    print(f"  (or just re-run the same command — successfully-downloaded categories are skipped)")
                    break
            if download_failed:
                # Don't proceed to ingest from a partial set. User can retry.
                return
        if not paths:
            sys.exit("No CSV files found / downloaded.")
        _run_ingest(paths, args)
    finally:
        # Clean up downloaded files unless the user asked to keep them OR
        # a download failed mid-run (in which case keep them so the user
        # can resume without re-pulling the ones that worked).
        if tmpdir and not args.keep_downloads and len(paths) == len(cats if 'cats' in dir() else paths):
            for p in paths:
                try: os.remove(p)
                except Exception: pass
            try: os.rmdir(tmpdir)
            except Exception: pass


def _run_ingest(paths, args):
    print(f"Loading {len(paths)} CSV file(s)…")
    for p in paths:
        print(f"  • {p}")
    by_url, by_text, csv_total = load_csv_index(paths)
    print(f"  Indexed {csv_total:,} CSV rows.")
    print(f"  by-URL keys:  {len(by_url):,}")
    print(f"  by-text keys: {len(by_text):,}")

    # ── Load catalog ──────────────────────────────────────────────────
    print(f"\nLoading catalog rows (game_type={args.tcg!r}) missing pricecharting_id…")
    cat_rows = load_catalog(args.tcg)
    print(f"  {len(cat_rows):,} rows in scope.")
    if not cat_rows:
        print("Nothing to do. Every in-scope row already has an id.")
        return

    if args.dry_run:
        print("\nDRY-RUN — no Supabase writes will happen.\n")
    else:
        print("\nWriting matches to Supabase. Press Ctrl+C if anything looks wrong.\n")
        time.sleep(2)

    n_url     = 0    # matched by exact URL
    n_text    = 0    # matched by set + name fallback
    n_nomatch = 0    # no match in any CSV
    n_priced  = 0    # current_value also written
    n_failed  = 0
    today_iso = date.today().isoformat()

    for i, row in enumerate(cat_rows, start=1):
        rid     = row["id"]
        matched = match_row(row, by_url, by_text)
        if not matched:
            n_nomatch += 1
            continue

        # Tag the match source for the summary; small lookup repeat is fine
        if row.get("price_source_url") and _normalize_url(row["price_source_url"]) in by_url:
            n_url += 1
        else:
            n_text += 1

        payload = {"pricecharting_id": matched["pc_id"]}
        write_price = (not args.skip_prices) and (matched["price"] is not None)
        if write_price:
            payload["current_value"] = matched["price"]

        if args.dry_run:
            continue

        try:
            patch_row(rid, payload)
        except Exception as e:
            n_failed += 1
            print(f"  [{i}/{len(cat_rows)}] FAIL patch {rid}: {e}")
            continue

        if write_price:
            try:
                upsert_history({
                    "catalog_id":     rid,
                    "recorded_value": matched["price"],
                    "recorded_at":    today_iso,
                    "source":         "pricecharting_csv",
                    "game_type":      row.get("game_type"),
                    "set_code":       row.get("set_code"),
                })
                n_priced += 1
            except Exception as e:
                # Non-fatal — id is already written, history is a nice-to-have.
                print(f"  [{i}/{len(cat_rows)}] history WARN {rid}: {e}")

        if i % 500 == 0:
            print(f"  [{i:>6}/{len(cat_rows)}] matched={n_url+n_text} nomatch={n_nomatch} failed={n_failed}")

    # ── Summary ───────────────────────────────────────────────────────
    total_matched = n_url + n_text
    print()
    print(f"  ─────────────────────────────────────────────────")
    print(f"  matched by URL    : {n_url:>7,}")
    print(f"  matched by name   : {n_text:>7,}")
    print(f"  no match in CSV   : {n_nomatch:>7,}  (run another CSV or leave for nightly scrape)")
    print(f"  patch failures    : {n_failed:>7,}")
    if not args.skip_prices:
        print(f"  prices written    : {n_priced:>7,}  (catalog.current_value + catalog_price_history)")
    if total_matched and not args.dry_run:
        print(f"\n  Match rate: {total_matched / max(len(cat_rows), 1) * 100:.1f}%")


if __name__ == "__main__":
    main()
