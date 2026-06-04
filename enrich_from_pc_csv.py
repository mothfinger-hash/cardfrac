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

import os, sys, csv, re, io, json, argparse, time, glob, tempfile, random, threading, html
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
#   (probable) gundam-card-game        — Bandai Gundam TCG (2025+)
#   (probable) dragon-ball-z-cards     — Panini DBZ TCG
#   (probable) dragon-ball-super-cards — newer DBS TCG
# Verify a candidate slug with: python3 enrich_from_pc_csv.py --category <slug> --inspect
# PC's full category list is at https://www.pricecharting.com/category/.
PC_DOWNLOAD_URL = "https://www.pricecharting.com/price-guide/download-custom"
KNOWN_CATEGORIES = [
    "pokemon-cards",
    "magic-cards",
    "yugioh-cards",
    "one-piece-cards",
    # NOTE: gundam-card-game, dragon-ball-z-cards, dragon-ball-super-cards,
    # pokemon-topps were tried here but PC's download-custom endpoint
    # doesn't actually serve them — it silently falls back to the
    # default 3DO video-game catalog. The sanity check in
    # download_category_csv catches the fallback and raises, so each
    # of those slugs costs ~30s of wasted retries per workflow run.
    # These four TCGs are now refreshed by the per-row HTTP scraper
    # in refresh-prices-small-tcgs.yml (workflow uses the per-row
    # script for gundam/dbz/onepiece/pokemon_topps; bulk-CSV path
    # handles only the four working categories above).
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
    # Brotli is supported when the `brotli` package is installed on the
    # runner (workflows install it explicitly). The module-level
    # _assert_brotli_available() check below fails loudly at startup if
    # it's missing — without that guard, PC opportunistically sends
    # brotli, urllib3 returns undecoded bytes, the resulting CSV is
    # garbage, and the downloader silently writes zero history rows for
    # the affected categories (the long-standing MTG/YGO refresh gap).
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

# Fail loudly at import time if we're advertising brotli but the runtime
# can't decode it — keeps the silent-garbage failure mode from coming
# back. Importers of this module (refresh_catalog_prices_csv.py + the
# enrichment runner) both pull download_category_csv, so guarding here
# covers every entry point.
def _assert_brotli_available():
    if "br" not in _DL_HEADERS.get("Accept-Encoding", ""):
        return
    try:
        import brotli  # noqa: F401
    except ImportError:
        sys.exit(
            "FATAL: Accept-Encoding advertises 'br' (brotli) but the `brotli` "
            "package is not installed. Run: pip3 install brotli --user --break-system-packages"
        )
_assert_brotli_available()


# ── CSV column name variants ──────────────────────────────────────────────────
# PC's bulk-CSV export (verified 2026-05) uses these column names. No URL
# column ships with the CSVs — matching has to go through (console, name)
# or (console, card_number). Keep the variant lists in case PC tweaks the
# headers in a future export.
CSV_COLUMNS = {
    "id":      ["id", "product-id", "product_id"],
    "name":    ["product-name", "product_name", "name"],
    "console": ["console-name", "console_name", "console", "set"],
    "loose":   ["loose-price", "loose_price"],
    "cib":     ["cib-price", "cib_price"],
    "new":     ["new-price", "new_price"],
}

# ── Card-number extraction ────────────────────────────────────────────────────
# PC's product-name format embeds the card number in several patterns:
#   "Charizard #6"                  → 6              (Pokemon, # prefix)
#   "Mew V #154"                    → 154
#   "Pikachu Promo #SWSH024"        → SWSH024
#   "Tropical Beach #BW28"          → BW28
#   "Ain OP07-002"                  → OP07-002       (OP/Gundam, bare code)
#   "Exodia the Forbidden One 25LP-EN000" → 25LP-EN000  (YGO, bare code)
#   "Dragonite #149 [Holo]"         → 149
#
# Two extraction patterns, tried in order:
#   1. # prefix (Pokemon's dominant style) — supports embedded dashes
#      so "Exodia ... #25LP-EN000" still works
#   2. Bare SET-NUM card code (YGO/OP/Gundam) — permissive enough to
#      catch digit-first set codes like "25LP" that the old regex missed
_PC_NUM_HASH     = re.compile(r"#\s*([A-Z0-9][A-Z0-9-]*)", re.IGNORECASE)
_PC_NUM_FULLCODE = re.compile(r"\b([A-Z0-9]{2,6}-[A-Z]{0,4}\d{1,5}[A-Z]?)\b", re.IGNORECASE)

def _extract_pc_card_number(product_name):
    """Pull the card number out of a PC product-name string.
    Returns lowercase normalized number or '' if none found."""
    if not product_name:
        return ""
    m = _PC_NUM_HASH.search(product_name)
    if m:
        return m.group(1).lower().rstrip("-")
    m = _PC_NUM_FULLCODE.search(product_name)
    if m:
        return m.group(1).lower()
    return ""


def _extract_pc_card_name(product_name):
    """The card name portion of PC's product-name — everything BEFORE the
    `#NUM` or `XXX-NNN` suffix, with bracketed tags stripped. For matching
    against our catalog's plain `name` column."""
    if not product_name:
        return ""
    s = _PC_NUM_HASH.sub("", product_name)
    s = _PC_NUM_FULLCODE.sub("", s)
    # Strip [Holo], [Foil], [Reverse Holo] etc. — variant tags don't match
    # our catalog's name field which doesn't carry them.
    s = re.sub(r"\[[^\]]*\]", "", s)
    return s.strip()


# ── Catalog-id parsing ────────────────────────────────────────────────────────
# Our catalog ids encode set + number, e.g.:
#   en-CRZ-154           → set='crz', num='154'
#   sv6-219              → set='sv6', num='219'
#   swsh11tg-TG23        → set='swsh11tg', num='tg23'
#   gym2-85              → set='gym2', num='85'
#   jp-sm10a-066         → set='sm10a', num='066'
#   dbz-awa-C18          → set='awa',  num='c18'  (multi-prefix)
#   sealed-jp-pc-7641193 → already has pc_id, gets skipped upstream
#
# Strategy: split on the LAST '-' to isolate the card number, then strip
# any known game/lang prefix from the leading portion. This handles the
# common case (en-CRZ-154) AND the multi-prefix case (dbz-awa-C18) which
# the old regex couldn't parse.
_CAT_ID_PREFIXES = ("en", "jp", "pd", "kr", "cn", "topps", "dbz", "mtg", "ygo", "op", "gun", "sealed")

def _extract_catalog_setnum(catalog_id):
    """Return (set_code_from_id_lower, card_number_lower) or ('','').

    Two patterns supported, picked by the number of dash-separated parts
    after stripping the game/lang prefix:
      2 parts → Pokemon-style: set, num                    (en-CRZ-154 → crz, 154)
      3+ parts → YGO/OP/Gundam-style: the LAST TWO parts
                 form the full card code, which PC indexes
                 as the card number INCLUDING the dash.
                 (ygo-25lp-25LP-EN000 → 25lp, 25lp-en000)
                 (op-eb-01-EB01-017   → eb01, eb01-017)
    """
    if not catalog_id or "-" not in catalog_id:
        return ("", "")

    # Strip game/lang prefix(es). 'dbz-awa-C18' → 'awa-C18'.
    rest = catalog_id
    while "-" in rest:
        head, tail = rest.split("-", 1)
        if head.lower() in _CAT_ID_PREFIXES:
            rest = tail
        else:
            break

    parts = rest.split("-")
    if len(parts) == 2:
        # Pokemon-style: set + plain number
        return (parts[0].lower(), parts[1].lower())
    if len(parts) >= 3:
        # YGO/OP/Gundam-style: the last two components are the full
        # card code (e.g. "25LP" + "EN000" → "25lp-en000"). PC's
        # product-name carries the same code verbatim, so matching the
        # full-code string against PC's by_setnum index works.
        card_set = parts[-2]
        card_num = parts[-1]
        full_code = (card_set + "-" + card_num).lower()
        return (card_set.lower(), full_code)
    return ("", "")


def _pick(row, key):
    """Return row[col] where col is the first matching variant from
    CSV_COLUMNS[key], or '' if none of them are present / non-empty.
    Strings are run through html.unescape so PriceCharting CSV titles
    that arrive entity-encoded (Goku&#39;s Energy, Pok&eacute;dex,
    &amp;, &rsquo;, etc.) match the catalog's decoded names cleanly.
    This script doesn't write back into name/set_name — but the
    matching pipeline normalises strings to compare against catalog
    rows, and encoded-vs-decoded mismatches silently drop matches
    that should have hit."""
    for col in CSV_COLUMNS.get(key, []):
        if col in row and row[col] not in (None, ""):
            v = row[col]
            return html.unescape(v) if isinstance(v, str) else v
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


# PC's CSV always prefixes the set name with the game ("Pokemon Base Set",
# "Magic: The Gathering Alpha", "Yu-Gi-Oh Legend of Blue Eyes"). Our
# catalog stores just the set name from pokedata / pokemontcg.io, with no
# game prefix. Strip the prefix before matching so "Pokemon Base Set" in
# PC lines up with "Base Set" in pathbinder.
_PC_CONSOLE_PREFIXES = [
    "pokemon japanese",         # check longest first so 'pokemon' doesn't eat it
    "pokemon",
    "magic the gathering",      # 'magic:' becomes 'magic ' after normalize
    "magic",
    "yu gi oh",                 # 'Yu-Gi-Oh!' normalizes to 'yu gi oh'
    "one piece",
    "gundam",
    "dragon ball z",
    "dragon ball super",
]

def _normalize_console(s):
    """Same as _normalize_text but also strips the leading game prefix
    PC adds to console names. So 'Pokemon Base Set' normalizes to the
    same key as our catalog's 'Base Set'."""
    norm = _normalize_text(s)
    for prefix in _PC_CONSOLE_PREFIXES:
        if norm.startswith(prefix + " "):
            return norm[len(prefix) + 1:]
        if norm == prefix:
            return ""
    return norm


# Single tokens that are too generic to use as a match key on their own.
# Without this filter, every PC console containing the word "set" / "edition"
# / "promos" would compete for the same (token, card_number) slot, and the
# match would be effectively random. We still emit these as part of bigrams
# and trigrams (where the surrounding context disambiguates).
_GENERIC_CONSOLE_TOKENS = frozenset({
    "the", "of", "and", "a", "an", "or",
    "set", "edition", "series", "promos", "promo",
    "card", "cards", "official", "league", "deck",
})

# Bigrams + trigrams + single tokens + full string of the stripped console
# name. Order matters — caller uses setdefault, so MORE SPECIFIC keys are
# yielded first to claim the (key, card_number) slot before any looser
# variant. So "Pokemon Base Set" Charizard #1 grabs ("base set", "1") AND
# ("base", "1"), and a later "Pokemon Base Set 2" #1 row only claims
# ("base set 2", "1") + ("set 2", "1") without clobbering "base".
def _console_keys(stripped_console):
    """Yield console keys in DECREASING specificity:
       full string → bigrams → trigrams → single tokens (stopword-filtered).
    Caller is responsible for dedup."""
    if not stripped_console:
        return
    yield stripped_console
    tokens = stripped_console.split()
    n = len(tokens)
    if n <= 1:
        return
    # n-grams sized 3 then 2 (most-specific-first within multi-word keys).
    for size in (3, 2):
        if n < size: continue
        for i in range(0, n - size + 1):
            ng = " ".join(tokens[i : i + size])
            if ng != stripped_console:    # already yielded
                yield ng
    # Single tokens last, so they're a fallback after exact / bigram hits.
    # Generic tokens excluded so (set, num) doesn't get owned by whichever
    # PC console happened to be processed first.
    for t in tokens:
        if t not in _GENERIC_CONSOLE_TOKENS:
            yield t


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
def _peek_first_row_genre(csv_path):
    """Read just the first data row from the CSV and return its genre
    column. Used to detect when PC's download endpoint silently returns
    a fallback catalog (3DO games etc.) for an unrecognized category
    slug. Returns None if the file can't be read or has no rows."""
    try:
        with open(csv_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Genre column lives at index 22 in PC's standard CSV
                # but column name varies, so use the dict accessor.
                return row.get("genre", "")
            return None
    except Exception:
        return None


# ─── 7-day CSV cache ─────────────────────────────────────────────────────────
# Persistent location for downloaded CSVs so a re-run within the same day
# doesn't have to re-pull from PC, AND so any future bug (encoding,
# matching, schema) can be retried against bytes-on-disk instead of
# burning bandwidth. We keep one folder per UTC date; anything older
# than 7 days gets pruned at the top of every download call.
# Stored on the runner under XDG_CACHE_HOME (default ~/.cache).
CSV_CACHE_ROOT = os.path.join(
    os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
    "pathbinder-pc-csvs",
)
CSV_CACHE_MAX_DAYS = 7

def _prune_csv_cache(root=CSV_CACHE_ROOT, max_days=CSV_CACHE_MAX_DAYS):
    """Delete date-named subdirs older than max_days. Idempotent."""
    if not os.path.isdir(root):
        return
    from datetime import datetime, timezone, timedelta
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=max_days)
    for entry in os.listdir(root):
        path = os.path.join(root, entry)
        if not os.path.isdir(path):
            continue
        try:
            entry_date = datetime.strptime(entry, "%Y-%m-%d").date()
        except ValueError:
            continue  # ignore non-date dirs
        if entry_date < cutoff:
            import shutil
            try:
                shutil.rmtree(path)
                print(f"  [cache] pruned {entry} (older than {max_days}d)")
            except Exception as e:
                print(f"  [cache] WARN failed to prune {entry}: {e}")

def _cache_path_for(category):
    """Today's cache filename for `category` (UTC date)."""
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return os.path.join(CSV_CACHE_ROOT, today, f"{category}.csv")


def download_category_csv(category, target_dir, max_retries=3):
    """Download a PC bulk CSV for the given category slug. Saves to
    `target_dir/<category>.csv` and returns the path.

    Caching:
      - Successful downloads also get copied to
        ~/.cache/pathbinder-pc-csvs/<YYYY-MM-DD>/<category>.csv
        so a re-run within the same day skips PC entirely (uses the
        cached copy). The cache is pruned to the last 7 days at the
        top of every call, so disk usage stays bounded.

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

    # Cache lookup: if today's CSV exists in cache, copy it into the
    # run's tempdir and skip the network call.
    _prune_csv_cache()
    cache_path = _cache_path_for(category)
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 50 * 1024:
        import shutil
        os.makedirs(target_dir, exist_ok=True)
        shutil.copy(cache_path, target_path)
        print(f"  {category}: cache hit ({os.path.getsize(cache_path)/1024:.0f} KB from {cache_path})")
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
                        last_err = f"suspiciously small response ({total_bytes} bytes)"
                        continue
                    # Sanity check: PC's download endpoint silently falls back
                    # to the DEFAULT category (3DO video games, alphabetically
                    # first) when the slug isn't recognized — instead of
                    # erroring or returning empty. A 19MB CSV of 3DO games
                    # looks like a successful download but matches nothing.
                    # Sample the first data row's `genre` column; if it
                    # doesn't contain "Card", "TCG", or "Sealed", flag the
                    # download as a category-slug miss.
                    sample = _peek_first_row_genre(target_path)
                    if sample is not None and not any(t in sample.lower() for t in ("card", "tcg", "sealed")):
                        try: os.remove(target_path)
                        except Exception: pass
                        last_err = (f"slug '{category}' not recognized by PC — endpoint "
                                    f"returned default catalog (first row genre: {sample!r}). "
                                    f"Check the slug on pricecharting.com.")
                        # Don't retry — this isn't a transient error.
                        raise RuntimeError(last_err)
                    # Sanity checks passed — copy into the 7-day cache so
                    # a same-day re-run or future bug retry doesn't have
                    # to re-download from PC.
                    try:
                        import shutil
                        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                        shutil.copy(target_path, cache_path)
                        print(f"  → {target_path} ({total_bytes/1024:.0f} KB)  [cached: {cache_path}]")
                    except Exception as e:
                        # Cache write failure is non-fatal — log and continue.
                        print(f"  → {target_path} ({total_bytes/1024:.0f} KB)  [cache write failed: {e}]")
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
def load_csv_index(paths, debug_headers=False):
    """Build four indexes from the CSV(s):
        by_setnum    : (normalized stripped console, card_number)        → csv_row_dict
        by_text      : (normalized stripped console, normalized cardname) → csv_row_dict
        by_unique_num: card_number → csv_row_dict, ONLY for numbers that
                       refer to a single product across the entire CSV
                       (catches things like 'bw100' / 'GG01' / 'TG23' where
                       PC bundles a set into a catch-all 'Pokemon Promo'
                       console but the card number is inherently unique)
        by_url       : reserved for future use; PC's CSV has no URL column
    Returns (by_url, by_text, by_setnum, by_unique_num, total_rows).

    Card number is the high-precision key — PC's product-name embeds it
    ("Charizard #6") and our catalog ids encode it too ("en-CRZ-154").
    Match on (set, number) and you avoid every name-variation pitfall
    (Charizard vs. Charizard ex vs. Charizard V vs. Charizard [Holo])."""
    by_url        = {}
    by_text       = {}
    by_setnum     = {}
    # Tracks every (card_number → {pc_id → entry}) so we can derive
    # by_unique_num after all CSVs are parsed. Built as we go.
    _num_to_pcids = {}
    total         = 0
    first_headers_logged = False

    for path in paths:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            headers = reader.fieldnames or []
            if debug_headers or not first_headers_logged:
                print(f"  CSV columns ({os.path.basename(path)}): {headers}")
                first_headers_logged = True

            for row in reader:
                total += 1
                pc_id = _pick(row, "id")
                if not pc_id:
                    continue
                full_name = _pick(row, "name")
                console   = _pick(row, "console")
                if not (full_name and console):
                    continue

                card_number = _extract_pc_card_number(full_name)
                card_name   = _extract_pc_card_name(full_name) or full_name
                price = _cents_to_dollars(_pick(row, "loose")) \
                     or _cents_to_dollars(_pick(row, "cib"))   \
                     or _cents_to_dollars(_pick(row, "new"))

                entry = {
                    "pc_id":       str(pc_id),
                    "name":        card_name,
                    "console":     console,
                    "card_number": card_number,
                    "price":       price,
                }

                # Build the candidate console keys IN ORDER of decreasing
                # specificity. Indexer uses setdefault so the FIRST inserted
                # key for any (key, card_number) wins — therefore we want
                # the most specific console keys to be processed first,
                # both within one PC row and across rows.
                stripped = _normalize_console(console)
                raw      = _normalize_text(console)
                console_keys = []
                seen = set()
                def _add(k):
                    if k and k not in seen:
                        seen.add(k); console_keys.append(k)
                # 1. Raw (with prefix) — most specific
                _add(raw)
                # 2. Stripped variants (drops game-name prefix + n-grams + tokens)
                for k in _console_keys(stripped):
                    _add(k)

                norm_name = _normalize_text(card_name) if card_name else ""
                for cn in console_keys:
                    if card_number:
                        by_setnum.setdefault((cn, card_number), entry)
                    if norm_name:
                        by_text.setdefault((cn, norm_name), entry)
                # Track this card_number → pc_id for the unique-number index
                if card_number:
                    _num_to_pcids.setdefault(card_number, {})[entry["pc_id"]] = entry

    # Build the unique-number index: card numbers that refer to a single
    # product across the entire CSV. Numbers like '1' or '100' are NOT
    # unique (every set has them); numbers like 'bw100', 'GG01', 'TG23',
    # 'SWSH024' typically ARE unique by construction.
    by_unique_num = {}
    for num, pcid_map in _num_to_pcids.items():
        if len(pcid_map) == 1:
            by_unique_num[num] = next(iter(pcid_map.values()))

    return by_url, by_text, by_setnum, by_unique_num, total


# ── Per-row match ─────────────────────────────────────────────────────────────
def _catalog_set_keys(set_name, set_code, id_set):
    """Build ordered candidate set keys for a catalog row.

    Symmetric to PC's indexer — we generate n-grams of the catalog's
    set_name so a catalog 'Wizards Black Star Promos' can match PC's
    'Pokemon Black Star Promos' via the trigram 'black star promos'.
    Without n-gramming the catalog side, the FULL set_name has to match
    PC's stripped console exactly, which fails for almost every set
    where the two data sources name things differently."""
    keys = []
    seen = set()
    def _add(k):
        if k and k not in seen:
            seen.add(k); keys.append(k)

    if set_name:
        norm = _normalize_text(set_name)
        # Full name first (most specific), then n-grams (less specific).
        _add(norm)
        for k in _console_keys(norm):
            _add(k)
    if set_code:
        _add(_normalize_text(set_code))
    if id_set:
        _add(id_set)
    return keys


def match_row(row, by_url, by_text, by_setnum, by_unique_num):
    """Return (csv_entry, source_label) for this catalog row, or (None, None).

    Match priority:
      1. (set, card_number)  — highest precision, immune to name variations
      2. (set, card_name)    — fallback when set keys agree but number missing
      3. card_number alone   — only when PC has a single product with that
                               number globally (catches PC's 'Pokemon Promo'
                               catch-all console where pokedata splits the
                               same cards into bwp/basep/neop/etc.)

    Set candidates are n-grammed on BOTH sides so partial matches work."""
    set_name = row.get("set_name")
    set_code = row.get("set_code")
    name     = row.get("name") or ""

    id_set, id_num = _extract_catalog_setnum(row.get("id") or "")
    set_keys = _catalog_set_keys(set_name, set_code, id_set)

    # 1. Card-number key with set — highest precision
    if id_num:
        for sk in set_keys:
            entry = by_setnum.get((sk, id_num))
            if entry:
                return (entry, "setnum")

    # 2. Name + set fallback
    if name:
        name_norm = _normalize_text(name)
        for sk in set_keys:
            entry = by_text.get((sk, name_norm))
            if entry:
                return (entry, "name")

    # 3. Globally-unique card_number fallback. Only fires when PC has
    #    exactly one product with that number across its entire catalog,
    #    so 'bw100' or 'GG01' resolves cleanly while plain '1' or '100'
    #    (which collide across hundreds of sets) won't fire here.
    if id_num:
        entry = by_unique_num.get(id_num)
        if entry:
            return (entry, "unique_num")

    return (None, None)


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
    ap.add_argument("--inspect", action="store_true",
                    help="Download (if needed), dump CSV columns + 3 sample rows, "
                         "then exit. NO catalog match, NO Supabase writes. ALWAYS keeps "
                         "downloaded CSVs so you can re-run against them.")
    ap.add_argument("--debug-unmatched", type=int, default=0, metavar="N",
                    help="At the end of an ingest, print full data for the first N "
                         "unmatched catalog rows AND the closest CSV candidates we found. "
                         "Use this to diagnose set-name drift / number-format issues.")
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
        # Inspect mode: just dump headers + a few rows from each CSV, no DB.
        if args.inspect:
            _run_inspect(paths)
            print(f"\n  CSVs kept at: {tmpdir or 'their original location'}")
            print(f"  Re-run a real ingest with: --csv-dir {tmpdir or '<your path>'}")
            return
        match_rate = _run_ingest(paths, args)
    finally:
        # Cleanup policy:
        #   - --keep-downloads → always keep
        #   - --inspect        → always keep (set above)
        #   - download failed  → keep (set above via early return)
        #   - low match rate   → keep so user can iterate without re-pulling
        #   - everything else  → delete to be tidy
        delete_ok = (
            tmpdir
            and not args.keep_downloads
            and not args.inspect
            and ('match_rate' in dir() and match_rate is not None and match_rate >= 50.0)
        )
        if delete_ok:
            for p in paths:
                try: os.remove(p)
                except Exception: pass
            try: os.rmdir(tmpdir)
            except Exception: pass
        elif tmpdir:
            print(f"\n  Downloaded CSVs kept at: {tmpdir}")
            print(f"  (Re-run without re-downloading: --csv-dir {tmpdir})")


def _run_inspect(paths):
    """Just dump the header + 3 sample rows from each CSV and return.
    Lets you see exactly what columns PC ships before committing to a
    full ingest."""
    for p in paths:
        print(f"\n=== {os.path.basename(p)} ===")
        with open(p, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            print(f"Headers ({len(reader.fieldnames or [])}):")
            for h in reader.fieldnames or []:
                print(f"  - {h}")
            print("Sample rows:")
            for i, row in enumerate(reader):
                if i >= 3:
                    break
                print(f"  Row {i+1}:")
                for k, v in row.items():
                    v_str = str(v)
                    if len(v_str) > 80: v_str = v_str[:77] + "..."
                    print(f"    {k}: {v_str}")


def _run_ingest(paths, args):
    print(f"Loading {len(paths)} CSV file(s)…")
    for p in paths:
        print(f"  • {p}")
    by_url, by_text, by_setnum, by_unique_num, csv_total = load_csv_index(paths)
    print(f"  Indexed {csv_total:,} CSV rows.")
    print(f"  by-setnum keys:    {len(by_setnum):,}   (set + card number — primary key)")
    print(f"  by-text keys:      {len(by_text):,}   (set + name fallback)")
    print(f"  by-unique-num:     {len(by_unique_num):,}   (globally-unique card numbers — catch-all-console fallback)")

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

    n_setnum     = 0    # matched by (set, card number) — primary
    n_text       = 0    # matched by (set, card name)   — fallback
    n_unique_num = 0    # matched by globally-unique card_number
    n_nomatch    = 0
    n_priced     = 0
    n_failed     = 0
    today_iso = date.today().isoformat()
    debug_n   = args.debug_unmatched
    unmatched_samples = []
    # Track outcomes by catalog.game_type so we can see at a glance which
    # TCG the misses concentrate in (e.g. YGO + Magic might be 90% of the
    # gap while Pokemon is mostly resolved). Built up per-row, dumped in
    # the summary block.
    by_game = {}   # game_type → {matched: int, nomatch: int}
    def _bump_game(gt, key):
        slot = by_game.setdefault(gt or "(none)", {"matched": 0, "nomatch": 0, "total": 0})
        slot[key]   += 1
        slot["total"] += 1
    # Reservoir-style: collect up to debug_n unmatched samples per game_type
    # so we see misses from EVERY TCG, not just whichever sorts alphabetically
    # first.
    unmatched_by_game = {}   # game_type → [rows]

    # ── Match phase (single-threaded, fast — pure dict lookups) ──────────
    # Build a queue of write jobs. Each job is (row, matched_entry,
    # source) so the write phase can fire them in parallel without
    # touching the matcher state.
    write_jobs = []
    for i, row in enumerate(cat_rows, start=1):
        matched, source = match_row(row, by_url, by_text, by_setnum, by_unique_num)
        if not matched:
            n_nomatch += 1
            _bump_game(row.get("game_type"), "nomatch")
            if debug_n:
                bucket = unmatched_by_game.setdefault(row.get("game_type") or "(none)", [])
                if len(bucket) < max(3, debug_n // 4):
                    bucket.append(row)
                if len(unmatched_samples) < debug_n:
                    unmatched_samples.append(row)
            continue
        _bump_game(row.get("game_type"), "matched")

        if   source == "setnum":     n_setnum     += 1
        elif source == "unique_num": n_unique_num += 1
        else:                        n_text       += 1

        if not args.dry_run:
            write_jobs.append((row, matched, source))

    if args.dry_run:
        print(f"  Dry-run: {len(write_jobs) if write_jobs else (n_setnum + n_text + n_unique_num)} matches identified, no writes performed.")
    else:
        # ── Write phase (parallel) ────────────────────────────────────────
        # Supabase round-trip is ~150-300ms each; doing 95k matched rows
        # serially would take ~8-12 HOURS. ThreadPoolExecutor with 20
        # workers cuts that to ~10-15 minutes. Supabase service-key writes
        # don't need rate limiting — its API rate budget is generous.
        WRITE_WORKERS = int(os.environ.get("SUPABASE_WRITE_WORKERS", "20"))
        from concurrent.futures import ThreadPoolExecutor, as_completed
        write_total = len(write_jobs)
        print(f"\n  Matching done. Writing {write_total:,} matches with {WRITE_WORKERS} parallel workers…")
        write_lock = threading.Lock()
        write_completed = [0]
        write_started_at = time.time()

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
                        "source":         "pricecharting_csv",
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
                    n = write_completed[0]
                    if status == "failed":
                        n_failed += 1
                        print(f"  FAIL patch {rid}: {err}")
                    elif status == "done_history_warn":
                        print(f"  history WARN {rid}: {err}")
                    if priced:
                        n_priced += 1
                    if n % 1000 == 0 or n == write_total:
                        elapsed = time.time() - write_started_at
                        rate = n / elapsed if elapsed > 0 else 0
                        eta_s = (write_total - n) / rate if rate > 0 else 0
                        print(f"  [{n:>7,}/{write_total:,}] writes  ({rate:.0f}/s, {eta_s/60:.1f}min left)")

    # ── Summary ───────────────────────────────────────────────────────
    total_matched = n_setnum + n_text + n_unique_num
    match_rate    = total_matched / max(len(cat_rows), 1) * 100
    print()
    print(f"  ─────────────────────────────────────────────────")
    print(f"  by (set, card #)   : {n_setnum:>7,}  — primary match key")
    print(f"  by (set, name)     : {n_text:>7,}  — set + name fallback")
    print(f"  by unique card #   : {n_unique_num:>7,}  — catch-all-console fallback (bw100 / GG01 / TG23 etc.)")
    print(f"  no match in CSV    : {n_nomatch:>7,}  (likely a set PC doesn't carry, or pokedata set-name drift)")
    print(f"  patch failures     : {n_failed:>7,}")
    if not args.skip_prices:
        print(f"  prices written    : {n_priced:>7,}  (catalog.current_value + catalog_price_history)")
    print(f"\n  Match rate: {match_rate:.1f}%")

    # ── Per-game-type breakdown ───────────────────────────────────────
    # Tells you which TCGs are pulling the rate down. Skipping the print
    # when there's only one game_type in scope (no comparison to make).
    if len(by_game) > 1:
        print(f"\n  ── By game_type ──")
        rows_sorted = sorted(by_game.items(), key=lambda kv: -kv[1]["total"])
        for gt, slot in rows_sorted:
            pct = slot["matched"] / max(slot["total"], 1) * 100
            print(f"    {gt:>16}: {slot['matched']:>7,} matched / {slot['total']:>7,} total  ({pct:5.1f}%)")

    # ── Debug dump for unmatched rows ─────────────────────────────────
    # Per-game-type sampling — show a handful from EVERY TCG that had
    # misses, not just the first N. Critical when the catalog spans
    # multiple TCGs and the bottleneck might be in Magic/YGO while
    # Pokemon is mostly resolved (or vice versa).
    if debug_n and unmatched_by_game:
        ordered = []
        for gt in sorted(unmatched_by_game.keys()):
            ordered.extend(unmatched_by_game[gt])
        print(f"\n  ── Sample unmatched rows (per game_type) ──")
        for row in ordered:
            id_set, id_num = _extract_catalog_setnum(row.get("id") or "")
            print()
            print(f"  CATALOG  id={row.get('id')}")
            print(f"           name={row.get('name')!r}")
            print(f"           set_name={row.get('set_name')!r}  set_code={row.get('set_code')!r}  game_type={row.get('game_type')!r}")
            print(f"           id-derived: set={id_set!r}  num={id_num!r}")
            # Find the closest PC consoles that have this card number
            # (without the set constraint) — tells us if the number IS in
            # PC's data, just not under any set string we tried.
            if id_num:
                hits = [(k[0], v) for k, v in by_setnum.items() if k[1] == id_num]
                # Cap to 5 to avoid flooding
                if hits:
                    print(f"  PC candidates with card #{id_num}:")
                    seen = set()
                    for cn, entry in hits[:30]:
                        # Dedupe by pc_id — multiple console keys point at the same entry
                        if entry["pc_id"] in seen: continue
                        seen.add(entry["pc_id"])
                        if len(seen) > 5: break
                        print(f"    pc_id={entry['pc_id']}  console={entry['console']!r}  name={entry['name']!r}")
                else:
                    print(f"  PC candidates with card #{id_num}: none — number not in PC data")
            else:
                print(f"  (no card number extractable from catalog id)")
    return match_rate


if __name__ == "__main__":
    main()
