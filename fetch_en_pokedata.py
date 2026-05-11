#!/usr/bin/env python3
"""
PathBinder — EN Card Catalog Builder (pokedata.io CDN)
=======================================================
Probes the pokedata CDN for English card images, uploads them to Supabase
Storage, and upserts rows into the catalog table.

This is additive-only: cards already in the catalog are skipped.
Any missing fields (name, rarity, etc.) can be filled in manually or via
the pokedata paid API later.

CDN pattern:
    https://pokemoncardimages.pokedata.io/images/{SetName}/{CardNumber}.webp

SETUP:
    pip3 install requests supabase --break-system-packages

USAGE:
    python3 fetch_en_pokedata.py --list-sets          # show all EN sets
    python3 fetch_en_pokedata.py --only "Surging Sparks"   # one set
    python3 fetch_en_pokedata.py --dry-run            # probe only, no DB writes
    python3 fetch_en_pokedata.py                      # process all EN sets

SUPABASE STORAGE (create bucket once if not already done):
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('card-images', 'card-images', true)
    ON CONFLICT DO NOTHING;
"""

import os, sys, re, time, json, argparse
import requests

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing supabase. Run: pip3 install supabase --break-system-packages")


# ══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════════════════════
SUPABASE_URL    = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY    = os.environ.get("SUPABASE_SERVICE_KEY") or input("Service role key: ").strip()
POKEDATA_BASE   = "https://www.pokedata.io"
IMAGE_CDN       = "https://pokemoncardimages.pokedata.io/images"
STORAGE_BUCKET  = "card-images"
REQUEST_TIMEOUT = 45
DELAY           = 0.05   # seconds between CDN HEAD requests

# EN sets can have cards beyond the printed total (secret rares, promo variants)
# so we probe a bit past the listed total.  Hard cap = 600.
OVERPROBE       = 30     # probe this many numbers past last hit before stopping
MAX_CARD_NUM    = 600


# ══════════════════════════════════════════════════════════════════════════════
# ARGS
# ══════════════════════════════════════════════════════════════════════════════
parser = argparse.ArgumentParser(description="Build EN card catalog from pokedata.io CDN")
parser.add_argument("--only",      type=str, default=None, help="Process only this set (name or code)")
parser.add_argument("--dry-run",   action="store_true",    help="Probe CDN but don't write to DB")
parser.add_argument("--list-sets", action="store_true",    help="Print all EN sets and exit")
parser.add_argument("--force",     action="store_true",    help="Re-process sets already in catalog")
args = parser.parse_args()


# ══════════════════════════════════════════════════════════════════════════════
# SUPABASE
# ══════════════════════════════════════════════════════════════════════════════
sb = create_client(SUPABASE_URL, SUPABASE_KEY)
try:
    res = sb.table("catalog").select("id", count="exact").limit(1).execute()
    print(f"✓ Supabase connected — catalog has {res.count:,} rows")
