"""
PathBinder — Shared image-variant helper for the mirror scripts.
================================================================
Generates small WebP thumbnails (200px + 400px wide) alongside the
main catalog image upload. Variants are stored as sibling objects in
the same Supabase Storage path:

    card-images/cn/set-code/8709229.webp        # main image
    card-images/cn/set-code/8709229-200.webp    # 200px wide
    card-images/cn/set-code/8709229-400.webp    # 400px wide

The browser-side helper `_pickThumbVariant(url, targetWidth)` in
index.html turns the main URL into the variant URL by inserting the
width before the .webp extension. <img onerror> handlers fall back to
the main URL if a variant is missing, so this is safe to roll out
incrementally — existing rows without variants still work.

Why pre-generated variants instead of Supabase's image-transformation
endpoint? Supabase counts unique (image, width, quality) tuples
against the Pro tier's 100/month quota; PathBinder blew through that
within weeks across the catalog + marketplace grid. Pre-generating at
mirror time costs ~1 KB of upload per variant per image and zero
recurring transformation quota.

Usage from mirror_singles_images.py / mirror_sealed_images.py:

    from image_variants import upload_variants

    sb.storage.from_(BUCKET).upload(path, webp_bytes, file_options=…)
    upload_variants(sb, BUCKET, path, webp_bytes)

Failures of individual variants are non-fatal — they're logged but
don't fail the whole row.
"""

import io
import re

try:
    from PIL import Image
except ImportError:
    raise SystemExit("image_variants.py requires Pillow. Install: pip3 install pillow --break-system-packages")


VARIANT_SIZES = (200, 400)
VARIANT_QUALITY = 78  # WebP quality for thumbnails (tighter than full-size)


def _variant_path(base_path, width):
    """
    Insert "-{width}" before the file extension.

    'cn/set/123.webp'  → 'cn/set/123-200.webp'
    'foo/bar/baz.jpg'  → 'foo/bar/baz-200.webp'    (variants always WebP)
    'cn/set/123'       → 'cn/set/123-200.webp'     (no extension)
    """
    # Match a trailing .ext where ext doesn't contain '/' or '.'.
    m = re.search(r'(\.[^./]+)$', base_path)
    if m:
        return base_path[: m.start()] + f'-{width}.webp'
    return base_path + f'-{width}.webp'


def upload_variants(sb, bucket, base_path, source, sizes=VARIANT_SIZES, quality=VARIANT_QUALITY):
    """
    Generate WebP thumbnails of `source` at the requested widths and
    upload each one as a sibling object in Supabase Storage.

    Args:
        sb: Supabase client (already authenticated with service key).
        bucket: storage bucket name (e.g. 'card-images').
        base_path: path of the main image already uploaded
                   (e.g. 'cn/chinese-151-collect/8709229.webp').
                   Variants are uploaded at the same base path with
                   the width slotted before the extension.
        source: raw bytes (downloaded image) OR an open PIL Image.
        sizes: iterable of target widths in pixels.
        quality: WebP quality for the variants.

    Returns:
        list of (width, success_bool, detail) — detail is the variant
        path on success or the error string on failure. Widths whose
        target is >= the source's width are skipped (no upscaling).
    """
    if isinstance(source, (bytes, bytearray)):
        im = Image.open(io.BytesIO(source))
    else:
        im = source

    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if im.mode in ("LA", "P") else "RGB")

    src_w, src_h = im.width, im.height
    results = []

    # EVERY requested width gets an object. This is the whole contract, and it
    # used to be broken.
    #
    # This loop used to `continue` when w >= src_w, on the reasoning that
    # upscaling is pointless and "the browser will just use it directly."
    # The first half is right. The second half is false, and it cost real
    # performance for months: _pickThumbVariant() in pb-app.js rewrites a URL
    # to '<stem>-400.webp' knowing ONLY that the path contains /card-images/ or
    # /card-photos/. It has no idea how wide the source is. So the client asks
    # for every variant this function decided not to write, gets a 400, and
    # limps through the <img> onerror cascade to the full-size original.
    #
    # Measured on the live catalog: 36% of '-400.webp' requests 400, and 56% of
    # those are sources <= 400px wide — 245px (the canonical card width, see
    # CLAUDE.md) and 200px dominate. That is ~10,000 catalog rows whose 400 is
    # PERMANENT and which no amount of backfilling could ever fix, because this
    # function was correctly declining to upscale them.
    #
    # Two bad ways to paper over it, both rejected: teach the client the source
    # width (needs a schema column and keeps the two halves coupled), or let the
    # service worker negatively-cache the 400 (hides the symptom, still pays a
    # round trip per TTL, and adds SW complexity we would have to maintain).
    #
    # Instead, make the assumption TRUE. For w >= src_w, upload the source at
    # its native size under the variant name — a passthrough, not an upscale.
    # No pixels are invented and nothing is enlarged. These sources are
    # 150-400px / ~11-36 KB, so the duplicate costs roughly 20 KB a row.
    # In exchange every variant URL unconditionally 200s, _pickThumbVariant
    # becomes correct by construction, and the onerror cascade goes quiet.
    for w in sizes:
        if w >= src_w:
            vim = im                       # passthrough at native size
        else:
            target_h = round(src_h * w / src_w)
            try:
                vim = im.resize((w, target_h), Image.LANCZOS)
            except Exception as e:
                results.append((w, False, f"resize: {e}"))
                continue

        buf = io.BytesIO()
        try:
            # Always re-encode rather than byte-copying the source: the object
            # is named .webp and served as image/webp, so it had better BE webp.
            # A .webp name over PNG/JPEG bytes is exactly the bug we just spent
            # a day removing from the browser upload path.
            vim.save(buf, format="WEBP", quality=quality, method=6)
        except Exception as e:
            results.append((w, False, f"encode: {e}"))
            continue

        variant_path = _variant_path(base_path, w)
        try:
            sb.storage.from_(bucket).upload(
                variant_path, buf.getvalue(),
                file_options={"content-type": "image/webp", "upsert": "true"},
            )
            results.append((w, True, variant_path))
        except Exception as e:
            results.append((w, False, f"upload: {e}"))

    return results
