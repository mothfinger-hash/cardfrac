#!/usr/bin/env python3
"""
PathBinder — PriceCharting Singles Enrichment
==============================================
Adds `pricecharting_id` + `price_source_url` to existing pokedata
catalog rows for TCGs where PriceCharting has prices but no category
index page (Gundam, Dragon Ball Z TCG). Auto-discovers sets via
/search-products, then per-set scrapes /console/{slug} and matches
each PC product to a catalog row by (set, card_number) or (set, name).

This is NOT a card creator — it never inserts new rows by default.
Pass --create-missing to insert rows for PC cards that don't match
anything in your catalog (useful if PC has variants pokedata missed).

USAGE:
    # Probe — list the sets we'd scrape and how many cards each has,
    # without touching the catalog
    python3 sync_pc_singles_enrich.py --tcg gundam --probe
    python3 sync_pc_singles_enrich.py --tcg dbz --probe

    # Preview enrichment for ONE set
    python3 sync_pc_singles_enrich.py --tcg gundam --only gundam-phantom-aria --dry-run

    # Full enrichment for one TCG
    python3 sync_pc_singles_enrich.py --tcg gundam
    python3 sync_pc_singles_enrich.py --tcg dbz

    # If you want PC-only cards (no pokedata match) added as new rows
    python3 sync_pc_singles_enrich.py --tcg gundam --create-missing

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key

ID PREFIX CONVENTION:
    Existing pokedata rows:    gun-{set-code}-{number}   /  dbz-{set-code}-{number}
    PC-only (--create-missing): gun-pc-{pricecharting_id} / dbz-pc-{pricecharting_id}
"""

import os, sys, re, json, time, random, argparse, threading, html
from urllib.parse import urljoin, quote
from concurrent.futures import ThreadPoolExecutor, as_completed

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

_session = requests.Session()
_session.headers.update(HEADERS)


