#!/usr/bin/env python3
"""
PathBinder — EN Catalog Cleanup
=================================
Removes Japanese cards that ended up in the English catalog by mistake.

PROBLEM:
  The catalog table contains entries with id like "en-SSP-001", but some
  have set_code values (e.g. "JP") that don't exist in the set_map table.
  These are cards that got pulled into the EN catalog by mistake and need
  to be removed.

SOLUTION:
  1. Load all valid pd_code values from set_map
  2. Load all distinct set_code values from catalog where id LIKE 'en-%'
  3. Identify set_codes NOT in set_map → these are orphaned/wrongly-placed
  4. Preview (--dry-run) or delete (--delete) in batches of 50

USAGE:
    python3 cleanup_en_catalog.py             # dry-run (default)
    python3 cleanup_en_catalog.py --dry-run   # explicit dry-run
    python3 cleanup_en_catalog.py --delete    # actually delete
"""

import os, sys, argparse

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing supabase. Run: pip3 install supabase --break-system-packages")


# ══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════════════════════
SUPABASE_URL = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or input("Service role key: ").strip()
BATCH_SIZE   = 50   # rows per delete batch


# ══════════════════════════════════════════════════════════════════════════════
# ARGS
# ══════════════════════════════════════════════════════════════════════════════
parser = argparse.ArgumentParser(description="Remove wrongly-placed Japanese cards from EN catalog")
parser.add_argument("--dry-run", action="store_true", default=True, dest="dry_run",
                    help="Preview what would be deleted (default)")
parser.add_argument("--delete", action="store_false", dest="dry_run",
                    help="Actually execute the deletes")
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
# HELPER
# ══════════════════════════════════════════════════════════════════════════════
def _str(val):
    """Return string value or empty string if None/not string."""
    return val if isinstance(val, str) else ""


# ══════════════════════════════════════════════════════════════════════════════
# LOAD VALID SET CODES FROM SET_MAP
# ══════════════════════════════════════════════════════════════════════════════
print("\nLoading valid set codes from set_map…")
try:
    res = sb.table("set_map").select("pd_code").execute()
    valid_set_codes = {_str(r.get("pd_code")) for r in (res.data or [])}
    print(f"  {len(valid_set_codes)} valid EN set codes loaded")
except Exception as e:
    sys.exit(f"✗ Cannot load set_map: {e}")

if not valid_set_codes:
    sys.exit("✗ set_map is empty. No valid set codes to match against.")


# ══════════════════════════════════════════════════════════════════════════════
# LOAD ALL DISTINCT SET_CODES FROM EN CATALOG ENTRIES
# ══════════════════════════════════════════════════════════════════════════════
print("\nScanning EN catalog entries…")
en_set_codes = set()
offset = 0

while True:
    try:
        res = sb.table("catalog").select("set_code").like("id", "en-%").range(offset, offset + 999).execute()
        chunk = res.data or []
        for row in chunk:
            code = _str(row.get("set_code"))
            if code:
                en_set_codes.add(code)

        if len(chunk) < 1000:
            break
        offset += 1000
    except Exception as e:
        sys.exit(f"✗ Cannot scan catalog: {e}")

print(f"  Found {len(en_set_codes)} distinct set_codes in EN catalog")


# ══════════════════════════════════════════════════════════════════════════════
# IDENTIFY ORPHANED SET CODES
# ══════════════════════════════════════════════════════════════════════════════
orphaned_codes = en_set_codes - valid_set_codes

if not orphaned_codes:
    print("\n✓ No orphaned set codes found — catalog is clean!")
    sys.exit(0)

print(f"\n⚠ Found {len(orphaned_codes)} orphaned set codes:")
for code in sorted(orphaned_codes):
    print(f"    {code}")


# ══════════════════════════════════════════════════════════════════════════════
# COUNT ROWS TO DELETE
# ══════════════════════════════════════════════════════════════════════════════
print("\nCounting rows to delete…")
total_to_delete = 0

for code in orphaned_codes:
    try:
        res = sb.table("catalog").select("id", count="exact").eq("set_code", code).like("id", "en-%").execute()
        count = res.count or 0
        total_to_delete += count
        if count > 0:
            print(f"    {code:<10} → {count:>5} rows")
    except Exception as e:
        print(f"    {code:<10} → ERROR: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# DRY-RUN OR DELETE
# ══════════════════════════════════════════════════════════════════════════════
print(f"""
════════════════════════════════════════
  Affected sets: {len(orphaned_codes)}
  Rows to delete: {total_to_delete:,}
  Mode: {'DRY-RUN' if args.dry_run else 'DELETE'}
════════════════════════════════════════
""")

if args.dry_run:
    print("(No changes made — use --delete to execute)")
    sys.exit(0)

# Actually delete
print("\nDeleting orphaned entries…")
total_deleted = 0

for code in orphaned_codes:
    print(f"  {code:<10} ", end="", flush=True)

    # Fetch all rows for this set_code in batches, then delete in batches
    rows_deleted_for_code = 0
    offset = 0

    while True:
        try:
            # Fetch a page of IDs for this set code
            res = sb.table("catalog").select("id").eq("set_code", code).like("id", "en-%").range(offset, offset + 999).execute()
            batch = res.data or []
            if not batch:
                break

            # Batch-delete using .in_() — much faster than row-by-row
            for i in range(0, len(batch), BATCH_SIZE):
                delete_ids = [r["id"] for r in batch[i:i+BATCH_SIZE]]
                try:
                    sb.table("catalog").delete().in_("id", delete_ids).execute()
                    rows_deleted_for_code += len(delete_ids)
                except Exception as e:
                    print(f"\n    ✗ Delete error: {e}")

            if len(batch) < 1000:
                break
            offset += 1000
        except Exception as e:
            print(f"\n    ✗ Fetch error: {e}")
            break

    print(f"→ {rows_deleted_for_code} deleted")
    total_deleted += rows_deleted_for_code


# ══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
print(f"""
════════════════════════════════════════
  Cleanup complete!
  ✓ Sets affected:  {len(orphaned_codes)}
  ✓ Rows deleted:   {total_deleted:,}
════════════════════════════════════════
""")
