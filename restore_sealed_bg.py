#!/usr/bin/env python3
"""
PathBinder — Sealed Background Repair Tool
================================================
Companion to remove_white_bg_sealed.py. Handles the two follow-up cases
that the initial pass missed:

  1. PRODUCTS WHERE THE FLOOD-FILL ATE TOO MUCH (e.g. Pokémon tins —
     the metal lid has bright-white highlights that look like
     background but are NOT). For these, --revert re-fetches the
     ORIGINAL image straight from PriceCharting and re-uploads it
     unmodified (white background restored).

  2. PRODUCTS WHERE BG REMOVAL DIDN'T RUN AT ALL (the original image
     never had a pure-white corner — e.g. ETBs photographed at an
     angle, premium collections on a gradient backdrop). --detect
     finds these by sampling corner alpha; --redo re-runs bg removal
     with caller-supplied (typically looser) thresholds.

The trick is that catalog.image_url now points at the *processed*
WebP in Supabase Storage — the original PriceCharting URL is gone.
We recover it by re-fetching price_source_url (the PC product page)
and pulling the main image URL out of the HTML.

PREREQUISITES:
    pip3 install requests pillow --break-system-packages

    # Optional — only needed for --mode ml (rembg/U2Net bg removal,
    # handles photo/gradient/tinted backgrounds that flood-fill can't):
    pip3 install rembg onnxruntime --break-system-packages

USAGE:
    # 1. Find out how bad it is — scans every sealed image and
    #    classifies as opaque (didn't get bg-removed) vs. transparent.
    python3 restore_sealed_bg.py --detect

    # 2. Same scan, but limit to tins to see how many tins were affected.
    python3 restore_sealed_bg.py --detect --name-pattern Tin

    # 3. Preview ONE row — saves before.webp + after.webp + original.jpg
    #    to disk so you can eyeball before committing.
    python3 restore_sealed_bg.py --revert --name-pattern Tin --preview

    # 4. REVERT every Pokémon tin to its original (white-bg) image.
    python3 restore_sealed_bg.py --revert --name-pattern Tin

    # 5. RE-DO bg removal with conservative thresholds on the products
    #    that didn't get any processing.
    python3 restore_sealed_bg.py --redo --only-opaque \\
        --white-thresh 245 --tolerance 20 --shrink 0

ENVIRONMENT:
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
"""

import os, sys, io, time, argparse, threading, re, random
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin

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
PC_BASE          = "https://www.pricecharting.com"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
}

_session = requests.Session()
_session.headers.update(HEADERS)

