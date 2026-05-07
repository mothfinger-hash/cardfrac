#!/usr/bin/env python3
"""
PathBinder — Translate JP Set Names to English
===============================================
Fetches English set names from TCGdex and updates catalog rows where
the set_name is currently in Japanese (or otherwise non-English).

HOW IT WORKS:
  1. Load all distinct (set_code, set_name) from catalog where id LIKE 'jp-%'
  2. For each set_code, fetch https://api.tcgdex.net/v2/en/sets/{code}
     (the BULK /en/sets endpoint only returns EN-language sets — JP sets
      must be looked up individually to get their English names)
  3. Compare current set_name to the English name from TCGdex
  4. If they differ → queue an UPDATE
  5. Preview (--dry-run) or apply (--update) the changes

USAGE:
    # Easiest — enter key when prompted:
    python3 translate_jp_set_names.py
    python3 translate_jp_set_names.py --update

    # Pass key inline:
    python3 translate_jp_set_names.py --key YOUR_SERVICE_KEY
    python3 translate_jp_set_names.py --key YOUR_SERVICE_KEY --update

    # Or export first, then run:
    export SUPABASE_SERVICE_KEY="YOUR_SERVICE_KEY"
    python3 translate_jp_set_names.py --update
"""

import os, sys, argparse, json, time, urllib.request, urllib.error

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing supabase. Run: pip3 install supabase --break-system-packages")


# ══════════════════════════════════════════════════════════════════════════════
# ARGS  (parsed first so --key and --update are available before key prompt)
# ══════════════════════════════════════════════════════════════════════════════
parser = argparse.ArgumentParser(description="Translate JP catalog set names to English via TCGdex")
parser.add_argument("--key",     metavar="SERVICE_KEY", default=None,
                    help="Supabase service role key (overrides env var)")
parser.add_argument("--dry-run", action="store_true", default=True, dest="dry_run",
                    help="Preview what would change (default)")
parser.add_argument("--update",  action="store_false", dest="dry_run",
                    help="Actually apply the updates")
args = parser.parse_args()


# ══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════════════════════
SUPABASE_URL   = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY   = args.key or os.environ.get("SUPABASE_SERVICE_KEY") or input("Service role key: ").strip()
TCGDEX_BASE    = "https://api.tcgdex.net/v2/en/sets"
BATCH_SIZE     = 100   # rows per update batch
REQUEST_DELAY  = 0.15  # seconds between TCGdex requests (be polite)


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
# HELPER: FETCH ONE SET FROM TCGDEX
# ══════════════════════════════════════════════════════════════════════════════
def fetch_tcgdex_set(set_code):
    """
    Returns the English name for a TCGdex set ID, or None if not found.
    Fetches /v2/en/sets/{set_code} — works for JP-only sets too.
    """
    url = f"{TCGDEX_BASE}/{set_code}"
    try:
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "User-Agent": "PathBinder/1.0"
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            return (data.get("name") or "").strip() or None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None   # set not in TCGdex at all
        print(f"    HTTP {e.code} for {set_code}")
        return None
    except Exception as e:
        print(f"    Error fetching {set_code}: {e}")
        return None


# ══════════════════════════════════════════════════════════════════════════════
# LOAD DISTINCT (set_code, set_name) FROM JP CATALOG
# ══════════════════════════════════════════════════════════════════════════════
print("\nLoading distinct JP set codes from catalog…")
jp_sets = {}   # set_code → current set_name (first seen)
offset  = 0

while True:
    try:
        res = (
            sb.table("catalog")
              .select("set_code,set_name")
              .like("id", "jp-%")
              .range(offset, offset + 999)
              .execute()
        )
        chunk = res.data or []
        for row in chunk:
            code = (row.get("set_code") or "").strip()
            name = (row.get("set_name") or "").strip()
            if code and code not in jp_sets:
                jp_sets[code] = name
        if len(chunk) < 1000:
            break
        offset += 1000
    except Exception as e:
        sys.exit(f"✗ Cannot scan jp catalog: {e}")

print(f"  {len(jp_sets)} distinct JP set codes found")


# ══════════════════════════════════════════════════════════════════════════════
# LOOK UP ENGLISH NAMES FROM TCGDEX (one request per set)
# ══════════════════════════════════════════════════════════════════════════════
print(f"\nLooking up English names from TCGdex ({len(jp_sets)} sets)…")
tcgdex_map   = {}   # set_code → english_name
not_in_tcgdex = []

