#!/usr/bin/env python3
"""
PathBinder — Pokedata Consolidated Sync
========================================
Single-pass replacement for the three older scripts (fetch_jp_pokedata.py
image update + --fill-missing + a separate name scraper). For each set
Pokedata knows about, fetches the /set/{code} page ONCE, extracts every
card's full metadata from __NEXT_DATA__, and batch-upserts to the
catalog table. ~400 HTTP calls total for the full JP catalog vs 7,000+
across the old three-pass approach.

USAGE:
    # First, probe one set to confirm the JSON shape Pokedata's pages
    # return. Saves raw __NEXT_DATA__ to probe.json for inspection.
    python3 pokedata_sync.py --probe sv4a

    # Dry-run on one set, show what would change
    python3 pokedata_sync.py --only sv4a --dry-run

    # Real run on one set
    python3 pokedata_sync.py --only sv4a

    # Full JP catalog sync, dry-run first
    python3 pokedata_sync.py --language JA --dry-run
    python3 pokedata_sync.py --language JA

    # English catalog sync
    python3 pokedata_sync.py --language EN

REQUIREMENTS:
    pip3 install requests supabase --break-system-packages

ENVIRONMENT / AUTH:
    SUPABASE_SERVICE_KEY   Supabase service-role / secret key
    pokedata_session.txt   Gitignored file with session + remember_token
                           cookies from a logged-in browser
"""

import os, sys, re, time, json, argparse, threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing 'supabase'. Run: pip3 install supabase --break-system-packages")


# ═════════════════════════════════════════════════════════════════════════════
# CONFIG
# ═════════════════════════════════════════════════════════════════════════════
SUPABASE_URL    = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY    = os.environ.get("SUPABASE_SERVICE_KEY") or input("Supabase service-role key: ").strip()
POKEDATA_BASE   = "https://www.pokedata.io"
POKEDATA_API    = "https://www.pokedata.io/api"      # internal XHR endpoint
IMAGE_CDN       = "https://pokemoncardimages.pokedata.io/images"
REQUEST_TIMEOUT = 45
DELAY_BETWEEN_SETS = 1.2   # politeness pause between API requests (raised
                           # from 0.4 after hitting 429s on EN sync)
UPSERT_BATCH    = 50

# Browser-style headers — Pokedata's /api/cards endpoint checks Referer
# and a real-looking User-Agent before serving the JSON. Without these
# you get a redirect to /login or an empty response.
BROWSER_HEADERS = {
    "accept":     "application/json, text/plain, */*",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
}

# ═════════════════════════════════════════════════════════════════════════════
# ARGS
# ═════════════════════════════════════════════════════════════════════════════
parser = argparse.ArgumentParser(description="One-pass Pokedata → Supabase catalog sync")
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--probe", type=str, default=None,
    help="Fetch one set page and save the raw __NEXT_DATA__ to probe.json. Pass set code (e.g. sv4a)")
mode.add_argument("--list-sets", action="store_true",
    help="Print all sets Pokedata knows about and exit")
mode.add_argument("--mirror-images", action="store_true",
    help="Download every catalog image still hosted on Pokedata, upload to Supabase Storage, rewrite image_url. Run after the main sync.")
mode.add_argument("--enrich-rarity", action="store_true",
    help="Backfill catalog.rarity for non-Pokemon TCGs. Uses Scryfall bulk data for Magic, YGOPRODeck for Yu-Gi-Oh, apitcg for One Piece. Idempotent — only fills NULL rarities by default. Use --tcg to scope per game.")
mode.add_argument("--check-images", action="store_true",
    help="Audit per-TCG image mirror status: how many rows are mirrored, still pending on pokedata, or missing entirely. Read-only. Pass --verbose to see sample failing rows.")
mode.add_argument("--diagnose-jp-legacy", action="store_true",
    help="Find legacy JP Pokemon catalog rows from a pre-Pokedata scrape (NULL image_url + non-ASCII set_name). Reports counts and a safe deletion preview. Pass --confirm to actually delete orphans (rows not referenced in collection_items).")
mode.add_argument("--probe-pending-urls", action="store_true",
    help="HEAD-check a sample of pending pokedata.io URLs per set to distinguish 'whole set is broken' (all 404s — usually wrong set_name) from 'individual cards missing' (mixed pass/fail). Read-only.")
parser.add_argument("--confirm", action="store_true",
    help="Required for destructive operations like --diagnose-jp-legacy deletion.")
parser.add_argument("--fallback-source", action="store_true",
    help="With --mirror-images, fetch from the canonical source (Scryfall/YGOPRODeck/apitcg) instead of pokedata. Use for stragglers that pokedata permanently 404s.")
parser.add_argument("--language", choices=["EN", "JA"], default=None,
    help="Limit to one language (default: both). Mostly relevant for Pokemon — most other TCGs are English-only on Pokedata.")
parser.add_argument("--tcg", type=str, default="Pokemon",
    help="Which TCG to scrape. Pokedata covers: Pokemon, Magic, Yugioh, One Piece, Digimon, Lorcana, Flesh and Blood, Union Arena, Dragon Ball, Grand Archive, MetaZoo, Star Wars, Gundam, Sorcery. Default 'Pokemon' for backward compat with existing scripts.")
parser.add_argument("--only", type=str, default=None,
    help="Process only this set code")
parser.add_argument("--dry-run", action="store_true",
    help="Read everything but don't write to Supabase")
parser.add_argument("--limit", type=int, default=None,
    help="Stop after this many sets (for testing)")
parser.add_argument("--no-create", action="store_true",
    help="Only update existing catalog rows; don't create new ones")
parser.add_argument("--no-update", action="store_true",
    help="Only create missing catalog rows; don't update existing ones")
parser.add_argument("--verbose", action="store_true",
    help="Print every HTTP request and per-card patch")
parser.add_argument("--workers", type=int, default=5,
    help="Parallel uploads for --mirror-images (default 5). Bump for speed; lower if you see lots of 429s.")
parser.add_argument("--legacy-only", action="store_true",
    help="Only target rows whose id has no en-/jp-/pd- prefix (the raw-tcg-id imports). Useful as a third mirror terminal that doesn't conflict with --language EN / JA runs.")
parser.add_argument("--reenrich", action="store_true",
    help="With --enrich-rarity, also overwrite rows that already have a rarity. Default is to fill only NULLs.")
args = parser.parse_args()


# ═════════════════════════════════════════════════════════════════════════════
# SUPABASE
# ═════════════════════════════════════════════════════════════════════════════
sb = create_client(SUPABASE_URL, SUPABASE_KEY)
# Lightweight connectivity check. We used to do `count="exact"` here for a
# nice "catalog has X rows" message, but once the catalog grew past ~100K
# rows the COUNT(*) started hitting Supabase's 8s statement timeout —
# especially while mirror runs are generating concurrent UPDATE traffic.
try:
    res = sb.table("catalog").select("id").limit(1).execute()
    print(f"✓ Supabase connected — catalog reachable")
except Exception as e:
    sys.exit(f"✗ Cannot reach catalog: {e}")


# ═════════════════════════════════════════════════════════════════════════════
# HTTP + MEMBERSHIP COOKIES
# ═════════════════════════════════════════════════════════════════════════════
_session = requests.Session()
_session.headers.update({"User-Agent": "PathBinder/1.0 (contact: charles@merchunlimited.com)"})

def _load_pokedata_cookies(path="pokedata_session.txt"):
    if not os.path.exists(path):
        return {}
    cookies = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            v = v.strip().strip('"').strip("'")
            if v:
                cookies[k.strip()] = v
    return cookies

_pd_cookies = _load_pokedata_cookies()
if _pd_cookies:
    for _k, _v in _pd_cookies.items():
        _session.cookies.set(_k, _v, domain=".pokedata.io")
    print(f"  Loaded {len(_pd_cookies)} membership cookies — fetching as logged-in user")
else:
    print(f"  (no pokedata_session.txt — fetching anonymously, results may be limited)")


def fetch_page(url, retries=3):
    """GET an HTML page, return text. Returns None on failure."""
    if args.verbose:
        print(f"  GET {url}")
    for attempt in range(retries):
        try:
            r = _session.get(url, timeout=REQUEST_TIMEOUT)
            if r.status_code == 404:
                return None
            if r.status_code == 429:
                wait = 20 * (attempt + 1)
                print(f"  Rate limited, sleeping {wait}s")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.text
        except requests.exceptions.RequestException as e:
            if attempt < retries - 1:
                time.sleep(4 * (attempt + 1))
            else:
                print(f"  ⚠ Fetch failed ({url[:80]}): {e}")
    return None


def extract_next_data(html):
    """Pull the __NEXT_DATA__ JSON blob out of a rendered Next.js page."""
    if not html:
        return None
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError as e:
        print(f"  ⚠ __NEXT_DATA__ parse failed: {e}")
        return None


def _str(val):
    return val if isinstance(val, str) else ""


# ═════════════════════════════════════════════════════════════════════════════
# FETCH SET LIST (works without auth, includes language flag)
# ═════════════════════════════════════════════════════════════════════════════
def fetch_all_sets():
    """Return the full list of sets for the active TCG.
    For Pokemon: scrapes /sets (the main index).
    For other TCGs: scrapes /tcg/{slug} (per-game page).
    Both pages embed the set array in __NEXT_DATA__'s pageProps."""
    tcg_input = getattr(args, "tcg", "") or "Pokemon"
    is_pokemon = "pokemon" in tcg_input.lower()
    if is_pokemon:
        url = f"{POKEDATA_BASE}/sets"
    else:
        slug = _tcg_slug(canonical_tcg(tcg_input))
        url = f"{POKEDATA_BASE}/tcg/{slug}"

    html = fetch_page(url)
    data = extract_next_data(html)
    if not data:
        sys.exit(f"✗ Could not fetch sets from {url}")

    page_props = data.get("props", {}).get("pageProps", {})

    # Try the known keys — different TCG pages may use different keys.
    for key in ("setInfoArr", "sets", "setList", "tcgSets", "data"):
        v = page_props.get(key)
        if isinstance(v, list) and v:
            return v

    # If __NEXT_DATA__ was empty for the per-TCG page, the set list is
    # probably loaded via XHR — same pattern as /api/cards for Pokemon.
    # Print a helpful diagnostic and bail.
    print(f"  ⚠ No set array found at {url}. pageProps keys: {list(page_props.keys())}")
    print(f"    Per-TCG set list may be loaded via XHR after page load.")
    print(f"    Inspect DevTools Network tab on {url} to find the right endpoint.")
    return []


