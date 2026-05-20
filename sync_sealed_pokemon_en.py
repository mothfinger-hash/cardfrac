#!/usr/bin/env python3
"""
PathBinder — Sealed Pokémon English Catalog Sync (per-set scrape)
===================================================================
Scrapes PriceCharting's per-set console pages (server-rendered HTML)
and upserts every sealed product into `catalog` with
`product_type` != 'single'.

Per-set rather than per-search because PriceCharting's
`/search-products?…` results page is JavaScript-rendered (the row
table is XHR-loaded after page-load) and our requests.get() only
sees the empty shell. The `/console/{slug}` pages, on the other
hand, are fully server-rendered.

PREREQUISITES:
    1. Run migration_sealed_products.sql in Supabase first.
    2. pip3 install requests supabase --break-system-packages

USAGE:
    # Dry-run — show what would be written, don't touch the DB
    python3 sync_sealed_pokemon_en.py --dry-run

    # Real sync
    python3 sync_sealed_pokemon_en.py

    # Sync ONE set only (debugging) — use the console slug
    python3 sync_sealed_pokemon_en.py --only "pokemon-scarlet-&-violet-151"

    # Inspect HTML for debugging when a parse turns up empty
    python3 sync_sealed_pokemon_en.py --debug-dump

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key (NOT anon)
"""

import os, sys, re, json, time, argparse, html, threading
from pathlib import Path
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

# NOTE: this script intentionally does NOT use supabase-py. The library
# has a Unicode-encoding bug at certain versions that corrupts batch
# upserts even when the data is ASCII. Hitting PostgREST directly with
# `requests` is the same operation with one less moving part.

# ─── Configuration ──────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

PC_BASE = "https://www.pricecharting.com"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Sets to scrape. Each tuple is (display_set_name, console_slug, set_code).
# console_slug is the slug PriceCharting uses in the URL after /console/.
# Notes on the slugs:
#   • Most sets are just `pokemon-{set-name}` (verified: paldea-evolved,
#     obsidian-flames, stellar-crown, prismatic-evolutions, etc.)
#   • The "151" expansion is a SUB-PRODUCT of S&V so its slug includes
#     the parent set name: `pokemon-scarlet-&-violet-151`. Literal `&`.
#   • Add new sets here as they release.
SETS = [
    # (display name,                pricecharting console slug,            our set_code)
    ("Scarlet & Violet",            "pokemon-scarlet-&-violet",            "sv1"),
    ("Paldea Evolved",              "pokemon-paldea-evolved",              "sv2"),
    ("Obsidian Flames",             "pokemon-obsidian-flames",             "sv3"),
    ("151",                         "pokemon-scarlet-&-violet-151",        "mew"),
    ("Paradox Rift",                "pokemon-paradox-rift",                "sv4"),
    ("Paldean Fates",               "pokemon-paldean-fates",               "sv4pt5"),
    ("Temporal Forces",             "pokemon-temporal-forces",             "sv5"),
    ("Twilight Masquerade",         "pokemon-twilight-masquerade",         "sv6"),
    ("Shrouded Fable",              "pokemon-shrouded-fable",              "sv6pt5"),
    ("Stellar Crown",               "pokemon-stellar-crown",               "sv7"),
    ("Surging Sparks",              "pokemon-surging-sparks",              "sv8"),
    ("Prismatic Evolutions",        "pokemon-prismatic-evolutions",        "sv8pt5"),
    ("Crown Zenith",                "pokemon-crown-zenith",                "swsh12pt5"),
    ("Silver Tempest",              "pokemon-silver-tempest",              "swsh12"),
    ("Lost Origin",                 "pokemon-lost-origin",                 "swsh11"),
    ("Astral Radiance",             "pokemon-astral-radiance",             "swsh10"),
    ("Brilliant Stars",             "pokemon-brilliant-stars",             "swsh9"),
    ("Fusion Strike",               "pokemon-fusion-strike",               "swsh8"),
    ("Evolving Skies",              "pokemon-evolving-skies",              "swsh7"),
    ("Celebrations",                "pokemon-celebrations",                "swsh11pt5"),
]

