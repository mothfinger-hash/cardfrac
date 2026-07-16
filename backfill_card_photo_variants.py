#!/usr/bin/env python3
"""
PathBinder — card-photos variant backfill
=========================================
Generates the missing -200.webp / -400.webp thumbnails for USER-UPLOADED
photos in the `card-photos` bucket, server-side.

Why this exists (and why it is not the browser's job)
----------------------------------------------------
The browser-side pipeline (_imgToWebpAndVariants in pb-app.js) is supposed
to do this at upload time. It has two silent failure modes, both measured:

  1. canvas.toBlob(cb, 'image/webp') is SPEC-MANDATED to fall back to PNG
     when the engine cannot encode WebP. pb-app.js accepts whatever blob
     comes back and _uploadPhotoVariants hardcodes contentType 'image/webp'
     without inspecting blob.type. Result: files named "-200.webp", served
     as image/webp, that are actually PNG bytes — correctly RESIZED, wrongly
     ENCODED, ~141 KB where a real WebP is ~13 KB. Worse than a miss: the
     URL returns 200, so the <img> onerror cascade never fires and the client
     downloads the PNG believing it got a thumbnail. Existence checks cannot
     see this. Only magic bytes can. THIS SCRIPT CHECKS MAGIC BYTES.

  2. Raw 12 MP camera stills (4032x3024) throw inside the canvas path; the
     catch returns variants:{} and console.warns. Nothing is uploaded, so
     storage RLS is never even consulted.

Python/Pillow has no canvas, no WebView memory ceiling and no toBlob
fallback — which is exactly why the card-images bucket (written by the
Python mirror) has ~70% coverage while card-photos/collection/ has ~3%.

EXIF ORIENTATION — the reason this is not just backfill_image_variants.py
-------------------------------------------------------------------------
backfill_image_variants.py is catalog-only (it walks /rest/v1/catalog) and
image_variants.upload_variants does NO EXIF transposition. That is correct
for catalog art, which is already web-normalized. It is WRONG for phone
photos: every 12 MP original measured carries exif_orientation=6 (rotate
90 deg). Feeding those straight to upload_variants would silently generate
SIDEWAYS thumbnails. This script applies ImageOps.exif_transpose first and
hands upload_variants an already-upright PIL Image (it accepts one).

Everything else is reused, not reimplemented: upload_variants already does
LANCZOS + WebP method=6 + upsert:true + the no-upscale skip, and its
_variant_path matches _pickThumbVariant in pb-app.js exactly.

SAFETY
------
  * Writes ONLY to '<stem>-200.webp' / '<stem>-400.webp' sibling paths.
    Originals are never read-modify-written, never renamed, never deleted.
    The detail view and openImageLightbox keep pointing at the originals.
  * Idempotent and re-runnable: a stem whose variants already validate as
    real WebP is skipped.
  * --dry-run does everything except the upload, INCLUDING decoding and
    re-encoding each image, so the reported byte savings are measured, not
    modelled. Dry-run works with the public anon key.

PREREQUISITES
    pip3 install pillow supabase requests --break-system-packages

USAGE
    # Dry run — measures everything, writes nothing. Anon key is enough.
    SUPABASE_URL=https://<ref>.supabase.co \
    SUPABASE_ANON_KEY=<anon> python3 backfill_card_photo_variants.py --dry-run

    # For real (needs the service-role key: uploads are RLS-gated)
    SUPABASE_URL=https://<ref>.supabase.co \
    SUPABASE_SERVICE_KEY=<service_role> python3 backfill_card_photo_variants.py

    # Scope / tune
    ... --prefix collection/<user-uuid>     # one user
    ... --limit 5                           # smoke test
    ... --workers 4
    ... --force                             # re-encode even if variants validate

ENVIRONMENT
    SUPABASE_URL           project URL
    SUPABASE_SERVICE_KEY   service-role key (required for a real run)
    SUPABASE_ANON_KEY      public key (sufficient for --dry-run)
"""

import io
import os
import sys
import argparse
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Requires Pillow.  pip3 install pillow --break-system-packages")

from image_variants import upload_variants, _variant_path, VARIANT_SIZES

BUCKET = "card-photos"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")

_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