# ═════════════════════════════════════════════════════════════════════════════
# PARSE PER-SET CARD DATA (this is where field names may need tuning after probe)
# ═════════════════════════════════════════════════════════════════════════════
def fetch_set_cards(set_code, set_name):
    """Hit Pokedata's internal /api/cards XHR endpoint and return the list
    of cards for one set. This is the same endpoint the browser uses when
    you view a set page — confirmed via DevTools recon.

    Requires the Referer header pointing back at the set page, plus a
    real-looking User-Agent. Without those Pokedata returns an empty
    payload or a redirect to /login."""
    # Build referer based on active TCG. Pokemon uses /set/{name},
    # everything else uses /tcg/{slug}/{name}.
    tcg_input = getattr(args, "tcg", "") or "Pokemon"
    is_pokemon = "pokemon" in tcg_input.lower()
    tcg_canon = canonical_tcg(tcg_input)
    set_name_url = set_name.replace(" ", "+")
    if is_pokemon:
        referer = f"{POKEDATA_BASE}/set/{set_name_url}"
    else:
        referer = f"{POKEDATA_BASE}/tcg/{_tcg_slug(tcg_canon)}/{set_name_url}"

    headers = dict(BROWSER_HEADERS)
    headers["referer"] = referer
    # Pokedata's frontend sends tcg= empty for Pokemon and the TCG display name
    # ('Magic The Gathering', 'Yu-Gi-Oh!', etc.) for everything else.
    params = {
        "set_name": set_name,
        "tcg":      "" if is_pokemon else tcg_canon,
        "stats":    "kwan",
    }
    if args.verbose:
        print(f"  GET {POKEDATA_API}/cards  set_name={set_name}")

    # Retry on 429 with growing backoff. Pokedata throttles after ~50–80
    # requests in quick succession; sleeping 30–120s usually clears it.
    r = None
    for attempt in range(5):
        try:
            r = _session.get(f"{POKEDATA_API}/cards", params=params,
                             headers=headers, timeout=REQUEST_TIMEOUT)
        except requests.exceptions.RequestException as e:
            if attempt < 4:
                time.sleep(2 ** attempt)
                continue
            print(f"  ⚠ API fetch failed: {e}")
            return []
        if r.status_code == 429:
            wait = 30 * (attempt + 1)   # 30s, 60s, 90s, 120s, 150s
            print(f"    ⏸ 429 from Pokedata for {set_name} — sleeping {wait}s")
            time.sleep(wait)
            continue
        break

    if r is None or r.status_code != 200:
        code = r.status_code if r is not None else "n/a"
        print(f"  ⚠ /api/cards returned HTTP {code} for {set_name}")
        return []
    try:
        data = r.json()
    except ValueError:
        print(f"  ⚠ /api/cards response wasn't JSON for {set_name}")
        return []

    # Response shape may be {"cards":[...]}, a bare list, or some wrapper.
    # Be defensive — try multiple shapes.
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("cards", "data", "results", "items", "rows"):
            v = data.get(key)
            if isinstance(v, list) and v:
                return v
        # Last resort — if there's a single list-typed value at any depth,
        # use it. This catches unusual wrappers.
        for v in data.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
    return []


def pokedata_card_to_row(card, fallback_set_code, fallback_set_name, fallback_language):
    """Map a Pokedata /api/cards item → a catalog row dict.
    Field names confirmed via the live probe of /api/cards.
    Empty fields are omitted so we don't blank out existing catalog data
    on upsert. Returns None if the card is missing essentials."""
    card_num = _str(card.get("num"))
    if not card_num:
        return None

    # Prefer card-level fields over our fallback (they're authoritative).
    set_code = _str(card.get("set_code")) or fallback_set_code
    set_name = _str(card.get("set_name")) or fallback_set_name
    card_lang = _str(card.get("language")).upper()
    if card_lang.startswith("JAPAN"):
        lang = "JA"
    elif card_lang.startswith("ENG") or card_lang == "EN":
        lang = "EN"
    else:
        lang = fallback_language or "EN"

    # Card-level tcg is authoritative — falls back to whatever the CLI said.
    tcg = _str(card.get("tcg")) or args.tcg or "Pokemon"
    id_prefix  = get_id_prefix(tcg, lang)
    game_type  = get_game_type(tcg)

    # Lowercase set_code in the id for consistency. Keep canonical case in column.
    cat_id = f"{id_prefix}-{set_code.lower()}-{card_num}"

    name   = _str(card.get("name"))
    img    = _str(card.get("img_url"))
    if img and not img.startswith("http"):
        img = ""
    # No reliable rarity in /api/cards — we leave rarity untouched.
    # `secret` IS available; use it as a weak fallback only when the
    # existing row has no rarity at all (handled in the diff step).
    secret = bool(card.get("secret"))

    # Capture the raw Pokedata stats array so we can populate price
    # columns later without re-fetching. JSONB column expected:
    #   alter table catalog add column if not exists pokedata_stats jsonb;
    stats = card.get("stats") if isinstance(card.get("stats"), list) else None
    pokedata_id = card.get("id")

    row = {"id": cat_id, "game_type": game_type}
    if name:        row["name"]          = name
    if set_name:    row["set_name"]      = set_name
    if set_code:    row["set_code"]      = set_code
    if card_num:    row["card_number"]   = card_num
    if img:         row["image_url"]     = img
    # Optional fields — only set if we have data
    if secret:      row["_secret_hint"]  = True       # internal marker, stripped before insert
    if stats is not None:  row["pokedata_stats"] = stats
    if pokedata_id is not None: row["pokedata_id"] = pokedata_id

    return row


def _normalize_card_num(n):
    """Strip leading zeros for matching (so '011' and '11' compare equal),
    but preserve non-numeric suffixes like 'TG01' or 'SV-P 042/SV-P'."""
    s = _str(n)
    if not s:
        return ""
    try:
        return str(int(s))
    except ValueError:
        return s


# ─── TCG → catalog id prefix & game_type column value ──────────────────────────
# Each game gets its own short prefix on catalog ids and a canonical
# lowercase `game_type` column value. Extend these as Pokedata adds games.

def get_id_prefix(tcg, language=None):
    """Return the catalog id prefix for a given TCG + language.
    Pokemon uses jp-/en- depending on language; everything else uses a
    game-specific short slug."""
    t = (tcg or "").lower().strip()
    if "pokemon" in t or "poké" in t or t == "pokémon":
        return "jp" if (language or "").upper() == "JA" else "en"
    if "magic" in t:                 return "mtg"
    if "yu-gi" in t or "yugioh" in t: return "ygo"
    if "one piece" in t:             return "op"
    if "digimon" in t:               return "dgm"
    if "lorcana" in t:               return "lor"
    if "flesh and blood" in t:       return "fab"
    if "union arena" in t:           return "ua"
    if "fusion world" in t:          return "dbf"
    if "dragon ball z" in t:         return "dbz"
    if "grand archive" in t:         return "ga"
    if "metazoo" in t:               return "mz"
    if "star wars" in t:             return "sw"
    if "gundam" in t:                return "gun"
    if "sorcery" in t:               return "sor"
    # Fallback: first three alphanum chars of the tcg name
    slug = "".join(c for c in t if c.isalnum())[:3]
    return slug or "unk"


def get_game_type(tcg):
    """Return the canonical lowercase `game_type` column value for a TCG.
    Use these consistently in the catalog so collection_items can join."""
    t = (tcg or "").lower().strip()
    if "pokemon" in t or "poké" in t or t == "pokémon": return "pokemon"
    if "magic" in t:                 return "magic"
    if "yu-gi" in t or "yugioh" in t: return "yugioh"
    if "one piece" in t:             return "onepiece"
    if "digimon" in t:               return "digimon"
    if "lorcana" in t:               return "lorcana"
    if "flesh and blood" in t:       return "fab"
    if "union arena" in t:           return "unionarena"
    if "fusion world" in t:          return "dbfusion"
    if "dragon ball z" in t:         return "dbz"
    if "grand archive" in t:         return "grandarchive"
    if "metazoo" in t:               return "metazoo"
    if "star wars" in t:             return "starwars"
    if "gundam" in t:                return "gundam"
    if "sorcery" in t:               return "sorcery"
    return "".join(c for c in t if c.isalnum()) or "unknown"


# ─── Pokedata URL slug for a TCG ───────────────────────────────────────────────
# Pokedata uses lowercase-hyphenated URL slugs for per-TCG pages.
# 'Magic The Gathering' → 'magic-the-gathering'
# 'Yu-Gi-Oh!'           → 'yu-gi-oh'  (punctuation dropped)
# 'One Piece'           → 'one-piece'
def _tcg_slug(tcg):
    if not tcg:
        return ""
    s = (tcg or "").lower().strip()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"\s+", "-", s).strip("-")
    s = re.sub(r"-+", "-", s)
    return s


# ─── Canonical TCG display name Pokedata expects in the `tcg` query param ──────
# Maps loose user input → the exact string Pokedata's API wants.
_TCG_CANONICAL = {
    "pokemon":           "Pokemon",
    "magic":             "Magic The Gathering",
    "magic the gathering": "Magic The Gathering",
    "mtg":               "Magic The Gathering",
    "yugioh":            "Yugioh",       # Pokedata uses one-word form, no punctuation
    "yu-gi-oh":          "Yugioh",
    "yu-gi-oh!":         "Yugioh",
    "ygo":               "Yugioh",
    "one piece":         "One Piece",
    "onepiece":          "One Piece",
    "op":                "One Piece",
    "digimon":           "Digimon Card Game",
    "digimon card game": "Digimon Card Game",
    "lorcana":           "Lorcana",
    "flesh and blood":   "Flesh and Blood",
    "fab":               "Flesh and Blood",
    "union arena":       "Union Arena",
    "dragon ball super fusion world": "Dragon Ball Super Fusion World",
    "fusion world":      "Dragon Ball Super Fusion World",
    "dragon ball z tcg": "Dragon Ball Z TCG",
    "dbz":               "Dragon Ball Z TCG",
    "grand archive":     "Grand Archive",
    "metazoo":           "MetaZoo",
    "star wars unlimited": "Star Wars Unlimited",
    "star wars":         "Star Wars Unlimited",
    "gundam":            "Gundam Card Game",
    "gundam card game":  "Gundam Card Game",
    "sorcery":           "Sorcery Contested Realm",
    "sorcery contested realm": "Sorcery Contested Realm",
}