# Patterns for finding the PRODUCT image on a PriceCharting page.
# The first <img> on the page is usually a site sprite/logo, so we
# specifically hunt for URLs on the images.pricecharting.com CDN and
# prefer the largest size we can see (PC sometimes ships /60 in src=
# and /1600 in data-src=, sometimes the reverse).
PC_CDN_HOST   = "images.pricecharting.com"
PC_IMG_RE     = re.compile(
    r'(?:src|data-src|content)="([^"]*' + re.escape(PC_CDN_HOST) + r'[^"]+)"',
    re.IGNORECASE,
)
OG_IMG_RE     = re.compile(
    r'<meta[^>]*property=["\']og:image["\'][^>]*content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
SIZE_RE       = re.compile(r'/(60|160|240|320|480|640|1600)\.(jpg|jpeg|png|webp)(?:\?[^"]*)?$', re.IGNORECASE)


# ─── Supabase REST helpers ───────────────────────────────────────────────

def pg_get_rows(name_pattern=None, id_pattern=None, exclude_name=None,
                bg_state_in=None):
    """Fetch sealed-product rows that have a Supabase Storage image_url
    AND a price_source_url we can re-scrape from. `exclude_name` is a
    list of case-insensitive substrings to filter OUT (e.g. ['Tin']).
    `bg_state_in` is a list of bg_state values to keep (e.g.
    ['opaque','unknown']) — uses PostgREST `in.(...)` filter which is
    index-backed via idx_catalog_bg_state."""
    rows = []
    page = 0; PAGE = 1000
    while True:
        params = {
            "select":             "id,name,image_url,price_source_url,product_type,bg_state",
            "product_type":       "neq.single",
            "image_url":          "ilike.*supabase.co*",
            "price_source_url":   "not.is.null",
            "limit":              str(PAGE),
            "offset":             str(page * PAGE),
        }
        if name_pattern:
            params["name"] = f"ilike.*{name_pattern}*"
        if id_pattern:
            params["id"] = f"ilike.*{id_pattern}*"
        if bg_state_in:
            params["bg_state"] = "in.(" + ",".join(bg_state_in) + ")"
        r = requests.get(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog",
            headers={
                "apikey":        SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Accept":        "application/json",
            },
            params=params, timeout=30,
        )
        r.raise_for_status()
        chunk = r.json()
        rows.extend(chunk)
        if len(chunk) < PAGE:
            break
        page += 1

    # Client-side exclude — PostgREST doesn't support negated ilike
    # cleanly across multiple substrings, so we filter in Python.
    if exclude_name:
        excludes = [s.lower() for s in exclude_name if s]
        before = len(rows)
        rows = [r for r in rows
                if not any(x in (r.get("name") or "").lower() for x in excludes)]
        dropped = before - len(rows)
        if dropped:
            print(f"  Excluded {dropped} rows matching {exclude_name}.")
    return rows


def filter_to_unprocessed(rows, hours=2):
    """Drop rows whose Supabase Storage image was uploaded in the last
    N hours — these are presumed already processed by a prior run, so
    we don't waste a re-fetch on them. Lets you just re-run the same
    command after a 403 wave and only the laggards get retried.
    Uses a HEAD request on each image's storage URL and parses the
    Last-Modified header. Sequential to avoid hammering Supabase."""
    if not rows:
        return rows
    cutoff = time.time() - (hours * 3600)
    fresh, stale = [], []
    print(f"  Checking which rows were already processed in the last {hours}h…")
    for i, r in enumerate(rows, 1):
        u = (r.get("image_url") or "").split("?", 1)[0]
        try:
            head = requests.head(u, timeout=10, allow_redirects=True)
            lm = head.headers.get("Last-Modified") or head.headers.get("last-modified")
            if lm:
                # Parse with email.utils since Last-Modified is RFC 1123
                from email.utils import parsedate_to_datetime
                dt = parsedate_to_datetime(lm)
                if dt.timestamp() >= cutoff:
                    fresh.append(r)
                    continue
        except Exception:
            pass
        stale.append(r)
        if i % 50 == 0:
            print(f"    [{i}/{len(rows)}] checked")
    print(f"  Skipping {len(fresh)} rows updated in the last {hours}h, retrying {len(stale)}.")
    return stale


def upload_image(path, data, content_type="image/webp"):
    url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{STORAGE_BUCKET}/{path}"
    r = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "apikey":        SUPABASE_KEY,
            "Content-Type":  content_type,
            "x-upsert":      "true",
        },
        data=data, timeout=30,
    )
    if not r.ok:
        raise RuntimeError(f"upload HTTP {r.status_code}: {r.text[:200]}")


def pg_set_bg_state(row_id, state):
    """PATCH catalog.bg_state so subsequent --only-opaque runs can filter
    via SQL instead of re-downloading every image. Best-effort —
    silently swallows errors (the run still succeeded; we just lose the
    cache for this row)."""
    import json as _json
    if state not in ("opaque", "transparent", "unknown"):
        return f"invalid bg_state: {state}"
    url = (f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?"
           f"id=eq.{requests.utils.quote(row_id)}")
    body = _json.dumps({"bg_state": state}).encode("utf-8")
    try:
        r = requests.patch(
            url,
            headers={
                "apikey":        SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type":  "application/json",
                "Prefer":        "return=minimal",
            },
            data=body, timeout=20,
        )
        if not r.ok:
            return f"HTTP {r.status_code}"
    except Exception as e:
        return str(e)
    return None


def pg_flag_for_manual_review(row_id, reason):
    """PATCH catalog row to set needs_manual_bg=true + reason. Called
    automatically when --redo can't actually strip the background
    (output bytes >= input bytes, corners not uniform, etc.).
    See migration_needs_manual_bg.sql for the column definitions."""
    import json as _json
    from datetime import datetime, timezone
    url = (f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?"
           f"id=eq.{requests.utils.quote(row_id)}")
    body = _json.dumps({
        "needs_manual_bg":   True,
        "bg_failure_reason": (reason or "")[:200],
        "bg_flagged_at":     datetime.now(timezone.utc).isoformat(),
    }).encode("utf-8")
    r = requests.patch(
        url,
        headers={
            "apikey":        SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type":  "application/json",
            "Prefer":        "return=minimal",
        },
        data=body, timeout=20,
    )
    if not r.ok:
        # Don't raise — flagging is best-effort. Surface to caller
        # so the run log shows the warning.
        return f"flag HTTP {r.status_code}: {r.text[:120]}"
    return None


