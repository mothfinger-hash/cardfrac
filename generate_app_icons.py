#!/usr/bin/env python3
"""
PathBinder — App icon generator.

Reads pb_icon.png (transparent-bg PB monogram), centers it on a navy
square canvas at the sizes the PWA manifest + Apple touch icon need.

Output:
  icons/icon-192.png          (Android home screen, PWA install)
  icons/icon-512.png          (PWA splash, high-DPI launchers)
  icons/apple-touch-icon.png  (iOS Safari "Add to Home Screen")

Design rules followed:
  • Solid #0a0e1a navy fill edge-to-edge (matches site bg)
  • No rounded corners in the PNG — iOS auto-applies squircle mask,
    Android's adaptive icon system applies its own shape
  • 12.5% padding on all sides so Android's "maskable" treatment
    doesn't crop the monogram (some launchers crop up to ~20%)

USAGE
-----
    pip3 install pillow --break-system-packages
    python3 generate_app_icons.py
"""

import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Missing Pillow. Run: pip3 install pillow --break-system-packages")


NAVY            = (10, 14, 26, 255)   # #0a0e1a — matches --bg CSS var
SOURCE_ICON     = "pb_icon.png"
OUTPUT_DIR      = "icons"
PADDING_FRACTION = 0.125               # 12.5% padding per side (icon = 75% of canvas)

SIZES = [
    (192, "icon-192.png"),
    (512, "icon-512.png"),
    (180, "apple-touch-icon.png"),
]


def make_icon(size, out_path, src_img):
    """Composite a single icon: navy square canvas + centered, scaled
    source. Uses LANCZOS resampling for clean downscaling."""
    canvas = Image.new("RGBA", (size, size), NAVY)

    # Scale source to fit within the (1 - 2*padding) inner region while
    # preserving aspect ratio. Most PB icons are roughly square but this
    # handles non-square gracefully.
    target = int(size * (1 - 2 * PADDING_FRACTION))
    src_w, src_h = src_img.size
    scale = min(target / src_w, target / src_h)
    new_w = max(1, int(src_w * scale))
    new_h = max(1, int(src_h * scale))
    scaled = src_img.resize((new_w, new_h), Image.LANCZOS)

    offset = ((size - new_w) // 2, (size - new_h) // 2)
    # Use the scaled image's alpha as the mask so the transparent
    # background composites cleanly onto the navy fill.
    canvas.paste(scaled, offset, scaled)

    canvas.save(out_path, optimize=True)
    print(f"  → {out_path} ({size}x{size})")


def main():
    if not os.path.exists(SOURCE_ICON):
        sys.exit(f"Source icon not found at {SOURCE_ICON!r}. "
                 f"Drop a transparent-bg PNG with that name in the repo root and re-run.")
    src = Image.open(SOURCE_ICON).convert("RGBA")
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"Generating {len(SIZES)} icon variants from {SOURCE_ICON} ({src.size[0]}x{src.size[1]}):")
    for size, name in SIZES:
        make_icon(size, os.path.join(OUTPUT_DIR, name), src)
    print("Done.")


if __name__ == "__main__":
    main()