def canonical_tcg(tcg):
    """Return the exact TCG display name Pokedata wants in query params."""
    if not tcg: return "Pokemon"
    return _TCG_CANONICAL.get(tcg.lower().strip(), tcg)


# ═════════════════════════════════════════════════════════════════════════════
# UPSERT
# ═════════════════════════════════════════════════════════════════════════════
def upsert_rows(rows):
    """Upsert in batches with on_conflict='id'. Returns count written.

    CRITICAL: Pokedata always returns its own image URLs (pokemoncardimages
    .pokedata.io / alltcgcardimages.pokedata.io). If we upsert blindly, we
    overwrite already-mirrored supabase.co URLs and waste hours of mirror
    work. Before each chunk, we check which existing rows already have a
    supabase.co image and strip image_url from those patches so the mirror
    persists. Rows that don't exist yet (INSERT branch of the upsert) and
    rows still on pokedata get the new image_url written normally."""
    if not rows or args.dry_run:
        return 0
    written = 0
    for i in range(0, len(rows), UPSERT_BATCH):
        chunk = rows[i:i+UPSERT_BATCH]
        chunk = _strip_image_url_for_mirrored(chunk)
        try:
            sb.table("catalog").upsert(chunk, on_conflict="id").execute()
            written += len(chunk)
        except Exception as e:
            print(f"    ✗ Upsert error: {e}")
    return written


def _strip_image_url_for_mirrored(chunk):
    """For each row in the chunk whose corresponding catalog row already has
    a supabase.co image_url, remove image_url from the payload so the upsert
    doesn't downgrade the mirrored URL back to pokedata."""
    ids = [r.get("id") for r in chunk if r.get("id")]
    if not ids:
        return chunk
    try:
        res = sb.table("catalog").select("id, image_url").in_("id", ids).execute()
    except Exception as e:
        # If we can't check, fail-safe: leave chunk unchanged so the sync
        # still progresses. Worst case is a re-mirror.
        print(f"    ⚠ image-url pre-check failed ({e}); proceeding without strip")
        return chunk
    mirrored = {row["id"] for row in (res.data or [])
                if (row.get("image_url") or "").lower().find("supabase.co") != -1}
    if not mirrored:
        return chunk
    cleaned = []
    for r in chunk:
        if r.get("id") in mirrored and "image_url" in r:
            new = {k: v for k, v in r.items() if k != "image_url"}
            cleaned.append(new)
        else:
            cleaned.append(r)
    return cleaned


def fetch_existing_ids_for_set(language, set_code, set_name=None):
    """Return a dict keyed by NORMALIZED card_number → existing row.

    Matches in two phases:
      1. By set_code  (case-insensitive). Catches en-* / pd-* / jp-*
         rows where the catalog already uses Pokedata's set_code scheme.
      2. By set_name  (case-insensitive). Catches legacy rows from older
         imports where set_code differs between sources (pokemontcg.io
         uses 'sv4', Pokedata uses 'PAR' — but both have set_name
         'Paradox Rift'). Critical for EN sync of 19K+ legacy rows.

    On collision (a card matched by both code AND name), the en-/jp- prefixed
    row wins over a raw-tcg-id row — preserves cleaner ids when available."""

    rows = []
    # Phase 1: by set_code, scoped to the prefixes for this game+language.
    # For Pokemon: jp-/pd- for JP, en- for EN (legacy raw-id rows are
    # picked up in Phase 2 by set_name). For other TCGs: their canonical
    # prefix (mtg-, ygo-, op-, etc.) — no Phase 2 needed since there's
    # no legacy data for those games yet.
    active_tcg = getattr(args, "tcg", "Pokemon")
    canonical_prefix = get_id_prefix(active_tcg, language or "EN")
    if canonical_prefix in ("jp", "en"):
        # Pokemon — preserve the existing jp+pd / en behavior
        prefixes = ["jp-", "pd-"] if language == "JA" else ["en-"]
    else:
        prefixes = [f"{canonical_prefix}-"]
    for prefix in prefixes:
        offset = 0
        while True:
            q = (sb.table("catalog")
                 .select("id,name,rarity,image_url,set_name,set_code,card_number")
                 .like("id", f"{prefix}%")
                 .ilike("set_code", set_code)
                 .range(offset, offset + 999))
            res = q.execute()
            chunk = res.data or []
            rows.extend(chunk)
            if len(chunk) < 1000:
                break
            offset += 1000

    # Phase 2: by set_name (no prefix filter — catches legacy raw-tcg-id rows).
    # For JP, only fall through if Phase 1 came up empty (avoids accidentally
    # matching an EN set that shares its English name with a JP release).
    # For EN, always do the name pass — that's where legacy rows live.
    # For non-Pokemon TCGs, skip Phase 2 entirely — they have no legacy data.
    is_pokemon = canonical_prefix in ("jp", "en")
    if is_pokemon and set_name and (language == "EN" or not rows):
        offset = 0
        while True:
            q = (sb.table("catalog")
                 .select("id,name,rarity,image_url,set_name,set_code,card_number")
                 .ilike("set_name", set_name)
                 .range(offset, offset + 999))
            res = q.execute()
            chunk = res.data or []
            # For EN, exclude JP/PD rows (they might share an English set_name
            # with a different language release we don't want to overwrite).
            if language == "EN":
                chunk = [r for r in chunk if not r["id"].startswith(("jp-", "pd-"))]
            else:
                chunk = [r for r in chunk if r["id"].startswith(("jp-", "pd-"))]
            rows.extend(chunk)
            if len(chunk) < 1000:
                break
            offset += 1000

    result = {}
    for r in rows:
        key = _normalize_card_num(r.get("card_number"))
        if not key:
            continue
        existing = result.get(key)
        if existing is None:
            result[key] = r
            continue
        # Prefer prefixed ids (en-, jp-) over raw-tcg ids when both exist.
        # And prefer jp- over pd- for JP (jp- is canonical, pd- was fill-missing).
        old_id = existing["id"]
        new_id = r["id"]
        old_is_prefixed = old_id.startswith(("en-", "jp-"))
        new_is_prefixed = new_id.startswith(("en-", "jp-"))
        if new_is_prefixed and not old_is_prefixed:
            result[key] = r
        elif old_id.startswith("pd-") and new_id.startswith("jp-"):
            result[key] = r
    return result


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --probe
# ═════════════════════════════════════════════════════════════════════════════
def mode_probe():
    """Call the /api/cards XHR endpoint directly for one set and dump
    the raw response so we can lock in the field mapping."""
    code = args.probe

    # Resolve to the set's display name — that's what /api/cards wants
    all_sets = fetch_all_sets()
    matching = [s for s in all_sets
                if _str(s.get("code")).lower() == code.lower()
                or _str(s.get("name")).lower() == code.lower()]
    if not matching:
        sys.exit(f"✗ No set in /sets index matches '{code}'. "
                 "Try `--list-sets` to find the exact code or name.")
    s = matching[0]
    set_name = _str(s.get("name"))
    set_code = _str(s.get("code"))
    print(f"\n  Resolved '{code}' → code='{set_code}', name='{set_name}'")

    cards = fetch_set_cards(set_code, set_name)
    if not cards:
        print(f"\n  ✗ /api/cards returned no cards for '{set_name}'.")
        print(f"    Likely causes: missing/expired session cookies, blocked Referer,")
        print(f"    or this set isn't visible to your membership tier.")
        return

    print(f"  ✓ /api/cards returned {len(cards)} cards")

    # Save the full response so we can re-inspect without re-fetching
    with open("probe.json", "w", encoding="utf-8") as f:
        json.dump(cards, f, indent=2, ensure_ascii=False)
    print(f"  Saved full response ({len(cards)} cards) to probe.json")

    sample = cards[0]
    print(f"\n  Keys on first card: {list(sample.keys())}")
    print(f"\n  First card (formatted):")
    pretty = json.dumps(sample, indent=2, ensure_ascii=False)
    for line in pretty.split("\n")[:40]:
        print(f"    {line}")

    # Heuristic suggestion of which fields map to which catalog columns
    print(f"\n  Suggested field mapping:")
    def _guess(field_options):
        for f in field_options:
            if f in sample and sample[f] not in (None, ""):
                return f
        return None
    suggestions = {
        "name":        _guess(["name", "card_name", "title"]),
        "card_number": _guess(["card_number", "number", "num", "card_num"]),
        "rarity":      _guess(["rarity", "card_rarity"]),
        "image_url":   _guess(["image_url", "image", "img", "img_url", "thumbnail"]),
        "hp":          _guess(["hp", "card_hp"]),
        "type":        _guess(["type", "card_type", "supertype"]),
    }
    for col, src in suggestions.items():
        if src:
            print(f"    catalog.{col:<12} ← card['{src}']  (e.g. {sample[src]!r})")
        else:
            print(f"    catalog.{col:<12} ← (no match found)")


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --list-sets
# ═════════════════════════════════════════════════════════════════════════════
def mode_list_sets():
    sets = fetch_all_sets()
    # fetch_all_sets already fetched the right per-TCG page, so the sets
    # returned are pre-filtered to this TCG by the source. But just in case
    # the page mixes TCGs, do a partial-name filter here too.
    if args.tcg:
        tcg_canon = canonical_tcg(args.tcg).lower()
        tcg_loose = args.tcg.lower()
        sets = [s for s in sets
                if tcg_canon in _str(s.get("tcg")).lower()
                or tcg_loose in _str(s.get("tcg")).lower()
                or not _str(s.get("tcg"))]
    if args.language:
        sets = [s for s in sets if _str(s.get("language")).upper().startswith(args.language)]
    print(f"\n{'Code':<10} {'Lang':<10} {'TCG':<14} {'Name':<40} Cards")
    print("-" * 95)
    for s in sets:
        code = _str(s.get("code"))[:10]
        lang = _str(s.get("language"))[:8]
        tcg  = _str(s.get("tcg"))[:14]
        name = _str(s.get("name"))[:40]
        cnt  = s.get("card_count") or s.get("total") or "?"
        print(f"  {code:<10} {lang:<10} {tcg:<14} {name:<40} {cnt}")
    print(f"\n  Total: {len(sets)} sets matching tcg='{args.tcg or 'ALL'}' lang='{args.language or 'ALL'}'")


