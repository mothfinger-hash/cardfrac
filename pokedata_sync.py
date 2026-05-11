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
args = parser.parse_args()


# ═════════════════════════════════════════════════════════════════════════════
# SUPABASE
# ═════════════════════════════════════════════════════════════════════════════
sb = create_client(SUPABASE_URL, SUPABASE_KEY)
try:
    res = sb.table("catalog").select("id", count="exact").limit(1).execute()
    print(f"✓ Supabase connected — catalog has {res.count:,} rows")
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
    """Upsert in batches with on_conflict='id'. Returns count written."""
    if not rows or args.dry_run:
        return 0
    written = 0
    for i in range(0, len(rows), UPSERT_BATCH):
        chunk = rows[i:i+UPSERT_BATCH]
        try:
            sb.table("catalog").upsert(chunk, on_conflict="id").execute()
            written += len(chunk)
        except Exception as e:
            print(f"    ✗ Upsert error: {e}")
    return written


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
# MODE: --mirror-images
# ═════════════════════════════════════════════════════════════════════════════
STORAGE_BUCKET = "card-images"

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

    while True:
        q = (sb.table("catalog")
             .select("id,image_url,set_code,card_number")
             .like("image_url", "%pokedata.io%"))
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
        url      = _str(row.get("image_url"))
        set_code = _str(row.get("set_code")).lower()
        card_num = _str(row.get("card_number"))
        if not (url and set_code and card_num):
            return (row["id"], "skipped", "missing fields")

        # Storage path = top-level by game/language. Pokemon stays under
        # jp/ or en/ (existing convention). Non-Pokemon games use their
        # id prefix (mtg/, ygo/, op/, etc.) — same prefix that goes on
        # catalog ids, so storage organization mirrors the catalog.
        rid = row["id"]
        if rid.startswith(("jp-", "pd-")):
            top = "jp"
        elif rid.startswith("en-"):
            top = "en"
        else:
            # Non-Pokemon: take the prefix portion of the id (everything before the first '-')
            top = rid.split("-", 1)[0] if "-" in rid else "misc"
        storage_path = f"{top}/{set_code}/{card_num}.webp"

        # 1. Download
        try:
            r = _session.get(url, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            img_bytes = r.content
            if not img_bytes:
                return (row["id"], "failed", "download: empty body")
        except Exception as e:
            return (row["id"], "failed", f"download: {e}")

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
# DISPATCH
# ═════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    if args.probe:
        mode_probe()
    elif args.list_sets:
        mode_list_sets()
    elif args.mirror_images:
        mode_mirror_images()
    else:
        main_sync()
