#!/usr/bin/env python3
"""
PathBinder — Multi-TCG Sealed Product Sync
===========================================
Generic version of sync_sealed_pokemon_en.py that handles every TCG
PriceCharting tracks: Pokémon, Magic: The Gathering, Yu-Gi-Oh!, and
One Piece. One script, one source of truth for the scrape pipeline.

USAGE:
    # Dry-run on Magic
    python3 sync_sealed_products.py --tcg magic --dry-run

    # Real sync for YuGiOh, 5 parallel workers
    python3 sync_sealed_products.py --tcg yugioh --workers 5

    # One Piece, single set only (debugging)
    python3 sync_sealed_products.py --tcg onepiece --only "one-piece-romance-dawn"

    # Same flags as the Pokémon script (--debug-dump, --limit, etc.)

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key

ID CONVENTION:
    sealed-mtg-pc-{pricecharting_id}    # Magic
    sealed-ygo-pc-{pricecharting_id}    # YuGiOh
    sealed-op-pc-{pricecharting_id}     # One Piece
    sealed-en-pc-{pricecharting_id}     # Pokémon EN (language-aware)
    sealed-jp-pc-{pricecharting_id}     # Pokémon JP, etc.
"""

import os, sys, re, json, time, argparse, html, threading
from pathlib import Path
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

# This script avoids supabase-py (Unicode-encoding bug). Direct PostgREST.

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

# ─── Per-TCG configuration ──────────────────────────────────────────────────