# ═════════════════════════════════════════════════════════════════════════════
# MAIN SYNC
# ═════════════════════════════════════════════════════════════════════════════
def main_sync():
    all_sets = fetch_all_sets()
    # fetch_all_sets() already hit the right per-TCG page, so sets are
    # already scoped to this game. Still do a defensive filter in case
    # the per-TCG page also mixes other games' entries.
    if args.tcg:
        tcg_canon = canonical_tcg(args.tcg).lower()
        tcg_loose = args.tcg.lower()
        all_sets = [s for s in all_sets
                    if tcg_canon in _str(s.get("tcg")).lower()
                    or tcg_loose in _str(s.get("tcg")).lower()
                    or not _str(s.get("tcg"))]
        if not all_sets:
            sys.exit(f"✗ No sets found matching tcg='{args.tcg}'. Try --list-sets --tcg '{args.tcg}' to see what Pokedata has.")
    if args.language:
        all_sets = [s for s in all_sets if _str(s.get("language")).upper().startswith(args.language)]
    if args.only:
        only_lower = args.only.lower()
        all_sets = [s for s in all_sets
                    if _str(s.get("code")).lower() == only_lower
                    or _str(s.get("name")).lower() == only_lower]
    if args.limit:
        all_sets = all_sets[:args.limit]

    print(f"\nSyncing {len(all_sets)} sets…\n")

    total_created = 0
    total_updated = 0
    total_unchanged = 0
    total_no_cards  = 0

    for set_idx, s in enumerate(all_sets, 1):
        set_code  = _str(s.get("code"))
        set_name  = _str(s.get("name"))
        language  = _str(s.get("language")).upper()
        if language.startswith("JA"):
            language = "JA"
        elif language.startswith("EN") or language == "ENGLISH":
            language = "EN"
        else:
            print(f"  [{set_idx}/{len(all_sets)}] {set_code} {set_name}: unknown language '{language}' — skipping")
            continue
        if not set_code or not set_name:
            continue

        cards = fetch_set_cards(set_code, set_name)
        if not cards:
            print(f"  [{set_idx}/{len(all_sets)}] {set_code:<10} {language} {set_name:<35} → no cards found")
            total_no_cards += 1
            time.sleep(DELAY_BETWEEN_SETS)
            continue

        existing = fetch_existing_ids_for_set(language, set_code, set_name=set_name)

        creates = []
        updates = []
        seen_ids = set()      # dedupe within this set's batch
        for c in cards:
            row = pokedata_card_to_row(c, set_code, set_name, language)
            if not row:
                continue

            # Pop internal markers before writing to DB
            secret_hint = row.pop("_secret_hint", False)
            normalized_num = _normalize_card_num(row.get("card_number"))

            old = existing.get(normalized_num)
            if old is None:
                if args.no_create:
                    continue
                # New row — use the canonical id we built
                if secret_hint:
                    row["rarity"] = "Secret Rare"
                if row["id"] in seen_ids:
                    continue
                seen_ids.add(row["id"])
                creates.append(row)
            else:
                if args.no_update:
                    continue
                target_id = old["id"]
                if target_id in seen_ids:
                    continue   # multiple pokedata cards mapped to same row (alt art)
                seen_ids.add(target_id)

                # Detect legacy raw-tcg-id rows — these came from a pre-prefix
                # import (xy3-9, swsh11-145, etc.). For those we ONLY want to
                # update image data; the original name / set_name / card_number
                # are authoritative from pokemontcg.io. For en-* / jp-* / pd-*
                # rows (prefixed), update everything Pokedata has.
                is_legacy = not target_id.startswith(("en-", "jp-", "pd-"))

                # Behavior depends on whether the row is "legacy" (raw tcg id
                # like xy3-9 — originally imported from pokemontcg.io) or
                # "prefixed" (en-/jp-/pd- — managed by these sync scripts).
                #
                #   Prefixed rows  → trust Pokedata, overwrite everything
                #                     that differs (full sync).
                #   Legacy rows    → keep pokemontcg.io's authoritative data
                #                     intact, but FILL blanks if Pokedata has
                #                     them. Always swap image_url + capture
                #                     Pokedata's stats / id.
                if is_legacy:
                    always_overwrite = ("image_url", "pokedata_stats", "pokedata_id")
                    fill_if_blank    = ("name", "set_name", "rarity")
                else:
                    always_overwrite = ("name", "set_name", "set_code", "card_number",
                                        "image_url", "pokedata_stats", "pokedata_id")
                    fill_if_blank    = ()

                # Build patch starting from old's data — ensures NOT NULL
                # columns (notably `name`) carry through even when pokedata
                # has nothing new to say about them. Without this, supabase's
                # upsert tries to INSERT a row with null name → constraint
                # violation before ON CONFLICT can save us.
                patch = {k: v for k, v in old.items() if v is not None}
                patch["id"] = target_id   # always identify by existing id

                any_change = False

                # Pass 1: overwrite-allowed fields
                for fld in always_overwrite:
                    new_val = row.get(fld)
                    if new_val in (None, ""):
                        continue
                    if new_val == old.get(fld):
                        continue
                    patch[fld] = new_val
                    any_change = True

                # Pass 2: gap-fill — only set if old is null/empty
                for fld in fill_if_blank:
                    new_val = row.get(fld)
                    if new_val in (None, ""):
                        continue
                    if old.get(fld) not in (None, ""):
                        continue   # legacy already has data — preserve it
                    patch[fld] = new_val
                    any_change = True

                if secret_hint and not _str(old.get("rarity")):
                    patch["rarity"] = "Secret Rare"
                    any_change = True

                if any_change:
                    updates.append(patch)
                else:
                    total_unchanged += 1

        # Apply
        if args.dry_run:
            print(f"  [{set_idx}/{len(all_sets)}] {set_code:<10} {language} {set_name:<35} → "
                  f"{len(creates)} create, {len(updates)} update, {len(cards)-len(creates)-len(updates)} unchanged (dry)")
        else:
            c_written = upsert_rows(creates)
            u_written = upsert_rows(updates)
            print(f"  [{set_idx}/{len(all_sets)}] {set_code:<10} {language} {set_name:<35} → "
                  f"+{c_written} new, ~{u_written} updated")

        total_created += len(creates)
        total_updated += len(updates)
        time.sleep(DELAY_BETWEEN_SETS)

    print("\n" + "═" * 60)
    if args.dry_run:
        print(f"  Dry-run summary ({len(all_sets)} sets):")
        print(f"    Would create:  {total_created:,} new catalog rows")
        print(f"    Would update:  {total_updated:,} existing rows")
        print(f"    Unchanged:     {total_unchanged:,}")
        print(f"    Empty sets:    {total_no_cards}")
    else:
        print(f"  Sync done ({len(all_sets)} sets):")
        print(f"    Created:       {total_created:,} new rows")
        print(f"    Updated:       {total_updated:,} rows")
        print(f"    Unchanged:     {total_unchanged:,}")
        print(f"    Empty sets:    {total_no_cards}")
    print("═" * 60)


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --mirror-images   (and --check-images audit)
# ═════════════════════════════════════════════════════════════════════════════
STORAGE_BUCKET = "card-images"

# Per-TCG audit groups for --check-images. Pokemon JP rows can use either
# 'jp-' or 'pd-' prefixes depending on which sync ingested them, so we
# aggregate both into one bucket.
_IMAGE_AUDIT_GROUPS = [
    ("Pokemon EN",  ["en-"]),
    ("Pokemon JP",  ["jp-", "pd-"]),
    ("Magic",       ["mtg-"]),
    ("Yu-Gi-Oh",    ["ygo-"]),
    ("One Piece",   ["op-"]),
]


def _count_with_or(prefixes, extra_filter=None, sample_limit=0):
    """Count catalog rows matching id-prefix(es) and an optional image-state
    filter. extra_filter is one of: 'mirrored' (image_url has supabase.co),
    'pending' (has pokedata.io), 'missing' (NULL image_url), or None (total).
    Returns (count, sample_rows).

    We avoid `count='exact'` because COUNT(*) on the now-large catalog (~150K
    rows) routinely trips Supabase's 8s statement timeout while mirror runs
    are writing. Instead we paginate id+image_url rows and count client-side.
    Slower by a few seconds per call but never times out."""
    def _apply_filters(q):
        if len(prefixes) == 1:
            q = q.like("id", f"{prefixes[0]}%")
        else:
            ors = ",".join([f"id.like.{p}%" for p in prefixes])
            q = q.or_(ors)
        if extra_filter == "mirrored":
            q = q.like("image_url", "%supabase.co%")
        elif extra_filter == "pending":
            q = q.like("image_url", "%pokedata.io%")
        elif extra_filter == "missing":
            q = q.is_("image_url", "null")
        return q

    samples = []
    count   = 0
    offset  = 0
    PAGE    = 1000
    while True:
        q = sb.table("catalog").select("id, image_url")
        q = _apply_filters(q).range(offset, offset + PAGE - 1)
        try:
            res = q.execute()
        except Exception as e:
            print(f"    (page at offset {offset} failed: {e})")
            break
        chunk = res.data or []
        if not chunk:
            break
        count += len(chunk)
        if sample_limit and len(samples) < sample_limit:
            samples.extend(chunk[:max(0, sample_limit - len(samples))])
        if len(chunk) < PAGE:
            break
        offset += PAGE
    return count, samples