# ─── TCG config ────────────────────────────────────────────────────────────────
# Each TCG gets: a search-products query term, the slug prefix used
# under /console/, the game_type column value (matches pokedata sync),
# the id_prefix used for PC-only inserts, and an exclude list to drop
# noise from the search results.
TCG_CONFIG = {
    "gundam": {
        "search_term": "gundam",
        "slug_prefix": "gundam-",
        "game_type":   "gundam",
        "id_prefix":   "gun",
        "exclude":     [],
        # Explicit slug list verified against PC's per-game dropdown.
        # Used by discover_sets_for_tcg() — supersedes the search-products
        # auto-discovery which only returns a popular subset.
        "explicit_slugs": [
            "gundam-dual-impact",
            "gundam-edition-beta",
            "gundam-newtype-rising",
            "gundam-phantom-aria",
            "gundam-promo",
            "gundam-starter-deck-01-heroic-beginnings",
            "gundam-steel-requiem",
        ],
    },
    # ── Disney Lorcana (Ravensburger) ───────────────────────────────────
    # Catalog uses game_type='lorcana' with id_prefix='lor'. PC serves
    # Lorcana singles under /console/lorcana-<set-slug>. The slugs below
    # follow PC's convention (lowercase, hyphenated, apostrophes dropped);
    # discover_sets_for_tcg() also auto-augments from PC's search endpoint.
    # Verify a run with --probe; if any set returns 0 cards its slug differs
    # from PC's live URL — copy the exact slug from the /category/lorcana-cards
    # page and fix it here (or run that one set with --only <slug>).
    "lorcana": {
        "search_term": "lorcana",
        "slug_prefix": "lorcana-",
        "game_type":   "lorcana",
        "id_prefix":   "lor",
        "exclude":     [],
        # Verified against PC via --probe. Note PC KEEPS the apostrophe in
        # the slug (lorcana-ursula's-return), and First Chapter is
        # "first-chapter" with no leading "the".
        "explicit_slugs": [
            "lorcana-first-chapter",
            "lorcana-rise-of-the-floodborn",
            "lorcana-into-the-inklands",
            "lorcana-ursula's-return",
            "lorcana-shimmering-skies",
            "lorcana-azurite-sea",
            "lorcana-archazia's-island",
            "lorcana-reign-of-jafar",
            "lorcana-fabled",
            "lorcana-whispers-in-the-well",
            "lorcana-winterspell",
            "lorcana-wilds-unknown",
            "lorcana-promo",
        ],
    },
    "dbz": {
        "search_term": "dragon ball z",
        "slug_prefix": "dragon-ball-z-",
        "game_type":   "dbz",
        "id_prefix":   "dbz",
        "exclude":     ["comic-books-dragon-ball-z"],   # comics, not the TCG
        # Verified against PC's per-game dropdown. Note: PC has a typo —
        # "Heroes and Villians" (not Villains). Slugged as-published.
        # Super 17 Saga returns just 1 card (PC has barely any data),
        # included for completeness.
        "explicit_slugs": [
            "dragon-ball-z-awakening",
            "dragon-ball-z-babidi-saga",
            "dragon-ball-z-buu-saga",
            "dragon-ball-z-cell-saga",
            "dragon-ball-z-evolution",
            "dragon-ball-z-frieza-saga",
            "dragon-ball-z-fusion-saga",
            "dragon-ball-z-heroes-and-villians",   # PC's typo, intentional
            "dragon-ball-z-kid-buu-saga",
            "dragon-ball-z-movie-collection",
            "dragon-ball-z-perfection",
            "dragon-ball-z-saiyan-saga",
            "dragon-ball-z-super-17-saga",
            "dragon-ball-z-trunks-saga",
            "dragon-ball-z-vengeance",
            "dragon-ball-z-world-games-saga",
        ],
    },
    # ── One Piece TCG (Bandai) ──────────────────────────────────────────
    # Our catalog uses game_type='onepiece' with id_prefix='op'. PC
    # serves OP cards under /console/one-piece-<set-slug>. Slug list
    # pulled from PC's /category/one-piece-cards index; new sets PC
    # adds get auto-discovered via the search-products fallback because
    # slug_prefix matches them. EN-only here — the JP printings live
    # under one-piece-japanese-* slugs and we don't currently sell JP
    # OP singles, so we skip them to keep the per-TCG run focused.
    "onepiece": {
        "search_term": "one piece",
        "slug_prefix": "one-piece-",
        "game_type":   "onepiece",
        "id_prefix":   "op",
        "exclude":     ["one-piece-japanese-"],   # skip JP printings
        "explicit_slugs": [
            "one-piece-500-years-in-the-future",
            "one-piece-adventure-on-kami%27s-island",
            "one-piece-awakening-of-the-new-era",
            "one-piece-azure-sea%27s-seven",
            "one-piece-carrying-on-his-will",
            "one-piece-emperors-in-the-new-world",
            "one-piece-extra-booster-anime-25th-collection",
            "one-piece-extra-booster-eb04",
            "one-piece-extra-booster-heroines-edition",
            "one-piece-extra-booster-memorial-collection",
            "one-piece-fist-of-divine-speed",
            "one-piece-kingdoms-of-intrigue",
            "one-piece-learn-together-deck-set",
            "one-piece-legacy-of-the-master",
            "one-piece-paramount-war",
            "one-piece-passage-to-the-grand-line",
            "one-piece-pillars-of-strength",
            "one-piece-premium-booster",
            "one-piece-premium-booster-2",
            "one-piece-promo",
            "one-piece-romance-dawn",
            "one-piece-royal-blood",
            "one-piece-seven-warlords-of-the-sea-binder-set",
            "one-piece-starter-deck-1-straw-hat-crew",
            "one-piece-starter-deck-2-worst-generation",
            "one-piece-starter-deck-3-the-seven-warlords-of-the-sea",
            "one-piece-starter-deck-4-animal-kingdom-pirates",
            "one-piece-starter-deck-5-film-edition",
            "one-piece-starter-deck-6-absolute-justice",
            "one-piece-starter-deck-7-big-mom-pirates",
            "one-piece-starter-deck-8-monkeydluffy",
            "one-piece-starter-deck-9-yamato",
            "one-piece-starter-deck-11-uta",
            "one-piece-starter-deck-12",
            "one-piece-starter-deck-14-3d2y",
            "one-piece-starter-deck-15-edward-newgate",
            "one-piece-starter-deck-16-uta",
            "one-piece-starter-deck-17-donquixote-donflamingo",
            "one-piece-starter-deck-18-monkeydluffy",
            "one-piece-starter-deck-19-smoker",
            "one-piece-starter-deck-20-charlotte-katakuri",
            "one-piece-starter-deck-21-gear5",
            "one-piece-starter-deck-22-ace-&-newgate",
            "one-piece-starter-deck-23-red-shanks",
            "one-piece-starter-deck-24-green-jewelry-bonney",
            "one-piece-starter-deck-25-blue-buggy",
            "one-piece-starter-deck-26-purple-monkeydluffy",
            "one-piece-starter-deck-27-black-marshalldteach",
            "one-piece-starter-deck-28-yellow-yamato",
            "one-piece-starter-deck-29-egghead",
            "one-piece-starter-deck-ex-30-luffy-&-ace",
            "one-piece-the-quest-begins",
            "one-piece-the-time-of-battle",
            "one-piece-tin-pack-set-vol-1",
            "one-piece-two-legends",
            "one-piece-ultra-deck-the-three-brothers",
            "one-piece-ultra-deck-the-three-captains",
            "one-piece-wings-of-the-captain",
        ],
    },
    # ── Pokemon Japanese singles (PC data + pokedata images) ───────────
    # JP set slugs are "pokemon-japanese-<set>". Pulling PC here gives each
    # single a pricecharting_id + price_source_url up front (no later
    # backfill). Inserts use id `jp-pc-{pcid}` so they match the app's JP
    # Sets view (`id like 'jp-%'`). Stripping the full "pokemon-japanese-"
    # prefix yields a clean set_code/set_name (e.g. "abyss-eye" / "Abyss
    # Eye") that lines up with pokedata, so fetch_jp_pokedata.py can swap in
    # the card images afterward. Use --set-name/--set-code to override the
    # derived keys for oddly-slugged sets.
    "pokemon-jp": {
        "search_term":   "pokemon japanese",
        "slug_prefix":   "pokemon-japanese-",
        "game_type":     "pokemon",
        "id_prefix":     "jp",
        "exclude":       [],
        # CRITICAL: the Pokémon catalog is huge and multi-set/multi-language,
        # so the default whole-catalog "match by number-or-name alone" would
        # wrongly attach JP cards onto English rows. Scope matching to THIS set
        # only — a brand-new JP set then has no matches and every card inserts
        # fresh as jp-pc-{id}. (Gundam/DBZ don't set this: small unique catalogs.)
        "scope_to_set":  True,
    },
    # ── Pokemon Topps (Topps Co., 1999–2000) ───────────────────────────
    # Slug prefix "pokemon-" is too broad (overlaps with the official
    # Pokemon TCG sets), so we use slug_contains="topps" as the
    # disambiguator. game_type kept distinct from 'pokemon' so the
    # frontend can give Topps its own tab.
    "pokemon_topps": {
        "search_term":   "pokemon topps",
        "slug_prefix":   "pokemon-",
        "slug_contains": "topps",   # narrows augmentation past slug_prefix
        "game_type":     "pokemon_topps",
        "id_prefix":     "topps",
        "exclude":       [],
        "explicit_slugs": [
            "pokemon-1999-topps-movie",
            "pokemon-1999-topps-movie-die-cut",
            "pokemon-1999-topps-movie-evolution",
            "pokemon-1999-topps-tv",
            "pokemon-2000-topps-chrome",
            "pokemon-2000-topps-movie",
            "pokemon-2000-topps-movie-first-appearance",
            "pokemon-2000-topps-tv",
            "pokemon-2000-topps-tv-clear",
            "pokemon-2000-topps-tv-sticker",
        ],
    },
}


