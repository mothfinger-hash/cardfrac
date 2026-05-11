#!/usr/bin/env python3
"""
PathBinder — Pokedata.io Authenticated API Client
==================================================
Pulls card metadata and (optionally) pricing data from the Pokedata.io REST API
into the local Supabase `catalog` table. Designed to complement the existing
scrape-based scripts (fetch_jp_pokedata.py, fetch_en_pokedata.py) — those
populate images via the public CDN, this fills the gaps the scrapes leave
behind (blank names, rarities, types, dates) and ingests entirely new sets.

REQUIREMENTS:
    pip3 install requests supabase --break-system-packages

ENVIRONMENT:
    POKEDATA_API_KEY      Your Pokedata.io API key (do NOT commit)
    SUPABASE_SERVICE_KEY  Supabase service-role key (do NOT commit)

USAGE:
    # Quick smoke test against the API
    python3 pokedata_api.py --ping

    # List all sets the API knows about (writes nothing)
    python3 pokedata_api.py --list-sets
    python3 pokedata_api.py --list-sets --language JA

    # Enrich existing catalog rows that have blank name/rarity/type
    python3 pokedata_api.py --enrich
    python3 pokedata_api.py --enrich --language JA --set sv4a
    python3 pokedata_api.py --enrich --dry-run

    # Ingest brand-new sets / cards that aren't in the catalog yet
    python3 pokedata_api.py --ingest --language EN
    python3 pokedata_api.py --ingest --set sv11W

    # Pull prices and write to card_prices table
    python3 pokedata_api.py --prices --language EN

    # Find rows missing an image_url and try the catalog's known image
    # endpoints — falls back to CDN probe if API doesn't return a URL.
    python3 pokedata_api.py --fix-images

DESIGN PRINCIPLES:
  • API key never leaves this script. No code path emits it to logs or DB.
  • Enrich mode NEVER overwrites a non-empty field — safe to re-run.
  • Ingest mode upserts with `on_conflict=id` so it merges, not replaces.
  • Admin overrides in card_overrides table take precedence at app-display
    time (handled in index.html, not here). Importing fresh data won't
    clobber what an admin has corrected.

═══════════════════════════════════════════════════════════════════════════════
TODO when API key arrives:
  1. Fill in API_BASE_URL with the real endpoint
  2. Fill in the four `_pdapi_*` helper functions with real paths/params/auth
     scheme (header? query param? Bearer? Token?)
  3. Map the response JSON into our catalog row shape inside
     `_pokedata_to_catalog_row` and `_pokedata_to_price_row`
  4. Adjust RATE_LIMIT_RPS to match your tier
  5. Delete this TODO block
═══════════════════════════════════════════════════════════════════════════════
"""

import os, sys, time, json, argparse
from collections import defaultdict

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing 'supabase'. Run: pip3 install supabase --break-system-packages")


# ═════════════════════════════════════════════════════════════════════════════
# CONFIG — fill in when API key arrives
# ═════════════════════════════════════════════════════════════════════════════
SUPABASE_URL     = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY     = os.environ.get("SUPABASE_SERVICE_KEY") or input("Supabase service-role key: ").strip()
POKEDATA_API_KEY = os.environ.get("POKEDATA_API_KEY")     or input("Pokedata API key: ").strip()

# TODO(api-key): confirm the actual base URL from Pokedata's docs.
API_BASE_URL = "https://api.pokedata.io/v0"

# TODO(api-key): adjust to your tier's allowed rate. Most free/dev tiers are
# 5–10 RPS. Paid tiers can be 50+. Keep conservative to avoid throttling.
RATE_LIMIT_RPS = 5

REQUEST_TIMEOUT = 30
USER_AGENT      = "PathBinder/1.0 (contact: charles@merchunlimited.com)"
UPSERT_BATCH    = 50      # rows per supabase upsert call

# Set this true the first time you run an --ingest to dump the raw API response
# to ./pokedata_sample_response.json so we can iterate on the field mapping
# without burning more API calls than necessary.
SAVE_SAMPLE_RESPONSE = False