def mode_check_images():
    """Audit-only: report per-TCG image mirror status. Read-only, safe to
    run anytime. Useful after a long mirror run to see what's still
    outstanding before deciding whether to retry."""
    print("\nAuditing image mirror status across all TCGs…\n")

    groups = _IMAGE_AUDIT_GROUPS
    if args.tcg and args.tcg.lower() != "pokemon":
        # Filter to the matching group (by name substring)
        canon = canonical_tcg(args.tcg).lower()
        groups = [g for g in groups if canon in g[0].lower()
                  or g[0].lower().replace("-", "") in canon.replace("-", "")]
        if not groups:
            print(f"  No audit group matched --tcg '{args.tcg}'. Showing all.\n")
            groups = _IMAGE_AUDIT_GROUPS

    totals = {"total": 0, "mirrored": 0, "pending": 0, "missing": 0}

    header = f"  {'TCG':<14} {'total':>9}  {'mirrored':>14}  {'pending':>8}  {'missing':>8}"
    print(header)
    print("  " + "─" * (len(header) - 2))

    for label, prefixes in groups:
        total,    _ = _count_with_or(prefixes)
        mirrored, _ = _count_with_or(prefixes, "mirrored")
        pending,  pending_sample  = _count_with_or(prefixes, "pending",
                                                   sample_limit=(5 if args.verbose else 0))
        missing,  _ = _count_with_or(prefixes, "missing")
        pct = (mirrored / total * 100) if total > 0 else 0
        print(f"  {label:<14} {total:>9,}  {mirrored:>7,} ({pct:>5.1f}%)  {pending:>8,}  {missing:>8,}")
        totals["total"]    += total
        totals["mirrored"] += mirrored
        totals["pending"]  += pending
        totals["missing"]  += missing

        if args.verbose and pending_sample:
            for row in pending_sample:
                url = (row.get("image_url") or "")[:64]
                print(f"      sample pending: {row['id']:<28} {url}")

    print("  " + "─" * (len(header) - 2))
    pct_total = (totals["mirrored"] / totals["total"] * 100) if totals["total"] > 0 else 0
    print(f"  {'TOTAL':<14} {totals['total']:>9,}  {totals['mirrored']:>7,} ({pct_total:>5.1f}%)  {totals['pending']:>8,}  {totals['missing']:>8,}")

    if totals["pending"] > 0:
        print(f"\n  To retry pending images: python3 pokedata_sync.py --mirror-images")
    if totals["pending"] > 0 and any(g[0] in ('Magic','Yu-Gi-Oh','One Piece') for g in groups):
        print(f"  For permanent-404 stragglers: --mirror-images --fallback-source --tcg <game>")


def _has_non_ascii(s):
    """True if string contains any non-ASCII (e.g. Japanese kana/kanji) char."""
    return any(ord(c) > 127 for c in (s or ""))


def mode_probe_pending_urls():
    """HEAD-check a sample of pending pokedata.io URLs per set so we can
    tell apart 'this whole set is broken' (e.g. set_name='Garchomp Half
    Deck 2009' should be 'Garchomp Half Deck') from 'a few cards in this
    set are genuinely missing from pokedata' (e.g. high-number Sun & Moon
    promos that pokedata never indexed).

    Read-only. Pulls all pending rows, groups by (game-id-prefix, set_name),
    samples up to 5 URLs per set, HEAD-checks in parallel."""
    print("\nProbing pending pokedata URLs per set…\n")

    # 1. Pull pending rows
    rows = []
    offset = 0
    while True:
        try:
            res = sb.table("catalog") \
                .select("id, set_name, image_url") \
                .like("image_url", "%pokedata.io%") \
                .range(offset, offset + 999).execute()
        except Exception as e:
            print(f"  ✗ catalog read failed: {e}")
            return
        chunk = res.data or []
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000

    if not rows:
        print("  No pending rows. Nothing to probe.")
        return

    print(f"  {len(rows):,} pending rows total. Grouping by (game prefix, set_name)…")

    # 2. Group by (game prefix, set_name)
    from collections import defaultdict
    groups = defaultdict(list)
    for r in rows:
        rid = r.get("id", "")
        pfx = rid.split("-", 1)[0] if "-" in rid else "(none)"
        sn  = r.get("set_name") or "(null set_name)"
        groups[(pfx, sn)].append(r)

    print(f"  {len(groups):,} distinct sets with pending images.")

    # 3. Sample + HEAD-check in parallel
    workers = max(1, int(getattr(args, "workers", 5) or 5))
    SAMPLE_PER_SET = 5

    def _head(url):
        try:
            r = _session.head(url, timeout=10, allow_redirects=True)
            return r.status_code
        except Exception:
            return 0

    # Build a flat list of (group_key, row, url) probes
    probes = []
    for key, group_rows in groups.items():
        sample = group_rows[:SAMPLE_PER_SET]
        for r in sample:
            url = r.get("image_url") or ""
            if url:
                probes.append((key, r, url))

    print(f"  Probing {len(probes):,} URLs with {workers} parallel workers (HEAD requests)…\n")

    results = defaultdict(lambda: {"ok": 0, "fail": 0, "fail_codes": [], "ok_sample": "", "fail_sample": ""})
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        future_to_key = {ex.submit(_head, url): (key, row, url) for key, row, url in probes}
        for fut in as_completed(future_to_key):
            key, row, url = future_to_key[fut]
            code = fut.result()
            entry = results[key]
            if code == 200:
                entry["ok"] += 1
                if not entry["ok_sample"]:
                    entry["ok_sample"] = url[:80]
            else:
                entry["fail"] += 1
                entry["fail_codes"].append(code)
                if not entry["fail_sample"]:
                    entry["fail_sample"] = url[:80]
            done += 1
            if done % 50 == 0:
                print(f"    probed {done}/{len(probes)}")

    # 4. Report by category. Sort sets with all-fail first (most actionable).
    print(f"\n  ════════════════════════════════════")
    print(f"  Results by set (sample = {SAMPLE_PER_SET}):\n")
    all_fail   = []
    all_ok     = []
    mixed      = []
    for key, entry in results.items():
        pfx, sn = key
        total_in_set = len(groups[key])
        sampled      = entry["ok"] + entry["fail"]
        record = (pfx, sn, total_in_set, entry["ok"], entry["fail"], entry["fail_sample"] or entry["ok_sample"])
        if entry["ok"] == 0:
            all_fail.append(record)
        elif entry["fail"] == 0:
            all_ok.append(record)
        else:
            mixed.append(record)

    if all_fail:
        print(f"  ✗ Sets where ALL sampled URLs failed ({len(all_fail)} sets — likely wrong set_name or pokedata removed the set):")
        all_fail.sort(key=lambda x: -x[2])  # sort by pending count desc
        for pfx, sn, total, ok, fail, sample in all_fail:
            print(f"     [{pfx:<4}] {sn:<40} pending: {total:>6,}   sample: {sample}")
        print()

    if mixed:
        print(f"  ◇ Sets with mixed results ({len(mixed)} sets — set exists but individual cards missing):")
        mixed.sort(key=lambda x: -x[2])
        for pfx, sn, total, ok, fail, sample in mixed[:20]:
            print(f"     [{pfx:<4}] {sn:<40} pending: {total:>6,}   sample {ok} ok / {fail} fail")
        if len(mixed) > 20:
            print(f"     … and {len(mixed) - 20} more mixed sets")
        print()

    if all_ok:
        print(f"  ✓ Sets where all sampled URLs returned 200 ({len(all_ok)} sets — should re-mirror cleanly):")
        all_ok.sort(key=lambda x: -x[2])
        for pfx, sn, total, ok, fail, sample in all_ok[:10]:
            print(f"     [{pfx:<4}] {sn:<40} pending: {total:>6,}")
        if len(all_ok) > 10:
            print(f"     … and {len(all_ok) - 10} more")
        print()

    print(f"  ════════════════════════════════════")
    if all_fail:
        broken_pending = sum(r[2] for r in all_fail)
        print(f"  {broken_pending:,} pending rows live in sets with all-failing URLs.")
        print(f"  Recommended actions:")
        print(f"    - For Pokemon sets with wrong set_name: fix the catalog set_name and re-run mirror.")
        print(f"    - For non-Pokemon (mtg/ygo/op): clear image_url and use --mirror-images --fallback-source.")
    if all_ok:
        ok_pending = sum(r[2] for r in all_ok)
        print(f"  {ok_pending:,} pending rows are in healthy sets — re-running --mirror-images should sweep them.")


def mode_diagnose_jp_legacy():
    """Find and optionally clean up legacy JP Pokemon catalog rows.

    A "legacy" row is one ingested by an old scraper (pre-Pokedata sync)
    that left behind:
      - NULL image_url   (no image was ever attached)
      - non-ASCII set_name (Japanese characters that never got translated)

    These rows are typically orphans — created during testing or an early
    scrape and never re-touched by the canonical pokedata_sync flow. Most
    of them are not referenced by any user's collection_items, in which case
    they can be safely deleted. The next `--tcg Pokemon --language JA` run
    will re-create them with proper translated set names and image URLs.

    Read-only by default. Pass --confirm to actually delete orphans."""
    print("\nDiagnosing legacy JP catalog rows…\n")

    # 1. Pull every JP-prefixed row with NULL image_url
    rows = []
    offset = 0
    while True:
        try:
            res = sb.table("catalog") \
                .select("id, name, set_name, set_code, card_number") \
                .or_("id.like.jp-%,id.like.pd-%") \
                .is_("image_url", "null") \
                .range(offset, offset + 999) \
                .execute()
        except Exception as e:
            print(f"  ✗ catalog read failed: {e}")
            return
        chunk = res.data or []
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000

    print(f"  JP rows with NULL image_url:         {len(rows):,}")

    # 2. Of those, how many have non-ASCII set_name (the legacy signature)
    legacy = [r for r in rows if _has_non_ascii(r.get("set_name") or "")]
    legacy_with_name = [r for r in legacy if r.get("name")]
    print(f"  Of those, with non-ASCII set_name:   {len(legacy):,}  (legacy old-scrape signature)")
    print(f"  Of those, with card name populated:  {len(legacy_with_name):,}")

    if not legacy:
        print(f"\n  Nothing to clean up — no rows match the legacy pattern.")
        return

    # 3. Sample a few so the user can eyeball them
    print(f"\n  Sample legacy rows:")
    for r in legacy[:8]:
        sn = (r.get("set_name") or "")[:40]
        nm = (r.get("name") or "")[:30]
        print(f"    {r['id']:<28}  set_name={sn:<42}  name={nm}")

    # 4. Check which are referenced by user collections.
    # We chunk the IN clause because PostgREST has a URL length limit.
    ids = [r["id"] for r in legacy]
    referenced = set()
    for i in range(0, len(ids), 200):
        chunk_ids = ids[i:i+200]
        try:
            res = sb.table("collection_items") \
                .select("api_card_id") \
                .in_("api_card_id", chunk_ids) \
                .execute()
            for row in (res.data or []):
                if row.get("api_card_id"):
                    referenced.add(row["api_card_id"])
        except Exception as e:
            print(f"  ⚠ collection_items check failed for chunk {i//200}: {e}")

    orphans  = [r for r in legacy if r["id"] not in referenced]
    in_use   = [r for r in legacy if r["id"] in referenced]
    print(f"\n  Of {len(legacy):,} legacy rows:")
    print(f"    Orphaned (safe to delete):         {len(orphans):,}")
    print(f"    Referenced by collection_items:    {len(in_use):,}")

    if in_use:
        print(f"\n  Referenced rows (cannot auto-delete — manual review):")
        for r in in_use[:5]:
            print(f"    {r['id']:<28}  {(r.get('set_name') or '')[:40]}")

    if not args.confirm:
        print(f"\n  Read-only. To delete the {len(orphans):,} orphaned rows, re-run with --confirm.")
        print(f"  Note: the next `--tcg Pokemon --language JA` sync will re-create them properly.")
        return

    if not orphans:
        print(f"\n  No orphans to delete.")
        return

    # 5. Delete in chunks
    print(f"\n  Deleting {len(orphans):,} orphan rows in chunks of 200…")
    deleted = 0
    errors  = 0
    for i in range(0, len(orphans), 200):
        chunk_ids = [r["id"] for r in orphans[i:i+200]]
        try:
            sb.table("catalog").delete().in_("id", chunk_ids).execute()
            deleted += len(chunk_ids)
            print(f"    {deleted}/{len(orphans)}")
        except Exception as e:
            errors += len(chunk_ids)
            print(f"    ✗ chunk {i//200} failed: {e}")
    print(f"\n  Done: deleted {deleted:,}, errors {errors:,}")
    print(f"  Next step: python3 pokedata_sync.py --tcg Pokemon --language JA")


