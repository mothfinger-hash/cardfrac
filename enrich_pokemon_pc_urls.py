#!/usr/bin/env python3
"""
PathBinder — Pokemon PriceCharting URL Enrichment
==================================================
Fills in catalog.price_source_url for Pokemon rows pokedata sync left
empty. Pokedata is the source of truth for catalog metadata but doesn't
carry PriceCharting URLs; this script bridges the gap so the nightly
refresh_catalog_prices.py can include those rows in the global price
refresh.

WORKFLOW:
  1. Load pokedata catalog rows in scope (en-/jp-/pd-prefixed, no URL).
  2. Group by (set_code, set_name).
  3. Discover every PC Pokemon set slug from /category/pokemon-cards
     (English) or /category/pokemon-japanese-cards (Japanese).
  4. Match pokedata set_name → PC slug by normalized substring overlap.
  5. For each matched set, scrape /console/{slug}, build a
     {card_number: pc_url} index, also keyed by normalized name as
     fallback for non-numeric card numbers (promos, trainer cards).
  6. For each pokedata row in the set, find the PC URL by card_number
     (preferred) or name; PATCH catalog.price_source_url.

PREREQUISITES:
    pip3 install requests --break-system-packages

USAGE:
    # Probe — list pokedata sets in scope + see how many sets PC has
    python3 enrich_pokemon_pc_urls.py --lang en --probe

    # Dry-run one pokedata set (set_code e.g. 'sv4a')
    python3 enrich_pokemon_pc_urls.py --lang en --only-set sv4a --dry-run

    # Full run for all English Pokemon
    python3 enrich_pokemon_pc_urls.py --lang en

    # Same for Japanese
    python3 enrich_pokemon_pc_urls.py --lang jp

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
"""

import os, sys, re, json, time, random, argparse, threading
from urllib.parse import quote
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

LANG_CONFIG = {
    "en": {
        "id_prefix":     ["en-", "pd-"],
        "category_path": "/category/pokemon-cards",
        "slug_must_have":     "pokemon-",
        # Reject EVERY language variant of a slug — these all appear
        # under /category/pokemon-cards. Without this, "Pokemon Card 151"
        # fuzzy-matches "pokemon-chinese-151-collect" with the same
        # overlap score as "pokemon-151".
        "slug_must_not_have": ["japanese-", "chinese-", "korean-", "german-",
                               "french-", "italian-", "spanish-", "portuguese-",
                               "dutch-", "russian-"],
        "desc":           "English Pokemon (en- + pd- prefixes)",
    },
    "jp": {
        "id_prefix":     ["jp-"],
        # PC doesn't separate Japanese into its own category page —
        # Japanese sets live on /category/pokemon-cards alongside EN,
        # distinguished only by the 'pokemon-japanese-' slug prefix.
        "category_path": "/category/pokemon-cards",
        "slug_must_have":     "pokemon-japanese-",
        "slug_must_not_have": [],
        "desc":           "Japanese Pokemon (jp- prefix)",
    },
}


# ─── HTTP w/ backoff ──────────────────────────────────────────────────────────
RETRY_STATUSES = (403, 429, 502, 503, 504)
MAX_RETRIES    = 5
_session       = requests.Session()
_session.headers.update(HEADERS)
_thread_jitter = threading.local()


def _pace(min_s=0.6, max_s=1.4):
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
            sleep_s = (2 ** (attempt + 1) - 1) + random.uniform(0, 3)
            last_err = f"HTTP {r.status_code} (retry {attempt+1}/{MAX_RETRIES} after {sleep_s:.1f}s)"
            time.sleep(sleep_s)
            continue
        raise RuntimeError(f"HTTP {r.status_code}")
    raise RuntimeError(last_err or "exhausted retries")


# ─── Supabase REST ────────────────────────────────────────────────────────────
def _sb_headers(extra=None):
    h = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    }
    if extra: h.update(extra)
    return h


def pg_get_catalog(lang_cfg, only_set=None):
    """Pull pokedata catalog rows in scope (id prefix in lang_cfg, missing URL)."""
    rows = []
    offset = 0
    PAGE = 1000
    # PostgREST or= for the id prefix list
    or_parts = ",".join(f"id.like.{p}%" for p in lang_cfg["id_prefix"])
    while True:
        params = {
            "select":           "id,name,set_code,set_name,card_number",
            "or":               f"({or_parts})",
            "price_source_url": "is.null",
            "limit":            str(PAGE),
            "offset":           str(offset),
        }
        if only_set:
            params["set_code"] = f"eq.{only_set}"
        r = requests.get(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog",
            headers=_sb_headers(),
            params=params, timeout=30,
        )
        r.raise_for_status()
        chunk = r.json()
        rows.extend(chunk)
        if len(chunk) < PAGE:
            break
        offset += PAGE
    return rows


