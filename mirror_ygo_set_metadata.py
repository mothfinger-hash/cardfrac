#!/usr/bin/env python3
"""
PathBinder — Yu-Gi-Oh Set Metadata (YGOPRODeck)
==================================================
Pulls the full Yu-Gi-Oh set list from YGOPRODeck and upserts
public.set_metadata rows with name + release_date + card counts.

NO LOGO MIRROR — YGOPRODeck doesn't ship set icons, and there's
no clean API for them. The Sets page renders YGO sets text-only
for now; we can revisit by either scraping Yugipedia (fragile) or
building a manual-upload admin tool (cleaner) once we know users
care.

PREREQUISITES
-------------
    pip3 install requests supabase --break-system-packages

USAGE
-----
    python3 mirror_ygo_set_metadata.py --dry-run
    python3 mirror_ygo_set_metadata.py
    python3 mirror_ygo_set_metadata.py --force

ENVIRONMENT
-----------
    SUPABASE_URL              your project URL
    SUPABASE_SERVICE_KEY      service-role key
"""

import os
import sys
import argparse

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

# YGOPRODeck's cardsetsinfo endpoint returns the full set list as a
# single JSON array — no pagination, no auth, free. Each entry has
# set_name, set_code, tcg_date, num_of_cards.
YGOPRODECK_SETS_URL = "https://db.ygoprodeck.com/api/v7/cardsets.php"

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def fetch_ygo_sets():
    """Pull the YGOPRODeck set list. Single ~1MB JSON response."""
    r = requests.get(YGOPRODECK_SETS_URL, timeout=60)
    r.raise_for_status()
    return r.json() or []


def existing_ygo_set_ids():
    """Return set ids already in set_metadata for YGO so re-runs skip
    them without --force."""
    seen = set()
    page = 0
    page_size = 1000
    while True:
        r = sb.table("set_metadata").select("id") \
              .eq("game_type", "yugioh") \
              .range(page * page_size, page * page_size + page_size - 1).execute()
        rows = r.data or []
        for row in rows:
            seen.add(row["id"])
        if len(rows) < page_size:
            break
        page += 1
    return seen


def normalize_ygo_set(s):
    """Map a YGOPRODeck set row to a set_metadata row. Returns None
    if we can't extract a usable id."""
    name = (s.get("set_name") or "").strip()
    code = (s.get("set_code") or "").strip().lower()
    if not (name and code):
        return None
    return {
        # Composite id under the ygo- prefix so it doesn't collide with
        # Pokemon ('sv8') or Magic ('mtg-lci') ids in set_metadata.
        "id":           f"ygo-{code}",
        "name":         name,
        "game_type":    "yugioh",
        # YGOPRODeck ships tcg_date as ISO yyyy-mm-dd or null.
        "release_date": s.get("tcg_date") or None,
        # YGOPRODeck's num_of_cards counts every printing in the set,
        # which matches Pokemon's `total` field semantics (includes
        # secret rares). printed_total isn't separately tracked.
        "printed_total": s.get("num_of_cards"),
        "total":         s.get("num_of_cards"),
        # No logos for YGO yet (see module docstring).
        "logo_url":   None,
        "symbol_url": None,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the rows that would be upserted.")
    ap.add_argument("--force", action="store_true",
                    help="Re-upsert sets already in set_metadata.")
    args = ap.parse_args()

    print("Fetching YGOPRODeck sets…", flush=True)
    sets = fetch_ygo_sets()
    print(f"  {len(sets)} sets returned.", flush=True)

    rows = [normalize_ygo_set(s) for s in sets]
    rows = [r for r in rows if r]

    if not args.force and not args.dry_run:
        seen = existing_ygo_set_ids()
        before = len(rows)
        rows = [r for r in rows if r["id"] not in seen]
        print(f"  skipping {before - len(rows)} already-loaded set(s) "
              f"(use --force to re-upsert).", flush=True)

    if not rows:
        print("Nothing to do.")
        return

    print(f"\n{'DRY-RUN — ' if args.dry_run else ''}Upserting {len(rows)} set(s)…\n",
          flush=True)

    ok, fail = 0, 0
    for row in rows:
        if args.dry_run:
            print(f"  · {row['id']:25s} {row['release_date'] or '----------':10s}  {row['name']}")
            ok += 1
            continue
        try:
            sb.table("set_metadata").upsert(row, on_conflict="id").execute()
            print(f"  ✓ {row['id']:25s} {row['release_date'] or '----------':10s}  {row['name']}")
            ok += 1
        except Exception as e:
            print(f"  ✗ {row['id']:25s} FAIL: {e}")
            fail += 1

    print()
    print(f"Done. upserted={ok}  failed={fail}")


if __name__ == "__main__":
    main()
