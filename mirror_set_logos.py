#!/usr/bin/env python3
"""
PathBinder — Set Logo Mirror
==============================
Fetches the pokemontcg.io sets list, downloads each set's logo + symbol
image, uploads them to Supabase Storage under the `set-logos/` bucket,
and upserts a row into public.set_metadata with the mirrored URLs +
release_date + total counts.

Why this exists
---------------
Lighthouse showed the Sets page transferred ~35 MB from pokemontcg.io
on a single visit, almost entirely set logos. By mirroring them once
we cut the third-party dependency, let the service worker cache them
aggressively, and survive any future pokemontcg.io outage.

PREREQUISITES
-------------
    pip3 install requests supabase --break-system-packages

USAGE
-----
    # First, run migration_set_metadata.sql in the Supabase SQL editor.
    # That creates the set_metadata table + set-logos storage bucket.

    # Dry-run — list sets that would be mirrored, no writes
    python3 mirror_set_logos.py --dry-run

    # Mirror all Pokemon sets from pokemontcg.io
    python3 mirror_set_logos.py

    # Force re-mirror even if already in set_metadata (e.g. logo URL
    # on pokemontcg.io changed)
    python3 mirror_set_logos.py --force

    # Crank up parallelism (default 4 workers)
    python3 mirror_set_logos.py --workers 8

ENVIRONMENT
-----------
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
    POKEMONTCG_IO_API_KEY     (optional) bumps pokemontcg.io rate limits

STORAGE LAYOUT
--------------
    set-logos/{set_id}-logo.{ext}      full set logo (with name text)
    set-logos/{set_id}-symbol.{ext}    small set symbol icon

The extension matches whatever pokemontcg.io serves — usually .png.
We don't transcode to WebP because set logos already use indexed PNG
which compresses very well and is universally supported.
"""

import os
import sys
import time
import random
import argparse
import threading
import mimetypes
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing 'supabase'. Run: pip3 install supabase --break-system-packages")


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

PTCG_API_KEY = os.environ.get("POKEMONTCG_IO_API_KEY", "").strip() or None
BUCKET = "set-logos"

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

_session = requests.Session()
_session.headers.update({
    "User-Agent": "PathBinder-LogoMirror/1.0",
    "Accept":     "image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
})

_print_lock = threading.Lock()
def _log(*args):
    with _print_lock:
        print(*args, flush=True)


# ─── pokemontcg.io fetch ─────────────────────────────────────────────────────
def fetch_pokemontcg_sets():
    """Return the full list of Pokemon sets from pokemontcg.io.
    The /v2/sets endpoint returns up to 250 in one shot, which covers
    the entire run from Base Set to the latest at time of writing."""
    headers = {}
    if PTCG_API_KEY:
        headers["X-Api-Key"] = PTCG_API_KEY
    url = "https://api.pokemontcg.io/v2/sets"
    params = {"orderBy": "-releaseDate", "pageSize": 250}
    r = _session.get(url, params=params, headers=headers, timeout=60)
    r.raise_for_status()
    data = r.json()
    return data.get("data", [])


# ─── Storage upload ──────────────────────────────────────────────────────────
def _ext_from_url(url):
    """Best-effort extension extraction from the URL path. Falls back
    to .png since that's what pokemontcg.io ships in practice."""
    try:
        path = urlparse(url).path
        ext = os.path.splitext(path)[1].lower()
        if ext in (".png", ".jpg", ".jpeg", ".webp", ".svg"):
            return ext
    except Exception:
        pass
    return ".png"


def _content_type_for(ext):
    guess = mimetypes.guess_type("x" + ext)[0]
    return guess or "image/png"


def _is_transient(err):
    """Detect macOS / Linux EAGAIN-style errors that resolve on retry.
    On macOS the supabase-py upload throws `[Errno 35] Resource
    temporarily unavailable` when too many sockets are open at once.
    The next attempt almost always succeeds after a brief sleep."""
    s = str(err).lower()
    return any(t in s for t in (
        "resource temporarily unavailable",
        "errno 35",
        "errno 11",                  # Linux EAGAIN
        "connection reset",
        "broken pipe",
        "timed out",
        "remoteprotocolerror",
        "503",
    ))


def upload_to_storage(set_id, kind, source_url, max_retries=5):
    """Download from source_url, upload to set-logos/{set_id}-{kind}{ext},
    return the public Supabase URL.

    Retries on transient OS-level network errors (EAGAIN, broken pipe,
    etc.) with exponential backoff. macOS's default 256-FD limit is
    easy to exhaust when running multiple workers each opening
    download + upload sockets — these failures are NOT bad inputs,
    they're resource starvation."""
    ext = _ext_from_url(source_url)
    path = f"{set_id}-{kind}{ext}"

    # Download — same session shared across all calls so we reuse
    # keep-alive connections instead of opening a new one per request.
    last_err = None
    for attempt in range(max_retries):
        try:
            r = _session.get(source_url, timeout=30)
            if not r.ok:
                raise RuntimeError(f"download {source_url} -> HTTP {r.status_code}")
            body = r.content
            if not body:
                raise RuntimeError(f"download {source_url} -> empty body")
            break
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1 and _is_transient(e):
                time.sleep((2 ** attempt) * 0.3 + random.uniform(0, 0.4))
                continue
            raise

    content_type = _content_type_for(ext)
    file_opts = {
        "content-type": content_type,
        "cache-control": "public, max-age=31536000, immutable",
        "upsert": "true",
    }

    # Upload — retry on EAGAIN / EPIPE / similar resource-starvation
    # errors. Each attempt sleeps a bit longer so the OS can recycle
    # the exhausted sockets / FDs before we hammer it again.
    for attempt in range(max_retries):
        try:
            sb.storage.from_(BUCKET).upload(path, body, file_options=file_opts)
            break
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1 and _is_transient(e):
                time.sleep((2 ** attempt) * 0.5 + random.uniform(0, 0.5))
                continue
            raise

    public = sb.storage.from_(BUCKET).get_public_url(path)
    # supabase-py occasionally returns the URL with a trailing ?
    return public.rstrip("?")