except Exception as e:
    sys.exit(f"✗ Cannot reach catalog: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# HTTP
# ══════════════════════════════════════════════════════════════════════════════
_session = requests.Session()
_session.headers.update({"User-Agent": "PathBinder/1.0 (contact: charles@merchunlimited.com)"})


# ── Pokedata membership cookie loader (mirrors fetch_jp_pokedata.py) ─────────
def _load_pokedata_cookies(path="pokedata_session.txt"):
    if not os.path.exists(path):
        return {}
    cookies = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
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
    print(f"  (no pokedata_session.txt — fetching anonymously)")


def fetch_page(url):
    try:
        r = _session.get(url, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return r.text
    except Exception as e:
        print(f"  ⚠ Fetch failed ({url[:60]}): {e}")
        return None

def image_exists(url):
    try:
        r = _session.head(url, timeout=REQUEST_TIMEOUT)
        return r.status_code == 200
    except Exception:
        return False

def download_image(url):
    try:
        r = _session.get(url, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return r.content
    except Exception:
        return None

def upload_to_storage(path, img_bytes):
    try:
        sb.storage.from_(STORAGE_BUCKET).upload(
            path, img_bytes,
            file_options={"content-type": "image/webp", "upsert": "true"}
        )
        return f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{path}"
    except Exception as e:
        print(f"  ⚠ Storage upload failed: {e}")
        return None

def _str(val):
    return val if isinstance(val, str) else ""


# ══════════════════════════════════════════════════════════════════════════════
# FETCH POKEDATA SET LIST
# ══════════════════════════════════════════════════════════════════════════════
print("\nFetching set list from pokedata.io…")
html = fetch_page(f"{POKEDATA_BASE}/sets")
if not html:
    sys.exit("✗ Could not fetch sets page.")

match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
if not match:
    sys.exit("✗ No __NEXT_DATA__ found — site structure may have changed.")

page_props = json.loads(match.group(1)).get("props", {}).get("pageProps", {})
all_sets   = page_props.get("setInfoArr", [])
en_sets    = [s for s in all_sets if _str(s.get("language")).upper() == "ENGLISH"]
print(f"  Found {len(en_sets)} English sets")

if args.list_sets:
    print(f"\n{'Code':<10} {'Name':<40} {'Series':<25} {'Released'}")
    print("-" * 90)
    for s in en_sets:
        code   = _str(s.get("code"))
        name   = _str(s.get("name"))
        series = _str(s.get("series"))
        rel    = _str(s.get("release_date"))[:10]
        print(f"  {code:<10} {name:<40} {series:<25} {rel}")
    sys.exit(0)

# Apply --only filter
if args.only:
    only_lower = args.only.lower()
    en_sets = [
        s for s in en_sets
        if _str(s.get("name")).lower() == only_lower
        or _str(s.get("code")).lower() == only_lower
    ]
    if not en_sets:
        sys.exit(f"✗ No EN set found matching '{args.only}'. Use --list-sets to browse.")
    print(f"  Filtered to: {en_sets[0].get('name')}")


# ══════════════════════════════════════════════════════════════════════════════
# LOAD EXISTING EN CATALOG ENTRIES (skip already-done sets)
# ══════════════════════════════════════════════════════════════════════════════
existing_codes = set()
if not args.force:
    print("\nChecking existing EN catalog entries…")
    offset = 0
    while True:
        res = (sb.table("catalog")
               .select("set_code")
               .like("id", "en-%")
               .range(offset, offset + 999)
               .execute())
        chunk = res.data or []
        existing_codes.update(_str(r.get("set_code")).lower() for r in chunk)
        if len(chunk) < 1000:
            break
        offset += 1000
    print(f"  {len(existing_codes)} set codes already in catalog — will skip")


# ══════════════════════════════════════════════════════════════════════════════
# MAIN LOOP — probe CDN set by set
# ══════════════════════════════════════════════════════════════════════════════
total_created = 0
total_skipped = 0
sets_done     = 0

print(f"\nProcessing {len(en_sets)} EN sets…\n")

for set_stub in en_sets:
    pd_name  = _str(set_stub.get("name"))
    pd_code  = _str(set_stub.get("code"))
    pd_series= _str(set_stub.get("series"))
    pd_total = set_stub.get("card_count") or set_stub.get("total") or 0

    if not pd_name:
        continue

    # Skip sets already in catalog (unless --force)
    if pd_code.lower() in existing_codes and not args.force:
        print(f"  ⏭  {pd_code:<10} {pd_name} — already in catalog")
        total_skipped += 1
        continue

    # EN CDN uses + for spaces and zero-padded 3-digit card numbers (001, 002…)
    cdn_set = pd_name.replace(' ', '+')
    print(f"  {pd_code:<10} {pd_name}", end="", flush=True)

    # Probe card numbers sequentially.
    # Use OVERPROBE consecutive misses to decide we've reached the end.
    # This catches secret rares and promo cards that skip numbers.
    found_cards = []
    card_num    = 1
    misses      = 0
    probe_limit = max(MAX_CARD_NUM, (pd_total or 0) + OVERPROBE)

    while misses < OVERPROBE and card_num <= probe_limit:
        num_str = str(card_num).zfill(3)   # EN uses 001, 002, 003…
        cdn_url = f"{IMAGE_CDN}/{cdn_set}/{num_str}.webp"
        if image_exists(cdn_url):
            found_cards.append((num_str, cdn_url))
            misses = 0
        else:
            misses += 1
        card_num += 1
        time.sleep(DELAY)

    if not found_cards:
        print(f"  — no images on CDN")
        continue

    print(f"  — {len(found_cards)} images found", end="")

    if args.dry_run:
        print(f"  [dry-run, skipping DB]")
        total_created += len(found_cards)
        continue

    # Download, upload to Storage, upsert catalog rows
    rows = []
    upload_errors = 0

    for num, cdn_url in found_cards:
        # Download image
        img_bytes = download_image(cdn_url)
        if not img_bytes:
            upload_errors += 1
            continue

        # Upload to Supabase Storage
        storage_path = f"en/{pd_code}/{num}.webp"
        stored_url   = upload_to_storage(storage_path, img_bytes)
        final_url    = stored_url or cdn_url   # fall back to CDN if upload fails

        rows.append({
            "id":          f"en-{pd_code}-{num}",
            "name":        "",          # blank — fill in manually or via paid API
            "set_name":    pd_name,
            "set_code":    pd_code,
            "card_number": num,
            "rarity":      "",
            "image_url":   final_url,
        })

    # Upsert in batches of 50
    BATCH = 50
    upsert_ok = 0
    for i in range(0, len(rows), BATCH):
        try:
            sb.table("catalog").upsert(rows[i:i+BATCH], on_conflict="id").execute()
            upsert_ok += len(rows[i:i+BATCH])
        except Exception as e:
            print(f"\n    ✗ Upsert error: {e}")

    if upload_errors:
        print(f"  ✓ {upsert_ok} saved  ⚠ {upload_errors} image download errors")
    else:
        print(f"  ✓ {upsert_ok} saved")

    total_created += upsert_ok
    sets_done     += 1
    time.sleep(0.3)   # brief pause between sets


# ══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
print(f"""
════════════════════════════════════════
  EN catalog build done!
  ✓ Cards added:  {total_created:,}
  ⏭ Sets skipped: {total_skipped} (already in catalog — use --force to re-run)
  Sets processed: {sets_done}
════════════════════════════════════════

New entries have blank card names and rarities.
Options to fill them in:
  • pokedata paid API: /v0/set?set_id=N  (names, numbers, rarities)
  • pokemontcg.io API: already integrated in PathBinder
  • Manual entry in Supabase dashboard

To wire PathBinder to use catalog images instead of pokemontcg.io:
  In index.html, update the card search flow to check catalog first
  (matching on set_code + card_number) before falling back to the live API.
""")