# Names that mark sealed products. SPECIFIC PHRASES FIRST so e.g. "booster
# bundle" is classified as booster_bundle (not the generic "bundle"), and
# "battle academy toolkit" before generic "toolkit". First match wins.
SEALED_PATTERNS = [
    # — Boxes & high-tier collections —
    ("ultra premium collection",     "utb"),
    ("upc",                          "utb"),
    ("elite trainer box",            "etb"),
    ("etb",                          "etb"),
    ("premium collection",           "premium_collection"),
    ("collection box",               "premium_collection"),
    ("special collection",           "premium_collection"),
    ("booster box",                  "booster_box"),
    ("trainer box",                  "etb"),

    # — Bundles (specific before generic) —
    ("booster bundle",               "booster_bundle"),
    ("gift bundle",                  "gift_bundle"),
    ("holiday bundle",               "gift_bundle"),
    ("bundle",                       "bundle"),         # catch-all

    # — Decks (specific before generic) —
    ("league battle deck",           "battle_deck"),
    ("battle deck",                  "battle_deck"),
    ("theme deck",                   "theme_deck"),
    ("starter deck",                 "theme_deck"),
    ("deck",                         "deck"),           # catch-all

    # — Toolkits —
    ("battle academy toolkit",       "toolkit"),
    ("battle toolkit",               "toolkit"),
    ("toolkit",                      "toolkit"),

    # — Binders (sealed binder products with promo cards) —
    ("collector's binder",           "binder_collection"),
    ("collectors binder",            "binder_collection"),
    ("premium binder",               "binder_collection"),
    ("binder collection",            "binder_collection"),
    ("binder",                       "binder_collection"),  # catch-all

    # — Build & Battle —
    ("build and battle",             "build_and_battle"),
    ("build & battle",               "build_and_battle"),

    # — Tins (mini before generic) —
    ("mini tin",                     "mini_tin"),
    (" tin",                         "tin"),            # space-prefix avoids "tincture"

    # — Packs (last because broad-ish) —
    ("booster pack",                 "booster_pack"),
]

# Single-card markers — applied first to skip listings like "X.Drake
# [Super Pre-release] ST04-013" that share a console page with sealed.
_SINGLE_CARD_TOKENS = (
    re.compile(r'\b[A-Z]{1,5}[0-9]{1,3}-\d{1,3}\b'),  # set-prefix + dash + number
    re.compile(r'#\d{1,3}\b'),                         # explicit #N
)
def looks_like_single_card(name: str) -> bool:
    return any(rx.search(name) for rx in _SINGLE_CARD_TOKENS)

def detect_product_type(name: str):
    if looks_like_single_card(name):
        return "single", False
    n = name.lower()
    for token, ptype in SEALED_PATTERNS:
        if token in n:
            return ptype, True
    return "single", False


# Map the slug language hint → the 2-letter code we use elsewhere in
# the catalog (en, jp, kr, …). Defaults to 'en' when nothing matches —
# most modern English Pokémon sets have plain slugs like
# `pokemon-paldea-evolved` with no language token.
def lang_from_slug(slug: str) -> str:
    s = slug.lower()
    if "japanese"   in s: return "jp"
    if "korean"     in s: return "kr"
    if "chinese"    in s: return "cn"
    if "german"     in s: return "de"
    if "french"     in s: return "fr"
    if "italian"    in s: return "it"
    if "spanish"    in s: return "es"
    if "portuguese" in s: return "pt"
    if "dutch"      in s: return "nl"
    if "russian"    in s: return "ru"
    return "en"


