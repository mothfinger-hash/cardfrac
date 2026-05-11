#!/usr/bin/env python3
"""
PathBinder — Supabase Storage PNG Cleanup
==========================================
Lists and (optionally) deletes .png files in Supabase Storage buckets.
Use after the Pokedata webp mirror to reclaim space from older PNG uploads
that pre-date the client-side webp encoding in cpSavePhoto.

USAGE:
    # Audit only (read-only — recommended first)
    python3 cleanup_png_storage.py

    # Audit one specific bucket
    python3 cleanup_png_storage.py --bucket card-images

    # Show what would be deleted, but don't actually delete
    python3 cleanup_png_storage.py --delete --dry-run

    # Actually delete every .png in every bucket
    python3 cleanup_png_storage.py --delete --confirm

    # Delete but spare specific paths (substring match)
    python3 cleanup_png_storage.py --delete --confirm \\
        --keep "default-cover.png" --keep "icons/"

REQUIREMENTS:
    pip3 install supabase --break-system-packages

ENVIRONMENT:
    SUPABASE_SERVICE_KEY   Supabase service-role / secret key
"""

import os, sys, argparse

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing 'supabase'. Run: pip3 install supabase --break-system-packages")


# ═════════════════════════════════════════════════════════════════════════════
# CONFIG
# ═════════════════════════════════════════════════════════════════════════════
SUPABASE_URL = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or input("Supabase service-role key: ").strip()
LIST_BATCH   = 1000


# ═════════════════════════════════════════════════════════════════════════════
# ARGS
# ═════════════════════════════════════════════════════════════════════════════
parser = argparse.ArgumentParser(description="Find and delete .png files in Supabase Storage")
parser.add_argument("--bucket", type=str, default=None,
    help="Limit to one bucket (default: scan all buckets)")
parser.add_argument("--delete", action="store_true",
    help="Actually delete the PNGs (default is audit-only)")
parser.add_argument("--dry-run", action="store_true",
    help="With --delete, show what would be deleted but don't do it")
parser.add_argument("--confirm", action="store_true",
    help="Required with --delete (not in dry-run mode) to actually fire deletes")
parser.add_argument("--keep", action="append", default=[],
    help="Substring(s) to SPARE from deletion. Can be passed multiple times. "
         "e.g. --keep 'default-cover.png' --keep 'avatars/'")
parser.add_argument("--bucket-filter", type=str, default=None,
    help="Substring to filter bucket names (e.g. 'card' matches card-images)")

args = parser.parse_args()


# ═════════════════════════════════════════════════════════════════════════════
# SUPABASE
# ═════════════════════════════════════════════════════════════════════════════
sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def list_buckets():
    """Return list of bucket dicts."""
    try:
        return sb.storage.list_buckets()
    except Exception as e:
        sys.exit(f"✗ Failed to list buckets: {e}")


def list_objects(bucket_id, path="", _depth=0):
    """Recursively list every object in a bucket. Returns flat list of
    {name, path, size, mimetype} dicts (path is the full key including folders)."""
    if _depth > 30:
        return []     # safety cap on recursion depth
    results = []
    offset = 0
    while True:
        try:
            page = sb.storage.from_(bucket_id).list(
                path,
                {"limit": LIST_BATCH, "offset": offset,
                 "sortBy": {"column": "name", "order": "asc"}}
            )
        except Exception as e:
            print(f"  ⚠ {bucket_id}/{path}: {e}")
            return results

        if not page:
            break

        for item in page:
            name = item.get("name", "")
            # Supabase distinguishes folders from files: folders have no id,
            # or have metadata=None. Files have id and metadata.
            is_folder = (item.get("id") is None) or (item.get("metadata") is None)
            full_path = f"{path}/{name}" if path else name
            if is_folder:
                results.extend(list_objects(bucket_id, full_path, _depth + 1))
            else:
                meta = item.get("metadata") or {}
                results.append({
                    "name":     name,
                    "path":     full_path,
                    "size":     meta.get("size") or 0,
                    "mimetype": meta.get("mimetype") or "",
                })

        if len(page) < LIST_BATCH:
            break
        offset += LIST_BATCH

    return results