# ─── HTTP w/ backoff ───────────────────────────────────────────────────────────
RETRY_STATUSES = (403, 429, 502, 503, 504)
MAX_RETRIES    = 5
_thread_jitter = threading.local()

def _pace(min_s=0.5, max_s=1.2):
    last = getattr(_thread_jitter, "last", 0)
    now  = time.time()
    delay = random.uniform(min_s, max_s)
    if now - last < delay:
        time.sleep(delay - (now - last))
    _thread_jitter.last = time.time()


def fetch(url):
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
            wait = (2 ** (attempt + 1) - 1) + random.uniform(0, 3)
            last_err = f"HTTP {r.status_code} (retry {attempt+1}/{MAX_RETRIES} after {wait:.1f}s)"
            time.sleep(wait)
            continue
        raise RuntimeError(f"HTTP {r.status_code}")
    raise RuntimeError(last_err or "exhausted retries")


# ─── PC scraping ───────────────────────────────────────────────────────────────
ROW_SPLIT  = re.compile(r'<tr\b', re.IGNORECASE)
ID_RE      = re.compile(r'data-product(?:-id)?="(\d+)"', re.IGNORECASE)
NAME_RE    = re.compile(r'<a[^>]*href="(/game/[^"]+)"[^>]*>([^<]+)</a>', re.IGNORECASE)
IMG_RE     = re.compile(r'<img[^>]*(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"', re.IGNORECASE)
SIZE_RE    = re.compile(r'/(60|160|240|320|480|640|1600)\.(jpg|jpeg|png|webp)$', re.IGNORECASE)
NUMBER_RE  = re.compile(r'\b(?:#|No\.\s?|GD\d+-|DR|VR|PR|HV|EV|WG|FU|SS|FS|CS|TS|KB|BB|GD)\s?(\d{1,4})\b', re.IGNORECASE)
# Console-page card numbers usually appear in the slug tail or
# parenthesized in the name. Common patterns:
#   "destiny-gundam-lr-holo-gd04-050"  → 050
#   "instant-transmission-dr1"          → 1   (DR=Dragon Rare Saiyan Saga)
SLUG_NUM_RE = re.compile(r'-([a-z]{1,3}\d+|\d{1,4})$', re.IGNORECASE)


def discover_sets_for_tcg(cfg):
    """Returns the canonical set list for the TCG. Uses the hand-verified
    `explicit_slugs` config as the source of truth (PC's search-products
    endpoint only returns the most popular subset, missing 4+ DBZ sets
    when we tried it). Optionally augments with any new slugs that
    search-products surfaces, in case PC adds a set after the explicit
    list was last updated."""
    found = set(cfg.get("explicit_slugs", []))
    # Best-effort augmentation — fail silently if /search-products is down.
    # When slug_prefix is too broad (e.g. "pokemon-" used for Pokemon Topps,
    # which would otherwise sweep up the official TCG), slug_contains
    # adds a substring requirement that disambiguates.
    contains_token = (cfg.get("slug_contains") or "").lower()
    try:
        page = fetch(f"{PC_BASE}/search-products?q={quote(cfg['search_term'])}&type=prices")
        for m in re.finditer(r'href="/console/([a-z0-9-]+)"', page):
            slug = m.group(1)
            if not slug.startswith(cfg["slug_prefix"]):
                continue
            if contains_token and contains_token not in slug.lower():
                continue
            if slug in cfg["exclude"]:
                continue
            found.add(slug)
    except Exception:
        pass
    return sorted(found)