def pg_patch_url(catalog_id, url):
    body = json.dumps({"price_source_url": url}, ensure_ascii=False).encode("utf-8")
    r = requests.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{quote(catalog_id)}",
        headers=_sb_headers({
            "Content-Type": "application/json; charset=utf-8",
            "Prefer":       "return=minimal",
        }),
        data=body, timeout=20,
    )
    if not r.ok:
        raise RuntimeError(f"PATCH HTTP {r.status_code}: {r.text[:200]}")


# ─── PC slug discovery + per-set scraping ─────────────────────────────────────
def discover_pc_slugs(cfg):
    """Hit PC's category page, extract every /console/{slug} link that
    starts with the language's slug_prefix. Returns a list of slugs.
    slug_must_not_have accepts either a single token (legacy) or a
    list of tokens; any match against any token rejects the slug."""
    page = fetch(f"{PC_BASE}{cfg['category_path']}")
    must     = cfg["slug_must_have"]
    must_not = cfg["slug_must_not_have"]
    # Normalize must_not into a list for uniform handling
    if must_not is None:
        bad_tokens = []
    elif isinstance(must_not, str):
        bad_tokens = [must_not]
    else:
        bad_tokens = list(must_not)
    found = set()
    for m in re.finditer(r'href="/console/([a-z0-9-]+)"', page):
        slug = m.group(1)
        if must and (must not in slug):
            continue
        if any(t in slug for t in bad_tokens):
            continue
        found.add(slug)
    return sorted(found)


def load_slugs_from_file(path):
    """Load slugs from a text file — one slug per line. Lines starting
    with '#' or whitespace-only are skipped, allowing comments. Lines
    that look like full URLs (https://www.pricecharting.com/console/X)
    are auto-stripped to just the slug, so the user can paste either
    format."""
    slugs = []
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            s = raw.strip()
            if not s or s.startswith("#"):
                continue
            # Strip URL prefix if pasted as full link
            m = re.search(r'/console/([a-z0-9-]+)', s)
            if m:
                slugs.append(m.group(1))
            else:
                slugs.append(s)
    # Dedupe while preserving order
    seen = set(); out = []
    for s in slugs:
        if s not in seen:
            seen.add(s); out.append(s)
    return out


# Same parsers we use elsewhere (sync_sealed_products / sync_pc_singles_enrich)
ROW_SPLIT  = re.compile(r'<tr\b', re.IGNORECASE)
ID_RE      = re.compile(r'data-product(?:-id)?="(\d+)"', re.IGNORECASE)
NAME_RE    = re.compile(r'<a[^>]*href="(/game/[^"]+)"[^>]*>([^<]+)</a>', re.IGNORECASE)


def _norm(s):
    """Normalize a set_name (pokedata side) or slug tail (PC side) so
    they can be compared. Pokedata adds 'Pokemon' / 'Pokemon Card'
    prefixes that PC slugs don't have, plus edition qualifiers like
    '1st Edition' / 'Unlimited'. Strip them all before alphanum-lower."""
    if not s: return ""
    t = s.lower()
    t = re.sub(r'\([^)]*\)', '', t)
    t = t.replace(' and ', ' & ')
    # Pokedata prefix variants
    t = re.sub(r'^pok[eé]mon\s+card\s+', '', t)
    t = re.sub(r'^pok[eé]mon\s+', '', t)
    # Edition qualifiers pokedata adds
    t = re.sub(r'\b(1st\s+edition|first\s+edition|unlimited|shadowless|english)\b', '', t)
    # Trailing "set" / "base" qualifiers
    t = re.sub(r'\s+set\s*$', '', t)
    t = re.sub(r'\s+base\s*$', '', t)
    # "Base Set X" → "Base X"
    t = re.sub(r'^base\s+set\b', 'base', t)
    return re.sub(r'[^a-z0-9]', '', t).strip()