def url_to_storage_path(url):
    marker = f"/{STORAGE_BUCKET}/"
    i = url.find(marker)
    if i < 0:
        return None
    return url[i + len(marker):].split("?", 1)[0]


# ─── Image fetching ──────────────────────────────────────────────────────

# Anti-bot defense from PriceCharting — they 403 aggressive callers.
# Each worker thread sleeps a random interval between requests, and on
# 403/429 we exponential-backoff with jitter (up to ~60s sleep before
# the final retry). 200 OK breaks the loop. After exhausting retries
# we surface the error to the caller (which prints FAIL).
RETRY_STATUSES = (403, 429, 502, 503, 504)
MAX_RETRIES    = 5

# Per-thread baseline pace. We add `--rate-limit` to bump this if PC
# keeps 403ing the run; default is conservative so a parallel run with
# 3-5 workers won't trip the limiter immediately.
_thread_jitter = threading.local()

def _pace(min_s=0.6, max_s=1.4):
    """Sleep a small random interval to avoid synchronized bursts."""
    last = getattr(_thread_jitter, "last", 0)
    now  = time.time()
    delay = random.uniform(min_s, max_s)
    elapsed = now - last
    if elapsed < delay:
        time.sleep(delay - elapsed)
    _thread_jitter.last = time.time()


def _request(url, want_bytes):
    """Single-URL fetch with built-in retry/backoff. Returns bytes if
    want_bytes=True else .text. Raises RuntimeError on terminal failure."""
    _pace()
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            r = _session.get(url, timeout=REQUEST_TIMEOUT)
        except Exception as e:
            last_err = f"network: {e}"
            time.sleep((2 ** attempt) + random.uniform(0, 1))
            continue
        if r.ok:
            return r.content if want_bytes else r.text
        if r.status_code in RETRY_STATUSES:
            # 403/429: PC anti-bot. Exponential backoff with jitter.
            # 1s, 3s, 7s, 15s, 31s — adding 0-3s jitter each step.
            sleep_s = (2 ** (attempt + 1) - 1) + random.uniform(0, 3)
            last_err = f"HTTP {r.status_code} (retry {attempt+1}/{MAX_RETRIES} after {sleep_s:.1f}s)"
            time.sleep(sleep_s)
            continue
        # Non-retryable (404, 410, etc.) — fail fast.
        raise RuntimeError(f"HTTP {r.status_code}")
    raise RuntimeError(last_err or "exhausted retries")


def fetch(url):
    return _request(url, want_bytes=True)


def fetch_text(url):
    return _request(url, want_bytes=False)


def _size_rank(url):
    """Return numeric size suffix in URL, 0 if absent. Used to pick the
    largest variant when a page references the same image at multiple
    sizes (PC ships /60 in <img src=> and /480 in data-src=, etc.)."""
    m = SIZE_RE.search(url)
    return int(m.group(1)) if m else 0


def scrape_pc_image_url(product_page_url, debug=False):
    """Pull the main product image URL from a PriceCharting product
    page. Strategy:
      1. Look for og:image meta — that's the canonical product image
         when set, doesn't change with page redesigns.
      2. Otherwise, gather every images.pricecharting.com URL on the
         page and pick the one with the largest size suffix.
      3. Return the URL, normalized to /480 (or whatever the script
         needs — fallback chain handles the rest).
    """
    page = fetch_text(product_page_url)

    candidates = []

    # Strategy 1: og:image — most reliable when present
    og = OG_IMG_RE.search(page)
    if og:
        og_url = og.group(1).strip()
        if PC_CDN_HOST in og_url:
            candidates.append(og_url)
            if debug: print(f"    [debug] og:image -> {og_url}")

    # Strategy 2: every CDN reference
    for m in PC_IMG_RE.finditer(page):
        u = m.group(1).strip()
        if u not in candidates:
            candidates.append(u)

    if not candidates:
        raise RuntimeError(
            f"no images.pricecharting.com URL found in {product_page_url} "
            f"(page was {len(page):,} bytes)"
        )

    # Pick the largest size we can see; ties broken by appearance order
    # (og:image first, then markup order — which usually means main
    # product image before related-product thumbs).
    best = max(candidates, key=_size_rank)

    if best.startswith("//"):
        best = "https:" + best
    elif best.startswith("/"):
        best = urljoin(PC_BASE, best)

    # Normalize to /480 — fallback chain in fetch_pc_original_with_fallback
    # will degrade if /480 isn't published for this asset.
    best = SIZE_RE.sub(lambda mm: f"/480.{mm.group(2)}", best)

    if debug:
        print(f"    [debug] picked  -> {best}  (from {len(candidates)} candidates)")

    return best


