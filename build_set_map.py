#!/usr/bin/env python3
"""
PathBinder — Set Code Mapping Builder
======================================
Matches pokemontcg.io set codes (e.g. 'sv8pt5') to pokedata.io set codes
(e.g. 'SSP') and populates the set_map table in Supabase.

This is what lets the app swap in your hosted Supabase Storage images
instead of pulling from pokemontcg.io's CDN.

SETUP:
    Run this SQL in Supabase SQL Editor first:

    CREATE TABLE IF NOT EXISTS set_map (
        ptcg_code  TEXT PRIMARY KEY,
        pd_code    TEXT NOT NULL,
        set_name   TEXT,
        matched    BOOLEAN DEFAULT true
    );

USAGE:
    python3 build_set_map.py            # build + upload mapping
    python3 build_set_map.py --dry-run  # print matches without writing to DB
"""

import os, sys, re, json, argparse, unicodedata
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
PTCG_SETS_URL   = "https://api.pokemontcg.io/v2/sets?pageSize=250&orderBy=releaseDate"
REQUEST_TIMEOUT = 45

parser = argparse.ArgumentParser()
parser.add_argument("--dry-run", action="store_true", help="Print matches without writing to DB")
args = parser.parse_args()


# ══════════════════════════════════════════════════════════════════════════════
# SUPABASE
# ══════════════════════════════════════════════════════════════════════════════
sb = create_client(SUPABASE_URL, SUPABASE_KEY)
try:
    sb.table("set_map").select("ptcg_code", count="exact").limit(1).execute()
    print("✓ Supabase connected")
except Exception as e:
    sys.exit(f"✗ Cannot reach set_map table: {e}\n\n"
             "  Make sure you've run this in Supabase SQL Editor:\n\n"
             "  CREATE TABLE IF NOT EXISTS set_map (\n"
             "      ptcg_code  TEXT PRIMARY KEY,\n"
             "      pd_code    TEXT NOT NULL,\n"
             "      set_name   TEXT,\n"
             "      matched    BOOLEAN DEFAULT true\n"
             "  );\n")


# ══════════════════════════════════════════════════════════════════════════════
# HTTP
# ══════════════════════════════════════════════════════════════════════════════
_session = requests.Session()
_session.headers.update({"User-Agent": "PathBinder/1.0 (contact: charles@merchunlimited.com)"})

def _str(val):
    return val if isinstance(val, str) else ""


# ══════════════════════════════════════════════════════════════════════════════
# NORMALIZE set name for matching
# ══════════════════════════════════════════════════════════════════════════════
_SUBS = [
    (r"[''']", ""),           # smart quotes
    (r"[&+]", "and"),         # & → and
    (r"\bex\b", "ex"),        # preserve ex
    (r"[^a-z0-9 ]", ""),      # strip everything else
    (r"\s+", " "),            # collapse spaces
]

def normalize(name):
    n = unicodedata.normalize("NFKD", name.lower())
    n = n.encode("ascii", "ignore").decode()
    for pat, rep in _SUBS:
        n = re.sub(pat, rep, n)
    return n.strip()