TCG_CONFIG = {
    "pokemon": {
        "category_path": "/category/pokemon-cards",
        "game_type":     "Pokémon",
        "slug_prefix":   "pokemon-",
        # Pokémon ids are language-aware (en, jp, kr, …) because PriceCharting
        # lists every language under the same /category/pokemon-cards page.
        "lang_aware":    True,
    },
    "magic": {
        # PriceCharting uses the short "magic-" prefix on both the
        # category page and the individual set slugs, NOT "magic-the-
        # gathering-". e.g. /category/magic-cards, /console/magic-5th-
        # edition, /console/magic-adventures-in-the-forgotten-realms.
        "category_path": "/category/magic-cards",
        "game_type":     "Magic: The Gathering",
        "slug_prefix":   "magic-",
        "id_segment":    "mtg",
        "lang_aware":    False,
    },
    "yugioh": {
        "category_path": "/category/yugioh-cards",
        "game_type":     "Yu-Gi-Oh!",
        "slug_prefix":   "yugioh-",
        "id_segment":    "ygo",
        "lang_aware":    False,
    },
    "onepiece": {
        "category_path": "/category/one-piece-cards",
        "game_type":     "One Piece",
        "slug_prefix":   "one-piece-",
        "id_segment":    "op",
        "lang_aware":    False,
    },
    # ── Disney Lorcana (Ravensburger, 2023+) ───────────────────────────
    # Auto-discovered like Magic/YGO/OP — PC has a category index page.
    # VERIFY the category path before a full run:
    #     python3 sync_sealed_products.py --tcg lorcana --debug-dump
    # If it returns nothing, the live PC URL differs — adjust
    # category_path / slug_prefix to match (PC console slugs look like
    # /console/lorcana-the-first-chapter).
    "lorcana": {
        "category_path": "/category/lorcana-cards",
        "game_type":     "Lorcana",
        "slug_prefix":   "lorcana-",
        "id_segment":    "lor",
        "lang_aware":    False,
    },
    # ── Gundam Card Game (Bandai, 2024+) ───────────────────────────────
    # PriceCharting has no /category/ index page for this TCG, so we
    # supply the set slugs explicitly. discover_set_slugs() picks these
    # up via the explicit_slugs key when category_path is absent.
    "gundam": {
        "category_path": None,
        "game_type":     "Gundam",
        "slug_prefix":   "gundam-",
        "id_segment":    "gun",
        "lang_aware":    False,
        "explicit_slugs": [
            "gundam-dual-impact",
            "gundam-edition-beta",
            "gundam-eternal-nexus",           # EB01, released 2026-06-26 (PC console page confirmed)
            "gundam-starter-deck-10-generation-pulse",  # ST10, released 2026-06-26 (matches ST01 slug convention; confirm on PC)
            "gundam-newtype-rising",
            "gundam-phantom-aria",
            "gundam-promo",
            "gundam-starter-deck-01-heroic-beginnings",
            "gundam-steel-requiem",
        ],
    },
    # ── Pokemon Topps (Topps Co., 1999–2000 wax / sealed) ──────────────
    # Same explicit_slugs pattern as Gundam/DBZ — PC has no category
    # page. Vintage Topps wax boxes / packs / factory sets where they
    # exist on PC. game_type "Pokemon Topps" matches the singles config.
    "pokemon_topps": {
        "category_path": None,
        "game_type":     "Pokemon Topps",
        "slug_prefix":   "pokemon-",
        "id_segment":    "topps",
        "lang_aware":    False,
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
    # ── Dragon Ball Z TCG (Score / Panini, 2000s–mid-2010s) ────────────
    # Same as Gundam — no category index. Note: PriceCharting has a typo
    # on "Heroes and Villians" (not Villains). Slugged as-published.
    "dbz": {
        "category_path": None,
        "game_type":     "Dragon Ball Z",
        "slug_prefix":   "dragon-ball-z-",
        "id_segment":    "dbz",
        "lang_aware":    False,
        "explicit_slugs": [
            "dragon-ball-z-awakening",
            "dragon-ball-z-babidi-saga",
            "dragon-ball-z-buu-saga",
            "dragon-ball-z-cell-saga",
            "dragon-ball-z-evolution",
            "dragon-ball-z-frieza-saga",
            "dragon-ball-z-fusion-saga",
            "dragon-ball-z-heroes-and-villians",   # PC typo, intentional
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
    # ── Dragon Ball Super CCG (Bandai, 2017+) ──────────────────────────
    # explicit_slugs (PC has no clean per-game DB category page). Auto-
    # derived from tcgcsv set names; verify with --debug-dump, misses 404.
    "dbsccg": {
        "category_path": None,
        "game_type":     "Dragon Ball Super CCG",
        "slug_prefix":   "dragon-ball-super-",
        "id_segment":    "dbs",
        "lang_aware":    False,
        "explicit_slugs": [
            "dragon-ball-super-5th-anniversary-set",
            "dragon-ball-super-assault-of-the-saiyans",
            "dragon-ball-super-battle-evolution-booster",
            "dragon-ball-super-battle-set-bundles",
            "dragon-ball-super-beyond-generations",
            "dragon-ball-super-clash-of-fates",
            "dragon-ball-super-collector's-selection-vol-1",
            "dragon-ball-super-collector's-selection-vol-2",
            "dragon-ball-super-collector's-selection-vol-3",
            "dragon-ball-super-colossal-warfare",
            "dragon-ball-super-critical-blow",
            "dragon-ball-super-cross-spirits",
            "dragon-ball-super-cross-worlds",
            "dragon-ball-super-dawn-of-the-z-legends",
            "dragon-ball-super-destroyer-kings",
            "dragon-ball-super-draft-box-04-dragon-brawl",
            "dragon-ball-super-draft-box-05-divine-multiverse",
            "dragon-ball-super-draft-box-06-giant-force",
            "dragon-ball-super-draft-boxes",
            "dragon-ball-super-expansion-deck-box-set-01-mighty-heroes",
            "dragon-ball-super-expansion-deck-box-set-02-dark-demon's-villains",
            "dragon-ball-super-expansion-deck-box-set-03-ultimate-box",
            "dragon-ball-super-expansion-deck-box-set-04-unity-of-saiyans",
            "dragon-ball-super-expansion-deck-box-set-05-unity-of-destruction",
            "dragon-ball-super-expansion-deck-box-set-07-magnificent-collection-fusion-hero",
            "dragon-ball-super-expansion-deck-box-set-08-magnificent-collection-forsaken-warrior",
            "dragon-ball-super-expansion-deck-box-set-09-saiyan-surge",
            "dragon-ball-super-expansion-deck-box-set-10-namekian-surge",
            "dragon-ball-super-expansion-deck-box-set-11-universe-7-unison",
            "dragon-ball-super-expansion-deck-box-set-12-universe-11-unison",
            "dragon-ball-super-expansion-deck-box-set-14-battle-advanced",
            "dragon-ball-super-expansion-deck-box-set-15-battle-enhanced",
            "dragon-ball-super-expansion-deck-box-set-16-ultimate-deck",
            "dragon-ball-super-expansion-deck-box-set-17-saiyan-boost",
            "dragon-ball-super-expansion-deck-box-set-18-namekian-boost",
            "dragon-ball-super-expansion-deck-box-set-20-ultimate-deck-2022",
            "dragon-ball-super-expansion-deck-box-set-22-ultimate-deck-2023",
            "dragon-ball-super-expansion-deck-box-set-23-premium-anniversary-box-2023",
            "dragon-ball-super-expansion-deck-box-set-24-premium-7th-anniversary-box-2024",
            "dragon-ball-super-expansion-deck-box-set-25-premium-anniversary-box-2025",
            "dragon-ball-super-fearsome-rivals",
            "dragon-ball-super-fighter's-ambition",
            "dragon-ball-super-galactic-battle",
            "dragon-ball-super-history-of-z",
            "dragon-ball-super-impact-beyond-dimensions",
            "dragon-ball-super-legend-of-the-dragon-balls",
            "dragon-ball-super-malicious-machinations",
            "dragon-ball-super-miraculous-revival",
            "dragon-ball-super-mythic-booster",
            "dragon-ball-super-oversized-cards",
            "dragon-ball-super-perfect-combination",
            "dragon-ball-super-power-absorbed",
            "dragon-ball-super-prismatic-clash",
            "dragon-ball-super-realm-of-the-gods",
            "dragon-ball-super-revision-pack-2020",
            "dragon-ball-super-rise-of-the-unison-warrior",
            "dragon-ball-super-rise-of-the-unison-warrior-2nd-edition",
            "dragon-ball-super-saiyan-showdown",
            "dragon-ball-super-special-anniversary-set",
            "dragon-ball-super-special-anniversary-set-2020",
            "dragon-ball-super-special-anniversary-set-2021",
            "dragon-ball-super-supreme-rivalry",
            "dragon-ball-super-theme-selection-history-of-son-goku",
            "dragon-ball-super-theme-selection-history-of-vegeta",
            "dragon-ball-super-three-glorious-fighters",
            "dragon-ball-super-ultimate-advent",
            "dragon-ball-super-ultimate-squad",
            "dragon-ball-super-union-force",
            "dragon-ball-super-universal-onslaught",
            "dragon-ball-super-vermilion-bloodline",
            "dragon-ball-super-vermilion-bloodline-2nd-edition",
            "dragon-ball-super-vicious-rejuvenation",
            "dragon-ball-super-wild-resurgence",
        ],
    },
    # ── Dragon Ball Super Fusion World (Bandai, 2024+) ─────────────────
    "dbfusion": {
        "category_path": None,
        "game_type":     "Dragon Ball Super Fusion World",
        "slug_prefix":   "dragon-ball-fusion-world-",
        "id_segment":    "dbf",
        "lang_aware":    False,
        "explicit_slugs": [
            "dragon-ball-fusion-world-awakened-pulse",
            "dragon-ball-fusion-world-blazing-aura",
            "dragon-ball-fusion-world-brightness-of-hope",
            "dragon-ball-fusion-world-cross-force",
            "dragon-ball-fusion-world-dual-evolution",
            "dragon-ball-fusion-world-manga-booster-01",
            "dragon-ball-fusion-world-manga-booster-02",
            "dragon-ball-fusion-world-new-adventure",
            "dragon-ball-fusion-world-raging-roar",
            "dragon-ball-fusion-world-rivals-clash",
            "dragon-ball-fusion-world-saiyan's-pride",
            "dragon-ball-fusion-world-starter-deck-1-son-goku",
            "dragon-ball-fusion-world-starter-deck-10-giblet",
            "dragon-ball-fusion-world-starter-deck-2-vegeta",
            "dragon-ball-fusion-world-starter-deck-3-broly",
            "dragon-ball-fusion-world-starter-deck-4-frieza",
            "dragon-ball-fusion-world-starter-deck-5-bardock",
            "dragon-ball-fusion-world-starter-deck-6-son-goku-mini",
            "dragon-ball-fusion-world-starter-deck-7-vegeta-mini",
            "dragon-ball-fusion-world-starter-deck-8-vegeta-mini-super-saiyan-3",
            "dragon-ball-fusion-world-starter-deck-9-shallot",
            "dragon-ball-fusion-world-starter-deck-ex-the-beat-of-ki",
            "dragon-ball-fusion-world-starter-deck-ex-the-phase-of-evolution",
            "dragon-ball-fusion-world-story-booster-01",
            "dragon-ball-fusion-world-ultra-limit",
            "dragon-ball-fusion-world-wish-for-shenron",
        ],
    },
}

# Patterns covering every TCG's sealed product naming. Specific → generic;
# first match wins. Adds MTG-specific (set booster, draft booster, fat pack,
# collector booster) and YGO/OP-specific (structure deck, starter deck, etc.)
# alongside the Pokémon patterns we already had.
SEALED_PATTERNS = [
    # — Pokemon high-tier collections (rare in MTG/YGO/OP)
    ("ultra premium collection",     "utb"),
    ("upc",                          "utb"),
    ("elite trainer box",            "etb"),
    ("etb",                          "etb"),
    ("premium collection",           "premium_collection"),
    ("collection box",               "premium_collection"),
    ("special collection",           "premium_collection"),

    # — MTG-specific (specific patterns must come before generic "booster"!)
    ("set booster",                  "set_booster"),
    ("draft booster",                "draft_booster"),
    ("collector booster",            "collector_booster"),
    ("jumpstart booster",            "jumpstart_booster"),
    ("play booster",                 "play_booster"),
    ("commander deck",               "commander_deck"),
    ("planeswalker deck",            "planeswalker_deck"),
    ("commander collection",         "premium_collection"),
    ("secret lair",                  "secret_lair"),
    ("fat pack",                     "bundle"),

    # — Booster boxes / packs (generic across TCGs)
    ("booster box",                  "booster_box"),
    ("booster pack",                 "booster_pack"),
    ("booster bundle",               "booster_bundle"),
    ("display box",                  "booster_box"),
    ("half booster box",             "booster_box"),

    # — Bundles
    ("gift bundle",                  "gift_bundle"),
    ("holiday bundle",               "gift_bundle"),
    ("bundle",                       "bundle"),

    # — Decks (specific before generic)
    ("league battle deck",           "battle_deck"),
    ("battle deck",                  "battle_deck"),
    ("structure deck",               "structure_deck"),
    ("starter deck",                 "starter_deck"),
    ("theme deck",                   "theme_deck"),
    ("preconstructed deck",          "starter_deck"),
    ("deck",                         "deck"),

    # — Toolkits / binders / build-and-battle / build a deck
    ("battle academy toolkit",       "toolkit"),
    ("battle toolkit",               "toolkit"),
    ("toolkit",                      "toolkit"),
    ("collector's binder",           "binder_collection"),
    ("collectors binder",            "binder_collection"),
    ("premium binder",               "binder_collection"),
    ("binder collection",            "binder_collection"),
    ("binder",                       "binder_collection"),
    ("build and battle",             "build_and_battle"),
    ("build & battle",               "build_and_battle"),
    ("build-a-deck",                 "build_and_battle"),

    # — Tins (mini before generic)
    ("mini tin",                     "mini_tin"),
    (" tin",                         "tin"),

    # — Pre-release (specific only — "pre-release" alone matches
    #   promo CARDS like "Nico Robin [Pre-release] OP02-037" which
    #   are NOT sealed product. We require an explicit "pack" / "box" /
    #   "kit" suffix to confirm sealed.)
    ("pre-release pack",             "prerelease_pack"),
    ("prerelease pack",              "prerelease_pack"),
    ("pre-release box",              "prerelease_pack"),
    ("prerelease box",               "prerelease_pack"),
    ("pre-release kit",              "prerelease_pack"),
    ("prerelease kit",               "prerelease_pack"),

    # — Promo / special collection boxes that mention "box"
    ("premium box",                  "premium_collection"),
]


# Patterns that mark a row as a SINGLE CARD, not a sealed product —
# applied BEFORE the sealed-keyword search. PriceCharting lists
# singles like "X.Drake [Super Pre-release] ST04-013" on the same
# console page as the boxes, and those used to slip through because
# they contain "pre-release". Card-number patterns are the give-away.
_SINGLE_CARD_TOKENS = (
    # set-prefix + dash + number  (OP02-037, ST04-013, SV1-012)
    re.compile(r'\b[A-Z]{1,5}[0-9]{1,3}-\d{1,3}\b'),
    # explicit #N or #NNN
    re.compile(r'#\d{1,3}\b'),
)

def looks_like_single_card(name: str) -> bool:
    return any(rx.search(name) for rx in _SINGLE_CARD_TOKENS)

def detect_product_type(name: str):
    # Reject obvious single-card listings up front
    if looks_like_single_card(name):
        return "single", False
    n = name.lower()
    for token, ptype in SEALED_PATTERNS:
        if token in n:
            return ptype, True
    return "single", False


# Smart-punct sanitizer (HTML entities + Unicode quotes / ellipsis / dashes).
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


# Language detection — only matters for Pokémon since other TCGs are
# almost exclusively English on PriceCharting.
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
    return "en"


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
    """For rows whose existing image_url is on Supabase Storage, drop
    image_url from the upsert payload so we don't clobber the mirrored
    URL with the PriceCharting one. Modifies rows in place."""
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

ROW_SPLIT = re.compile(r'<tr\b', re.IGNORECASE)
ID_RE     = re.compile(r'data-product(?:-id)?="(\d+)"', re.IGNORECASE)
IMG_RE    = re.compile(r'<img[^>]*(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"', re.IGNORECASE)


def discover_set_slugs(tcg_cfg):
    """Returns list of (display_name, console_slug) for the TCG.

    Two discovery paths:
      1. Category page scrape (Pokemon/MTG/YGO/OP — these all have a
         /category/<game>-cards index page that lists every set).
      2. Explicit slug list (Gundam, DBZ — PC has no category page for
         these TCGs; the slugs are hand-verified in TCG_CONFIG).

    Either path returns the (display_name, slug) tuples downstream
    code expects. For explicit lists we synthesize the display name
    by titlecasing the slug tail."""
    # Path 2: explicit slug list (no category page)
    if not tcg_cfg.get("category_path") and tcg_cfg.get("explicit_slugs"):
        slug_prefix = tcg_cfg["slug_prefix"]
        found = []
        for slug in tcg_cfg["explicit_slugs"]:
            tail = slug
            if slug.startswith(slug_prefix):
                tail = slug[len(slug_prefix):]
            name = tail.replace("-", " ").title()
            found.append((name, slug))
        return found

    # Path 1: scrape the category index page
    page_html = fetch(f"{PC_BASE}{tcg_cfg['category_path']}")
    if not page_html:
        return []
    slug_prefix = tcg_cfg["slug_prefix"]
    rx = re.compile(
        r'href="/console/(' + re.escape(slug_prefix) + r'[^"]+)"[^>]*>([^<]+)</a>',
        re.IGNORECASE,
    )
    found = []
    seen  = set()
    for m in rx.finditer(page_html):
        slug = html.unescape(m.group(1))
        name = html.unescape(m.group(2).strip())
        if slug in seen:
            continue
        seen.add(slug)
        found.append((name, slug))
    return found


def parse_console_page(page_html, set_name, set_code, slug, tcg_cfg):
    """Yield catalog rows for sealed products on a per-set console page."""
    if not page_html:
        return
    game_type = tcg_cfg["game_type"]
    lang      = lang_from_slug(slug) if tcg_cfg["lang_aware"] else "en"
    id_seg    = tcg_cfg.get("id_segment")   # 'mtg' / 'ygo' / 'op' for non-Pokémon

    # The link regex per TCG must match /game/{slug_prefix}{...}
    link_rx = re.compile(
        r'<a[^>]*href="(/game/' + re.escape(tcg_cfg["slug_prefix"]) + r'[^"]+)"[^>]*>([^<]+)</a>',
        re.IGNORECASE,
    )

    chunks = ROW_SPLIT.split(page_html)[1:]
    for chunk in chunks:
        id_m = ID_RE.search(chunk)
        if not id_m:
            continue
        pc_id = id_m.group(1)

        link_m = link_rx.search(chunk)
        if not link_m:
            continue
        prod_url = link_m.group(1)
        name     = sanitize_text(link_m.group(2))

        ptype, is_sealed = detect_product_type(name)
        if not is_sealed:
            continue

        img_m   = IMG_RE.search(chunk)
        image_u = img_m.group(1) if img_m else None
        if image_u and image_u.startswith("/"):
            image_u = urljoin(PC_BASE, image_u)
        if image_u:
            # Upgrade /60.jpg thumbnails to /480.jpg
            image_u = re.sub(r'/60\.(jpg|jpeg|png|webp)$', r'/480.\1', image_u, flags=re.IGNORECASE)

        # ID prefix: language-aware for Pokemon, fixed segment for others.
        if tcg_cfg["lang_aware"]:
            catalog_id = f"sealed-{lang}-pc-{pc_id}"
        else:
            catalog_id = f"sealed-{id_seg}-pc-{pc_id}"

        yield {
            "id":               catalog_id,
            "name":             name,
            "set_name":         set_name,
            "set_code":         set_code,
            "card_number":      None,
            "rarity":           None,
            "supertype":        "Sealed Product",
            "image_url":        image_u,
            "game_type":        game_type,
            "product_type":     ptype,
            "msrp_usd":         None,    # no seed for non-Pokémon yet
            "pricecharting_id": pc_id,
            "price_source_url": urljoin(PC_BASE, prod_url) if prod_url else None,
            "release_date":     None,
        }


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tcg", required=True, choices=list(TCG_CONFIG.keys()),
                    help="Which TCG to scrape: pokemon | magic | yugioh | onepiece")
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would be written; don't touch the DB.")
    ap.add_argument("--only", help="Sync a single set by console slug.")
    ap.add_argument("--workers", type=int, default=1,
                    help="Parallel scrape workers (default 1). 5-8 is reasonable.")
    ap.add_argument("--debug-dump", action="store_true",
                    help="Fetch one console page, save HTML, exit.")
    args = ap.parse_args()

    tcg_cfg = TCG_CONFIG[args.tcg]
    print(f"  TCG: {args.tcg}  ({tcg_cfg['game_type']})  category={tcg_cfg['category_path']}")

    if args.debug_dump:
        # Pick the first discovered set of this TCG and dump it.
        sets = discover_set_slugs(tcg_cfg)
        if not sets:
            sys.exit("  [debug] discovery returned no sets")
        slug = sets[0][1]
        url  = f"{PC_BASE}/console/{slug}"
        print(f"  [debug] Fetching {url}")
        page_html = fetch(url)
        if not page_html:
            sys.exit("  [debug] fetch returned nothing")
        path = Path(__file__).parent / f"scrape_debug_{args.tcg}.html"
        path.write_text(page_html)
        print(f"  [debug] {len(page_html):,} bytes saved to {path}")
        ids   = ID_RE.findall(page_html)
        link_rx = re.compile(
            r'<a[^>]*href="(/game/' + re.escape(tcg_cfg["slug_prefix"]) + r'[^"]+)"[^>]*>([^<]+)</a>',
            re.IGNORECASE,
        )
        links = link_rx.findall(page_html)
        print(f"  [debug] {len(set(ids))} unique product ids   {len(links)} product links")
        for href, name in links[:10]:
            print(f"     {name.strip()[:60]:60s}  ({href})")
        return

    # Build the set list (auto-discover unless --only)
    if args.only:
        discovered = [(args.only.replace(tcg_cfg["slug_prefix"], "").replace("-", " ").title(), args.only)]
    else:
        print("  Discovering sets from PriceCharting category index…")
        discovered = discover_set_slugs(tcg_cfg)
        print(f"    → found {len(discovered)} sets")
    if not discovered:
        sys.exit("  No sets found. Check the category URL or your network.")

    rows = []
    seen = set()
    skipped = 0
    _lock = threading.Lock()

    def _scrape_one(item):
        set_name, slug = item
        url = f"{PC_BASE}/console/{slug}"
        # Per-TCG set_code = slug minus the TCG prefix, truncated.
        set_code = slug.replace(tcg_cfg["slug_prefix"], "")[:32]
        page_html = fetch(url)
        if not page_html:
            return (set_name, url, None)
        set_rows = list(parse_console_page(page_html, set_name, set_code, slug, tcg_cfg))
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
                print(f"  {set_name:40s} → {len(unique):3d} sealed rows  ({url})")
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

    print(f"\n  Done. {written} sealed-product rows written to catalog.")


if __name__ == "__main__":
    main()