def fetch_pc_original_with_fallback(image_url):
    """Try /480 first, then degrade to /320, /240, /160, /60. Returns
    raw bytes on success, raises on total failure."""
    base = SIZE_RE.sub('', image_url)
    m = SIZE_RE.search(image_url)
    ext = m.group(2) if m else "jpg"
    last_err = None
    for size in (480, 320, 240, 160, 60):
        candidate = f"{base}/{size}.{ext}"
        try:
            data = fetch(candidate)
            if data:
                return data
        except Exception as e:
            last_err = e
    raise RuntimeError(f"no size worked, last error: {last_err}")


# ─── Image analysis & processing ─────────────────────────────────────────

def classify_corners(raw_bytes):
    """Return (transparent_corners, total_corners) for an image."""
    im = Image.open(io.BytesIO(raw_bytes))
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    w, h = im.size
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    tcount = 0
    for c in corners:
        try:
            px = im.getpixel(c)
            if len(px) > 3 and px[3] == 0:
                tcount += 1
        except Exception:
            pass
    return tcount, len(corners)


def convert_to_webp(raw_bytes, quality=86):
    """Strip-down conversion — no bg removal, just re-encode."""
    im = Image.open(io.BytesIO(raw_bytes))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    out = io.BytesIO()
    im.save(out, format="WEBP", quality=quality, method=6)
    return out.getvalue()


def _shrink_alpha_edge(im_rgba, pixels):
    if pixels < 1:
        return im_rgba
    r, g, b, a = im_rgba.split()
    for _ in range(pixels):
        a = a.filter(ImageFilter.MinFilter(3))
    return Image.merge("RGBA", (r, g, b, a))


# Lazy-loaded rembg session — the U2Net model is ~150MB so we only
# materialize it when --mode ml is actually used. Cached at module
# scope so workers share the same loaded model.
_REMBG_SESSION = None
_REMBG_LOCK    = threading.Lock()

def _get_rembg_session():
    """Returns a rembg session (loads model on first call). Raises a
    helpful error if rembg isn't installed."""
    global _REMBG_SESSION
    with _REMBG_LOCK:
        if _REMBG_SESSION is None:
            try:
                from rembg import new_session  # type: ignore
            except ImportError:
                raise RuntimeError(
                    "rembg not installed. Run:\n"
                    "    pip3 install rembg onnxruntime --break-system-packages"
                )
            print("  [ml] Loading U2Net model (first-run downloads ~150MB)…")
            _REMBG_SESSION = new_session("u2net")
            print("  [ml] Model loaded.")
        return _REMBG_SESSION


def remove_bg_ml(raw_bytes, shrink=0):
    """ML-based bg removal via rembg + U2Net. Handles photo backgrounds,
    gradients, off-white / cream / tinted bgs, and anything else
    flood-fill chokes on. Always returns a 4-channel RGBA WebP — the
    success check in the caller looks at corner alpha, not file size,
    since rembg adds an alpha channel which makes lossless WebP larger
    even on clean removals."""
    from rembg import remove  # type: ignore
    session = _get_rembg_session()
    im = Image.open(io.BytesIO(raw_bytes))
    if im.mode != "RGB":
        im = im.convert("RGB")
    out_im = remove(im, session=session)   # returns PIL Image
    if out_im.mode != "RGBA":
        out_im = out_im.convert("RGBA")
    if shrink and shrink > 0:
        out_im = _shrink_alpha_edge(out_im, shrink)
    out = io.BytesIO()
    out_im.save(out, format="WEBP", quality=86, method=6)
    return out.getvalue()