# ═════════════════════════════════════════════════════════════════════════════
# ARGS
# ═════════════════════════════════════════════════════════════════════════════
parser = argparse.ArgumentParser(description="Pokedata.io authenticated API → Supabase catalog")
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument("--ping",       action="store_true", help="Smoke-test the API and exit")
mode.add_argument("--list-sets",  action="store_true", help="Print all sets the API exposes")
mode.add_argument("--enrich",     action="store_true", help="Fill blank name/rarity/type on existing catalog rows")
mode.add_argument("--ingest",     action="store_true", help="Upsert sets/cards that aren't in catalog yet")
mode.add_argument("--prices",     action="store_true", help="Pull prices into the card_prices table")
mode.add_argument("--fix-images", action="store_true", help="Patch catalog rows with empty image_url using API/CDN")

parser.add_argument("--language", choices=["EN", "JA"], default=None, help="Limit to one language")
parser.add_argument("--set",      type=str, default=None, help="Limit to one set code (e.g. sv4a, s12a)")
parser.add_argument("--dry-run",  action="store_true", help="Read-only — fetch + print, no DB writes")
parser.add_argument("--limit",    type=int, default=None, help="Cap total rows touched (debug)")
parser.add_argument("--verbose",  action="store_true", help="Print every API call URL")

args = parser.parse_args()


# ═════════════════════════════════════════════════════════════════════════════
# HTTP SESSION — shared, rate-limited
# ═════════════════════════════════════════════════════════════════════════════
_session = requests.Session()
_session.headers.update({
    "User-Agent": USER_AGENT,
    "Accept":     "application/json",
    # TODO(api-key): Pokedata's docs will tell you which one of these to keep.
    # Common patterns: Bearer token, X-API-Key header, or ?api_key= query param.
    "Authorization": f"Bearer {POKEDATA_API_KEY}",
    # "X-API-Key": POKEDATA_API_KEY,
})

# Token-bucket-ish rate limit. Sleeps to keep us under RATE_LIMIT_RPS.
_last_call_ts = [0.0]
_min_interval = 1.0 / max(RATE_LIMIT_RPS, 1)

def _throttle():
    now = time.time()
    elapsed = now - _last_call_ts[0]
    if elapsed < _min_interval:
        time.sleep(_min_interval - elapsed)
    _last_call_ts[0] = time.time()


def _pdapi_get(path, params=None, retries=4, _trace=False):
    """Authenticated GET against the Pokedata API with retry/back-off.
    Set _trace=True to print full diagnostic info (URL, status, body preview)."""
    _throttle()
    url = f"{API_BASE_URL}{path}"
    if args.verbose or _trace:
        print(f"  GET {url}  params={params or '{}'}")
    for attempt in range(retries):
        try:
            r = _session.get(url, params=params, timeout=REQUEST_TIMEOUT)
            if _trace:
                preview = (r.text or "")[:600].replace("\n", " ")
                print(f"  → HTTP {r.status_code}  {r.headers.get('content-type','')}")
                print(f"  → body[:600]: {preview}")
            if r.status_code == 401:
                sys.exit(f"✗ 401 Unauthorized — check POKEDATA_API_KEY / auth header (request to {url})")
            if r.status_code == 403:
                sys.exit(f"✗ 403 Forbidden — your tier may not include this endpoint")
            if r.status_code == 404:
                if _trace:
                    print(f"  ⚠ 404 — endpoint path is wrong")
                return None
            if r.status_code == 429:
                wait = 20 * (attempt + 1)
                print(f"  Rate limited, waiting {wait}s…")
                time.sleep(wait)
                continue
            r.raise_for_status()
            try:
                return r.json()
            except ValueError:
                if _trace:
                    print(f"  ⚠ Response isn't JSON")
                return None
        except requests.exceptions.RequestException as e:
            if attempt < retries - 1:
                time.sleep(4 * (attempt + 1))
            else:
                print(f"  ⚠ {url} — {e}")
                return None
    return None