# Names that PriceCharting lists alongside singles on a /console/{slug}
# page but are actually sealed product. The singles enrich script must
# skip these — otherwise --create-missing inserts them as
# product_type='single' and they bleed into the Sets-page Singles view.
_SEALED_NAME_PATTERNS = (
    re.compile(r'\bbooster\s+box\b',              re.IGNORECASE),
    re.compile(r'\bbooster\s+pack\b',             re.IGNORECASE),
    re.compile(r'\bbooster\s+bundle\b',           re.IGNORECASE),
    re.compile(r'\bsleeved\s+booster\s+pack\b',   re.IGNORECASE),
    re.compile(r'\belite\s+trainer\s+box\b',      re.IGNORECASE),
    re.compile(r'\bultra\s+premium\s+collection\b', re.IGNORECASE),
    re.compile(r'\bpremium\s+collection\b',       re.IGNORECASE),
    re.compile(r'\bcollection\s+box\b',           re.IGNORECASE),
    re.compile(r'\bstarter\s+deck\b',             re.IGNORECASE),
    re.compile(r'\bstructure\s+deck\b',           re.IGNORECASE),
    re.compile(r'\btheme\s+deck\b',               re.IGNORECASE),
    re.compile(r'\bbattle\s+deck\b',              re.IGNORECASE),
    re.compile(r'\bcommander\s+deck\b',           re.IGNORECASE),
    re.compile(r'\bbuild\s*[&+]?\s*battle\b',     re.IGNORECASE),
    re.compile(r'\bgift\s+bundle\b',              re.IGNORECASE),
    re.compile(r'\bfat\s+pack\b',                 re.IGNORECASE),
    re.compile(r'\bmini\s+tin\b',                 re.IGNORECASE),
    re.compile(r'\b(?:^|\s)tin\b',                re.IGNORECASE),
    re.compile(r'\bdisplay\s+box\b',              re.IGNORECASE),
    re.compile(r'\bwax\s+box\b',                  re.IGNORECASE),
    re.compile(r'\bbinder\s+collection\b',        re.IGNORECASE),
    re.compile(r'\bjumbo\s+box\b',                re.IGNORECASE),
    re.compile(r'\bcase\s*$',                     re.IGNORECASE),
    re.compile(r'\b\d+[- ]?pack\s+mini\s+tin\b',  re.IGNORECASE),
)

def _looks_like_sealed_product(name):
    """Quick guard for sync_pc_singles_enrich.py --create-missing: returns
    True when the PC listing's name reads as a sealed product. We use
    word-boundary regexes to avoid false positives like 'Cutting' or
    'Hunting' matching the bare token 'tin'."""
    if not name:
        return False
    return any(rx.search(name) for rx in _SEALED_NAME_PATTERNS)


def _clean_pc_name(name_raw):
    """Strip every annotation PC layers on top of a card title:
      - [Bracket tags]      → rarity, foil status ('[LR++ Holo]', '[Foil]', '[SPR]')
      - (Paren annotations) → '(Foil)', '(Unlimited Edition)'
      - #GD04-050 / OP02-037 / ST04-013  → set code + card number
      - #123                → bare # number
      - trailing 123        → bare trailing card number (1-4 digits)
      - 1-letter+digits codes at the tail: P12, S22, R105, U79, C150
        (DBZ rarity codes — pokedata stores these as card_number)
      - 2-letter+digits codes at the tail: DR1, UR141, SPR, etc.
        (DBZ + Gundam rarity codes)
    Leaves the bare card name for matching against pokedata."""
    s = name_raw
    # HTML entity decode for the few common ones embedded in PC source
    s = s.replace("&#43;", "+").replace("&#39;", "'").replace("&amp;", "&")
    # Brackets and parens
    s = re.sub(r'\s*\[[^\]]*\]', '', s)
    s = re.sub(r'\s*\([^)]*\)', '', s)
    # Set-code + number combos: GD04-050, OP02-037, ST04-013 (optionally # prefixed)
    s = re.sub(r'\s+#?[A-Z]{1,5}\d{1,3}-\d{1,3}\s*$', '', s, flags=re.IGNORECASE)
    # # prefix bare number
    s = re.sub(r'\s+#\d{1,4}\b\s*$', '', s)
    # Trailing 1-3 letter prefix + digits (catches DBZ P12 / S22 / UR141 / DR13,
    # Gundam LR+ / SPR, anything similar). Looser than the named list so we
    # don't have to keep adding codes per TCG.
    s = re.sub(r'\s+[A-Z]{1,3}\d{1,4}\s*$', '', s, flags=re.IGNORECASE)
    # Trailing bare number (1-4 digits) — applied last so codes win first
    s = re.sub(r'\s+\d{1,4}\s*$', '', s)
    return s.strip()