def _clean_pc_name(raw):
    """Strip bracket annotations, set-code-number combos, and 1-3 letter
    rarity codes so PC names align with pokedata's bare names."""
    s = (raw or "")
    s = s.replace("&#43;", "+").replace("&#39;", "'").replace("&amp;", "&")
    s = re.sub(r'\s*\[[^\]]*\]', '', s)
    s = re.sub(r'\s*\([^)]*\)', '', s)
    s = re.sub(r'\s+#?[A-Z]{1,5}\d{1,3}-\d{1,3}\s*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+#\d{1,4}\b\s*$', '', s)
    s = re.sub(r'\s+[A-Z]{1,3}\d{1,4}\s*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+\d{1,4}\s*$', '', s)
    return s.strip()


def _norm_card_num(raw):
    """Canonicalize a card number across sources. Preserves any
    letter prefix (so 'SV001' stays distinct from regular '1') but
    strips leading zeros from the numeric portion. Returns uppercased
    string like 'SV1', 'TG12', '1', '45'."""
    if not raw: return ""
    s = str(raw).strip()
    m = re.match(r'^([A-Z]*)(\d+)$', s, re.IGNORECASE)
    if m:
        prefix = (m.group(1) or "").upper()
        digits = m.group(2).lstrip("0") or "0"
        return f"{prefix}{digits}"
    # Unrecognized format — fall back to lower+stripped
    return s.upper().lstrip("0") or s


def _extract_card_number(raw):
    """Pull the card-number token off a PC listing's name tail.
    Preserves the letter prefix so Shiny Vault 'SV001' stays distinct
    from a regular '#1'. Returns the canonicalized form ('SV1', '1',
    'TG12', etc.) so it matches pokedata's stored card_number after
    _norm_card_num normalization."""
    s = (raw or "")
    s = s.replace("&#43;", "+").replace("&#39;", "'").replace("&amp;", "&")
    # Set-code-number combo: 'OP02-037' / '#GD04-050'
    m = re.search(r'#?([A-Z]{1,5}\d{1,3}-\d{1,3})\s*$', s, re.IGNORECASE)
    if m:
        return m.group(1).rsplit("-", 1)[-1].lstrip("0") or "0"
    # Letter+digits tail: 'SV001', 'TG12', 'SWSH256'. Keep the prefix.
    m = re.search(r'\b([A-Z]{1,3}\d{1,4})\s*$', s, re.IGNORECASE)
    if m:
        return _norm_card_num(m.group(1))
    # Bare #N
    m = re.search(r'#(\d{1,4})\b', s)
    if m: return m.group(1).lstrip("0") or "0"
    # Trailing bare number
    m = re.search(r'\b(\d{1,4})\s*$', s)
    if m: return m.group(1).lstrip("0") or "0"
    return None


def scrape_pc_set(slug):
    """Returns a list of dicts: {pc_url, name_clean, card_number}."""
    try:
        html = fetch(f"{PC_BASE}/console/{slug}")
    except Exception:
        return []
    out = []
    for chunk in ROW_SPLIT.split(html)[1:]:
        id_m = ID_RE.search(chunk)
        nm_m = NAME_RE.search(chunk)
        if not (id_m and nm_m):
            continue
        prod_url = nm_m.group(1)
        name_raw = nm_m.group(2).strip()
        out.append({
            "pc_url":      f"{PC_BASE}{prod_url}",
            "name_raw":    name_raw,
            "name_clean":  _clean_pc_name(name_raw),
            "card_number": _extract_card_number(name_raw),
        })
    return out


# ─── Matching ─────────────────────────────────────────────────────────────────
def match_pokedata_to_pc_slug(pokedata_set_name, pc_slugs, cfg):
    """For a pokedata set (e.g. 'Shrouded Fable'), find the PC slug whose
    tail best matches. Heuristic: normalize the set name + each slug
    tail, exact match wins (returned immediately), otherwise highest-
    score substring/token overlap wins. Score is biased so exact tails
    always beat partial overlaps of the same length."""
    if not pokedata_set_name: return None
    target = _norm(pokedata_set_name)
    if not target: return None
    must = cfg["slug_must_have"]
    # Strip prefix only at the start so multi-word slugs aren't shredded.
    def tail_of(slug):
        return slug[len(must):] if slug.startswith(must) else slug
    # Exact match attempt first — returns immediately.
    for slug in pc_slugs:
        if _norm(tail_of(slug)) == target:
            return slug
    # Fuzzy: highest overlap score wins. Exact-tail bonus already
    # handled above, so here we only do substring overlap. Shorter
    # tails (more specific match) preferred when scores tie.
    best = None; best_score = 0; best_tail_len = 999
    for slug in pc_slugs:
        tail_norm = _norm(tail_of(slug))
        if not tail_norm: continue
        if tail_norm in target:
            score = len(tail_norm)
        elif target in tail_norm:
            score = len(target)
        else:
            tokens = tail_of(slug).split("-")
            score = sum(len(t) for t in tokens if _norm(t) and _norm(t) in target)
        # Pick higher score; on tie, prefer shorter tail (more specific).
        if score > best_score or (score == best_score and len(tail_norm) < best_tail_len):
            best = slug; best_score = score; best_tail_len = len(tail_norm)
    # 3-char minimum overlap. Short set names like '151' still match,
    # but two-letter false-positives (e.g. 'sv' overlap) get filtered.
    return best if best_score >= 3 else None


