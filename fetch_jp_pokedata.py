#!/usr/bin/env python3
"""
PathBinder — JP Image Updater (pokedata.io CDN source)
=======================================================
Pokedata's card metadata requires authentication, but their image CDN is public:
    https://pokemoncardimages.pokedata.io/images/{SetName}/{CardNumber}.webp

Strategy:
  1. Pull the full JP set list from pokedata.io (works — data is in __NEXT_DATA__)
  2. For each set, look up cards already in our Supabase catalog (from TCGdex)
  3. For each catalog card, try to fetch the pokedata CDN image using the card_number
  4. If the image loads (200), optionally upload to Supabase Storage and update image_url
  5. Cards not in our catalog are skipped — this script only fixes images, not metadata

This fills the image gap for sets where TCGdex gave us card names but bad/missing images.

SETUP:
    pip3 install requests supabase Pillow --break-system-packages

USAGE:
    python3 fetch_jp_pokedata.py --list-sets          # show all JP sets pokedata knows about
    python3 fetch_jp_pokedata.py --only "Nihil Zero"  # update images for one set
    python3 fetch_jp_pokedata.py                      # update images for all JP sets in catalog
    python3 fetch_jp_pokedata.py --upload             # also mirror images to Supabase Storage

SUPABASE STORAGE (only needed with --upload):
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
SUPABASE_URL   = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY   = os.environ.get("SUPABASE_SERVICE_KEY") or input("Service role key: ").strip()
POKEDATA_BASE  = "https://www.pokedata.io"
IMAGE_CDN      = "https://pokemoncardimages.pokedata.io/images"
STORAGE_BUCKET = "card-images"
REQUEST_TIMEOUT = 45
DELAY          = 0.05   # seconds between image HEAD requests


# ══════════════════════════════════════════════════════════════════════════════
# ARGS
# ══════════════════════════════════════════════════════════════════════════════
parser = argparse.ArgumentParser(description="Update JP card image URLs from pokedata.io CDN")
parser.add_argument("--only",         type=str,  default=None, help="Only process this set (name or code)")
parser.add_argument("--upload",       action="store_true",   help="Upload images to Supabase Storage (otherwise just update image_url to CDN URL)")
parser.add_argument("--list-sets",    action="store_true",   help="Print all JP sets pokedata knows about and exit")
parser.add_argument("--dry-run",      action="store_true",   help="Check images but don't update catalog")
parser.add_argument("--fill-missing", action="store_true",   help="For JP sets in pokedata but NOT in catalog, probe CDN and create new entries")
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

def fetch_page(url):
    try:
        r = _session.get(url, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return r.text
    except Exception as e:
        print(f"  ⚠ Fetch failed ({url[:60]}): {e}")
        return None

def image_exists(url):
    """HEAD request — fast check whether image is available on CDN."""
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
print("Fetching JP set list from pokedata.io…")
html = fetch_page(f"{POKEDATA_BASE}/sets")
if not html:
    sys.exit("✗ Could not fetch sets page.")

match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
if not match:
    sys.exit("✗ No __NEXT_DATA__ found — site structure may have changed.")

page_props   = json.loads(match.group(1)).get("props", {}).get("pageProps", {})
all_sets     = page_props.get("setInfoArr", [])
jp_sets      = [s for s in all_sets if _str(s.get("language")).upper() == "JAPANESE"]
print(f"  Found {len(jp_sets)} Japanese sets")

# Build lookup: set_name (lowercase) → pokedata set name (for CDN URL)
# Also index by code so we can match catalog set_codes
pokedata_by_name = {}   # "nihil zero"    → "Nihil Zero"
pokedata_by_code = {}   # "m3"            → "Nihil Zero"
pokedata_name_to_code = {}  # "nihil zero" → "m3"
for s in jp_sets:
    name = _str(s.get("name"))
    code = _str(s.get("code"))
    if name:
        pokedata_by_name[name.lower()] = name
    if code:
        pokedata_by_code[code.lower()] = name
    if name and code:
        pokedata_name_to_code[name.lower()] = code.lower()

if args.list_sets:
    for s in jp_sets:
        code   = _str(s.get("code"))
        name   = _str(s.get("name"))
        series = _str(s.get("series"))
        rel    = _str(s.get("release_date"))[:16]
        cdn_sample = f"{IMAGE_CDN}/{requests.utils.quote(name)}/1.webp" if name else ""
        print(f"  {code:8s}  {name:35s}  {series:20s}  {rel}")
        if cdn_sample:
            print(f"           CDN: {cdn_sample}")
    sys.exit(0)


# ══════════════════════════════════════════════════════════════════════════════
# FETCH CATALOG CARDS (jp- prefix only)
# ══════════════════════════════════════════════════════════════════════════════
print("\nLoading JP cards from catalog…")

# Apply --only filter
only_filter = args.only

catalog_cards = []
offset = 0
while True:
    q = sb.table("catalog").select("id,name,set_name,set_code,card_number,image_url").like("id", "jp-%")
    if only_filter:
        # Try to match set_name or set_code
        pd_name = (pokedata_by_name.get(only_filter.lower())
                   or pokedata_by_code.get(only_filter.lower())
                   or only_filter)
        # We'll filter after fetching since PostgREST OR on two columns is verbose
    q = q.range(offset, offset + 999)
    res = q.execute()
    chunk = res.data or []
    catalog_cards.extend(chunk)
    if len(chunk) < 1000:
        break
    offset += 1000

print(f"  {len(catalog_cards):,} JP cards in catalog")

# Filter to --only set if specified
if only_filter:
    only_lower = only_filter.lower()
    # Resolve English name → set code (e.g. "vstar universe" → "s12a")
    only_code  = pokedata_name_to_code.get(only_lower, only_lower)
    catalog_cards = [
        c for c in catalog_cards
        if _str(c.get("set_name")).lower() == only_lower       # JP name exact
        or _str(c.get("set_code")).lower() == only_lower       # set code direct
        or _str(c.get("set_code")).lower() == only_code        # English name → code
    ]
    print(f"  {len(catalog_cards):,} cards match '{only_filter}'")
    if not catalog_cards:
        print(f"\n  Tip: This set might be in catalog under a different set_name.")
        print(f"  Check with: SELECT DISTINCT set_name, set_code FROM catalog WHERE id LIKE 'jp-%';")
        sys.exit(0)


# ══════════════════════════════════════════════════════════════════════════════
# MATCH CATALOG CARDS TO POKEDATA CDN
# ══════════════════════════════════════════════════════════════════════════════
# Group cards by their set to find the pokedata display name
from collections import defaultdict
cards_by_set = defaultdict(list)
for c in catalog_cards:
    cards_by_set[(c.get("set_name",""), c.get("set_code",""))].append(c)

total_updated = 0
total_missing = 0
total_skipped = 0

for (set_name, set_code), cards in cards_by_set.items():
    # Find the pokedata display name for this set
    pd_name = (pokedata_by_name.get(set_name.lower())
               or pokedata_by_code.get(set_code.lower())
               or pokedata_by_name.get(set_code.lower()))

    if not pd_name:
        print(f"\n  ⚠ No pokedata match for '{set_name}' ({set_code}) — skipping {len(cards)} cards")
        total_skipped += len(cards)
        continue

    cdn_set = requests.utils.quote(pd_name, safe="")
    print(f"\n  {set_name or set_code}  →  pokedata '{pd_name}'  ({len(cards)} cards)")

    set_updated = 0
    set_missing = 0

    for card in cards:
        card_num = _str(card.get("card_number"))
        if not card_num:
            total_skipped += 1
            continue

        cdn_url = f"{IMAGE_CDN}/{cdn_set}/{card_num}.webp"

        # Check if image exists
        if not image_exists(cdn_url):
            set_missing += 1
            time.sleep(DELAY)
            continue

        final_url = cdn_url

        if args.upload:
            img_bytes = download_image(cdn_url)
            if img_bytes:
                storage_path = f"jp/{set_code or set_name}/{card_num}.webp"
                uploaded = upload_to_storage(storage_path, img_bytes)
                if uploaded:
                    final_url = uploaded

        if not args.dry_run:
            sb.table("catalog").update({"image_url": final_url}).eq("id", card["id"]).execute()

        set_updated += 1
        time.sleep(DELAY)

    print(f"    ✓ {set_updated} updated  |  ✗ {set_missing} not on CDN")
    total_updated += set_updated
    total_missing += set_missing

print(f"""
════════════════════════════════════════
  Image update done!
  ✓ Updated:  {total_updated:,}
  ✗ Missing:  {total_missing:,} (not found on pokedata CDN)
  ⏭ Skipped:  {total_skipped:,} (no pokedata set match)