def _extract_card_number(name_raw, product_url):
    """Return (full_code, numeric). full_code matches pokedata's
    card_number for Gundam ('GD04-050') and DBZ ('P12', 'UR141', 'S22').
    numeric is the bare integer (leading zeros stripped) as a fallback
    for TCGs where pokedata stores just digits.
    """
    s = name_raw
    s = s.replace("&#43;", "+").replace("&#39;", "'").replace("&amp;", "&")
    # 1. Full set-code-number combo (Gundam): "#GD04-050" or "GD04-050"
    m = re.search(r'#?([A-Z]{1,5}\d{1,3}-\d{1,3})\s*$', s, re.IGNORECASE)
    if m:
        code = m.group(1).upper()
        bare = code.rsplit("-", 1)[-1].lstrip("0") or "0"
        return code, bare
    # 2. Trailing letter+number rarity code (DBZ): "P12", "UR141", "S22"
    m = re.search(r'\b([A-Z]{1,3}\d{1,4})\s*$', s, re.IGNORECASE)
    if m:
        code = m.group(1).upper()
        bare = re.sub(r'^[A-Z]+', '', code, flags=re.IGNORECASE).lstrip("0") or "0"
        return code, bare
    # 3. # prefix bare number
    m = re.search(r'#(\d{1,4})\b', s)
    if m:
        bare = m.group(1).lstrip("0") or "0"
        return None, bare
    # 4. Trailing bare number
    m = re.search(r'\b(\d{1,4})\s*$', s)
    if m:
        bare = m.group(1).lstrip("0") or "0"
        return None, bare
    # 5. URL fallback
    m = re.search(r'-(\d{1,4})(?:/|$)', product_url or '')
    if m:
        bare = m.group(1).lstrip("0") or "0"
        return None, bare
    return None, None


def parse_console_page(slug, html_text):
    """Yield rows on a per-set console page. Returns dicts with:
      pricecharting_id, name, card_number_guess, product_url

    Note: parameter is named `html_text` (not `html`) so the imported
    `html` stdlib module stays accessible inside this scope. An earlier
    version shadowed the module with the parameter name and crashed
    with `AttributeError: 'str' object has no attribute 'unescape'`
    the first time it tried to decode HTML entities."""
    chunks = ROW_SPLIT.split(html_text)[1:]
    for chunk in chunks:
        id_m = ID_RE.search(chunk)
        if not id_m:
            continue
        name_m = NAME_RE.search(chunk)
        if not name_m:
            continue
        # Decode HTML entities in the href before storing. PC's set
        # page ships paths like `/game/one-piece-starter-deck-22-ace-&amp;-newgate/...`
        # with the `&` HTML-encoded. Browsers automatically decode entity
        # references in href attributes; requests does NOT. If we stored
        # the raw `&amp;`, the next scraper fetch would send the literal
        # text in the URL path, PC's router can't match it, and PC
        # redirects to /search-products?type=prices → no Ungraded markup
        # → no_price. Same applies to `&#43;` (the `+` glyph used in
        # Gundam rarity codes like LR+, R++). This was the root cause
        # of "scraping worked before we switched to the API" — the
        # original API path bypassed URL encoding entirely.
        product_url = html.unescape(name_m.group(1))
        # html.unescape decodes entities that the PriceCharting page
        # ships in product titles (Goku&#39;s Energy, Pok&eacute;dex,
        # &amp;, &rsquo;, etc.) so we don't write the encoded form into
        # the catalog. Idempotent on already-decoded text. See also
        # migration_decode_html_entities.sql for the one-off cleanup
        # of rows already written before this pass landed.
        name_raw = html.unescape(name_m.group(2).strip())
        name_clean = _clean_pc_name(name_raw)
        full_code, bare_number = _extract_card_number(name_raw, product_url)
        # Image URL — PC pages ship /60 thumbs in src= and the full
        # /480 in data-src=. We grab whichever IMG_RE matches first
        # (data-src takes precedence in the regex alternation) and
        # normalize the size suffix to /480 for crisp grid thumbnails.
        img_m = IMG_RE.search(chunk)
        image_url = None
        if img_m:
            img_src = img_m.group(1)
            if img_src.startswith("/"):
                img_src = urljoin(PC_BASE, img_src)
            image_url = SIZE_RE.sub(lambda m: f"/480.{m.group(2)}", img_src)

        yield {
            "pricecharting_id":  id_m.group(1),
            "name":               name_raw,
            "name_clean":         name_clean,
            "card_number":        bare_number,
            "card_code":          full_code,    # 'GD04-050' / 'P12' / 'UR141' etc.
            "product_url":        f"{PC_BASE}{product_url}",
            "image_url":          image_url,
            "slug":               slug,
        }