# Strip "smart" Unicode punctuation that breaks ASCII-only encoders in
# some HTTP libraries (the supabase-py upsert path chokes on U+2026 "…"
# even though regular accented chars like é in "Pokémon" pass fine).
SMART_PUNCT = str.maketrans({
    "…": "...",    # …  horizontal ellipsis
    "‘": "'",      # '  left single quote
    "’": "'",      # '  right single quote / apostrophe
    "“": '"',      # "  left double quote
    "”": '"',      # "  right double quote
    "–": "-",      # –  en dash
    "—": "--",     # —  em dash
    " ": " ",      #   non-breaking space
})
def sanitize_text(s):
    if not isinstance(s, str):
        return s
    # Decode HTML entities first ("&amp;" → "&", "&#39;" → "'", etc.)
    cleaned = html.unescape(s)
    # Then normalise the smart-punctuation we know about
    cleaned = cleaned.translate(SMART_PUNCT).strip()
    # Safety net: replace anything still outside Latin-1 (covers any
    # weird Unicode left over from PriceCharting). 'é' in "Pokémon" is
    # inside Latin-1 so it survives.
    try:
        cleaned.encode('latin-1')
        return cleaned
    except UnicodeEncodeError:
        return cleaned.encode('ascii', errors='replace').decode('ascii')

def sanitize_row(row):
    """Scrub every string value in the dict. Catches sneaky Unicode in
    fields we didn't realise might contain it."""
    return {k: (sanitize_text(v) if isinstance(v, str) else v)
            for k, v in row.items()}


def load_msrp_seed():
    p = Path(__file__).parent / "data" / "msrp_sealed_pokemon_en.json"
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text())
        return {k.lower(): v for k, v in raw.items() if not k.startswith("_")}
    except Exception as e:
        print(f"  [warn] MSRP seed parse failed: {e}", file=sys.stderr)
        return {}


def fetch(url, retries=4):
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=20)
            if r.status_code == 200:
                return r.text
            last = f"status {r.status_code}"
            # 403 / 429 = rate-limited. Back off MUCH harder than for
            # generic errors, and only on rate-limit codes. Keeps
            # transient connection issues from waiting forever.
            if r.status_code in (403, 429):
                backoff = 5 * (attempt + 1) ** 2     # 5, 20, 45, 80 sec
                time.sleep(backoff)
                continue
        except Exception as e:
            last = str(e)
        time.sleep(1 + attempt)
    print(f"  [warn] fetch failed {url}: {last}", file=sys.stderr)
    return None


def upsert_catalog(rows):
    """Bulk upsert into public.catalog via PostgREST directly.
    Bypasses supabase-py (which has a Unicode-encoding bug at some versions)."""
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?on_conflict=id"
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json; charset=utf-8",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
    }
    body = json.dumps(rows, ensure_ascii=False).encode("utf-8")
    r = requests.post(url, headers=headers, data=body, timeout=30)
    if not r.ok:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")


def preserve_mirrored_image_urls(rows):
    """For rows whose existing image_url is already on Supabase Storage
    (mirrored), strip the 'image_url' key from the new payload so the
    upsert doesn't clobber the mirrored URL with the PriceCharting one.
    Pops image_url IN PLACE; nothing returned."""
    if not rows:
        return
    ids = [r["id"] for r in rows]
    # PostgREST query: id=in.(a,b,c)  →  url-encoded as quoted list
    id_param = "in.(" + ",".join(f'"{i}"' for i in ids) + ")"
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog"
    params = {"select": "id,image_url", "id": id_param}
    try:
        r = requests.get(url, headers={
            "apikey":        SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Accept":        "application/json",
        }, params=params, timeout=30)
        r.raise_for_status()
        existing = {row["id"]: (row.get("image_url") or "") for row in r.json()}
    except Exception as e:
        print(f"  [warn] couldn't fetch existing image_urls — image_url will be overwritten. {e}",
              file=sys.stderr)
        return
    sup_host_token = SUPABASE_URL.rstrip("/").split("//", 1)[-1].lower()
    preserved = 0
    for r in rows:
        existing_url = existing.get(r["id"], "")
        if existing_url and sup_host_token in existing_url.lower():
            r.pop("image_url", None)
            preserved += 1
    if preserved:
        print(f"  Preserving {preserved} already-mirrored image_url values.")