def remove_white_bg(raw_bytes, white_thresh=245, tolerance=20, shrink=0, mode="flood"):
    """Same engine as remove_white_bg_sealed.py but with caller-driven
    defaults tuned conservative (high thresh, low tolerance) so the
    --redo path doesn't repeat the over-aggressive first pass.
    mode='ml' delegates to remove_bg_ml() (U2Net-based)."""
    if mode == "ml":
        return remove_bg_ml(raw_bytes, shrink=shrink)
    im = Image.open(io.BytesIO(raw_bytes))
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    w, h = im.size

    if mode == "flood":
        corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
        for seed in corners:
            try:
                px = im.getpixel(seed)
            except Exception:
                continue
            if len(px) > 3 and px[3] == 0:
                continue
            if px[0] >= white_thresh and px[1] >= white_thresh and px[2] >= white_thresh:
                ImageDraw.floodfill(
                    im, seed,
                    value=(255, 255, 255, 0),
                    thresh=tolerance,
                )
    elif mode == "all-white":
        px = im.load()
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a == 0:
                    continue
                if r >= white_thresh and g >= white_thresh and b >= white_thresh:
                    px[x, y] = (r, g, b, 0)

    if shrink and shrink > 0:
        im = _shrink_alpha_edge(im, shrink)

    out = io.BytesIO()
    im.save(out, format="WEBP", quality=86, method=6)
    return out.getvalue()


# ─── Per-row processors ──────────────────────────────────────────────────

def process_detect(row, write_cache=True):
    """Download current Supabase image, classify corner alpha. Writes
    the result to catalog.bg_state so subsequent --only-opaque runs
    can filter via SQL instead of re-downloading."""
    rid = row["id"]
    cur = (row.get("image_url") or "").split("?", 1)[0]
    try:
        cur_bytes = fetch(cur)
    except Exception as e:
        return (rid, "failed", f"download: {e}", 0)
    try:
        t, n = classify_corners(cur_bytes)
    except Exception as e:
        return (rid, "failed", f"classify: {e}", 0)
    status = "transparent" if t > 0 else "opaque"
    if write_cache:
        # Only PATCH if the cached value is different from what we
        # just measured — avoids hammering the DB on a re-scan where
        # nothing changed.
        if row.get("bg_state") != status:
            pg_set_bg_state(rid, status)
    return (rid, status, f"{t}/{n} corners transparent", t)


def process_revert(row, preview=False):
    """Re-fetch original from PriceCharting, upload as-is (no bg removal)."""
    rid = row["id"]
    page = row.get("price_source_url")
    if not page:
        return (rid, "skipped", "no price_source_url")
    try:
        orig_url = scrape_pc_image_url(page, debug=preview)
    except Exception as e:
        return (rid, "failed", f"scrape: {e}")
    if preview:
        print(f"  [preview] product page: {page}")
        print(f"  [preview] scraped image URL: {orig_url}")
    try:
        raw = fetch_pc_original_with_fallback(orig_url)
    except Exception as e:
        return (rid, "failed", f"fetch original from {orig_url}: {e}")
    try:
        webp = convert_to_webp(raw)
    except Exception as e:
        return (rid, "failed", f"convert: {e}")

    if preview:
        Path("original.jpg").write_bytes(raw)
        Path("after_revert.webp").write_bytes(webp)
        return (rid, "preview", f"saved original.jpg + after_revert.webp ({len(raw):,} → {len(webp):,} bytes)")

    cur = (row.get("image_url") or "").split("?", 1)[0]
    path = url_to_storage_path(cur)
    if not path:
        return (rid, "failed", "couldn't parse storage path")
    try:
        upload_image(path, webp)
    except Exception as e:
        return (rid, "failed", f"upload: {e}")
    # Revert restores the original white background → opaque corners.
    pg_set_bg_state(rid, "opaque")
    return (rid, "reverted", path)