# ─── Supabase REST ─────────────────────────────────────────────────────────────
def pg_get(path, params=None):
    r = requests.get(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}",
        headers={
            "apikey":        SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Accept":        "application/json",
        },
        params=params, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def pg_patch(row_id, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    r = requests.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{quote(row_id)}",
        headers={
            "apikey":        SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type":  "application/json; charset=utf-8",
            "Prefer":        "return=minimal",
        },
        data=body, timeout=20,
    )
    if not r.ok:
        raise RuntimeError(f"PATCH HTTP {r.status_code}: {r.text[:200]}")


def pg_post(payload):
    """Insert with on_conflict (id) → upsert."""
    body = json.dumps([payload], ensure_ascii=False).encode("utf-8")
    r = requests.post(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?on_conflict=id",
        headers={
            "apikey":        SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type":  "application/json; charset=utf-8",
            "Prefer":        "return=minimal,resolution=merge-duplicates",
        },
        data=body, timeout=20,
    )
    if not r.ok:
        raise RuntimeError(f"POST HTTP {r.status_code}: {r.text[:200]}")


def load_catalog_for_tcg(game_type):
    """Load every catalog row for this TCG. Returns list of dicts."""
    rows = []
    offset = 0
    PAGE = 1000
    while True:
        chunk = pg_get("catalog", params={
            "select":     "id,name,set_name,set_code,card_number,pricecharting_id",
            "game_type":  f"eq.{game_type}",
            "limit":      str(PAGE),
            "offset":     str(offset),
        })
        rows.extend(chunk)
        if len(chunk) < PAGE:
            break
        offset += PAGE
    return rows


# ─── Matching ──────────────────────────────────────────────────────────────────
def _norm(s):
    if not s: return ""
    return re.sub(r'[^a-z0-9]', '', s.lower())


def build_catalog_index(catalog_rows, slug, cfg, scope_extra=None):
    """Build a multi-key index over the ENTIRE catalog for this TCG
    (no per-set filter — PC's per-set pages contain reprints from
    other sets, so the catalog row matching the PC card may live in
    a different pokedata set_name).
    Returns:
      {
        'by_code':       {'GD04-050': [row, ...]},  ← exact pokedata card_number
        'by_name_code':  {('destinygundam', 'GD04-050'): [row, ...]},
        'by_name':       {'destinygundam': [row, ...]},
      }
    """
    # Set-scoped matching (e.g. pokemon-jp): only index rows in the SAME set
    # as the slug, so JP cards can't match English rows by bare number/name.
    if cfg.get("scope_to_set"):
        # Target set derived from the slug (e.g. pokemon-japanese-abyss-eye ->
        # 'abysseye'). But PC's slug often doesn't equal our set_code/set_name
        # (slug 'mega-dream-ex' -> 'megadreamex' vs our set_code 'M2a' /
        # set_name 'Mega Dream'), which silently indexes ZERO rows and marks
        # every PC card unmatched. Accept extra targets from --set-code /
        # --set-name so the operator can pin the alignment for such sets.
        targets = {_norm(slug.replace(cfg["slug_prefix"], ""))}
        for x in (scope_extra or []):
            t = _norm(x)
            if t:
                targets.add(t)
        targets.discard("")
        catalog_rows = [r for r in catalog_rows
                        if _norm(r.get("set_code")) in targets or _norm(r.get("set_name")) in targets]
    by_code      = {}
    by_name_code = {}
    by_name      = {}
    for r in catalog_rows:
        n  = _norm(r.get("name"))
        cn = (r.get("card_number") or "").upper().strip()
        if cn:
            by_code.setdefault(cn, []).append(r)
            if n:
                by_name_code.setdefault((n, cn), []).append(r)
        if n:
            by_name.setdefault(n, []).append(r)
    return {"by_code": by_code, "by_name_code": by_name_code, "by_name": by_name}


def find_catalog_match(pc_row, ix):
    """Return the best catalog row match for a PC scrape result, or None.

    Priority:
      1. (cleaned name + full card code) — most specific
      2. card code alone — catches name format drift on the same product
      3. cleaned name alone (first candidate)
    """
    n_clean = _norm(pc_row["name_clean"])
    n_raw   = _norm(pc_row["name"])
    code    = (pc_row.get("card_code") or "").upper().strip()

    if n_clean and code:
        c = ix["by_name_code"].get((n_clean, code))
        if c: return c[0]
    if n_raw and code:
        c = ix["by_name_code"].get((n_raw, code))
        if c: return c[0]
    if code:
        c = ix["by_code"].get(code)
        if c: return c[0]
    if n_clean:
        c = ix["by_name"].get(n_clean)
        if c: return c[0]
    if n_raw:
        c = ix["by_name"].get(n_raw)
        if c: return c[0]
    return None