def find_pc_card(pokedata_row, pc_cards_by_num, pc_cards_by_name):
    """Look up the PC card for a pokedata row. Try (card_number) first
    with prefix-preserving normalization, fall back to normalized name."""
    pn = _norm_card_num(pokedata_row.get("card_number") or "")
    if pn and pn in pc_cards_by_num:
        return pc_cards_by_num[pn]
    name_key = _norm(pokedata_row.get("name", ""))
    if name_key and name_key in pc_cards_by_name:
        return pc_cards_by_name[name_key]
    return None


# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--lang", choices=list(LANG_CONFIG.keys()), required=True,
                    help="en (English + pd-prefixed) or jp (Japanese).")
    ap.add_argument("--probe",     action="store_true",
                    help="List pokedata sets in scope + PC slug count, no DB writes.")
    ap.add_argument("--only-set",  help="Process only this pokedata set_code.")
    ap.add_argument("--dry-run",   action="store_true", help="No DB writes.")
    ap.add_argument("--limit",     type=int, default=0,
                    help="Stop after N catalog rows (debug).")
    ap.add_argument("--workers",   type=int, default=3,
                    help="Parallel PC fetchers (default 3 — PC rate-limits).")
    ap.add_argument("--slugs-file",
                    help="Path to a text file with PC slugs, one per line. "
                         "Supersedes category-page auto-discovery. Lines "
                         "can be bare slugs ('pokemon-base-set') or full "
                         "URLs ('https://www.pricecharting.com/console/...'). "
                         "Comments starting with '#' are skipped.")
    args = ap.parse_args()

    cfg = LANG_CONFIG[args.lang]
    print(f"\n  Enriching {cfg['desc']}")

    # 1. Load pokedata catalog rows
    print(f"  Loading pokedata catalog rows missing price_source_url…")
    rows = pg_get_catalog(cfg, only_set=args.only_set)
    if args.limit:
        rows = rows[:args.limit]
    print(f"  {len(rows):,} pokedata rows to enrich.")
    if not rows:
        print("  Nothing to do.")
        return

    # 2. Group by pokedata set
    by_set = {}
    for r in rows:
        key = r.get("set_code") or r.get("set_name") or "(unknown)"
        by_set.setdefault(key, {"set_name": r.get("set_name") or key, "rows": []})
        by_set[key]["rows"].append(r)
    print(f"  Spanning {len(by_set)} pokedata sets.")

    # 3. Discover PC slugs (file > category-page auto-discovery)
    if args.slugs_file:
        pc_slugs = load_slugs_from_file(args.slugs_file)
        print(f"  Loaded {len(pc_slugs)} PC slugs from {args.slugs_file}.")
    else:
        print(f"  Discovering PC slugs via {cfg['category_path']}…")
        pc_slugs = discover_pc_slugs(cfg)
        print(f"  {len(pc_slugs)} PC slugs found.")
    if args.probe:
        print(f"\n  --probe — first 10 pokedata sets in scope:")
        for k, info in list(by_set.items())[:10]:
            print(f"     {k:<20} '{info['set_name']}'  ({len(info['rows'])} cards)")
        print(f"\n  --probe — first 10 PC slugs:")
        for s in pc_slugs[:10]:
            print(f"     /console/{s}")
        return

    # 4. Match pokedata sets → PC slugs
    print(f"\n  Matching pokedata sets to PC slugs…")
    mapped   = {}     # set_code → (slug, pokedata_set_name)
    unmapped = []
    for set_code, info in by_set.items():
        slug = match_pokedata_to_pc_slug(info["set_name"], pc_slugs, cfg)
        if slug:
            mapped[set_code] = (slug, info["set_name"])
        else:
            unmapped.append((set_code, info["set_name"], len(info["rows"])))

    # Detect ambiguous matches — same PC slug claimed by 2+ pokedata
    # sets. Promos and McDonald's sets often collide on a generic slug
    # like "pokemon-promo" because the matcher can't disambiguate
    # between different-era promo sets. Reject all such matches; user
    # can re-target them via --only-set after adding a hand-mapping.
    slug_users = {}
    for sc, (slug, _) in mapped.items():
        slug_users.setdefault(slug, []).append(sc)
    ambiguous = {slug: users for slug, users in slug_users.items() if len(users) > 1}
    n_ambiguous_sets = 0
    n_ambiguous_cards = 0
    if ambiguous:
        print(f"\n  ============================================================")
        print(f"  AMBIGUOUS MATCHES DROPPED (one PC slug claimed by 2+ pokedata sets):")
        print(f"  ============================================================")
        rejected = set()
        for slug, users in ambiguous.items():
            users_with_counts = [f"{sc}({len(by_set[sc]['rows'])})" for sc in users]
            print(f"     {slug:<40}  <- {', '.join(users_with_counts)}")
            for sc in users:
                rejected.add(sc)
                n_ambiguous_cards += len(by_set[sc]['rows'])
                unmapped.append((sc, by_set[sc]['set_name'], len(by_set[sc]['rows'])))
        n_ambiguous_sets = len(rejected)
        # Remove rejected from mapped so we don't enrich with bad data
        mapped = {sc: v for sc, v in mapped.items() if sc not in rejected}
        print(f"  ============================================================")
        print(f"  Skipped {n_ambiguous_sets} sets ({n_ambiguous_cards:,} cards) to prevent mismatched data.")
        print(f"  ============================================================")

    print(f"\n  Final: matched {len(mapped)}/{len(by_set)} sets cleanly"
          + (f" (after dropping {n_ambiguous_sets} ambiguous)" if n_ambiguous_sets else "")
          + ".")
    if unmapped:
        print(f"  Unmatched ({len(unmapped)}) — first 15:")
        for sc, sn, n in unmapped[:15]:
            print(f"     {sc:<20} '{sn}'  ({n} rows)")

    # 5+6. Per-set scrape + match + patch
    print(f"\n  Processing {len(mapped)} matched sets with {args.workers} workers…\n")
    stats = {"enriched": 0, "unmatched_cards": 0, "set_fetch_failed": 0, "patch_failed": 0}
    _lock = threading.Lock()

    def process_set(set_code):
        slug, set_name = mapped[set_code]
        pc_cards = scrape_pc_set(slug)
        if not pc_cards:
            return (set_code, slug, "fetch_failed", 0, 0)
        by_num  = {}
        by_name = {}
        for c in pc_cards:
            if c["card_number"]:
                by_num.setdefault(c["card_number"], c)
            name_key = _norm(c["name_clean"])
            if name_key:
                by_name.setdefault(name_key, c)
        n_enr = 0; n_unm = 0
        for r in by_set[set_code]["rows"]:
            pc = find_pc_card(r, by_num, by_name)
            if not pc:
                n_unm += 1
                continue
            if args.dry_run:
                pass
            else:
                try:
                    pg_patch_url(r["id"], pc["pc_url"])
                except Exception:
                    with _lock:
                        stats["patch_failed"] += 1
                    continue
            n_enr += 1
        return (set_code, slug, "ok", n_enr, n_unm)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_set, sc): sc for sc in mapped}
        for f in as_completed(futs):
            set_code, slug, status, n_enr, n_unm = f.result()
            with _lock:
                if status == "fetch_failed":
                    stats["set_fetch_failed"] += 1
                    print(f"  FAIL  {set_code:<18} /console/{slug}")
                    continue
                stats["enriched"]        += n_enr
                stats["unmatched_cards"] += n_unm
                print(f"  {set_code:<18} /console/{slug}  enriched={n_enr} unmatched={n_unm}")

    summary = ' '.join(f'{k}={v}' for k,v in stats.items())
    if n_ambiguous_sets:
        summary += f" ambiguous_skipped={n_ambiguous_sets}sets/{n_ambiguous_cards}cards"
    print(f"\n  Done. {summary}")
    if args.dry_run:
        print(f"  --dry-run: no writes. Re-run without --dry-run to commit.")


if __name__ == "__main__":
    main()