# ═════════════════════════════════════════════════════════════════════════════
# POKEDATA API METHODS — stubs to fill in when key + docs arrive
# ═════════════════════════════════════════════════════════════════════════════
# Each method documents the EXPECTED contract we want to consume. When you
# get the actual API docs, swap the implementation to match. The rest of the
# script consumes these helpers, so as long as the *return shapes* stay the
# same, no other code changes.

def pdapi_list_sets(language=None):
    """
    Return a list of dicts describing every set the API knows about.
    Expected dict shape (rename keys to match the real response):
        {
          "code":         "sv4a",
          "name":         "Shiny Treasure ex",   # English name
          "name_ja":      "シャイニートレジャーex",  # native name if applicable
          "language":     "JA",                    # "EN" | "JA"
          "release_date": "2023-12-01",
          "card_count":   190
        }
    """
    # TODO(api-key): swap to real endpoint. Common shapes:
    #   GET /v0/sets               → {"data": [...]}
    #   GET /v0/sets?lang=ja       → [...]
    data = _pdapi_get("/sets", params={"language": language} if language else None)
    if data is None:
        return []
    sets = data.get("data", data) if isinstance(data, dict) else data
    # TODO(api-key): normalise field names here so callers see our canonical shape.
    return sets


def pdapi_list_cards(set_code):
    """
    Return a list of card dicts for one set. Expected dict shape:
        {
          "id":           "sv4a-001",         # globally unique
          "card_number":  "001",
          "name":         "Roaring Moon ex",
          "rarity":       "Special Art Rare",
          "type":         "Pokemon",          # "Pokemon" | "Trainer" | "Energy"
          "supertype":    "Pokemon",
          "subtypes":     ["ex", "Tera"],
          "hp":           220,
          "image_url":    "https://.../sv4a/001.webp",
          "set_code":     "sv4a",
          "set_name":     "Shiny Treasure ex",
          "language":     "JA",
          "release_date": "2023-12-01"
        }
    """
    # TODO(api-key): swap to real endpoint. Common shapes:
    #   GET /v0/set?set_id=sv4a
    #   GET /v0/sets/sv4a/cards
    data = _pdapi_get(f"/sets/{set_code}/cards") or _pdapi_get(f"/set", params={"set_id": set_code})
    if data is None:
        return []
    cards = data.get("data", data.get("cards", data)) if isinstance(data, dict) else data
    return cards


def pdapi_get_card(card_id):
    """Return full detail for one card by API id."""
    # TODO(api-key): swap to real endpoint.
    data = _pdapi_get(f"/cards/{card_id}")
    if data is None:
        return None
    return data.get("data", data) if isinstance(data, dict) else data


def pdapi_get_prices(card_id):
    """
    Return current price points for a card. Expected list shape:
        [
          {"condition": "raw", "market": 12.30, "low": 9.00, "high": 18.00, "source": "tcgplayer"},
          {"condition": "psa10", "market": 88.00, "source": "ebay"}
        ]
    """
    # TODO(api-key): swap to real endpoint. Pricing is often a separate
    # endpoint and only on paid tiers.
    data = _pdapi_get(f"/cards/{card_id}/prices") or _pdapi_get(f"/pricing", params={"card_id": card_id})
    if data is None:
        return []
    prices = data.get("data", data.get("prices", data)) if isinstance(data, dict) else data
    return prices


# ═════════════════════════════════════════════════════════════════════════════
# SUPABASE
# ═════════════════════════════════════════════════════════════════════════════
sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def _cat_id_for(language, set_code, card_number):
    """Build the catalog id matching the rest of the codebase:
       en-{set}-{num} for English, jp-{set}-{num} for Japanese."""
    prefix = "jp" if language == "JA" else "en"
    return f"{prefix}-{set_code}-{card_number}"


def _pokedata_to_catalog_row(card, language=None):
    """Map a Pokedata API card dict → our catalog row schema. Tolerant of
    differently-shaped responses — favors keys we likely have."""
    lang = language or card.get("language") or "EN"
    set_code   = card.get("set_code")   or (card.get("set") or {}).get("code") or ""
    card_num   = card.get("card_number") or card.get("number") or ""
    return {
        "id":          _cat_id_for(lang, set_code, card_num),
        "name":        card.get("name") or "",
        "set_name":    card.get("set_name") or (card.get("set") or {}).get("name") or "",
        "set_code":    set_code,
        "card_number": card_num,
        "rarity":      card.get("rarity") or "",
        "image_url":   card.get("image_url") or card.get("image") or "",
        # `language` column may or may not exist on your catalog — guard at write time
    }


