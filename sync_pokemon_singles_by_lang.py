#!/usr/bin/env python3
"""
PathBinder — Per-Language Pokémon Singles Sync
================================================
Scrapes PriceCharting console pages for a single language family
(Chinese, German, French, Italian, Spanish, Portuguese, Korean) and
upserts INDIVIDUAL CARDS (not sealed) into the catalog with the
language-appropriate id prefix.

Pokedata.io covers English & Japanese, so we use this script for the
other languages that Pokedata doesn't track. Same scrape pattern as
the sealed sync — same per-set console page — just keeps the rows the
sealed sync rejected (and rejects the ones the sealed sync kept).

USAGE:
    # Chinese (default)
    python3 sync_pokemon_singles_by_lang.py --dry-run
    python3 sync_pokemon_singles_by_lang.py --workers 5

    # German
    python3 sync_pokemon_singles_by_lang.py --lang german --workers 5

    # All non-English/Japanese languages in one go
    python3 sync_pokemon_singles_by_lang.py --lang all --workers 5

    # Single set only (for debugging)
    python3 sync_pokemon_singles_by_lang.py --only "pokemon-chinese-151-collect"

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key

ID CONVENTION:
    cn-pc-{pricecharting_id}      Chinese
    de-pc-{pricecharting_id}      German
    fr-pc-{pricecharting_id}      French
    it-pc-{pricecharting_id}      Italian
    es-pc-{pricecharting_id}      Spanish
    pt-pc-{pricecharting_id}      Portuguese
    kr-pc-{pricecharting_id}      Korean
"""

import os, sys, re, json, time, argparse, html, threading
from pathlib import Path
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

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

# slug-token → (id_prefix, display)
LANG_MAP = {
    "chinese":    ("cn", "Chinese"),
    "german":     ("de", "German"),
    "french":     ("fr", "French"),
    "italian":    ("it", "Italian"),
    "spanish":    ("es", "Spanish"),
    "portuguese": ("pt", "Portuguese"),
    "korean":     ("kr", "Korean"),
    "dutch":      ("nl", "Dutch"),
    "russian":    ("ru", "Russian"),
}
SUPPORTED_LANGS = list(LANG_MAP.keys()) + ["all"]


# Sealed-product keyword detector — identical to the multi-TCG sealed
# sync. We use it to REJECT rows that are sealed, since this script
# wants singles only. (The sealed sync uses it the other way around.)
SEALED_PATTERNS = (
    "ultra premium collection", "upc", "elite trainer box", "etb",
    "premium collection", "collection box", "special collection",
    "booster box", "half booster box", "booster pack", "booster bundle",
    "display box", "gift bundle", "holiday bundle",
    "set booster", "draft booster", "collector booster", "jumpstart booster",
    "play booster", "commander deck", "planeswalker deck", "secret lair",
    "fat pack", "league battle deck", "battle deck", "structure deck",
    "starter deck", "theme deck", "preconstructed deck",
    "battle academy toolkit", "battle toolkit", "toolkit",
    "collector's binder", "collectors binder", "premium binder",
    "binder collection",
    "build and battle", "build & battle", "build-a-deck",
    "mini tin", "pre-release pack", "prerelease pack",
    "pre-release box", "prerelease box", "premium box",
)

def is_sealed_name(name: str) -> bool:
    n = name.lower()
    return any(token in n for token in SEALED_PATTERNS)


SMART_PUNCT = str.maketrans({
    "…": "...",  "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-",    "—": "--", " ": " ",
})

def sanitize_text(s):
    if not isinstance(s, str):
        return s
    cleaned = html.unescape(s).translate(SMART_PUNCT).strip()
    try:
        cleaned.encode('latin-1')
        return cleaned
    except UnicodeEncodeError:
        return cleaned.encode('ascii', errors='replace').decode('ascii')

def sanitize_row(row):
    return {k: (sanitize_text(v) if isinstance(v, str) else v) for k, v in row.items()}


# ─── Fetch / DB ─────────────────────────────────────────────────────────────