# Discover Pokémon set console-slugs from the category index. Far more
# comprehensive than a hand-curated list — picks up every era from
# Base Set through the latest release with one HTTP call. We still
# keep a small `set_code` map for the modern sets so our internal
# set_code stays short ("sv1", "mew", …); everything else gets a
# slug-derived set_code that the admin "needs review" view surfaces.
CATEGORY_INDEX_URL = f"{PC_BASE}/category/pokemon-cards"

def discover_set_slugs():
    """Returns list of (display_name, console_slug) for every Pokémon
    set listed on the category index page."""
    page_html = fetch(CATEGORY_INDEX_URL)
    if not page_html:
        return []
    # Each set is linked as <a href="/console/pokemon-foo">Foo</a>.
    # We keep EVERY language Pokémon set — Japanese, Korean, Chinese,
    # German, French, etc. — so we don't need a second-pass sync later.
    # The language-aware ID prefix downstream namespaces them apart.
    SKIP_TOKENS = ()
    found = []
    seen  = set()
    for m in re.finditer(r'href="/console/(pokemon-[^"]+)"[^>]*>([^<]+)</a>', page_html, re.IGNORECASE):
        slug = m.group(1)
        name = m.group(2).strip()
        # CRITICAL: PriceCharting renders the slug HTML-encoded in the
        # category index ("pokemon-scarlet-&amp;-violet"). We need the
        # raw form ("pokemon-scarlet-&-violet") for the actual URL to
        # resolve. html.unescape covers &amp; / &#39; / etc.
        slug = html.unescape(slug)
        name = html.unescape(name)
        if any(t in slug.lower() for t in SKIP_TOKENS):
            continue
        if slug in seen:
            continue
        seen.add(slug)
        found.append((name, slug))
    return found


# ─── HTML parsing ───────────────────────────────────────────────────────────
#
# Verified shape (May 2026):
#   PriceCharting's console pages render a big <tr>…</tr> per product.
#   The PriceCharting product id lives in a `data-product-id="…"` (and
#   sometimes `data-product="…"`) attribute carried on the row itself or
#   on one of its inner <td>s. The product link is the first
#   <a href="/game/{slug}/{product-slug}">Product Name</a> inside the row.
#   Image is a thumbnail <img src="…jpg|png|webp">.
#
# Row capture: split on </tr> boundaries and look for data-product-id
# inside each chunk. More forgiving than requiring the attribute to live
# on the <tr> element itself.

ROW_SPLIT = re.compile(r'<tr\b', re.IGNORECASE)
ID_RE     = re.compile(r'data-product(?:-id)?="(\d+)"', re.IGNORECASE)
LINK_RE   = re.compile(r'<a[^>]*href="(/game/pokemon[^"]+)"[^>]*>([^<]+)</a>', re.IGNORECASE)
IMG_RE    = re.compile(r'<img[^>]*(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"', re.IGNORECASE)


