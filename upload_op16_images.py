#!/usr/bin/env python3
"""
upload_op16_images.py

Convert the scraped OP16 card PNGs to WebP and upload them to the
PathBinder Supabase Storage bucket, matching the image_url values in
migration_add_op16.sql.

  Storage layout : card-images/op/op16/<CODE>.webp
  Public URL     : {SUPABASE_URL}/storage/v1/object/public/card-images/op/op16/<CODE>.webp
  <CODE>         : the official card code = each PNG's filename
                   (e.g. OP16-001, OP16-001_p1, OP10-045_p2)

Idempotent: re-running re-uploads with upsert=true, so it's safe to stop
and restart. Matches the convention in pokedata_sync.py (mode_mirror_images).

USAGE
  pip install supabase pillow
  export SUPABASE_SERVICE_KEY="<your service-role key>"
  python3 upload_op16_images.py --images ./OP16_images

  # dry run (convert + report, no upload):
  python3 upload_op16_images.py --images ./OP16_images --dry-run
"""

import argparse, io, os, sys, glob

SUPABASE_URL   = "https://xjamytrhxeaynywcwfun.supabase.co"
STORAGE_BUCKET = "card-images"
STORAGE_PREFIX = "op/op16"          # game prefix / set_code, lowercased


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", default="./OP16_images",
                    help="Folder of scraped PNGs (default ./OP16_images)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Convert + report only; do not upload")
    ap.add_argument("--quality", type=int, default=90, help="WebP quality (default 90)")
    args = ap.parse_args()

    try:
        from PIL import Image
    except ImportError:
        sys.exit("Missing dependency: pip install pillow")

    pngs = sorted(glob.glob(os.path.join(args.images, "*.png")))
    if not pngs:
        sys.exit(f"No PNGs found in {args.images!r}")

    sb = None
    if not args.dry_run:
        key = os.environ.get("SUPABASE_SERVICE_KEY")
        if not key:
            sys.exit("Set SUPABASE_SERVICE_KEY (service-role key) in your environment.")
        try:
            from supabase import create_client
        except ImportError:
            sys.exit("Missing dependency: pip install supabase")
        sb = create_client(SUPABASE_URL, key)

    ok = failed = 0
    for p in pngs:
        code = os.path.splitext(os.path.basename(p))[0]   # OP16-001, OP10-045_p2, ...
        storage_path = f"{STORAGE_PREFIX}/{code}.webp"
        try:
            im = Image.open(p).convert("RGB")
            buf = io.BytesIO()
            im.save(buf, format="WEBP", quality=args.quality, method=6)
            data = buf.getvalue()
        except Exception as e:
            print(f"  CONVERT FAIL {code}: {e}"); failed += 1; continue

        if args.dry_run:
            print(f"  would upload {storage_path}  ({len(data)//1024} KB)"); ok += 1; continue

        last = None
        for attempt in range(3):
            try:
                sb.storage.from_(STORAGE_BUCKET).upload(
                    storage_path, data,
                    file_options={"content-type": "image/webp", "upsert": "true"},
                )
                last = None; break
            except Exception as e:
                last = e
        if last is not None:
            print(f"  UPLOAD FAIL {code}: {last}"); failed += 1
        else:
            print(f"  uploaded {storage_path}"); ok += 1

    print(f"\nDone. ok={ok} failed={failed} total={len(pngs)}")
    if not args.dry_run:
        print(f"Public URL base: {SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{STORAGE_PREFIX}/")


if __name__ == "__main__":
    main()