def fetch(url, retries=4):
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=20)
            if r.status_code == 200:
                return r.text
            last = f"status {r.status_code}"
            if r.status_code in (403, 429):
                time.sleep(5 * (attempt + 1) ** 2)
                continue
        except Exception as e:
            last = str(e)
        time.sleep(1 + attempt)
    print(f"  [warn] fetch failed {url}: {last}", file=sys.stderr)
    return None


def upsert_catalog(rows):
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
    """If a row already has its image on Supabase Storage, drop image_url
    from the upsert payload so we don't overwrite the mirrored URL with
    the original PriceCharting one. Modifies rows in place."""
    if not rows:
        return
    ids = [r["id"] for r in rows]
    id_param = "in.(" + ",".join(f'"{i}"' for i in ids) + ")"
    try:
        r = requests.get(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog",
            headers={"apikey": SUPABASE_KEY,
                     "Authorization": f"Bearer {SUPABASE_KEY}",
                     "Accept": "application/json"},
            params={"select": "id,image_url", "id": id_param},
            timeout=30,
        )
        r.raise_for_status()
        existing = {row["id"]: (row.get("image_url") or "") for row in r.json()}
    except Exception as e:
        print(f"  [warn] couldn't fetch existing image_urls; image_url will be overwritten. {e}",
              file=sys.stderr)
        return
    sup_host_token = SUPABASE_URL.rstrip("/").split("//", 1)[-1].lower()
    preserved = 0
    for row in rows:
        eu = existing.get(row["id"], "")
        if eu and sup_host_token in eu.lower():
            row.pop("image_url", None)
            preserved += 1
    if preserved:
        print(f"  Preserving {preserved} already-mirrored image_url values.")


# ─── Discovery + parsing ────────────────────────────────────────────────────

CATEGORY_INDEX_URL = f"{PC_BASE}/category/pokemon-cards"
ROW_SPLIT = re.compile(r'<tr\b', re.IGNORECASE)
ID_RE     = re.compile(r'data-product(?:-id)?="(\d+)"', re.IGNORECASE)
LINK_RE   = re.compile(r'<a[^>]*href="(/game/pokemon[^"]+)"[^>]*>([^<]+)</a>', re.IGNORECASE)
IMG_RE    = re.compile(r'<img[^>]*(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"', re.IGNORECASE)

# Card-number patterns (e.g. "Pikachu #25", "Charizard ex SV1-024").
# Used to extract card_number into its own column for nicer display.
CARD_NUM_HASH   = re.compile(r'#(\d{1,4})\b')
CARD_NUM_PREFIX = re.compile(r'\b([A-Z]{1,5}\d{1,3}-\d{1,3})\b')


def discover_set_slugs_for_lang(lang_token):
    """Returns list of (display_name, console_slug) where the slug
    contains the lang_token. If lang_token is None, returns ALL
    Pokémon sets that match any LANG_MAP key (the 'all' mode)."""
    page_html = fetch(CATEGORY_INDEX_URL)
    if not page_html:
        return []
    rx = re.compile(r'href="/console/(pokemon-[^"]+)"[^>]*>([^<]+)</a>', re.IGNORECASE)
    found = []
    seen  = set()
    for m in rx.finditer(page_html):
        slug = html.unescape(m.group(1))
        name = html.unescape(m.group(2).strip())
        s = slug.lower()
        if lang_token is None:
            # All non-English/Japanese languages
            if not any(t in s for t in LANG_MAP.keys()):
                continue
        else:
            if lang_token not in s:
                continue
        if slug in seen:
            continue
        seen.add(slug)
        found.append((name, slug))
    return found


def lang_prefix_from_slug(slug):
    """Return (id_prefix, lang_display) by matching the slug against LANG_MAP."""
    s = slug.lower()
    for token, (prefix, display) in LANG_MAP.items():
        if token in s:
            return prefix, display
    return "en", "English"   # fallback — shouldn't happen if discovery filtered correctly