# ─────────────────────────────────────────────────────────────────────────────
# Fallback image sources (per-TCG canonical APIs)
# ─────────────────────────────────────────────────────────────────────────────
# Used by --mirror-images --fallback-source for rows where pokedata 404s
# permanently. Each returns a usable HTTPS image URL or None.

def _fallback_image_mtg(set_code, card_number):
    """Scryfall: GET /cards/{set}/{collector_number}. Returns normal-size PNG."""
    try:
        url = f"https://api.scryfall.com/cards/{set_code.lower()}/{card_number}"
        r = _session.get(url, timeout=20)
        if r.status_code != 200:
            return None
        data = r.json()
        imgs = data.get("image_uris") or {}
        return imgs.get("normal") or imgs.get("large") or imgs.get("png") or None
    except Exception:
        return None


def _fallback_image_ygo(name, set_code, card_number):
    """YGOPRODeck images are keyed by numeric card id, not set+number. We
    look up by name with set filter, then use the card's id to construct
    the canonical image URL."""
    if not name:
        return None
    try:
        r = _session.get("https://db.ygoprodeck.com/api/v7/cardinfo.php",
                        params={"fname": name}, timeout=20)
        if r.status_code != 200:
            return None
        cards = r.json().get("data") or []
        # If multiple cards match the fuzzy name, prefer the one whose
        # card_sets includes our set_code.
        best = None
        for c in cards:
            for p in (c.get("card_sets") or []):
                code = str(p.get("set_code", ""))
                if set_code and code.lower().startswith(set_code.lower() + "-"):
                    best = c
                    break
            if best:
                break
        chosen = best or (cards[0] if cards else None)
        if not chosen:
            return None
        cid = chosen.get("id")
        if not cid:
            return None
        return f"https://images.ygoprodeck.com/images/cards/{cid}.jpg"
    except Exception:
        return None


def _fallback_image_op(name, set_code, card_number):
    """apitcg One Piece. Catalog OP rows store card_number as the FULL
    card code already (e.g. 'EB01-001'), so target_code is just an
    upper-cased copy. set_code is sometimes 'eb-01' or 'op01' depending
    on which sync ingested the row — we don't actually need it to match
    apitcg's 'code' field, only the card_number portion."""
    api_key = os.environ.get("APITCG_API_KEY")
    if not api_key or not name:
        return None
    target_code = (card_number or "").upper()
    if not target_code:
        return None
    try:
        r = _session.get("https://www.apitcg.com/api/one-piece/cards",
                        params={"name": name}, timeout=20,
                        headers={"x-api-key": api_key, "Accept": "application/json"})
        if r.status_code != 200:
            return None
        cards = (r.json().get("data") or [])
        chosen = None
        for c in cards:
            if str(c.get("code", "")).upper() == target_code:
                chosen = c
                break
        chosen = chosen or (cards[0] if cards else None)
        if not chosen:
            return None
        imgs = chosen.get("images") or {}
        return imgs.get("large") or imgs.get("small") or chosen.get("image_url") or None
    except Exception:
        return None


def _resolve_fallback_image(row):
    """Dispatch to the right fallback source based on the row's id prefix.
    Returns a usable image URL or None."""
    rid = row.get("id") or ""
    name      = str(row.get("name") or "").strip()
    set_code  = str(row.get("set_code") or "").strip()
    card_num  = str(row.get("card_number") or "").strip()

    # When name/set_code/card_number are null, derive set+num from the id.
    if not set_code or not card_num:
        for pfx in ("mtg", "ygo", "op"):
            if rid.startswith(pfx + "-"):
                sc_id, num_id = _split_id(rid, pfx)
                if not set_code: set_code = sc_id.split("-")[0]   # leading segment
                if not card_num: card_num = num_id
                break

    if rid.startswith("mtg-"):
        return _fallback_image_mtg(set_code, card_num)
    if rid.startswith("ygo-"):
        return _fallback_image_ygo(name, set_code, card_num)
    if rid.startswith("op-"):
        return _fallback_image_op(name, set_code, card_num)
    return None


