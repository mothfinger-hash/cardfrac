#!/usr/bin/env python3
"""
PathBinder — Sealed Product Background Remover
================================================
Walks every sealed-product image in Supabase Storage and replaces the
white background with transparency. Uses Pillow flood-fill from each
corner — that preserves white *inside* the product (text on a booster
box, light areas inside an ETB illustration, etc.) while only stripping
the white that's actually background.

Idempotent — re-running on an already-processed image is a no-op
because the corners are already transparent and won't match the
white-threshold flood-fill criterion.

PREREQUISITES:
    pip3 install requests pillow --break-system-packages

USAGE:
    # Dry-run on ONE image — saves before.webp and after.webp to disk
    # so you can preview the result before committing to the full run.
    python3 remove_white_bg_sealed.py --preview

    # Real run — process every sealed-product image in storage
    python3 remove_white_bg_sealed.py

    # Limit + bump workers for speed
    python3 remove_white_bg_sealed.py --workers 8 --limit 50

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
"""

import os, sys, io, time, argparse, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    sys.exit("Missing 'pillow'. Run: pip3 install pillow --break-system-packages")

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

STORAGE_BUCKET   = "card-images"
REQUEST_TIMEOUT  = 25

# Flood-fill tuning. WHITE_THRESH is the corner-detection trigger
# (a pixel must be at least this white to be considered background).
# THRESH_TOLERANCE is how much variation the fill tolerates as it
# spreads from the seed — bigger = more aggressive, smaller = more
# conservative. Both can be overridden via CLI flags so you can tune
# without editing this file.
WHITE_THRESH      = 220   # was 235 — looser default catches more off-whites
THRESH_TOLERANCE  = 60    # was 30  — more aggressive spread by default


def fetch_image(url):
    r = requests.get(url, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    if not r.content:
        raise RuntimeError("empty body")
    return r.content


def upload_image(path, data):
    """Upload (with upsert) to Supabase Storage via REST."""
    url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{STORAGE_BUCKET}/{path}"
    r = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "apikey":        SUPABASE_KEY,
            "Content-Type":  "image/webp",
            "x-upsert":      "true",
        },
        data=data,
        timeout=30,
    )
    if not r.ok:
        raise RuntimeError(f"upload HTTP {r.status_code}: {r.text[:200]}")


def pg_get_rows():
    """Fetch sealed-product rows that have a Supabase Storage image_url."""
    rows = []
    page = 0; PAGE = 1000
    while True:
        r = requests.get(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog",
            headers={
                "apikey":        SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Accept":        "application/json",
            },
            params={
                "select":       "id,image_url",
                "product_type": "neq.single",
                "image_url":    "ilike.*supabase.co*",
                "limit":        str(PAGE),
                "offset":       str(page * PAGE),
            },
            timeout=30,
        )
        r.raise_for_status()
        chunk = r.json()
        rows.extend(chunk)
        if len(chunk) < PAGE:
            break
        page += 1
    return rows


def _shrink_alpha_edge(im_rgba, pixels):
    """Grow the transparent region inward by `pixels` pixels — the
    standard fix for anti-aliased fringes left behind by chromakey/
    flood-fill. Pulls the alpha channel out, runs MinFilter(3) once
    per pixel of shrink, then pastes it back. Doesn't touch RGB."""
    if pixels < 1:
        return im_rgba
    r, g, b, a = im_rgba.split()
    for _ in range(pixels):
        a = a.filter(ImageFilter.MinFilter(3))
    return Image.merge("RGBA", (r, g, b, a))


def remove_white_bg(raw_bytes, mode="flood", shrink=0, verbose=False):
    """Open an image, strip its white background, save as RGBA WebP.

    mode='flood'      — flood-fill from each corner (preserves white
                        INSIDE the product). Best for boxes with white
                        text, light gradients, etc.
    mode='all-white'  — replace EVERY near-white pixel with transparent
                        regardless of position. Best when the corner
                        approach fails (no truly-white corner pixel)
                        but the product doesn't have important white
                        details to preserve.
    """
    im = Image.open(io.BytesIO(raw_bytes))
    if im.mode != "RGBA":
        im = im.convert("RGBA")

    w, h = im.size

    if verbose:
        corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
        print("  [debug] corner pixels (R, G, B, A):")
        for c in corners:
            print(f"     {c}: {im.getpixel(c)}")
        print(f"  [debug] WHITE_THRESH={WHITE_THRESH}, THRESH_TOLERANCE={THRESH_TOLERANCE}, mode={mode}")

    if mode == "flood":
        corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
        filled = 0
        for seed in corners:
            try:
                px = im.getpixel(seed)
            except Exception:
                continue
            if len(px) > 3 and px[3] == 0:
                continue   # already transparent
            if px[0] >= WHITE_THRESH and px[1] >= WHITE_THRESH and px[2] >= WHITE_THRESH:
                ImageDraw.floodfill(
                    im, seed,
                    value=(255, 255, 255, 0),
                    thresh=THRESH_TOLERANCE,
                )
                filled += 1
        if verbose:
            print(f"  [debug] flood-filled {filled}/4 corners")
    elif mode == "all-white":
        # Walk every pixel and zero alpha on the near-whites.
        # Slower (1-2 sec per image at 480px) but bulletproof for
        # photos where corner-flood doesn't reach all the background.
        px = im.load()
        zeroed = 0
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a == 0:
                    continue
                if r >= WHITE_THRESH and g >= WHITE_THRESH and b >= WHITE_THRESH:
                    px[x, y] = (r, g, b, 0)
                    zeroed += 1
        if verbose:
            print(f"  [debug] zeroed {zeroed:,} near-white pixels ({zeroed * 100 / (w * h):.1f}% of image)")
    else:
        raise ValueError(f"unknown mode: {mode}")

    # Optional fringe-eater: shrink the opaque area by N pixels so any
    # leftover anti-aliased halo gets removed cleanly. Safe because it
    # only affects pixels right at the transparent boundary.
    if shrink and shrink > 0:
        im = _shrink_alpha_edge(im, shrink)
        if verbose:
            print(f"  [debug] shrunk opaque edge by {shrink}px")

    out = io.BytesIO()
    im.save(out, format="WEBP", quality=86, method=6)
    return out.getvalue()