def _headers(key):
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def list_prefix(key, prefix, limit=1000):
    """One level of the storage tree. Folders come back with metadata=None."""
    r = requests.post(
        f"{SUPABASE_URL}/storage/v1/object/list/{BUCKET}",
        headers={**_headers(key), "Content-Type": "application/json"},
        json={"prefix": prefix, "limit": limit, "offset": 0,
              "sortBy": {"column": "name", "order": "asc"}},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def walk(key, prefix):
    """Recursively yield object paths under prefix."""
    out = []
    for entry in list_prefix(key, prefix):
        name = entry.get("name")
        if not name:
            continue
        path = f"{prefix.rstrip('/')}/{name}" if prefix else name
        if entry.get("metadata") is None and entry.get("id") is None:
            out.extend(walk(key, path))          # folder
        else:
            out.append(path)
    return out


def public_url(path):
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{path}"


def fetch(path):
    r = requests.get(public_url(path), timeout=60)
    return r.content if r.status_code == 200 else None


def is_real_webp(b):
    """Magic bytes, not filename and not content-type. RIFF....WEBP."""
    return bool(b) and len(b) >= 12 and b[0:4] == b"RIFF" and b[8:12] == b"WEBP"


VARIANT_SUFFIXES = tuple(f"-{w}.webp" for w in VARIANT_SIZES)


def is_variant(path):
    return path.endswith(VARIANT_SUFFIXES)


def main():
    ap = argparse.ArgumentParser(
        description="Backfill -200/-400 WebP variants for user photos in card-photos.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prefix", default="collection",
                    help="storage prefix to walk (default: collection)")
    ap.add_argument("--limit", type=int, default=None, help="max stems to process")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true",
                    help="decode + re-encode + measure, but upload nothing")
    ap.add_argument("--force", action="store_true",
                    help="regenerate even when variants already validate")
    args = ap.parse_args()

    if not SUPABASE_URL:
        sys.exit("Set SUPABASE_URL.")
    key = SERVICE_KEY or ANON_KEY
    if not key:
        sys.exit("Set SUPABASE_SERVICE_KEY (real run) or SUPABASE_ANON_KEY (--dry-run).")
    if not args.dry_run and not SERVICE_KEY:
        sys.exit("A real run needs SUPABASE_SERVICE_KEY — uploads are RLS-gated. "
                 "Use --dry-run with the anon key.")

    mode = "DRY RUN (nothing will be written)" if args.dry_run else "LIVE — WILL WRITE"
    log(f"card-photos variant backfill — {mode}")
    log(f"  bucket={BUCKET}  prefix={args.prefix}  key={'service_role' if SERVICE_KEY else 'anon'}")

    log("\nListing bucket…")
    all_paths = walk(key, args.prefix)
    stems = [p for p in all_paths if not is_variant(p)]
    existing = {p for p in all_paths if is_variant(p)}
    log(f"  {len(all_paths)} objects = {len(stems)} originals + {len(existing)} variant files")

    # Decide what needs work. A stem needs work if any expected variant is
    # absent OR present-but-not-real-WebP (the PNG-in-webp-clothing case).
    todo, fake = [], []
    for stem in stems:
        need = []
        for w in VARIANT_SIZES:
            vp = _variant_path(stem, w)
            if vp not in existing:
                need.append(w)
            elif args.force:
                need.append(w)
            else:
                b = fetch(vp)
                if not is_real_webp(b):
                    need.append(w)
                    fake.append((vp, len(b or b"")))
        if need:
            todo.append(stem)
    if args.limit:
        todo = todo[: args.limit]

    log(f"  {len(todo)} originals need variants")
    if fake:
        log(f"  {len(fake)} EXISTING variants are NOT real WebP (PNG bytes in a .webp name) "
            f"— these will be overwritten:")
        for p, n in fake[:8]:
            log(f"      {p}  ({n/1024:.0f} KB)")

    stats = {"ok": 0, "skip": 0, "err": 0, "src": 0, "out": 0, "rot": 0}

    def work(stem):
        raw = fetch(stem)
        if not raw:
            log(f"  ! download failed: {stem}")
            stats["err"] += 1
            return
        try:
            im = Image.open(io.BytesIO(raw))
            orient = im.getexif().get(274)
            # THE reason this script exists rather than reusing the catalog one.
            im = ImageOps.exif_transpose(im)
            if orient not in (None, 1):
                stats["rot"] += 1
        except Exception as e:
            log(f"  ! decode failed: {stem}: {e}")
            stats["err"] += 1
            return

        stats["src"] += len(raw)

        if args.dry_run:
            # Re-encode for real so the reported savings are measured.
            made = []
            for w in VARIANT_SIZES:
                if w >= im.width:
                    continue
                v = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im
                v = v.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
                buf = io.BytesIO()
                v.save(buf, format="WEBP", quality=78, method=6)
                stats["out"] += buf.tell()
                made.append(f"{w}px={buf.tell()/1024:.0f}KB")
            stats["ok"] += 1
            log(f"  would write {stem.split('/')[-1]:38} "
                f"{im.width}x{im.height} {len(raw)/1024:7.0f}KB -> {', '.join(made) or '(source too small, skip)'}"
                f"{'  [rotated]' if orient not in (None,1) else ''}")
            return

        results = upload_variants(sb, BUCKET, stem, im)
        wrote = [r for r in results if r[1]]
        for w, ok, detail in results:
            if not ok and "not wider than" not in str(detail):
                log(f"  ! {stem} @{w}: {detail}")
        # Validate what we just wrote by re-reading the bytes.
        for w, ok, detail in wrote:
            b = fetch(detail)
            if not is_real_webp(b):
                log(f"  !! WROTE NON-WEBP: {detail} — investigate before trusting this run")
                stats["err"] += 1
            else:
                stats["out"] += len(b)
        if wrote:
            stats["ok"] += 1
            log(f"  wrote {len(wrote)} variant(s) for {stem.split('/')[-1]}"
                f"{'  [rotated]' if orient not in (None,1) else ''}")
        else:
            stats["skip"] += 1

    global sb
    sb = None
    if not args.dry_run:
        from supabase import create_client
        sb = create_client(SUPABASE_URL, SERVICE_KEY)

    log("")
    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(work, todo))

    log("\n" + "=" * 66)
    log(f"  processed         {stats['ok']}")
    log(f"  EXIF-rotated      {stats['rot']}   <- would have been sideways without transpose")
    log(f"  errors            {stats['err']}")
    log(f"  source bytes      {stats['src']/1048576:8.1f} MB")
    log(f"  variant bytes     {stats['out']/1048576:8.2f} MB")
    if stats["src"]:
        log(f"  reduction         {(1 - stats['out']/stats['src'])*100:8.1f}%  "
            f"({stats['src']/max(1,stats['out']):.0f}x smaller)")
    log("=" * 66)
    if args.dry_run:
        log("DRY RUN — nothing was written. Re-run with SUPABASE_SERVICE_KEY to apply.")


if __name__ == "__main__":
    main()