for i, code in enumerate(sorted(jp_sets.keys()), 1):
    en_name = fetch_tcgdex_set(code)
    if en_name:
        tcgdex_map[code] = en_name
        print(f"  [{i:>3}/{len(jp_sets)}] {code:<14} → {en_name}")
    else:
        not_in_tcgdex.append(code)
        print(f"  [{i:>3}/{len(jp_sets)}] {code:<14} → (not in TCGdex)")
    if i < len(jp_sets):
        time.sleep(REQUEST_DELAY)

print(f"\n  {len(tcgdex_map)} sets resolved, {len(not_in_tcgdex)} not found in TCGdex")


# ══════════════════════════════════════════════════════════════════════════════
# DIFF: FIND SETS WHERE NAME NEEDS UPDATING
# ══════════════════════════════════════════════════════════════════════════════
to_update = []   # list of (set_code, old_name, new_name)

for code, current_name in sorted(jp_sets.items()):
    if code in tcgdex_map:
        english_name = tcgdex_map[code]
        if current_name != english_name:
            to_update.append((code, current_name, english_name))


# ══════════════════════════════════════════════════════════════════════════════
# REPORT
# ══════════════════════════════════════════════════════════════════════════════
if to_update:
    print(f"\n{'SET CODE':<14}  {'CURRENT NAME':<45}  NEW NAME")
    print("─" * 100)
    for code, old, new in to_update:
        marker = "  ✓" if old == new else "  →"
        print(f"  {code:<12}  {old:<45}{marker}  {new}")
else:
    print("\n✓ All matched JP set names are already in English — nothing to do!")

if not_in_tcgdex:
    print(f"\n  ℹ  {len(not_in_tcgdex)} set code(s) not found in TCGdex (promos / pd-fills / custom):")
    for code in sorted(not_in_tcgdex):
        print(f"      {code:<14}  (current: {jp_sets[code]!r})")

print(f"""
════════════════════════════════════════
  JP set codes scanned:  {len(jp_sets)}
  Resolved via TCGdex:   {len(tcgdex_map)}
  Names to update:       {len(to_update)}
  Not found in TCGdex:   {len(not_in_tcgdex)}
  Mode: {'DRY-RUN' if args.dry_run else 'UPDATE'}
════════════════════════════════════════
""")

if not to_update:
    sys.exit(0)

if args.dry_run:
    print("(No changes made — use --update to apply)")
    sys.exit(0)


# ══════════════════════════════════════════════════════════════════════════════
# APPLY UPDATES
# ══════════════════════════════════════════════════════════════════════════════
print("Applying updates…\n")
total_rows_updated = 0
errors = []

for code, old_name, new_name in to_update:
    print(f"  {code:<12}  {old_name!r}  →  {new_name!r}")

    updated_for_code = 0
    offset2 = 0

    while True:
        try:
            id_res = (
                sb.table("catalog")
                  .select("id")
                  .eq("set_code", code)
                  .like("id", "jp-%")
                  .range(offset2, offset2 + 999)
                  .execute()
            )
            batch_rows = id_res.data or []
            if not batch_rows:
                break

            for i in range(0, len(batch_rows), BATCH_SIZE):
                ids = [r["id"] for r in batch_rows[i : i + BATCH_SIZE]]
                try:
                    sb.table("catalog").update({"set_name": new_name}).in_("id", ids).execute()
                    updated_for_code += len(ids)
                except Exception as e:
                    print(f"\n             ✗ Update error: {e}")
                    errors.append((code, str(e)))

            if len(batch_rows) < 1000:
                break
            offset2 += 1000

        except Exception as e:
            print(f"\n             ✗ Fetch error: {e}")
            errors.append((code, str(e)))
            break

    print(f"             ✓ {updated_for_code:,} rows updated")
    total_rows_updated += updated_for_code


# ══════════════════════════════════════════════════════════════════════════════
# FINAL SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
print(f"""
════════════════════════════════════════
  Translation complete!
  ✓ Sets renamed:   {len(to_update) - len(errors)}
  ✓ Rows updated:   {total_rows_updated:,}
  ✗ Errors:         {len(errors)}
════════════════════════════════════════
""")

if errors:
    print("Errors encountered:")
    for code, msg in errors:
        print(f"  {code}: {msg}")