def mode_mirror_images():
    """Walk every catalog row whose image_url still points off-Supabase
    (i.e. at pokemoncardimages.pokedata.io). Download the image, upload
    to Supabase Storage, rewrite image_url to the Supabase public URL.

    Idempotent — skips rows already on supabase.co, so re-running picks
    up from where a previous run left off (if interrupted).

    Storage layout:
        card-images/jp/{set_code_lower}/{card_number}.webp
        card-images/en/{set_code_lower}/{card_number}.webp
    """
    print("\nLoading catalog rows with off-Supabase images…")

    rows = []
    offset = 0
    # Pull anything with an image_url that's NOT already on supabase.co.
    # `like` with %pokedata.io% is the most reliable filter (we know that's
    # the source) — if other CDNs need mirroring later, broaden the filter.
    # If --tcg is set, scope the mirror to that game so parallel terminals
    # (one per TCG) don't race on the same rows. Use id-prefix matching
    # because game_type isn't populated on every legacy row.
    tcg_prefix = None
    if args.tcg:
        canon = canonical_tcg(args.tcg).lower()
        if canon in ("pokemon", "pokémon"):
            tcg_prefix = "POKEMON"   # sentinel — handled below
        elif canon in ("magic", "mtg", "magic the gathering"):
            tcg_prefix = "mtg-"
        elif canon in ("yugioh", "yu-gi-oh", "yu-gi-oh!", "ygo"):
            tcg_prefix = "ygo-"
        elif canon in ("one piece", "onepiece", "op"):
            tcg_prefix = "op-"
        if tcg_prefix:
            print(f"  Scoping mirror to --tcg '{args.tcg}' (id prefix: {tcg_prefix})")

    # When --fallback-source is set, we also include rows whose image_url
    # is NULL (never had a pokedata URL) because the canonical APIs can
    # often fill those too.
    while True:
        q = (sb.table("catalog")
             .select("id,image_url,set_code,card_number,name"))
        if getattr(args, "fallback_source", False):
            # Either still on pokedata, OR null → fall back to canonical source
            q = q.or_("image_url.like.%pokedata.io%,image_url.is.null")
        else:
            q = q.like("image_url", "%pokedata.io%")
        # Per-TCG scoping
        if tcg_prefix == "POKEMON":
            # Pokemon rows are en-/jp-/pd- prefixed OR legacy raw ids (no prefix)
            # We let --language / --legacy-only narrow this further; without them,
            # exclude non-Pokemon prefixes explicitly.
            q = q.not_.like("id", "mtg-%").not_.like("id", "ygo-%").not_.like("id", "op-%")
        elif tcg_prefix:
            q = q.like("id", f"{tcg_prefix}%")
        if args.language == "JA":
            q = q.like("id", "jp-%")
        elif args.language == "EN":
            q = q.like("id", "en-%")
        if args.legacy_only:
            # Exclude every known prefix → leaves legacy raw-tcg-id rows
            # (xy3-9, swsh11-145, etc.) Note: postgrest supports `not.like`.
            q = q.not_.like("id", "jp-%").not_.like("id", "en-%").not_.like("id", "pd-%")
        if args.only:
            q = q.ilike("set_code", args.only)
        q = q.range(offset, offset + 999)
        res = q.execute()
        chunk = res.data or []
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000

    if args.limit:
        rows = rows[:args.limit]

    # Quick sanity check — show distribution of id prefixes so the user can
    # visually confirm the scope (catches accidentally-broad runs).
    if rows:
        prefix_counts = {}
        for r in rows:
            rid = r.get("id", "")
            p = rid.split("-", 1)[0] if "-" in rid else "(none)"
            prefix_counts[p] = prefix_counts.get(p, 0) + 1
        top = sorted(prefix_counts.items(), key=lambda kv: -kv[1])[:6]
        print(f"  id-prefix breakdown: {', '.join(f'{p}={n}' for p, n in top)}")

    print(f"  {len(rows):,} rows to mirror")
    if not rows:
        return

    # Estimate size before committing (so the user knows what's coming)
    avg_size_kb = 75
    total_mb = (len(rows) * avg_size_kb) / 1024
    print(f"  Estimated transfer: ~{total_mb:.0f} MB (avg {avg_size_kb}KB/img)")
    print(f"  Estimated time:     ~{(len(rows) * 0.15)/60:.0f} min at 150ms/card")
    if not args.dry_run:
        print(f"  Starting in 3s — Ctrl+C to abort\n")
        time.sleep(3)

    # Dry-run stays sequential — it's just previewing the first few
    if args.dry_run:
        mirrored_dry = 0
        skipped_dry  = 0
        for i, row in enumerate(rows, 1):
            url      = _str(row.get("image_url"))
            set_code = _str(row.get("set_code")).lower()
            card_num = _str(row.get("card_number"))
            if not (url and set_code and card_num):
                skipped_dry += 1
                continue
            lang_prefix = "jp" if row["id"].startswith(("jp-", "pd-")) else "en"
            storage_path = f"{lang_prefix}/{set_code}/{card_num}.webp"
            if i <= 5:
                print(f"  [{i}/{len(rows)}] {row['id']:<24} {url[:60]}... → {storage_path}")
            mirrored_dry += 1
        print(f"\n  ════════════════════════════════════")
        print(f"  Mirror dry-run:")
        print(f"    Would mirror: {mirrored_dry:,}")
        print(f"    Skipped:      {skipped_dry:,}")
        print(f"  ════════════════════════════════════")
        return

    # Real run — parallelize via ThreadPoolExecutor. Each worker handles
    # one card end-to-end (download → upload → DB update). All HTTP calls
    # are stateless and thread-safe in the supabase/requests clients.
    workers = max(1, int(getattr(args, "workers", 5) or 5))
    print(f"  Running with {workers} parallel workers")

    _print_lock   = threading.Lock()
    _counter_lock = threading.Lock()
    stats = {"mirrored": 0, "failed": 0, "skipped": 0, "completed": 0}

    def _mirror_one(row):
        rid       = row["id"]
        url       = _str(row.get("image_url"))
        set_code  = _str(row.get("set_code")).lower()
        card_num  = _str(row.get("card_number"))

        # Storage path = top-level by game/language. Pokemon stays under
        # jp/ or en/ (existing convention). Non-Pokemon games use their
        # id prefix (mtg/, ygo/, op/, etc.) — same prefix that goes on
        # catalog ids, so storage organization mirrors the catalog.
        if rid.startswith(("jp-", "pd-")):
            top = "jp"
        elif rid.startswith("en-"):
            top = "en"
        else:
            top = rid.split("-", 1)[0] if "-" in rid else "misc"

        # When set_code or card_num is null on the row, derive from id so we
        # can still build a deterministic storage path. Critical for fallback
        # mode where many rows have null columns.
        if not (set_code and card_num):
            sc_id, num_id = _split_id(rid, top) if top in ("mtg","ygo","op") else ("","")
            if not set_code: set_code = (sc_id.split("-")[0] or "misc").lower()
            if not card_num: card_num = num_id or rid.rsplit("-", 1)[-1]

        if not (set_code and card_num):
            return (rid, "skipped", "missing set_code / card_number even after id parse")

        storage_path = f"{top}/{set_code}/{card_num}.webp"

        # 1. Resolve source URL. Fallback mode uses the canonical API per TCG.
        # Regular mode uses whatever was on the row (pokedata).
        if getattr(args, "fallback_source", False):
            url = _resolve_fallback_image(row)
            if not url:
                return (rid, "failed", "fallback source returned no URL")

        if not url:
            return (rid, "skipped", "no image URL to fetch")

        # 2. Download
        try:
            r = _session.get(url, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            img_bytes = r.content
            if not img_bytes:
                return (rid, "failed", "download: empty body")
        except Exception as e:
            return (rid, "failed", f"download: {e}")

        # 2. Upload to Supabase Storage (upsert; retry on transient failures)
        last_err = None
        for upload_attempt in range(3):
            try:
                sb.storage.from_(STORAGE_BUCKET).upload(
                    storage_path, img_bytes,
                    file_options={"content-type": "image/webp", "upsert": "true"}
                )
                last_err = None
                break
            except Exception as e:
                last_err = e
                if upload_attempt < 2:
                    time.sleep(2 * (upload_attempt + 1))   # 2s, 4s
        if last_err is not None:
            return (row["id"], "failed", f"upload: {last_err}")
        new_url = f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{storage_path}"

        # 3. Rewrite catalog row's image_url
        try:
            sb.table("catalog").update({"image_url": new_url}).eq("id", row["id"]).execute()
        except Exception as e:
            return (row["id"], "failed", f"db: {e}")
        return (row["id"], "mirrored", "")

    total = len(rows)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(_mirror_one, row) for row in rows]
        for fut in as_completed(futures):
            cat_id, status, msg = fut.result()
            with _counter_lock:
                stats["completed"] += 1
                stats[status] += 1
                done = stats["completed"]
                m, f, s = stats["mirrored"], stats["failed"], stats["skipped"]
            if status == "failed":
                with _print_lock:
                    print(f"  ⚠ {cat_id} {msg}")
            if done % 100 == 0:
                with _print_lock:
                    print(f"  [{done:>5}/{total}]  mirrored:{m:<6}  failed:{f:<4}  skipped:{s}")

    print(f"\n  ════════════════════════════════════")
    print(f"  Mirror done ({workers} workers):")
    print(f"    Mirrored: {stats['mirrored']:,}")
    print(f"    Failed:   {stats['failed']:,}")
    print(f"    Skipped:  {stats['skipped']:,}")
    print(f"  ════════════════════════════════════")


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --enrich-rarity
# ═════════════════════════════════════════════════════════════════════════════
# Backfills catalog.rarity for non-Pokemon TCGs from the corresponding free
# public API. Idempotent: by default only fills rows where rarity is NULL.
# Pass --reenrich to overwrite existing rarities (rare; usually you want NULL-fill).
#
# Sources per game:
#   Magic     → Scryfall bulk data (one JSON download, ~100MB)
#   Yu-Gi-Oh  → YGOPRODeck cardinfo.php (all cards in one response, ~50MB)
#   One Piece → apitcg.com /one-piece/cards (paginated)

def _fetch_catalog_rows_missing_rarity(prefix):
    """Pull every catalog row with the given id prefix that has no rarity yet."""
    rows = []
    offset = 0
    while True:
        q = sb.table("catalog").select("id, name, set_code, card_number, rarity") \
              .like("id", f"{prefix}-%")
        if not args.reenrich:
            q = q.is_("rarity", "null")
        q = q.range(offset, offset + 999)
        try:
            res = q.execute()
        except Exception as e:
            print(f"  ⚠ catalog read failed: {e}")
            break
        chunk = res.data or []
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000
    return rows


def _norm_num(s):
    """Normalize card numbers for matching. '011' → '11', 'T-1' stays 'T-1'.
    Both sides of a match call this."""
    if s is None:
        return ""
    s = str(s).strip()
    if not s:
        return ""
    try:
        return str(int(s))
    except ValueError:
        return s


def _split_id(id_str, prefix):
    """Derive (set_code_lower, card_num) from a catalog id of the form
    '{prefix}-{set_code}-{card_num}'. set_code may contain dashes; we always
    treat the LAST dash-separated segment as the card number. Returns
    ('', '') if the id doesn't match the expected prefix."""
    if not id_str or not id_str.startswith(prefix + "-"):
        return "", ""
    rest = id_str[len(prefix) + 1:]
    if "-" not in rest:
        return "", rest
    set_lower, _, num = rest.rpartition("-")
    return set_lower.lower(), num


def _build_mtg_rarity_index():
    """Download Scryfall's default_cards bulk JSON. Returns
    { (set_code_lower, collector_number_norm): rarity_titlecase }."""
    print("  Fetching Scryfall bulk-data manifest…")
    try:
        manifest = _session.get("https://api.scryfall.com/bulk-data", timeout=30).json()
    except Exception as e:
        print(f"  ✗ Scryfall manifest fetch failed: {e}")
        return {}
    entry = next((b for b in manifest.get("data", []) if b.get("type") == "default_cards"), None)
    if not entry:
        print("  ✗ Scryfall default_cards entry missing from manifest")
        return {}
    url = entry["download_uri"]
    size_mb = (entry.get("size") or 0) / 1024 / 1024
    print(f"  Downloading Scryfall default_cards (~{size_mb:.0f}MB)…")
    try:
        data = _session.get(url, timeout=300).json()
    except Exception as e:
        print(f"  ✗ Scryfall bulk download failed: {e}")
        return {}
    print(f"  Got {len(data):,} Scryfall cards — building index")
    idx = {}
    for c in data:
        sc  = str(c.get("set", "")).lower()
        num = _norm_num(c.get("collector_number", ""))
        rar = c.get("rarity", "")
        if sc and num and rar:
            # Scryfall returns lowercase ('common','uncommon','rare','mythic') —
            # title-case to match the existing catalog convention.
            idx[(sc, num)] = rar.title() if rar != "mythic" else "Mythic Rare"
    return idx


    # Known YGO region prefixes used at the start of card-set codes.
    # Listing them explicitly avoids stripping 'SP' from 'SP1' or 'TG' from
    # 'TG01' (those aren't regions, they're real id parts).
_YGO_REGION_PREFIXES = ("EN", "JP", "KR", "DE", "FR", "IT", "ES", "PT", "EU", "CH", "TC", "SC", "CT", "AE", "RU")

def _ygo_normalize_num(num_part):
    """YGO card-number normalizer. Catalog stores 'TDGS-ENSP1' or 'TDGS-EN040'.
    YGOPRODeck stores the same identifiers. We want the SAME stripped form
    on both sides so the keys match. Rule: strip exactly the known region
    prefix when one is present, then int-normalize what's left if numeric.

    Examples:
      'EN040'  → '040' → '40'
      'JP012'  → '012' → '12'
      'ENSP1'  → 'SP1' (region EN stripped; SP1 kept as-is — promo / special)
      'SP1'    → 'SP1' (no region — keep intact, would have been wrong to strip)
      '001'    → '1'   (no region prefix, numeric → int-normalized)
    """
    s = str(num_part or "")
    for r in _YGO_REGION_PREFIXES:
        if s.startswith(r) and len(s) > len(r):
            s = s[len(r):]
            break
    return _norm_num(s)


def _build_ygo_rarity_index():
    """Pull all YGO cards from YGOPRODeck. Returns
    { (set_code_lower, number_norm): rarity }. Catalog YGO rows often have
    null name, so we key by (set, num) only — derivable from the id."""
    print("  Fetching YGOPRODeck cardinfo (full DB, ~50MB)…")
    try:
        resp = _session.get("https://db.ygoprodeck.com/api/v7/cardinfo.php", timeout=120).json()
    except Exception as e:
        print(f"  ✗ YGOPRODeck fetch failed: {e}")
        return {}
    cards = resp.get("data") or []
    print(f"  Got {len(cards):,} YGO cards — building index")
    idx = {}
    sample_set_codes = []  # for diagnostics
    for c in cards:
        for p in c.get("card_sets") or []:
            full = str(p.get("set_code", ""))   # e.g. 'LOB-EN001' or 'LOB-001'
            rar  = p.get("set_rarity", "")
            if not full or not rar or "-" not in full:
                continue
            if len(sample_set_codes) < 8:
                sample_set_codes.append(full)
            set_pref, _, num_part = full.rpartition("-")
            num_norm = _ygo_normalize_num(num_part)
            if set_pref and num_norm:
                idx.setdefault((set_pref.lower(), num_norm), rar)
    print(f"  YGOPRODeck sample set_codes: {sample_set_codes}")
    if idx:
        print(f"  Index sample keys: {list(idx.keys())[:8]}")
    return idx