def process_redo(row, white_thresh, tolerance, shrink, mode,
                 preview=False, flag_failures=True):
    """Re-fetch original from PC, run bg removal with caller-supplied
    (typically conservative) thresholds, upload. When `flag_failures`
    is true (default), rows where bg removal couldn't strip the
    background (output bytes >= input bytes — flood-fill seeded
    nothing) get flagged in the catalog for manual review."""
    rid = row["id"]
    page = row.get("price_source_url")
    if not page:
        return (rid, "skipped", "no price_source_url")
    try:
        orig_url = scrape_pc_image_url(page, debug=preview)
    except Exception as e:
        return (rid, "failed", f"scrape: {e}")
    if preview:
        print(f"  [preview] product page: {page}")
        print(f"  [preview] scraped image URL: {orig_url}")
    try:
        raw = fetch_pc_original_with_fallback(orig_url)
    except Exception as e:
        return (rid, "failed", f"fetch original from {orig_url}: {e}")
    try:
        webp = remove_white_bg(raw, white_thresh=white_thresh,
                               tolerance=tolerance, shrink=shrink, mode=mode)
    except Exception as e:
        return (rid, "failed", f"process: {e}")

    # Detect "bg removal did nothing". Two heuristics depending on mode:
    #   flood / all-white: rely on file size. WebP overhead means a
    #     successful removal usually SHRINKS the file despite adding
    #     alpha; a no-op output is 5-20% LARGER.
    #   ml: rembg always outputs RGBA so file size grows even on
    #     clean removals. Check corner alpha directly — at least 2 of
    #     the 4 corners should be fully transparent on a successful
    #     ML pass (background pixels at every corner).
    if mode == "ml":
        try:
            tcount, _ = classify_corners(webp)
            bg_changed = tcount >= 2
        except Exception:
            bg_changed = False
    else:
        bg_changed = len(webp) < len(raw)

    if preview:
        Path("original.jpg").write_bytes(raw)
        Path("after_redo.webp").write_bytes(webp)
        flag_note = "" if bg_changed else "  [WOULD FLAG for manual review — output >= input]"
        return (rid, "preview", f"saved original.jpg + after_redo.webp "
                                f"({len(raw):,} → {len(webp):,} bytes){flag_note}")

    if not bg_changed:
        # Flag for manual review instead of uploading the larger file.
        # The existing image stays in storage so users still see
        # something; the row goes into the admin queue. bg_state is
        # confirmed 'opaque' (the bg removal couldn't strip it).
        pg_set_bg_state(rid, "opaque")
        if flag_failures:
            err = pg_flag_for_manual_review(
                rid,
                f"redo output >= input ({len(webp):,} >= {len(raw):,} bytes) "
                f"with white-thresh={white_thresh} tolerance={tolerance}"
            )
            if err:
                return (rid, "failed", f"flag attempt failed: {err}")
        return (rid, "flagged", f"bg removal no-op — needs_manual_bg=true")

    cur = (row.get("image_url") or "").split("?", 1)[0]
    path = url_to_storage_path(cur)
    if not path:
        return (rid, "failed", "couldn't parse storage path")
    try:
        upload_image(path, webp)
    except Exception as e:
        return (rid, "failed", f"upload: {e}")
    # Successful bg removal → corners are now transparent. Also clears
    # needs_manual_bg + bg_failure_reason + bg_flagged_at in case this
    # row was flagged on a previous run with stricter thresholds; the
    # looser-threshold retry now succeeded so the manual queue can
    # drop it.
    import json as _json
    try:
        requests.patch(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?"
            f"id=eq.{requests.utils.quote(rid)}",
            headers={
                "apikey":        SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type":  "application/json",
                "Prefer":        "return=minimal",
            },
            data=_json.dumps({
                "bg_state":          "transparent",
                "needs_manual_bg":   False,
                "bg_failure_reason": None,
                "bg_flagged_at":     None,
            }).encode("utf-8"),
            timeout=20,
        )
    except Exception:
        # Best-effort — fall back to just setting bg_state if the
        # combined PATCH failed.
        pg_set_bg_state(rid, "transparent")
    return (rid, "redone", path)