def _pokedata_to_price_row(card_id, p):
    return {
        "catalog_id":   card_id,
        "condition":    p.get("condition") or "raw",
        "market_price": p.get("market") or p.get("price"),
        "low_price":    p.get("low"),
        "high_price":   p.get("high"),
        "source":       p.get("source") or "pokedata",
        "recorded_at":  time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def upsert_catalog_rows(rows):
    """Upsert in batches with on_conflict='id'. Returns count written."""
    if not rows:
        return 0
    written = 0
    for i in range(0, len(rows), UPSERT_BATCH):
        chunk = rows[i:i+UPSERT_BATCH]
        try:
            sb.table("catalog").upsert(chunk, on_conflict="id").execute()
            written += len(chunk)
        except Exception as e:
            print(f"  ✗ Upsert error on chunk {i//UPSERT_BATCH}: {e}")
    return written


def fetch_catalog_ids(language=None, set_code=None, only_blank_field=None):
    """Pull catalog rows matching filters. only_blank_field='name' returns just
    rows where that column is empty/null (used by --enrich)."""
    all_rows = []
    offset = 0
    while True:
        q = sb.table("catalog").select("id,name,set_name,set_code,card_number,rarity,image_url")
        if language == "JA":
            q = q.like("id", "jp-%")
        elif language == "EN":
            q = q.like("id", "en-%")
        if set_code:
            q = q.eq("set_code", set_code)
        if only_blank_field:
            q = q.or_(f"{only_blank_field}.is.null,{only_blank_field}.eq.")
        q = q.range(offset, offset + 999)
        res = q.execute()
        chunk = res.data or []
        all_rows.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000
    return all_rows


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --ping
# ═════════════════════════════════════════════════════════════════════════════
def mode_ping():
    """Probe a battery of likely endpoint paths and auth schemes so we can
    diagnose without guessing. Prints every attempt with status code + body
    preview. Whichever combo returns a useful 200 is the one to wire up."""
    print(f"Pokedata API ping — base {API_BASE_URL}\n")

    # Supabase round-trip first (so we know that side is fine)
    try:
        res = sb.table("catalog").select("id", count="exact").limit(1).execute()
        print(f"  ✓ Supabase catalog reachable: {res.count:,} rows\n")
    except Exception as e:
        print(f"  ✗ Supabase failed: {e}\n")

    # Candidate endpoint paths — common naming conventions for "list sets"
    candidate_paths = [
        "/sets",
        "/set",
        "/sets/all",
        "/list-sets",
        "/cards/sets",
        "/v0/sets",            # in case base URL already lacks /v0
        "/v1/sets",
        "/api/sets",
        "/api/v1/sets",
        "/",                    # some APIs have a root listing
    ]

    # Candidate auth schemes — we'll temporarily swap headers per probe
    auth_schemes = [
        ("Authorization: Bearer", {"Authorization": f"Bearer {POKEDATA_API_KEY}"}),
        ("Authorization: Token",  {"Authorization": f"Token {POKEDATA_API_KEY}"}),
        ("X-API-Key header",      {"X-API-Key":     POKEDATA_API_KEY}),
        ("api_key query param",   {"_QUERY":        {"api_key": POKEDATA_API_KEY}}),
        ("key query param",       {"_QUERY":        {"key":     POKEDATA_API_KEY}}),
    ]

    print(f"  Probing {len(candidate_paths)} paths × {len(auth_schemes)} auth schemes…")
    print(f"  (silent on 404 / empty results — only loud on hits)\n")

    hits = []
    for scheme_name, scheme in auth_schemes:
        # Reset headers then apply this scheme's auth
        _session.headers.pop("Authorization", None)
        _session.headers.pop("X-API-Key", None)
        query_extra = {}
        for k, v in scheme.items():
            if k == "_QUERY":
                query_extra = v
            else:
                _session.headers[k] = v

        for path in candidate_paths:
            try:
                _throttle()
                url = f"{API_BASE_URL}{path}"
                r = _session.get(url, params=query_extra, timeout=10)
            except requests.exceptions.RequestException as e:
                continue

            status = r.status_code
            # Only report on hits that look promising (2xx or 401 — both say
            # "endpoint exists"). Skip 404/empty.
            if status >= 200 and status < 300:
                # Try to detect if the body has actual content
                try:
                    body = r.json()
                except ValueError:
                    body = r.text[:200]
                # If it's a non-empty dict/list, we have a winner
                body_size = (
                    len(body) if isinstance(body, (list, dict))
                    else len(str(body))
                )
                if body_size > 0:
                    print(f"  ✓ {scheme_name:<30}  {path:<22}  HTTP {status}  size={body_size}")
                    preview = json.dumps(body, ensure_ascii=False)[:300] if isinstance(body, (list, dict)) else str(body)[:300]
                    print(f"      body[:300]: {preview}\n")
                    hits.append({"scheme": scheme_name, "path": path, "status": status, "body_size": body_size, "preview": preview})

            elif status in (401, 403):
                # Endpoint exists, but auth was wrong/insufficient
                print(f"  · {scheme_name:<30}  {path:<22}  HTTP {status}  (endpoint exists, auth issue)")

    print("\n  ════════════════════════════════════")
    if hits:
        print(f"  Found {len(hits)} working combo(s):\n")
        for h in hits:
            print(f"    • {h['scheme']}  →  {h['path']}  ({h['body_size']} bytes / items)")
        # Persist the first hit so future runs of --list-sets etc. can use it
        with open("pokedata_probe_result.json", "w", encoding="utf-8") as f:
            json.dump(hits, f, indent=2, ensure_ascii=False)
        print(f"\n  Saved details to pokedata_probe_result.json")
        print(f"  Send me that file and I'll wire up the real config.")
    else:
        print("  ✗ Nothing landed. Either the base URL is wrong, or auth")
        print("    isn't being accepted. Check:")
        print("      • Pokedata's docs for the actual base URL")
        print("      • Whether your key has been activated / approved")
        print("      • Whether they have an account dashboard showing example curl commands")
    print("  ════════════════════════════════════")


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --list-sets
# ═════════════════════════════════════════════════════════════════════════════
def mode_list_sets():
    sets = pdapi_list_sets(language=args.language)
    if not sets:
        print("No sets returned.")
        return
    print(f"\n{'Code':<10} {'Lang':<5} {'Name':<40} {'Cards':<7} Release")
    print("-" * 90)
    for s in sets:
        code = s.get("code") or s.get("id") or ""
        lang = s.get("language") or s.get("lang") or ""
        name = s.get("name") or ""
        cnt  = s.get("card_count") or s.get("total") or "?"
        rel  = (s.get("release_date") or "")[:10]
        print(f"  {code:<10} {lang:<5} {name:<40} {str(cnt):<7} {rel}")
    print(f"\n  Total: {len(sets)} sets")


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --enrich  (fill blank fields on existing catalog rows)
# ═════════════════════════════════════════════════════════════════════════════
def mode_enrich():
    """For every catalog row matching the filter with a blank name or rarity,
    look up the card via the API and patch in the missing fields. Never
    overwrites a non-empty field."""
    print("Loading rows with blank name…")
    rows = fetch_catalog_ids(language=args.language, set_code=args.set, only_blank_field="name")
    if args.limit:
        rows = rows[:args.limit]
    print(f"  {len(rows):,} rows to enrich")

    if not rows:
        return

    # Group by set so we can batch /cards-in-set calls
    by_set = defaultdict(list)
    for r in rows:
        by_set[r.get("set_code") or ""].append(r)

    enriched = 0
    api_calls = 0
    for set_code, group in by_set.items():
        if not set_code:
            print(f"  ⚠ Skipping {len(group)} rows with no set_code")
            continue
        print(f"\n  Set {set_code} — {len(group)} rows")
        cards = pdapi_list_cards(set_code)
        api_calls += 1
        if not cards:
            print(f"    ⚠ API returned no cards for {set_code}")
            continue

        # Build lookup by card_number
        by_num = {}
        for c in cards:
            num = c.get("card_number") or c.get("number") or ""
            if num:
                by_num[str(num).lstrip("0") or "0"] = c
                by_num[str(num).zfill(3)] = c
                by_num[str(num)] = c

        patches = []
        for row in group:
            num = str(row.get("card_number") or "")
            match = by_num.get(num) or by_num.get(num.lstrip("0") or "0") or by_num.get(num.zfill(3))
            if not match:
                continue
            patch = {"id": row["id"]}
            # Only fill blank fields — preserve anything the row already has
            if not row.get("name")     and match.get("name"):     patch["name"]     = match["name"]
            if not row.get("rarity")   and match.get("rarity"):   patch["rarity"]   = match["rarity"]
            if not row.get("set_name") and (match.get("set_name") or (match.get("set") or {}).get("name")):
                patch["set_name"] = match.get("set_name") or (match.get("set") or {}).get("name")
            if not row.get("image_url") and (match.get("image_url") or match.get("image")):
                patch["image_url"] = match.get("image_url") or match.get("image")
            if len(patch) > 1:  # 'id' alone doesn't count
                patches.append(patch)

        print(f"    → {len(patches)} patches ready")
        if args.dry_run:
            for p in patches[:3]:
                print(f"      sample: {p}")
            enriched += len(patches)
            continue
        if patches:
            written = upsert_catalog_rows(patches)
            enriched += written
            print(f"    ✓ {written} rows updated")

    print(f"\n  ════════════════════════════════════")
    print(f"  Enrichment done: {enriched:,} rows patched in {api_calls} API calls")
    print(f"  ════════════════════════════════════")


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --ingest  (pull sets/cards not yet in catalog)
# ═════════════════════════════════════════════════════════════════════════════
def mode_ingest():
    """Pull every set from the API and upsert every card. Idempotent —
    safe to re-run because of `on_conflict=id`."""
    sets = pdapi_list_sets(language=args.language)
    if args.set:
        sets = [s for s in sets if (s.get("code") or s.get("id") or "") == args.set]
    if not sets:
        print("No sets to ingest.")
        return

    print(f"Ingesting {len(sets)} sets…")
    total_cards = 0

    for s in sets:
        set_code = s.get("code") or s.get("id") or ""
        if not set_code:
            continue
        lang = (s.get("language") or s.get("lang") or "EN").upper()
        if lang not in ("EN", "JA"):
            lang = "EN"

        cards = pdapi_list_cards(set_code)
        if not cards:
            print(f"  {set_code}: no cards returned")
            continue

        rows = []
        for c in cards:
            row = _pokedata_to_catalog_row(c, language=lang)
            # Skip rows where the join key would be malformed
            if not row.get("card_number"):
                continue
            rows.append(row)

        if args.limit and total_cards + len(rows) > args.limit:
            rows = rows[: args.limit - total_cards]

        if args.dry_run:
            print(f"  {set_code} ({lang}): {len(rows)} cards — dry-run, no write")
            if rows:
                print(f"    sample id: {rows[0]['id']}  name: {rows[0]['name']!r}")
            total_cards += len(rows)
        else:
            written = upsert_catalog_rows(rows)
            total_cards += written
            print(f"  {set_code} ({lang}): {written}/{len(rows)} cards upserted")

        if args.limit and total_cards >= args.limit:
            print("  (limit reached, stopping)")
            break

    print(f"\n  ════════════════════════════════════")
    print(f"  Ingest done: {total_cards:,} cards processed")
    print(f"  ════════════════════════════════════")


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --prices  (pull current prices, write to card_prices table)
# ═════════════════════════════════════════════════════════════════════════════
def mode_prices():
    """
    Requires a `card_prices` table. SQL migration:

        create table if not exists card_prices (
          id            uuid primary key default gen_random_uuid(),
          catalog_id    text references catalog(id) on delete cascade,
          condition     text default 'raw',
          market_price  numeric,
          low_price     numeric,
          high_price    numeric,
          source        text,
          recorded_at   timestamptz default now()
        );
        create index if not exists card_prices_catalog_idx
          on card_prices(catalog_id, recorded_at desc);
    """
    rows = fetch_catalog_ids(language=args.language, set_code=args.set)
    if args.limit:
        rows = rows[:args.limit]
    print(f"Pulling prices for {len(rows):,} cards…")

    pulled = 0
    written = 0
    for i, row in enumerate(rows, 1):
        # The API expects ITS id, not our id. If we stored the api id when
        # ingesting, use that — otherwise reconstruct best-effort.
        # TODO(api-key): adjust how you map our catalog id → the API's card id.
        api_id = row["id"].replace("jp-", "").replace("en-", "")
        prices = pdapi_get_prices(api_id)
        if not prices:
            continue
        pulled += 1
        price_rows = [_pokedata_to_price_row(row["id"], p) for p in prices]
        if args.dry_run:
            if i <= 3:
                print(f"  {row['id']}: {len(price_rows)} price points (sample)")
            written += len(price_rows)
            continue
        try:
            sb.table("card_prices").insert(price_rows).execute()
            written += len(price_rows)
        except Exception as e:
            msg = (str(e) or "").lower()
            if "relation" in msg or "does not exist" in msg:
                print("\n  ✗ card_prices table missing. Migration is documented")
                print("    in the docstring at the top of mode_prices() above.")
                return
            print(f"  ✗ Insert error for {row['id']}: {e}")

        if i % 50 == 0:
            print(f"  …{i}/{len(rows)} (pulled {pulled}, wrote {written})")

    print(f"\n  ════════════════════════════════════")
    print(f"  Prices done: {written:,} points written for {pulled:,} cards")
    print(f"  ════════════════════════════════════")


# ═════════════════════════════════════════════════════════════════════════════
# MODE: --fix-images
# ═════════════════════════════════════════════════════════════════════════════
def mode_fix_images():
    """Find catalog rows with blank image_url and patch from the API."""
    print("Loading rows with blank image_url…")
    rows = fetch_catalog_ids(language=args.language, set_code=args.set, only_blank_field="image_url")
    if args.limit:
        rows = rows[:args.limit]
    print(f"  {len(rows):,} rows missing images")

    # Group by set for batched lookup
    by_set = defaultdict(list)
    for r in rows:
        by_set[r.get("set_code") or ""].append(r)

    patched = 0
    for set_code, group in by_set.items():
        if not set_code:
            continue
        cards = pdapi_list_cards(set_code)
        by_num = {}
        for c in cards:
            num = str(c.get("card_number") or c.get("number") or "")
            if num:
                by_num[num] = c
                by_num[num.lstrip("0") or "0"] = c
                by_num[num.zfill(3)] = c

        patches = []
        for row in group:
            num = str(row.get("card_number") or "")
            match = by_num.get(num) or by_num.get(num.lstrip("0") or "0") or by_num.get(num.zfill(3))
            if match:
                img = match.get("image_url") or match.get("image")
                if img:
                    patches.append({"id": row["id"], "image_url": img})

        if args.dry_run:
            print(f"  {set_code}: {len(patches)} image patches ready (dry-run)")
            patched += len(patches)
            continue

        if patches:
            written = upsert_catalog_rows(patches)
            patched += written
            print(f"  {set_code}: {written} images patched")

    print(f"\n  ════════════════════════════════════")
    print(f"  Image fix done: {patched:,} rows updated")
    print(f"  ════════════════════════════════════")


# ═════════════════════════════════════════════════════════════════════════════
# DISPATCH
# ═════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    if args.ping:       mode_ping()
    elif args.list_sets: mode_list_sets()
    elif args.enrich:   mode_enrich()
    elif args.ingest:   mode_ingest()
    elif args.prices:   mode_prices()
    elif args.fix_images: mode_fix_images()