# ─── Main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tcg", choices=list(TCG_CONFIG.keys()), required=True)
    ap.add_argument("--probe", action="store_true",
                    help="List discovered sets + card counts; don't touch catalog.")
    ap.add_argument("--only", help="Process only this set slug (e.g. gundam-phantom-aria).")
    ap.add_argument("--set-name", dest="set_name", default=None,
                    help="Override the set_name on --create-missing inserts "
                         "(default: derived from slug). Pin to the pokedata set "
                         "name so fetch_jp_pokedata.py can match images.")
    ap.add_argument("--set-code", dest="set_code", default=None,
                    help="Override the set_code on --create-missing inserts "
                         "(default: slug minus prefix).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would be enriched, don't PATCH.")
    ap.add_argument("--create-missing", action="store_true",
                    help="Insert new catalog rows for PC cards that don't match any pokedata row.")
    ap.add_argument("--force-refresh-urls", action="store_true",
                    help="Overwrite price_source_url even when it's already set. "
                         "Use to clear out stale URLs from older script versions "
                         "(e.g. ones that stored raw HTML-entity-encoded paths). "
                         "Without this flag, rows that already have BOTH a "
                         "pricecharting_id and a price_source_url are skipped.")
    ap.add_argument("--force-refresh-ids", action="store_true",
                    help="Overwrite pricecharting_id on a MATCHED row with the id read "
                         "from PC's current console page. That page IS the set (scoped "
                         "match), so its id is authoritative — use this to REPAIR "
                         "collided/wrong ids on existing rows. Pair with --set-code for "
                         "sets whose PC slug != our set_code (e.g. mega-dream-ex vs M2a). "
                         "Dry-run first and eyeball the [dry] lines.")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--debug-unmatched", type=int, default=0,
                    help="With --dry-run, print first N PC rows that "
                         "didn't match any pokedata row in this set. Use to "
                         "diagnose name-format drift between sources.")
    args = ap.parse_args()

    cfg = TCG_CONFIG[args.tcg]
    print(f"\n  TCG: {args.tcg.upper()}  game_type={cfg['game_type']}  prefix={cfg['slug_prefix']}")

    # 1. Discover sets
    if args.only:
        slugs = [args.only]
    else:
        print(f"  Discovering sets via /search-products?q={cfg['search_term']}…")
        slugs = discover_sets_for_tcg(cfg)
        print(f"  Found {len(slugs)} sets:")
        for s in slugs:
            print(f"     /console/{s}")

    if args.probe:
        # Just count cards per set + total
        print(f"\n  Probing per-set card counts…")
        total = 0
        for s in slugs:
            try:
                html = fetch(f"{PC_BASE}/console/{s}")
                ids = set(ID_RE.findall(html))
                print(f"     {s:<55} {len(ids):>4} cards")
                total += len(ids)
            except Exception as e:
                print(f"     {s:<55} FAIL {e}")
        print(f"\n  Total: {len(slugs)} sets, {total} cards")
        return

    # 2. Load existing catalog for this TCG
    print(f"\n  Loading catalog for game_type={cfg['game_type']}…")
    catalog_rows = load_catalog_for_tcg(cfg["game_type"])
    print(f"  {len(catalog_rows):,} catalog rows.")

    # 3. Per-set scrape + match + patch
    stats = {"enriched": 0, "already_enriched": 0, "unmatched": 0, "inserted": 0, "failed": 0}
    _lock = threading.Lock()

    def process_set(slug):
        # Note: local var named `html_text` (not `html`) so the imported
        # `html` stdlib module remains accessible if any helper in this
        # scope needs html.unescape later. Same defensive pattern as
        # parse_console_page below.
        try:
            html_text = fetch(f"{PC_BASE}/console/{slug}")
        except Exception as e:
            return [(slug, "fail", f"fetch: {e}", 0, 0, 0)]
        by_name = build_catalog_index(catalog_rows, slug, cfg,
                                      scope_extra=[args.set_code, args.set_name])
        n_enr = 0; n_unm = 0; n_already = 0; n_url_only = 0
        unmatched_samples = []   # for --debug-unmatched
        for pc in parse_console_page(slug, html_text):
            match = find_catalog_match(pc, by_name)
            if match:
                # We patch BOTH pricecharting_id and price_source_url
                # if they're missing. Older versions of this script
                # short-circuited on `match.get("pricecharting_id")`,
                # which left thousands of rows URL-less forever — the
                # legacy API-only enrichment had stamped the PCID but
                # never wrote a URL, so --force-scrape later skipped
                # every one of them. Now we treat the two columns
                # independently: each gets written only if currently
                # null. "already" means BOTH columns are populated.
                has_pcid = bool(match.get("pricecharting_id"))
                has_url  = bool(match.get("price_source_url"))
                # With --force-refresh-urls we always overwrite the URL
                # (the canonical source is PC's current set page). Use
                # this when the previously-stored URL is suspected stale
                # — e.g. after the HTML-entity-encoding bug was fixed and
                # we need to replace the broken `&amp;` URLs in bulk.
                force_url = args.force_refresh_urls
                # --force-refresh-ids REPAIRS a collided/wrong id: overwrite the
                # stored pricecharting_id with the one from this set's console
                # page (authoritative, since the match is set-scoped). Only when
                # it actually differs — a no-op rewrite is skipped so the summary
                # and the [dry] output reflect real changes.
                force_id   = args.force_refresh_ids
                id_differs = force_id and str(match.get("pricecharting_id") or "") \
                                            != str(pc["pricecharting_id"])
                if has_pcid and has_url and not force_url and not id_differs:
                    n_already += 1
                    continue
                payload = {}
                if not has_pcid or id_differs:
                    payload["pricecharting_id"] = pc["pricecharting_id"]
                if not has_url or force_url:
                    payload["price_source_url"] = pc["product_url"]
                if not payload:
                    n_already += 1
                    continue
                if args.dry_run:
                    cols = "+".join(payload.keys())
                    print(f"     [dry] {match['id']:<35} → {cols:<40}  ({pc['name'][:40]})")
                else:
                    try:
                        pg_patch(match["id"], payload)
                    except Exception as e:
                        return [(slug, "fail", f"patch {match['id']}: {e}", 0, 0, 0)]
                # Bucket which kind of enrichment we did so the per-set
                # summary tells the operator whether the existing
                # catalog was mostly URL-deficient (the common case
                # post-bugfix) vs missing both.
                if "pricecharting_id" in payload:
                    n_enr += 1        # wrote an id (new row OR forced repair)
                else:
                    n_url_only += 1   # url-only backfill on a row that kept its id
            else:
                n_unm += 1
                if args.debug_unmatched and len(unmatched_samples) < args.debug_unmatched:
                    unmatched_samples.append(
                        f"     UNMATCHED  raw='{pc['name'][:55]}'  "
                        f"clean='{pc['name_clean'][:35]}'  num={pc.get('card_number')}"
                    )
                if args.create_missing:
                    # Skip rows that look like sealed product — they live
                    # in the catalog under sealed-{tcg}-pc-{id} via
                    # sync_sealed_products.py, NOT as singles.
                    if _looks_like_sealed_product(pc["name"]):
                        continue
                    new_id = f"{cfg['id_prefix']}-pc-{pc['pricecharting_id']}"
                    payload = {
                        "id":               new_id,
                        "name":             pc["name"],
                        "set_code":         args.set_code or slug.replace(cfg["slug_prefix"], ""),
                        "set_name":         args.set_name or slug.replace(cfg["slug_prefix"], "").replace("-", " ").title(),
                        "card_number":      pc.get("card_number"),
                        "game_type":        cfg["game_type"],
                        "product_type":     "single",
                        "pricecharting_id": pc["pricecharting_id"],
                        "price_source_url": pc["product_url"],
                    }
                    # Image URL gets included only when we successfully
                    # scraped one — the mirror_sealed_images.py pass
                    # later picks these up by `image_url like '%pricecharting%'`
                    # and rewrites to the Supabase Storage CDN.
                    if pc.get("image_url"):
                        payload["image_url"] = pc["image_url"]
                    if args.dry_run:
                        print(f"     [dry-insert] {new_id}  ({pc['name'][:40]})")
                    else:
                        try:
                            pg_post(payload)
                        except Exception as e:
                            return [(slug, "fail", f"insert: {e}", 0, 0, 0)]
        # Surface unmatched samples for debugging
        if unmatched_samples:
            print(f"\n  [{slug}] first {len(unmatched_samples)} unmatched PC rows:")
            for line in unmatched_samples:
                print(line)
            sample_keys = list(by_name["by_name"].keys())[:5]
            if sample_keys:
                print(f"  [{slug}] sample catalog row names (normalized):")
                for k in sample_keys:
                    sample = by_name["by_name"][k][0]
                    print(f"     CATALOG    name='{sample.get('name', '')[:55]}'  num={sample.get('card_number')}")
        return [(slug, "ok",
                 f"new={n_enr} url_only={n_url_only} already={n_already} unmatched={n_unm}",
                 n_enr, n_unm, n_url_only)]

    print(f"\n  Processing {len(slugs)} sets with {args.workers} workers…\n")
    stats.setdefault("url_only", 0)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_set, s): s for s in slugs}
        for f in as_completed(futs):
            results = f.result()
            for slug, status, detail, n_enr, n_unm, n_url_only in results:
                with _lock:
                    if status == "ok":
                        stats["enriched"] += n_enr
                        stats["unmatched"] += n_unm
                        stats["url_only"]  += n_url_only
                    else:
                        stats["failed"] += 1
                    print(f"     {slug:<55}  {status:<6}  {detail}")

    print(f"\n  Done. new={stats['enriched']} url_only={stats['url_only']} "
          f"unmatched={stats['unmatched']} failed={stats['failed']}")


if __name__ == "__main__":
    main()