# ══════════════════════════════════════════════════════════════════════════════
# FETCH POKEMONTCG.IO SETS
# ══════════════════════════════════════════════════════════════════════════════
print("\nFetching pokemontcg.io set list…")
try:
    r = _session.get(PTCG_SETS_URL, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    ptcg_sets = r.json().get("data", [])
except Exception as e:
    sys.exit(f"✗ Could not fetch pokemontcg.io sets: {e}")
print(f"  {len(ptcg_sets)} sets found")

# Build lookup: normalized_name → {id, name, series, releaseDate}
ptcg_by_name = {}
for s in ptcg_sets:
    key = normalize(_str(s.get("name")))
    ptcg_by_name[key] = s


# ══════════════════════════════════════════════════════════════════════════════
# FETCH POKEDATA EN SETS
# ══════════════════════════════════════════════════════════════════════════════
print("Fetching pokedata.io EN set list…")
try:
    r = _session.get(f"{POKEDATA_BASE}/sets", timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    html = r.text
except Exception as e:
    sys.exit(f"✗ Could not fetch pokedata sets page: {e}")

match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
if not match:
    sys.exit("✗ No __NEXT_DATA__ found on pokedata sets page.")

page_props = json.loads(match.group(1)).get("props", {}).get("pageProps", {})
all_sets   = page_props.get("setInfoArr", [])
en_sets    = [s for s in all_sets if _str(s.get("language")).upper() == "ENGLISH"]
print(f"  {len(en_sets)} EN sets found")


# ══════════════════════════════════════════════════════════════════════════════
# MATCH
# ══════════════════════════════════════════════════════════════════════════════
print("\nMatching sets…\n")

matched   = []
unmatched = []

for pd_set in en_sets:
    pd_name = _str(pd_set.get("name"))
    pd_code = _str(pd_set.get("code"))
    if not pd_name or not pd_code:
        continue

    key = normalize(pd_name)
    ptcg = ptcg_by_name.get(key)

    if ptcg:
        matched.append({
            "ptcg_code": ptcg["id"],
            "pd_code":   pd_code,
            "set_name":  pd_name,
            "matched":   True,
        })
        print(f"  ✓  {ptcg['id']:<12} ↔  {pd_code:<10}  {pd_name}")
    else:
        # Try partial match (pokedata name contained in ptcg name or vice versa)
        partial = None
        for ptcg_key, ptcg_s in ptcg_by_name.items():
            if key in ptcg_key or ptcg_key in key:
                partial = ptcg_s
                break

        if partial:
            matched.append({
                "ptcg_code": partial["id"],
                "pd_code":   pd_code,
                "set_name":  pd_name,
                "matched":   True,
            })
            print(f"  ~  {partial['id']:<12} ↔  {pd_code:<10}  {pd_name}  (partial match)")
        else:
            unmatched.append({"pd_code": pd_code, "name": pd_name})
            print(f"  ✗  {'?':<12}    {pd_code:<10}  {pd_name}  ← NO MATCH")

print(f"\n  Matched:   {len(matched)}")
print(f"  Unmatched: {len(unmatched)}")

if unmatched:
    print("\n  Unmatched sets (pokemontcg.io may not carry these):")
    for u in unmatched:
        print(f"    {u['pd_code']:<10}  {u['name']}")

# ── Deduplicate by ptcg_code, keeping first occurrence (exact > partial) ──
seen_ptcg = set()
deduped   = []
for row in matched:
    if row["ptcg_code"] not in seen_ptcg:
        deduped.append(row)
        seen_ptcg.add(row["ptcg_code"])
    else:
        print(f"  (dedup) skipping duplicate ptcg_code {row['ptcg_code']} for {row['pd_code']}")
matched = deduped
print(f"\n  After dedup: {len(matched)} unique ptcg_code mappings")


# ══════════════════════════════════════════════════════════════════════════════
# UPSERT INTO set_map
# ══════════════════════════════════════════════════════════════════════════════
if args.dry_run:
    print("\n[dry-run] No changes written to DB.")
    sys.exit(0)

if not matched:
    sys.exit("\nNo matches found — nothing to write.")

print(f"\nUpserting {len(matched)} rows into set_map…")
BATCH = 50
inserted = 0
for i in range(0, len(matched), BATCH):
    try:
        sb.table("set_map").upsert(matched[i:i+BATCH], on_conflict="ptcg_code").execute()
        inserted += len(matched[i:i+BATCH])
    except Exception as e:
        print(f"  ✗ Upsert error: {e}")

print(f"""
════════════════════════════════════════
  Set map built!
  ✓ Mapped:    {inserted}
  ✗ Unmatched: {len(unmatched)} (pokemontcg.io likely doesn't carry these)
════════════════════════════════════════

Next step: run wire_catalog_images.py (or update index.html) to use
set_map for image lookups.
""")