════════════════════════════════════════
""")


# ══════════════════════════════════════════════════════════════════════════════
# FILL MISSING — create catalog entries for sets pokedata has but TCGdex doesn't
# ══════════════════════════════════════════════════════════════════════════════
if not args.fill_missing:
    sys.exit(0)

print("\n══ FILL MISSING MODE ════════════════════")
print("Probing CDN for sets not yet in catalog…\n")

# Find which set codes are already in catalog
existing_codes = set()
offset = 0
while True:
    res = sb.table("catalog").select("set_code").like("id", "jp-%").range(offset, offset + 999).execute()
    chunk = res.data or []
    existing_codes.update(_str(r.get("set_code")).lower() for r in chunk)
    if len(chunk) < 1000:
        break
    offset += 1000
print(f"  {len(existing_codes)} set codes already in catalog")

# Find pokedata JP sets whose code isn't in catalog
missing_sets = [
    s for s in jp_sets
    if _str(s.get("code")).lower() not in existing_codes
    and _str(s.get("name"))  # must have a name for CDN URL
]

# Apply --only filter
if only_filter:
    only_lower  = only_filter.lower()
    only_code   = pokedata_name_to_code.get(only_lower, only_lower)
    missing_sets = [
        s for s in missing_sets
        if _str(s.get("name")).lower() == only_lower
        or _str(s.get("code")).lower() == only_lower
        or _str(s.get("code")).lower() == only_code
    ]

print(f"  {len(missing_sets)} sets to probe\n")

fill_created = 0
fill_skipped = 0

for set_stub in missing_sets:
    pd_name  = _str(set_stub.get("name"))
    pd_code  = _str(set_stub.get("code"))
    pd_series= _str(set_stub.get("series"))
    cdn_set  = requests.utils.quote(pd_name, safe="")

    print(f"  {pd_code:8s}  {pd_name}", end="", flush=True)

    # Probe card numbers sequentially until 3 consecutive misses
    # (gap of 3 handles secret rares that skip numbers)
    found_cards = []
    card_num    = 1
    misses      = 0

    while misses < 3 and card_num <= 500:  # 500 is a safe upper bound
        cdn_url = f"{IMAGE_CDN}/{cdn_set}/{card_num}.webp"
        if image_exists(cdn_url):
            found_cards.append((str(card_num), cdn_url))
            misses = 0
        else:
            misses += 1
        card_num += 1
        time.sleep(DELAY)

    if not found_cards:
        print(f"  — no images found on CDN")
        fill_skipped += 1
        continue

    print(f"  — {len(found_cards)} images found")

    if args.dry_run:
        fill_created += len(found_cards)
        continue

    # Upsert catalog rows for each found card
    rows = []
    for num, url in found_cards:
        rows.append({
            "id":          f"pd-{pd_code}-{num}",
            "name":        "",           # unknown — no auth to get names
            "set_name":    pd_name,      # English name from pokedata
            "set_code":    pd_code,
            "card_number": num,
            "rarity":      "",
            "image_url":   url,
        })

    # Upsert in batches
    BATCH = 50
    for i in range(0, len(rows), BATCH):
        try:
            sb.table("catalog").upsert(rows[i:i+BATCH], on_conflict="id").execute()
        except Exception as e:
            print(f"    ✗ Upsert error: {e}")

    fill_created += len(found_cards)

print(f"""
════════════════════════════════════════
  Fill-missing done!
  ✓ Created:  {fill_created:,} new catalog entries
  ⏭ Skipped:  {fill_skipped:,} sets (no images on CDN)
════════════════════════════════════════

Note: new entries have blank card names.
Run generate_embeddings.py next to add CLIP embeddings for scanner matching.
""")