# ─── DB upsert ───────────────────────────────────────────────────────────────
def upsert_set_metadata(row):
    """Idempotent upsert by id (the set's pokemontcg.io id)."""
    sb.table("set_metadata").upsert(row, on_conflict="id").execute()


def existing_set_ids():
    """Pull every id we've already mirrored so we can skip them on
    re-runs (unless --force)."""
    seen = set()
    page = 0
    page_size = 1000
    while True:
        r = sb.table("set_metadata").select("id").range(
            page * page_size, page * page_size + page_size - 1
        ).execute()
        rows = r.data or []
        for row in rows:
            seen.add(row["id"])
        if len(rows) < page_size:
            break
        page += 1
    return seen


# ─── Per-set processor ───────────────────────────────────────────────────────
def process_set(s, force=False, dry_run=False):
    """Mirror one set. Returns 'mirrored' / 'skipped' / 'failed'."""
    set_id = s.get("id")
    name   = s.get("name")
    if not (set_id and name):
        return ("failed", set_id or "(no id)", "missing id/name in API row")

    images = s.get("images") or {}
    logo_src   = images.get("logo")
    symbol_src = images.get("symbol")

    if not (logo_src or symbol_src):
        return ("skipped", set_id, "no logo or symbol in API response")

    release_date = s.get("releaseDate")  # ISO yyyy/mm/dd in their feed
    if release_date:
        # pokemontcg.io returns 2026/05/22 with slashes. Postgres
        # accepts both yyyy-mm-dd and yyyy/mm/dd, but normalize anyway.
        release_date = release_date.replace("/", "-")

    row = {
        "id":            set_id,
        "name":          name,
        "series":        s.get("series"),
        "game_type":     "pokemon",
        "release_date":  release_date,
        "printed_total": s.get("printedTotal"),
        "total":         s.get("total"),
    }

    if dry_run:
        return ("mirrored", set_id, f"DRY: would mirror {name} (logo+symbol)")

    # Upload images, then write the row referencing the mirrored URLs.
    try:
        if logo_src:
            row["logo_url"] = upload_to_storage(set_id, "logo", logo_src)
        if symbol_src:
            row["symbol_url"] = upload_to_storage(set_id, "symbol", symbol_src)
    except Exception as e:
        return ("failed", set_id, f"upload: {e}")

    try:
        upsert_set_metadata(row)
    except Exception as e:
        return ("failed", set_id, f"upsert: {e}")

    return ("mirrored", set_id, name)


# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description="Mirror pokemontcg.io set logos to Supabase Storage.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="List what would be mirrored, write nothing.")
    ap.add_argument("--force", action="store_true",
                    help="Re-mirror sets that are already in set_metadata.")
    ap.add_argument("--workers", type=int, default=2,
                    help="Parallel upload workers (default 2 — macOS's "
                         "low FD limit means more workers risk EAGAIN "
                         "errors. The retry path handles those but a "
                         "smaller default avoids them entirely).")
    ap.add_argument("--only", default=None, metavar="SET_ID",
                    help="Mirror just one set by id (debugging).")
    args = ap.parse_args()

    _log("Fetching set list from pokemontcg.io…")
    sets = fetch_pokemontcg_sets()
    _log(f"  Received {len(sets):,} sets.")

    if args.only:
        sets = [s for s in sets if s.get("id") == args.only]
        if not sets:
            sys.exit(f"No set with id={args.only} in the API response.")

    if not args.force and not args.dry_run:
        _log("Reading set_metadata to skip already-mirrored sets…")
        already = existing_set_ids()
        _log(f"  {len(already):,} already mirrored. Use --force to re-do.")
        sets = [s for s in sets if s.get("id") not in already]

    if not sets:
        _log("Nothing to do.")
        return

    _log(f"Mirroring {len(sets):,} set(s) with {args.workers} workers…")
    n_ok = n_skip = n_fail = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(process_set, s, args.force, args.dry_run) for s in sets]
        for i, fut in enumerate(as_completed(futs), start=1):
            outcome, set_id, info = fut.result()
            if outcome == "mirrored":
                n_ok += 1
                _log(f"  [{i:>4}/{len(sets)}] ✓ {set_id:<24s} {info}")
            elif outcome == "skipped":
                n_skip += 1
                _log(f"  [{i:>4}/{len(sets)}] - {set_id:<24s} {info}")
            else:
                n_fail += 1
                _log(f"  [{i:>4}/{len(sets)}] FAIL {set_id:<22s} {info}")

    _log("")
    _log(f"  Mirrored : {n_ok}")
    _log(f"  Skipped  : {n_skip}")
    _log(f"  Failed   : {n_fail}")
    if args.dry_run:
        _log("")
        _log("  (DRY RUN — nothing was written. Re-run without --dry-run to commit.)")


if __name__ == "__main__":
    main()