def parse_console_page(html: str, set_name: str, set_code: str, slug: str, msrp_seed: dict):
    """Yield catalog rows for sealed products in a per-set console page."""
    if not html:
        return
    # Language code derived from the slug (en | jp | kr | …) — used to
    # prefix the catalog id so sealed products cluster with the right
    # language's cards in queries.
    lang = lang_from_slug(slug)
    # Split into per-<tr> chunks. The first chunk is the header / chrome
    # before the first <tr>; skip it.
    chunks = ROW_SPLIT.split(html)[1:]
    for chunk in chunks:
        id_m = ID_RE.search(chunk)
        if not id_m:
            continue
        pc_id = id_m.group(1)

        link_m = LINK_RE.search(chunk)
        if not link_m:
            continue
        prod_url = link_m.group(1)
        # Scrub smart-quotes/ellipsis/HTML-entities BEFORE everything
        # else so the sealed-keyword detector and the MSRP lookup work
        # on clean text.
        name = sanitize_text(link_m.group(2))

        ptype, is_sealed = detect_product_type(name)
        if not is_sealed:
            continue

        img_m   = IMG_RE.search(chunk)
        image_u = img_m.group(1) if img_m else None
        if image_u and image_u.startswith("/"):
            image_u = urljoin(PC_BASE, image_u)
        # PriceCharting embeds the 60-pixel thumbnail in console listings
        # (URLs end in /60.jpg or /60.png). Request the 480px size for
        # binder-grid display — sharper on retina displays and small
        # enough (~30-60KB per webp after conversion).
        if image_u:
            image_u = re.sub(r'/60\.(jpg|jpeg|png|webp)$', r'/480.\1', image_u, flags=re.IGNORECASE)

        # MSRP lookup: try a few name variations to make seed matching
        # tolerant of small wording differences. PriceCharting often
        # appends "Box" to UPC / Premium Collection names that the seed
        # stores without the suffix.
        def _try_msrp(*candidates):
            for c in candidates:
                v = msrp_seed.get(c.lower())
                if v is not None:
                    return v
            return None
        full_name      = f"{set_name} {name}"
        name_no_box    = re.sub(r'\s+box$', '', name, flags=re.IGNORECASE)
        full_no_box    = f"{set_name} {name_no_box}"
        msrp = _try_msrp(
            f"pokemon {full_name}",
            full_name,
            f"pokemon {full_no_box}",
            full_no_box,
            f"pokemon {name}",
            name,
            name_no_box,
        )

        # Full PriceCharting product URL — fed to /api/lookup-price.js
        # when refreshing prices for sealed items, same pattern as singles.
        price_source = urljoin(PC_BASE, prod_url) if prod_url else None

        yield {
            # ID: sealed-{lang}-pc-{id} so sealed products namespace
            # by language alongside cards (en-, jp-, kr-, etc.).
            "id":               f"sealed-{lang}-pc-{pc_id}",
            "name":             name,
            "set_name":         set_name,
            "set_code":         set_code,
            "card_number":      None,
            "rarity":           None,
            "supertype":        "Sealed Product",
            "image_url":        image_u,
            "game_type":        "Pokémon",
            "product_type":     ptype,
            "msrp_usd":         msrp,
            "pricecharting_id": pc_id,
            "price_source_url": price_source,
            "release_date":     None,
        }


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would be written; don't touch the DB")
    ap.add_argument("--only", help="Sync a single set by console slug")
    ap.add_argument("--debug-dump", action="store_true",
                    help="Fetch one console page, save HTML to scrape_debug.html, exit")
    ap.add_argument("--workers", type=int, default=1,
                    help="Number of parallel scrape workers (default 1). "
                         "Bump to 5-8 to fetch multiple sets concurrently. "
                         "Stay reasonable — PriceCharting may rate-limit at high concurrency.")
    args = ap.parse_args()

    if args.debug_dump:
        slug = "pokemon-paldea-evolved"
        url  = f"{PC_BASE}/console/{slug}"
        print(f"  [debug] Fetching {url}")
        page_html = fetch(url)
        if not page_html:
            sys.exit("  [debug] fetch returned nothing")
        path = Path(__file__).parent / "scrape_debug.html"
        path.write_text(page_html)
        print(f"  [debug] {len(page_html):,} bytes saved to {path}")
        ids   = ID_RE.findall(page_html)
        links = LINK_RE.findall(page_html)
        print(f"  [debug] {len(set(ids))} unique data-product-id values")
        print(f"  [debug] {len(links)} /game/pokemon-… links")
        print("  [debug] First 10 product names found:")
        for href, name in links[:10]:
            print(f"     {name.strip()[:60]:60s}  ({href})")
        return

    msrp_seed = load_msrp_seed()
    print(f"  Loaded {len(msrp_seed)} MSRP seed entries.")

    # Build the set list. Either:
    #   • --only <slug>  → just that one
    #   • otherwise      → auto-discover every Pokémon set from PriceCharting
    if args.only:
        discovered = [(args.only.replace("pokemon-", "").replace("-", " ").title(), args.only)]
    else:
        print("  Discovering Pokémon sets from PriceCharting category index…")
        discovered = discover_set_slugs()
        print(f"    → found {len(discovered)} sets")
    if not discovered:
        sys.exit("  No sets found. Check network / verify the category page exists.")

    # Map of slug → short set_code for the modern sets. Anything not in
    # this map gets a slug-derived set_code that the admin "needs review"
    # view surfaces for cleanup.
    SLUG_TO_SETCODE = {s[1]: s[2] for s in SETS}

    rows = []
    seen = set()
    skipped = 0
    _lock = threading.Lock()

    def _scrape_one(item):
        """Fetch + parse one set. Returns (set_name, url, set_rows_list)."""
        set_name, slug = item
        url = f"{PC_BASE}/console/{slug}"
        set_code = SLUG_TO_SETCODE.get(slug, slug.replace("pokemon-", "")[:32])
        page_html = fetch(url)
        if not page_html:
            return (set_name, url, None)
        set_rows = list(parse_console_page(page_html, set_name, set_code, slug, msrp_seed))
        return (set_name, url, set_rows)

    workers = max(1, args.workers)
    if workers == 1:
        # Sequential — keep the polite 1.5s gap so we're nice to PriceCharting.
        for item in discovered:
            set_name, url, set_rows = _scrape_one(item)
            if set_rows is None:
                continue
            unique = [r for r in set_rows if r["id"] not in seen]
            for r in unique: seen.add(r["id"])
            if unique:
                rows.extend(unique)
                print(f"  {set_name:40s} → {len(unique):3d} sealed rows  ({url})")
            else:
                skipped += 1
            time.sleep(1.5)
    else:
        # Parallel — N concurrent fetches. No per-set sleep needed
        # since requests are coming from N different threads. We DO
        # still want politeness, so cap concurrency and the pool handles
        # the rest. PriceCharting is pretty tolerant of moderate
        # parallel fetches at this scale (~80 set pages).
        print(f"  Running with {workers} parallel workers")
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(_scrape_one, item): item for item in discovered}
            for f in as_completed(futs):
                set_name, url, set_rows = f.result()
                if set_rows is None:
                    continue
                with _lock:
                    unique = [r for r in set_rows if r["id"] not in seen]
                    for r in unique: seen.add(r["id"])
                    if unique:
                        rows.extend(unique)
                        print(f"  {set_name:40s} → {len(unique):3d} sealed rows  ({url})")
                    else:
                        skipped += 1
    if skipped:
        print(f"\n  ({skipped} sets had 0 sealed products and were quietly skipped.)")

    print(f"\n  Total unique sealed products to upsert: {len(rows)}")

    if args.dry_run:
        print("\n  --dry-run — printing first 5 rows and exiting.")
        for r in rows[:5]:
            print(json.dumps(r, indent=2, default=str))
        return

    # Final pass: scrub every string field across every row.
    rows = [sanitize_row(r) for r in rows]

    BATCH = 50
    written = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        # Don't clobber image_urls that have already been mirrored to
        # Supabase Storage. If an existing row's image_url contains
        # the project domain, we strip image_url from the upsert
        # payload so the merge-duplicates UPDATE skips that column.
        preserve_mirrored_image_urls(chunk)
        try:
            upsert_catalog(chunk)
            written += len(chunk)
            print(f"  Upserted {written}/{len(rows)}")
        except Exception as e:
            print(f"  [error] batch {i}-{i + len(chunk)} failed: {e}", file=sys.stderr)
            if chunk:
                print(f"  [error] first row of failing batch (repr):", file=sys.stderr)
                for k, v in chunk[0].items():
                    print(f"          {k}: {v!r}", file=sys.stderr)

    print(f"\n  Done. {written} sealed-product rows written to catalog.")


if __name__ == "__main__":
    main()