# ─── Main ────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    # Action mode (mutually exclusive)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--detect",  action="store_true",
                   help="Scan every matching image's corner alpha. Reports "
                        "how many already had bg-removed (transparent corners) "
                        "vs. didn't (opaque corners).")
    g.add_argument("--revert",  action="store_true",
                   help="Re-fetch the ORIGINAL image from PriceCharting and "
                        "upload as-is (white background restored). Use this "
                        "for tins / products the chromakey over-ate.")
    g.add_argument("--redo",    action="store_true",
                   help="Re-fetch the ORIGINAL image from PriceCharting and "
                        "re-run bg removal with the supplied --white-thresh / "
                        "--tolerance / --shrink settings.")

    # Filters
    ap.add_argument("--name-pattern", help="Case-insensitive substring on catalog.name (include).")
    ap.add_argument("--id-pattern",   help="Case-insensitive substring on catalog.id (include).")
    ap.add_argument("--exclude-name", action="append", default=[],
                    help="Case-insensitive substring on catalog.name to EXCLUDE. "
                         "Can be specified multiple times "
                         "(e.g. --exclude-name Tin --exclude-name 'Mini Tin').")
    ap.add_argument("--only-opaque",  action="store_true",
                    help="Before revert/redo, filter to rows whose CURRENT Supabase "
                         "image has all-opaque corners (i.e. bg removal never landed).")

    # Bg-removal tuning (used only by --redo)
    ap.add_argument("--white-thresh", type=int, default=245,
                    help="Conservative default for --redo: pixel must be >=245 to "
                         "count as white. (Original pass used 220.)")
    ap.add_argument("--tolerance",    type=int, default=20,
                    help="Conservative default for --redo: how much variation the "
                         "fill tolerates as it spreads. (Original pass used 60.)")
    ap.add_argument("--shrink",       type=int, default=0,
                    help="After bg removal, eat N pixels from the opaque edge. "
                         "Default 0 for --redo (no shrink = no metallic fringe loss).")
    ap.add_argument("--mode", choices=["flood", "all-white", "ml"], default="flood",
                    help="flood (default) | all-white | ml (rembg/U2Net, "
                         "handles photo/gradient/tinted bgs flood-fill can't).")

    # Workflow
    ap.add_argument("--preview",  action="store_true",
                    help="Process exactly ONE row and save the result to disk "
                         "(original.jpg + after_*.webp) instead of uploading. "
                         "Lets you eyeball settings before committing.")
    ap.add_argument("--limit",    type=int, default=0,
                    help="Stop after N rows (debug).")
    ap.add_argument("--workers",  type=int, default=3,
                    help="Parallel workers (default 3 — PriceCharting "
                         "rate-limits aggressively, raise carefully).")
    ap.add_argument("--dry-run",  action="store_true",
                    help="Show counts + first 10 affected rows, don't upload anything.")
    ap.add_argument("--resume",   action="store_true",
                    help="Skip rows whose Supabase image was uploaded "
                         "in the last 2 hours (presumed already done by "
                         "a prior run). Lets you re-run after 403 waves "
                         "and only laggards get retried.")
    ap.add_argument("--no-flag",  action="store_true",
                    help="Disable auto-flagging of bg-removal failures. "
                         "Default behaviour: when --redo can't strip the "
                         "background (output bytes >= input bytes — cream "
                         "/ yellow / gradient bg), the row is marked "
                         "needs_manual_bg=true in catalog and surfaces in "
                         "the admin Sealed BG Review queue.")
    args = ap.parse_args()

    print("\n  Loading sealed-product rows…")
    # When --only-opaque is set, push the filter into Postgres via
    # bg_state IN ('opaque','unknown') — that's index-backed and avoids
    # the per-image HTTP pre-scan entirely. 'unknown' is included so
    # rows that haven't been classified yet (fresh after migration)
    # still get processed; --redo will set their state correctly.
    bg_state_filter = None
    sql_pushed_opaque = False
    if args.only_opaque and not args.detect:
        bg_state_filter = ["opaque", "unknown"]
        sql_pushed_opaque = True
    rows = pg_get_rows(
        name_pattern=args.name_pattern,
        id_pattern=args.id_pattern,
        exclude_name=args.exclude_name,
        bg_state_in=bg_state_filter,
    )
    print(f"  {len(rows):,} rows matched filters"
          + (" (bg_state IN opaque,unknown — cached)" if sql_pushed_opaque else "")
          + ".")

    if args.resume and not args.detect:
        rows = filter_to_unprocessed(rows, hours=2)

    # Optionally narrow to opaque-corner rows (= didn't get bg-removed).
    # Has to happen BEFORE limit/workers, and we need the corner scan
    # anyway — so we just call detect first.
    if args.only_opaque and not args.detect:
        # SQL filter already kept only bg_state IN (opaque, unknown).
        # Rows tagged 'opaque' in catalog are trusted — no classification.
        # Rows tagged 'unknown' (never classified yet) get scanned now
        # and their state is cached back to catalog. After the first
        # run everything is cached and this whole block is a no-op.
        unknown_rows = [r for r in rows if (r.get("bg_state") or "unknown") == "unknown"]
        cached_opaque = [r for r in rows if r.get("bg_state") == "opaque"]
        if unknown_rows:
            print(f"  Classifying {len(unknown_rows)} rows with bg_state=unknown "
                  f"(one-time per row — result cached in catalog.bg_state)…")
            classified_opaque = []
            transparent_count = 0
            failed_count = 0
            failures = []
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                futs = {pool.submit(process_detect, r): r for r in unknown_rows}
                done = 0
                for f in as_completed(futs):
                    rid, status, detail, _ = f.result()
                    done += 1
                    if status == "opaque":
                        classified_opaque.append(futs[f])
                    elif status == "transparent":
                        transparent_count += 1
                    else:
                        failed_count += 1
                        if len(failures) < 10:
                            failures.append((rid, detail))
                    if done % 100 == 0:
                        print(f"    scanned {done}/{len(unknown_rows)}  "
                              f"(opaque={len(classified_opaque)} transparent={transparent_count} failed={failed_count})")
            print(f"  Classification done: opaque={len(classified_opaque)} "
                  f"transparent={transparent_count} failed={failed_count}")
            if failures:
                print(f"  First {len(failures)} failures:")
                for rid, detail in failures:
                    print(f"     {rid:<40}  {detail[:80]}")
            rows = cached_opaque + classified_opaque
        else:
            print(f"  All {len(cached_opaque)} rows have cached bg_state — skipping pre-scan.")
            rows = cached_opaque
        print(f"  {len(rows):,} opaque rows to process.")

    if args.limit:
        rows = rows[:args.limit]

    # ─── DETECT MODE ─────────────────────────────────────────────────────
    if args.detect:
        if args.dry_run:
            print("\n  --dry-run: first 10 candidate rows:")
            for r in rows[:10]:
                print(f"    {r['id']:<40}  {r['name'][:60]}")
            return
        print(f"\n  Scanning {len(rows):,} images with {args.workers} workers…\n")
        stats = {"opaque": 0, "transparent": 0, "failed": 0}
        opaque_list = []
        _lock = threading.Lock()
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = {pool.submit(process_detect, r): r for r in rows}
            done = 0
            for f in as_completed(futs):
                rid, status, detail, _ = f.result()
                done += 1
                with _lock:
                    stats[status] = stats.get(status, 0) + 1
                    if status == "opaque":
                        opaque_list.append((rid, futs[f].get("name", "")))
                    if done % 50 == 0 or done == len(rows):
                        print(f"  [{done}/{len(rows)}] transparent={stats['transparent']} opaque={stats['opaque']} failed={stats['failed']}")
        print(f"\n  Summary: {stats['transparent']:,} transparent, {stats['opaque']:,} opaque, {stats['failed']:,} failed.")
        if opaque_list:
            print(f"\n  First 30 opaque (= bg removal never applied):")
            for rid, name in opaque_list[:30]:
                print(f"    {rid:<40}  {name[:60]}")
        return

    # ─── REVERT / REDO MODES ─────────────────────────────────────────────
    if args.dry_run:
        print(f"\n  --dry-run: first 10 of {len(rows)} rows that would be "
              f"{'reverted' if args.revert else 'redone'}:")
        for r in rows[:10]:
            print(f"    {r['id']:<40}  {r['name'][:60]}")
        return

    if args.preview:
        if not rows:
            sys.exit("  No rows to preview.")
        r = rows[0]
        print(f"  [preview] {r['id']}  {r['name']}")
        if args.revert:
            res = process_revert(r, preview=True)
        else:
            res = process_redo(r, args.white_thresh, args.tolerance,
                               args.shrink, args.mode, preview=True)
        rid, status, detail = res
        print(f"  [preview] {status}: {detail}")
        return

    action_label = "reverting" if args.revert else "redoing"
    print(f"\n  {action_label.capitalize()} {len(rows):,} rows with {args.workers} workers")
    print("  Starting in 3s — Ctrl+C to abort\n")
    time.sleep(3)

    _lock = threading.Lock()
    stats = {"completed": 0}

    def worker(row):
        if args.revert:
            return process_revert(row)
        return process_redo(row, args.white_thresh, args.tolerance,
                            args.shrink, args.mode,
                            flag_failures=not args.no_flag)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(worker, r): r for r in rows}
        for f in as_completed(futs):
            rid, status, detail = f.result()
            with _lock:
                stats[status] = stats.get(status, 0) + 1
                stats["completed"] += 1
                n = stats["completed"]
                if status == "failed":
                    print(f"  [{n:>4}/{len(rows)}] FAIL  {rid}  — {detail}")
                elif n % 25 == 0 or n == len(rows):
                    parts = [f"{k}={v}" for k, v in stats.items() if k != "completed"]
                    print(f"  [{n:>4}/{len(rows)}] " + " ".join(parts))

    print(f"\n  Done. " + " ".join(f"{k}={v}" for k, v in stats.items() if k != "completed"))


if __name__ == "__main__":
    main()