def fmt_size(n):
    """1234567 → '1.18 MB'."""
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.2f} {unit}"
        n /= 1024
    return f"{n:.2f} TB"


# ═════════════════════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════════════════════
print("Listing Supabase Storage buckets…")
buckets = list_buckets()
if args.bucket:
    buckets = [b for b in buckets if b.id == args.bucket or b.name == args.bucket]
if args.bucket_filter:
    buckets = [b for b in buckets
               if args.bucket_filter.lower() in (b.id or "").lower()
               or args.bucket_filter.lower() in (b.name or "").lower()]
if not buckets:
    sys.exit("✗ No buckets matched. Use without --bucket to see them all.")

print(f"  {len(buckets)} bucket(s) to scan")

all_pngs = []   # list of (bucket_id, path, size)
total_size = 0

for b in buckets:
    bid = b.id if hasattr(b, "id") else b.get("id")
    if not bid:
        continue
    print(f"\n  Scanning bucket: {bid}")
    objects = list_objects(bid)
    pngs = [o for o in objects if o["path"].lower().endswith(".png")]
    bucket_total = sum(o["size"] for o in pngs)
    print(f"    {len(objects):,} total objects, {len(pngs):,} PNGs ({fmt_size(bucket_total)})")

    for o in pngs[:3]:
        print(f"      sample: {o['path']}  ({fmt_size(o['size'])})")
    if len(pngs) > 3:
        print(f"      … and {len(pngs)-3} more")

    for o in pngs:
        all_pngs.append((bid, o["path"], o["size"]))
        total_size += o["size"]

print(f"\n  ════════════════════════════════════")
print(f"  PNG summary across {len(buckets)} bucket(s):")
print(f"    Total files:  {len(all_pngs):,}")
print(f"    Total size:   {fmt_size(total_size)}")
print(f"  ════════════════════════════════════")

if not args.delete:
    print("\n  Audit only — pass --delete to remove these files.")
    print("  Add --dry-run with --delete to see what would be removed without deleting.")
    sys.exit(0)


# ═════════════════════════════════════════════════════════════════════════════
# DELETION
# ═════════════════════════════════════════════════════════════════════════════
# Filter out anything matched by --keep substrings
keep_patterns = [p.lower() for p in args.keep]
def is_kept(path):
    pl = path.lower()
    return any(kp in pl for kp in keep_patterns)

to_delete = [(b, p, s) for (b, p, s) in all_pngs if not is_kept(p)]
spared    = len(all_pngs) - len(to_delete)

print(f"\n  Spared by --keep patterns:  {spared:,}")
print(f"  Marked for deletion:        {len(to_delete):,}  ({fmt_size(sum(s for _,_,s in to_delete))})")

if not to_delete:
    print("  Nothing to delete.")
    sys.exit(0)

if args.dry_run:
    print("\n  Dry-run sample (first 10):")
    for bid, path, size in to_delete[:10]:
        print(f"    {bid}/{path}  ({fmt_size(size)})")
    sys.exit(0)

if not args.confirm:
    sys.exit("\n  ✗ Refusing to delete without --confirm. Re-run with --confirm to proceed.")

# Group by bucket and batch the delete calls
print(f"\n  Deleting {len(to_delete):,} files…")
by_bucket = {}
for bid, path, _ in to_delete:
    by_bucket.setdefault(bid, []).append(path)

deleted = 0
errors  = 0
DELETE_BATCH = 100   # supabase storage remove() takes a list

for bid, paths in by_bucket.items():
    for i in range(0, len(paths), DELETE_BATCH):
        chunk = paths[i:i+DELETE_BATCH]
        try:
            sb.storage.from_(bid).remove(chunk)
            deleted += len(chunk)
            print(f"    {bid}: {deleted}/{len(paths)}")
        except Exception as e:
            errors += len(chunk)
            print(f"    ✗ {bid} chunk failed: {e}")

print(f"\n  ════════════════════════════════════")
print(f"  Cleanup done:")
print(f"    Deleted: {deleted:,}")
print(f"    Errors:  {errors:,}")
print(f"  ════════════════════════════════════")
