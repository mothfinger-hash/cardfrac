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

    for w in sizes:
        if w >= src_w:
            # No upscaling — skip variants for tiny sources. The original
            # is already smaller than the requested variant, so the
            # browser will just use it directly.
            results.append((w, False, f"source {src_w}px not wider than {w}px"))
            continue

        target_h = round(src_h * w / src_w)
        try:
            vim = im.resize((w, target_h), Image.LANCZOS)
        except Exception as e:
            results.append((w, False, f"resize: {e}"))
            continue

        buf = io.BytesIO()
        try:
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
