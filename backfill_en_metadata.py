#!/usr/bin/env python3
"""
PathBinder — EN Catalog Metadata Backfill
==========================================
Fills in blank name, rarity, and supertype fields for en- catalog entries
by looking up each card on pokemontcg.io using the set_map table.

Matches on: ptcg set code + card number (zero-padded → stripped for PTCG)

USAGE:
    python3 backfill_en_metadata.py             # backfill all blank entries
    python3 backfill_en_metadata.py --dry-run   # preview without writing
    python3 backfill_en_metadata.py --set sv8   # one ptcg set code only
"""

import os, sys, re, time, argparse
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
PTCG_BASE       = "https://api.pokemontcg.io/v2"
REQUEST_TIMEOUT = 30
DELAY           = 0.1   # seconds between PTCG API calls (be polite)
BATCH_SIZE      = 50    # cards per Supabase upsert


# ══════════════════════════════════════════════════════════════════════════════
# ARGS
# ══════════════════════════════════════════════════════════════════════════════
parser = argparse.ArgumentParser(description="Backfill EN catalog metadata from pokemontcg.io")
parser.add_argument("--dry-run", action="store_true", help="Preview without writing to DB")
parser.add_argument("--set",     type=str, default=None, help="Only process this ptcg set code (e.g. sv8)")
parser.add_argument("--force",   action="store_true", help="Re-fetch even if name already populated")
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

def _str(val):
    return val if isinstance(val, str) else ""


# ══════════════════════════════════════════════════════════════════════════════
# LOAD SET MAP (pd_code → ptcg_code)
# ══════════════════════════════════════════════════════════════════════════════
print("\nLoading set map…")
try:
    res = sb.table("set_map").select("ptcg_code,pd_code").execute()
    # pd_code → ptcg_code  (e.g. "SSP" → "sv8")
    pd_to_ptcg = {r["pd_code"]: r["ptcg_code"] for r in (res.data or [])}
    print(f"  {len(pd_to_ptcg)} set mappings loaded")
except Exception as e:
    sys.exit(f"✗ Cannot load set_map: {e}\n  Make sure build_set_map.py has been run.")


# ══════════════════════════════════════════════════════════════════════════════
# LOAD EN CATALOG ENTRIES WITH BLANK NAMES
# ══════════════════════════════════════════════════════════════════════════════
print("\nLoading EN catalog entries to backfill…")

catalog_cards = []
offset = 0
while True:
    q = sb.table("catalog").select("id,set_code,card_number,name,rarity")
    q = q.like("id", "en-%")

    if not args.force:
        # Only fetch entries with blank name
        q = q.or_("name.is.null,name.eq.")

    if args.set:
        # Resolve ptcg code → pd code for filtering
        pd_code = next((pd for pd, ptcg in pd_to_ptcg.items() if ptcg == args.set), None)
        if pd_code:
            q = q.eq("set_code", pd_code)
        else:
            sys.exit(f"✗ ptcg set code '{args.set}' not found in set_map.")

    res = q.range(offset, offset + 999).execute()
    chunk = res.data or []
    catalog_cards.extend(chunk)
    if len(chunk) < 1000:
        break
    offset += 1000

print(f"  {len(catalog_cards):,} entries need metadata")

if not catalog_cards:
    print("\nNothing to backfill — all entries already have names.")
    sys.exit(0)


# ══════════════════════════════════════════════════════════════════════════════
# GROUP BY SET CODE (minimise PTCG API calls — fetch whole set at once)
# ══════════════════════════════════════════════════════════════════════════════
from collections import defaultdict
by_set = defaultdict(list)
for card in catalog_cards:
    by_set[_str(card.get("set_code"))].append(card)

print(f"  Across {len(by_set)} sets\n")


# ══════════════════════════════════════════════════════════════════════════════
# FETCH + MATCH + UPDATE
# ══════════════════════════════════════════════════════════════════════════════
total_updated = 0
total_missing = 0
total_skipped = 0

for pd_code, cards in by_set.items():
    ptcg_code = pd_to_ptcg.get(pd_code)
    if not ptcg_code:
        print(f"  ⚠ No ptcg mapping for pd_code '{pd_code}' — skipping {len(cards)} cards")
        total_skipped += len(cards)
        continue

    print(f"  {ptcg_code:<12} ({pd_code})  {len(cards)} cards", end="", flush=True)

    # Fetch ALL cards in this set from pokemontcg.io in one call
    ptcg_cards = []
    page = 1
    while True:
        try:
            r = _session.get(
                f"{PTCG_BASE}/cards",
                params={"q": f"set.id:{ptcg_code}", "pageSize": 250, "page": page,
                        "select": "id,name,number,rarity,supertype"},
                timeout=REQUEST_TIMEOUT
            )
            r.raise_for_status()
            data = r.json()
            ptcg_cards.extend(data.get("data", []))
            if len(data.get("data", [])) < 250:
                break
            page += 1
            time.sleep(DELAY)
        except Exception as e:
            print(f"\n    ⚠ PTCG API error: {e}")
            break

    if not ptcg_cards:
        print(f"  — no PTCG data")
        total_missing += len(cards)
        continue

    # Build lookup: stripped card number → ptcg card data
    # PTCG numbers are like "1", "52", "SV001" — strip leading zeros for matching
    ptcg_by_num = {}
    for c in ptcg_cards:
        num = _str(c.get("number"))
        # Store by both raw number and zero-padded (for matching our 001 format)
        ptcg_by_num[num] = c
        # Also store stripped version
        stripped = num.lstrip("0") or "0"
        ptcg_by_num[stripped] = c

    # Match our catalog entries to PTCG cards
    updates = []
    set_updated = 0
    set_missing = 0

    for card in cards:
        our_num = _str(card.get("card_number"))   # e.g. "001"
        stripped = our_num.lstrip("0") or "0"     # e.g. "1"

        ptcg = ptcg_by_num.get(our_num) or ptcg_by_num.get(stripped)

        if not ptcg:
            set_missing += 1
            continue

        updates.append({
            "id":        card["id"],
            "name":      _str(ptcg.get("name")),
            "rarity":    _str(ptcg.get("rarity")),
            "supertype": _str(ptcg.get("supertype")),
        })
        set_updated += 1

    print(f"  → {set_updated} matched  {f'| {set_missing} not found' if set_missing else ''}")

    if args.dry_run or not updates:
        total_updated += set_updated
        total_missing += set_missing
        continue

    # Upsert in batches
    for i in range(0, len(updates), BATCH_SIZE):
        try:
            sb.table("catalog").upsert(updates[i:i+BATCH_SIZE], on_conflict="id").execute()
        except Exception as e:
            print(f"    ✗ Upsert error: {e}")

    total_updated += set_updated
    total_missing += set_missing
    time.sleep(DELAY)


# ══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
print(f"""
════════════════════════════════════════
  Metadata backfill {'(dry-run) ' if args.dry_run else ''}done!
  ✓ Updated:  {total_updated:,}
  ✗ Missing:  {total_missing:,} (no matching card on pokemontcg.io)
  ⏭ Skipped:  {total_skipped:,} (no set_map entry)
════════════════════════════════════════
""")