def url_to_storage_path(url):
    """Translate a Supabase public URL into its storage path under
    the card-images bucket."""
    # ".../storage/v1/object/public/card-images/{path}"
    marker = f"/{STORAGE_BUCKET}/"
    i = url.find(marker)
    if i < 0:
        return None
    p = url[i + len(marker):]
    # Strip trailing query string (cache-busters)
    return p.split("?", 1)[0]


def main():
    # Must declare globals BEFORE we read them as argparse defaults.
    global WHITE_THRESH, THRESH_TOLERANCE

    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true",
                    help="Process exactly ONE row, save before.webp + after.webp to disk for visual review, then exit.")
    ap.add_argument("--mode", choices=["flood", "all-white"], default="flood",
                    help="flood (default, preserves white inside the product) | "
                         "all-white (more aggressive, removes every near-white pixel — use if flood doesn't catch the background).")
    ap.add_argument("--white-thresh", type=int, default=WHITE_THRESH,
                    help=f"Minimum R/G/B value for a pixel to count as white (default {WHITE_THRESH}). "
                         "Lower = catches more off-whites. Try 200-240.")
    ap.add_argument("--tolerance", type=int, default=THRESH_TOLERANCE,
                    help=f"How aggressively the fill spreads from the seed (default {THRESH_TOLERANCE}). "
                         "Higher = catches anti-aliased / fringe pixels. Try 30-90.")
    ap.add_argument("--shrink", type=int, default=1,
                    help="After bg removal, eat N pixels from the opaque edge "
                         "to kill anti-aliased halos. 1 is usually plenty; "
                         "2-3 if heavy fringing remains. 0 disables.")
    ap.add_argument("--limit", type=int, default=0,
                    help="Stop after N rows (debug).")
    ap.add_argument("--workers", type=int, default=5,
                    help="Parallel workers (default 5).")
    args = ap.parse_args()

    # Apply CLI overrides
    WHITE_THRESH     = args.white_thresh
    THRESH_TOLERANCE = args.tolerance

    print("\n  Loading sealed-product rows with Supabase-hosted images…")
    rows = pg_get_rows()
    print(f"  {len(rows):,} candidate rows.")

    if args.preview:
        if not rows:
            sys.exit("  No rows to preview.")
        r = rows[0]
        url = (r.get("image_url") or "").split("?", 1)[0]
        print(f"  [preview] downloading {url}")
        raw = fetch_image(url)
        before_path = Path("before.webp").resolve()
        after_path  = Path("after.webp").resolve()
        before_path.write_bytes(raw)
        print(f"  [preview] before saved → {before_path}  ({len(raw):,} bytes)")
        processed = remove_white_bg(raw, mode=args.mode, shrink=args.shrink, verbose=True)
        after_path.write_bytes(processed)
        print(f"  [preview] after  saved → {after_path}  ({len(processed):,} bytes, mode={args.mode})")
        if len(processed) == len(raw):
            print("  [preview] WARNING: output bytes identical to input — nothing was changed.")
            print("  Try --mode all-white, or lower WHITE_THRESH near the top of the file.")
        print()
        print("  To compare them side-by-side on macOS:")
        print(f"    open '{before_path}' '{after_path}'")
        return

    if args.limit:
        rows = rows[:args.limit]
    print(f"  Processing {len(rows):,} rows with {args.workers} workers")
    print("  Starting in 3s — Ctrl+C to abort\n")
    time.sleep(3)

    _lock = threading.Lock()
    stats = {"done": 0, "failed": 0, "skipped": 0, "completed": 0}

    def process_one(row):
        rid = row["id"]
        url = (row.get("image_url") or "").split("?", 1)[0]
        path = url_to_storage_path(url)
        if not path:
            return (rid, "skipped", "couldn't parse storage path")
        try:
            raw = fetch_image(url)
        except Exception as e:
            return (rid, "failed", f"download: {e}")
        try:
            processed = remove_white_bg(raw, mode=args.mode, shrink=args.shrink)
        except Exception as e:
            return (rid, "failed", f"process: {e}")
        try:
            upload_image(path, processed)
        except Exception as e:
            return (rid, "failed", f"upload: {e}")
        return (rid, "done", path)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_one, r): r for r in rows}
        for f in as_completed(futs):
            rid, status, detail = f.result()
            with _lock:
                stats[status] = stats.get(status, 0) + 1
                stats["completed"] += 1
                n = stats["completed"]
                if status == "failed":
                    print(f"  [{n:>4}/{len(rows)}] FAIL  {rid}  — {detail}")
                elif n % 50 == 0 or n == len(rows):
                    print(f"  [{n:>4}/{len(rows)}] done={stats['done']} skipped={stats['skipped']} failed={stats['failed']}")

    print(f"\n  Finished. done={stats['done']} skipped={stats['skipped']} failed={stats['failed']}")


if __name__ == "__main__":
    main()