def _build_op_rarity_index(catalog_rows):
    """For One Piece, apitcg now REQUIRES an API key (free tier closed).
    Set APITCG_API_KEY in your environment and we'll send it as `x-api-key`.
    Without a key we probe once, detect the auth-required response, and
    skip the run cleanly. Returns { (set_code_lower, number_norm): rarity }."""
    print("  Building OP rarity index from apitcg…")
    api_key = os.environ.get("APITCG_API_KEY")

    # Quick probe to confirm we can reach the API with what we have.
    headers = {"User-Agent": "PathBinder/1.0", "Accept": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    try:
        probe = _session.get("https://www.apitcg.com/api/one-piece/cards",
                            params={"name": "Luffy"}, timeout=15, headers=headers)
        probe_body = probe.text[:200]
    except Exception as e:
        print(f"  ✗ apitcg unreachable: {e}")
        return {}
    if probe.status_code in (401, 403) or "API key is required" in probe_body:
        print(f"  ✗ apitcg requires an API key now (free tier closed).")
        print(f"    1) Sign up at https://apitcg.com/platform")
        print(f"    2) Re-run with APITCG_API_KEY=your_key python3 pokedata_sync.py --enrich-rarity --tcg 'One Piece'")
        return {}
    if probe.status_code != 200:
        print(f"  ✗ apitcg probe returned {probe.status_code}: {probe_body}")
        return {}

    # Probe succeeded — dump the response shape so we can confirm field names.
    # This prints once, then we move on. If parsing produces 0 results below
    # you can adjust _ingest() to match what's actually returned.
    print(f"  apitcg probe sample (first 400 chars):")
    print(f"    {probe_body[:400]}")
    try:
        probe_json = probe.json()
        first_list = probe_json.get("data") or probe_json.get("cards") or (probe_json if isinstance(probe_json, list) else [])
        if first_list:
            print(f"  First card keys: {sorted(list(first_list[0].keys()))[:25]}")
            sample = first_list[0]
            print(f"  Sample values: name='{sample.get('name')}', code='{sample.get('code')}', rarity='{sample.get('rarity')}', set_code='{sample.get('set_code')}', set={sample.get('set')}")
    except Exception as _:
        pass

    idx = {}
    workers = max(1, int(getattr(args, "workers", 5) or 5))

    name_set = set()
    for r in catalog_rows:
        n = str(r.get("name") or "").strip()
        if n:
            name_set.add(n)

    def _ingest(cards):
        """Walk a list of apitcg one-piece card dicts, populate idx.
        apitcg's response has 'code' like 'ST14-001' or 'OP01-075' — that's
        the canonical set+num identifier. No separate set_code is returned,
        so we parse it out of 'code' directly. Catalog ids look like
        'op-st14-001' so the set portion lowercased matches cleanly."""
        for c in cards:
            code = str(c.get("code") or "").strip()
            rar  = (c.get("rarity") or "").strip()
            if not code or not rar or "-" not in code:
                continue
            sc, _, num = code.rpartition("-")
            sc  = sc.lower()
            num = _norm_num(num)
            if sc and num:
                idx.setdefault((sc, num), rar)

    def _fetch_by_name(name):
        try:
            r = _session.get("https://www.apitcg.com/api/one-piece/cards",
                            params={"name": name}, timeout=20, headers=headers)
            if r.status_code != 200:
                return []
            data = r.json()
            return data.get("data") or data.get("cards") or (data if isinstance(data, list) else [])
        except Exception:
            return []

    name_list = sorted(name_set)
    done = 0
    print(f"  Querying apitcg for {len(name_list):,} unique names ({workers} workers, key: {'yes' if api_key else 'NO'})…")
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_fetch_by_name, n) for n in name_list]
        for fut in as_completed(futs):
            _ingest(fut.result())
            done += 1
            if done % 100 == 0:
                print(f"    {done}/{len(name_list)} names  ·  index size: {len(idx)}")
    return idx


def _match_rarity(row, prefix, idx):
    """Look up a rarity for one catalog row. Prefers explicit column values
    when present; falls back to parsing the id when name/set_code are null
    (the common case for non-Pokemon rows ingested by pokedata_sync).

    YGO needs its own card_number parsing because pokedata stores the full
    card code ('TDGS-ENSP1') in card_number — we have to extract the trailing
    portion and strip the region prefix the same way YGOPRODeck does."""
    # YGO-specific path
    if prefix == "ygo":
        sc_col = str(row.get("set_code") or "").lower()
        sc_id, num_id = _split_id(row["id"], "ygo")
        # Catalog id is 'ygo-{setcode}-{full_card_code}'. First segment of
        # what's between the prefix and the last '-' is the actual set abbrev
        # (pokedata sometimes duplicates the set, e.g. 'ygo-tdgs-TDGS-ENSP1'
        # gives sc_id='tdgs-tdgs' — take the leading piece).
        sc_id_first = sc_id.split("-")[0] if sc_id else ""
        sc = sc_col or sc_id_first
        # card_number column holds the full card code (e.g. 'TDGS-ENSP1').
        # Fall back to the trailing segment of the id if the column is null.
        raw_num = str(row.get("card_number") or "") or num_id
        if "-" in raw_num:
            raw_num = raw_num.rsplit("-", 1)[-1]
        num = _ygo_normalize_num(raw_num)
        if not (sc and num):
            return None
        return idx.get((sc, num))

    # Default path (MTG, OP, future games)
    sc_col   = str(row.get("set_code") or "").lower()
    num_col  = _norm_num(row.get("card_number") or "")
    sc_id, num_id = _split_id(row["id"], prefix)
    sc  = sc_col or sc_id
    num = num_col or _norm_num(num_id)
    if not num:
        return None
    return idx.get((sc, num)) or idx.get((sc_id, _norm_num(num_id)))


def mode_enrich_rarity():
    """Backfill catalog.rarity for non-Pokemon TCGs."""
    tcgs_to_run = [args.tcg] if args.tcg and args.tcg.lower() != "pokemon" else \
                  ["Magic", "Yugioh", "One Piece"]
    for tcg in tcgs_to_run:
        prefix = get_id_prefix(tcg)
        if prefix not in ("mtg", "ygo", "op"):
            print(f"\nSkipping {tcg} — no rarity source wired (prefix: {prefix})")
            continue

        print(f"\n══ Enriching {tcg} (prefix: {prefix}-) ══")
        rows = _fetch_catalog_rows_missing_rarity(prefix)
        print(f"  {len(rows):,} catalog rows need rarity")
        if not rows:
            continue

        # Diagnostic: show a few catalog row ids and what we derive from them.
        # Helps confirm the key shape matches the index we're about to build.
        sample = rows[:5]
        print(f"  Sample catalog rows:")
        for r in sample:
            sc_col   = (r.get("set_code") or "").lower()
            num_col  = _norm_num(r.get("card_number") or "")
            sc_id, num_id = _split_id(r["id"], prefix)
            print(f"    id={r['id']:<30} set_col={sc_col or '-':<12} num_col={num_col or '-':<8} set_id={sc_id or '-':<12} num_id={_norm_num(num_id) or '-'}")

        # Build the per-game lookup index
        if prefix == "mtg":
            idx = _build_mtg_rarity_index()
        elif prefix == "ygo":
            idx = _build_ygo_rarity_index()
        elif prefix == "op":
            idx = _build_op_rarity_index(rows)

        if not idx:
            print(f"  ✗ Empty index — skipping {tcg}")
            continue

        # Match + collect updates
        updates = []
        unmatched = 0
        for r in rows:
            rar = _match_rarity(r, prefix, idx)
            if rar:
                updates.append({"id": r["id"], "rarity": rar})
            else:
                unmatched += 1
        print(f"  Matched {len(updates):,} / {len(rows):,} rows  (unmatched: {unmatched:,})")

        if args.dry_run:
            print(f"  Dry-run — sample first 5:")
            for u in updates[:5]:
                print(f"    {u['id']} → {u['rarity']}")
            continue

        if not updates:
            continue

        # Per-row UPDATE parallelized. We use UPDATE (not UPSERT) because the
        # catalog has a NOT NULL constraint on `name` and many non-Pokemon
        # rows have null name — an upsert would re-attempt INSERT on conflict
        # and fail the NOT NULL check. UPDATE only touches the rarity column.
        write_workers = max(1, int(getattr(args, "workers", 5) or 5))
        print(f"  Writing {len(updates):,} rarity updates ({write_workers} workers)…")

        def _apply_one(item):
            try:
                sb.table("catalog").update({"rarity": item["rarity"]}).eq("id", item["id"]).execute()
                return True
            except Exception as e:
                return str(e)

        written = 0
        errors  = 0
        sample_errs = []
        with ThreadPoolExecutor(max_workers=write_workers) as ex:
            futs = [ex.submit(_apply_one, u) for u in updates]
            for fut in as_completed(futs):
                result = fut.result()
                if result is True:
                    written += 1
                else:
                    errors += 1
                    if len(sample_errs) < 3:
                        sample_errs.append(result)
                done = written + errors
                if done % 500 == 0:
                    print(f"    {done:,}/{len(updates):,}  (wrote: {written:,}, errors: {errors:,})")
        for s in sample_errs:
            print(f"    sample err: {s[:200]}")
        print(f"  Done: wrote {written:,}, errors {errors:,}")


# ═════════════════════════════════════════════════════════════════════════════
# DISPATCH
# ═════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    if args.probe:
        mode_probe()
    elif args.list_sets:
        mode_list_sets()
    elif args.check_images:
        mode_check_images()
    elif args.diagnose_jp_legacy:
        mode_diagnose_jp_legacy()
    elif args.probe_pending_urls:
        mode_probe_pending_urls()
    elif args.mirror_images:
        mode_mirror_images()
    elif args.enrich_rarity:
        mode_enrich_rarity()
    else:
        main_sync()