def parse_console_page_for_singles(page_html, set_name, set_code, slug):
    """Yield catalog rows for SINGLE CARDS on a per-set console page.
    Rejects rows whose name matches the sealed-product keywords."""
    if not page_html:
        return
    id_prefix, _ = lang_prefix_from_slug(slug)

    chunks = ROW_SPLIT.split(page_html)[1:]
    for chunk in chunks:
        id_m = ID_RE.search(chunk)
        if not id_m:
            continue
        pc_id = id_m.group(1)

        link_m = LINK_RE.search(chunk)
        if not link_m:
            continue
        prod_url = link_m.group(1)
        name = sanitize_text(link_m.group(2))

        # Skip sealed product rows — those are handled by the sealed sync.
        if is_sealed_name(name):
            continue

        # Extract a card number when present.
        card_number = None
        m1 = CARD_NUM_PREFIX.search(name)
        if m1:
            card_number = m1.group(1)
        else:
            m2 = CARD_NUM_HASH.search(name)
            if m2:
                card_number = m2.group(1)

        img_m   = IMG_RE.search(chunk)
        image_u = img_m.group(1) if img_m else None
        if image_u and image_u.startswith("/"):
            image_u = urljoin(PC_BASE, image_u)
        if image_u:
            image_u = re.sub(r'/60\.(jpg|jpeg|png|webp)$', r'/480.\1', image_u, flags=re.IGNORECASE)

        yield {
            "id":               f"{id_prefix}-pc-{pc_id}",
            "name":             name,
            "set_name":         set_name,
            "set_code":         set_code,
            "card_number":      card_number,
            "rarity":           None,
            "supertype":        None,
            "image_url":        image_u,
            "game_type":        "Pokémon",
            "product_type":     "single",
            "msrp_usd":         None,
            "pricecharting_id": pc_id,
            "price_source_url": urljoin(PC_BASE, prod_url) if prod_url else None,
            "release_date":     None,
        }


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="chinese", choices=SUPPORTED_LANGS,
                    help="Which language family to sync (default 'chinese'). "
                         "Use 'all' to sync every non-EN/JP language in one run.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print first 5 rows; don't touch the DB.")
    ap.add_argument("--only", help="Sync a single set by console slug.")
    ap.add_argument("--workers", type=int, default=1,
                    help="Parallel scrape workers (default 1). 5-8 is reasonable.")
    args = ap.parse_args()

    lang_token = None if args.lang == "all" else args.lang
    label = "all non-EN/JP" if args.lang == "all" else LANG_MAP[args.lang][1]
    print(f"  Pokémon singles — language family: {label}")

    if args.only:
        discovered = [(args.only.replace("pokemon-", "").replace("-", " ").title(), args.only)]
    else:
        print("  Discovering sets from PriceCharting category index…")
        discovered = discover_set_slugs_for_lang(lang_token)
        print(f"    → found {len(discovered)} {label} sets")
    if not discovered:
        sys.exit("  No sets matched. Try --only with a known slug, or check the lang token.")

    rows = []
    seen = set()
    skipped = 0
    _lock = threading.Lock()

    def _scrape_one(item):
        set_name, slug = item
        url = f"{PC_BASE}/console/{slug}"
        set_code = slug.replace("pokemon-", "")[:32]
        page_html = fetch(url)
        if not page_html:
            return (set_name, url, None)
        set_rows = list(parse_console_page_for_singles(page_html, set_name, set_code, slug))
        return (set_name, url, set_rows)

    workers = max(1, args.workers)
    if workers == 1:
        for item in discovered:
            set_name, url, set_rows = _scrape_one(item)
            if set_rows is None:
                continue
            unique = [r for r in set_rows if r["id"] not in seen]
            for r in unique: seen.add(r["id"])
            if unique:
                rows.extend(unique)
                print(f"  {set_name:40s} → {len(unique):4d} singles  ({url})")
            else:
                skipped += 1
            time.sleep(1.5)
    else:
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
                        print(f"  {set_name:40s} → {len(unique):4d} singles  ({url})")
                    else:
                        skipped += 1

    if skipped:
        print(f"\n  ({skipped} sets had 0 singles and were quietly skipped.)")
    print(f"\n  Total unique singles to upsert: {len(rows)}")

    if args.dry_run:
        print("\n  --dry-run — printing first 5 rows and exiting.")
        for r in rows[:5]:
            print(json.dumps(r, indent=2, default=str))
        return

    rows = [sanitize_row(r) for r in rows]

    BATCH = 50
    written = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
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

    print(f"\n  Done. {written} singles written to catalog.")


if __name__ == "__main__":
    main()
