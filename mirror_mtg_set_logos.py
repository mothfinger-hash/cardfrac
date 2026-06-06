#!/usr/bin/env python3
"""
PathBinder — Magic Set Logo Mirror (Scryfall)
==============================================
Fetches the Magic sets list from Scryfall, downloads each set's SVG
icon, uploads to Supabase Storage under the `set-logos/` bucket
alongside the Pokemon mirrors, and upserts a row into
public.set_metadata with the mirrored URL + release_date + card counts.

Why Scryfall
-------------
Scryfall is the canonical Magic-the-Gathering data source — same
icons used by MTGGoldfish, EDHRec, Moxfield, etc. No API key, no
rate-limiting issues at the volume we're mirroring (~800 sets, one
~15KB SVG each). They request a 50-100ms delay between requests as
a courtesy; we already pace via the per-worker sleep.

PREREQUISITES
-------------
    pip3 install requests supabase --break-system-packages

USAGE
-----
    # Dry-run — list sets that would be mirrored
    python3 mirror_mtg_set_logos.py --dry-run

    # Mirror everything
    python3 mirror_mtg_set_logos.py

    # Force re-mirror even if already in set_metadata
    python3 mirror_mtg_set_logos.py --force

    # Parallelism (default 4 workers — Scryfall handles it fine)
    python3 mirror_mtg_set_logos.py --workers 4

ENVIRONMENT
-----------
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key

STORAGE LAYOUT
--------------
    set-logos/mtg-{set_code}-logo.svg

Set codes are lowercased by Scryfall (e.g. "lci", "neo", "lotr") so
the storage path stays clean.
"""

import os
import sys
import time
import random
import argparse
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

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

BUCKET = "set-logos"
SCRYFALL_SETS_URL = "https://api.scryfall.com/sets"

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

_session = requests.Session()
_session.headers.update({
    "User-Agent": "PathBinder-LogoMirror/1.0 (contact: charles@merchunlimited.com)",
    "Accept":     "image/svg+xml,image/*;q=0.8,*/*;q=0.5",
})

_print_lock = threading.Lock()
def _log(*args):
    with _print_lock:
        print(*args, flush=True)


# ─── Scryfall fetch ──────────────────────────────────────────────────────────
def fetch_scryfall_sets():
    """Pull the full Scryfall sets list. Single call returns ~800 sets,
    no pagination needed."""
    r = _session.get(SCRYFALL_SETS_URL, timeout=60)
    r.raise_for_status()
    data = r.json()
    return data.get("data", [])


# ─── Storage upload ──────────────────────────────────────────────────────────
def _is_transient(err):
    s = str(err).lower()
    return any(t in s for t in (
        "resource temporarily unavailable",
        "errno 35", "errno 11", "connection reset", "broken pipe",
        "timed out", "remoteprotocolerror", "503",
    ))


def upload_to_storage(set_code, source_url, max_retries=5):
    """Download Scryfall's SVG and upload to set-logos/mtg-<code>-logo.svg.
    Returns the public Supabase URL."""
    path = f"mtg-{set_code}-logo.svg"

    last_err = None
    body = None
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

    file_opts = {
        "content-type":  "image/svg+xml",
        "cache-control": "public, max-age=31536000, immutable",
        "upsert":        "true",
    }
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
    return public.rstrip("?")


# ─── DB helpers ──────────────────────────────────────────────────────────────
def upsert_set_metadata(row):
    sb.table("set_metadata").upsert(row, on_conflict="id").execute()


def existing_mtg_set_ids():
    """Return set ids already mirrored for Magic so we can skip them
    on re-runs unless --force is passed."""
    seen = set()
    page = 0
    page_size = 1000
    while True:
        r = sb.table("set_metadata").select("id") \
              .eq("game_type", "magic") \
              .range(page * page_size, page * page_size + page_size - 1).execute()
        rows = r.data or []
        for row in rows:
            seen.add(row["id"])
        if len(rows) < page_size:
            break
        page += 1
    return seen


# ─── Per-set processor ───────────────────────────────────────────────────────
def process_set(s, force=False, dry_run=False):
    """Mirror one MTG set. Returns (status, set_code, detail)."""
    code = (s.get("code") or "").lower()
    name = s.get("name")
    if not (code and name):
        return ("failed", code or "(no code)", "missing code/name in API row")

    # Composite id under the mtg- prefix so it doesn't collide with
    # Pokemon ids in set_metadata (Pokemon uses bare codes like 'sv8').
    set_id = f"mtg-{code}"

    icon_src = s.get("icon_svg_uri")
    if not icon_src:
        return ("skipped", set_id, "no icon_svg_uri in Scryfall response")

    release_date = s.get("released_at")   # ISO yyyy-mm-dd, already normalized

    row = {
        "id":            set_id,
        "name":          name,
        "series":        s.get("block") or s.get("set_type"),
        "game_type":     "magic",
        "release_date":  release_date,
        "printed_total": s.get("card_count"),
        "total":         s.get("card_count"),
    }

    if dry_run:
        return ("mirrored", set_id, f"DRY: would mirror {name} ({code}, {release_date})")

    try:
        row["logo_url"] = upload_to_storage(code, icon_src)
        # Scryfall's icon IS the symbol (compact ~25x25 SVG). We
        # populate both columns to the same URL so the UI can fall
        # back interchangeably without extra logic per game.
        row["symbol_url"] = row["logo_url"]
    except Exception as e:
        return ("failed", set_id, f"upload: {e}")

    try:
        upsert_set_metadata(row)
    except Exception as e:
        return ("failed", set_id, f"upsert: {e}")

    return ("mirrored", set_id, f"{name} ({release_date})")


# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true",
                    help="List sets that would be mirrored without writing.")
    ap.add_argument("--force", action="store_true",
                    help="Re-mirror sets already in set_metadata.")
    ap.add_argument("--workers", type=int, default=4,
                    help="Parallel mirror workers (default 4).")
    ap.add_argument("--only", default=None,
                    help="Mirror only this set code (e.g. 'lci', 'neo').")
    args = ap.parse_args()

    print("Fetching Scryfall sets list…", flush=True)
    sets = fetch_scryfall_sets()
    print(f"  {len(sets)} sets returned.", flush=True)

    if args.only:
        sets = [s for s in sets if (s.get("code") or "").lower() == args.only.lower()]
        print(f"  filtered to --only={args.only} → {len(sets)} set(s)", flush=True)

    if not args.force and not args.dry_run:
        seen = existing_mtg_set_ids()
        before = len(sets)
        sets = [s for s in sets if f"mtg-{(s.get('code') or '').lower()}" not in seen]
        print(f"  skipping {before - len(sets)} already-mirrored set(s) "
              f"(use --force to re-mirror).", flush=True)

    if not sets:
        print("Nothing to mirror.")
        return

    counts = {"mirrored": 0, "skipped": 0, "failed": 0}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_set, s, args.force, args.dry_run): s for s in sets}
        for f in as_completed(futs):
            status, set_id, detail = f.result()
            counts[status] = counts.get(status, 0) + 1
            sym = {"mirrored":"✓","skipped":"·","failed":"✗"}.get(status, "?")
            _log(f"  {sym} {set_id:20s} {detail}")

    print()
    print(f"Done. mirrored={counts['mirrored']}  skipped={counts['skipped']}  failed={counts['failed']}")


if __name__ == "__main__":
    main()
