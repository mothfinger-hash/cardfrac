#!/usr/bin/env python3
"""
PathBinder — release_date backfill (tcgcsv publishedOn -> catalog.release_date)
==============================================================================
Fills catalog.release_date so era can be a first-class fact: the "your era"
Market rail, era filters, "newest first" sorting, and anything else that wants
to know when a card came out.

Why this exists
---------------
Measured before writing this: release_date is populated 90-100% for jp-, mtg-
and ygo- rows and 0/26,027 for ENGLISH POKEMON — both the en- (PokeData) shard
and the legacy bare-id shard. So era works today for a Magic collector and is
completely blind for the core audience.

No sync writes it for EN Pokemon. pokedata_sync.py mentions release_date zero
times, and it is a dead end anyway (that source is retired — its Japanese cards
are already in). The live pipeline is tcgcsv, and tcgcsv's group feed carries
publishedOn:
    {"groupId": 23228, "abbreviation": "SV03", "name": "SV03: Obsidian Flames",
     "publishedOn": "2023-08-11T00:00:00"}
and tcgplayer_group_map already bridges group_id -> set_code (1,607 rows,
written by sync_tcgcsv.py). So the whole job is a join we already have both
sides of.

Coverage, measured against the live catalog:
    155 / 249 EN Pokemon set_codes  ->  17,227 / 26,027 rows  (66%)
    era split it produces:  1,585 vintage (<=2003)
                            5,132 mid     (2004-2015)
                           10,510 modern  (2016+)
The 8,800 unmatched rows are sets with no group-map entry or no publishedOn
(SMP, DRI, MCAP, xyp, swshp, …) — mostly promo sets. They stay NULL and the era
rail simply skips them, which is correct: a guessed date is worse than none.

Scope is derived from tcgplayer_group_map's own (category_id, game_type) pairs
rather than a hardcoded list — a hardcoded list of games is exactly the kind of
allowlist that rots silently. Whatever the map knows about, this covers.

PREREQUISITES
    pip3 install requests --break-system-packages

USAGE
    # Dry run — reports coverage and writes nothing. Anon key is enough.
    SUPABASE_URL=https://<ref>.supabase.co \
    SUPABASE_ANON_KEY=<anon> python3 backfill_release_dates.py --dry-run

    # For real
    SUPABASE_URL=https://<ref>.supabase.co \
    SUPABASE_SERVICE_KEY=<service_role> python3 backfill_release_dates.py

    ... --game pokemon        # scope to one game
    ... --force               # overwrite existing dates (default: only fill NULLs)

ENVIRONMENT
    SUPABASE_URL            project URL
    SUPABASE_SERVICE_KEY    service-role key (required for a real run)
    SUPABASE_ANON_KEY       public key (enough for --dry-run)
"""

import os
import sys
import time
import argparse
import collections

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")

TCGCSV_BASE = "https://tcgcsv.com"
# tcgcsv 401s on a default urllib/requests UA. sync_tcgcsv.py uses this exact
# string; keep them identical so we're one identifiable client to them.
USER_AGENT = "PathBinderSync/1.0 (+https://pathbinder.gg)"
REQ_SLEEP = 0.1

_last = [0.0]


def log(m):
    print(m, flush=True)


def rest(key):
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def tcg_get(path):
    dt = time.time() - _last[0]
    if dt < REQ_SLEEP:
        time.sleep(REQ_SLEEP - dt)
    r = requests.get(f"{TCGCSV_BASE}{path}", headers={"User-Agent": USER_AGENT}, timeout=60)
    _last[0] = time.time()
    r.raise_for_status()
    return r.json().get("results", [])


def page(key, path):
    """Page a PostgREST endpoint; the server caps at 1000 rows per response."""
    out, off = [], 0
    while True:
        r = requests.get(f"{SUPABASE_URL}/rest/v1/{path}&limit=1000&offset={off}",
                         headers=rest(key), timeout=60)
        r.raise_for_status()
        b = r.json()
        if not b:
            break
        out += b
        if len(b) < 1000:
            break
        off += 1000
    return out


def main():
    ap = argparse.ArgumentParser(description="Backfill catalog.release_date from tcgcsv publishedOn.")
    ap.add_argument("--game", default=None, help="scope to one game_type (default: every game in the group map)")
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--force", action="store_true", help="overwrite existing dates (default: fill NULLs only)")
    args = ap.parse_args()

    if not SUPABASE_URL:
        sys.exit("Set SUPABASE_URL.")
    key = SERVICE_KEY or ANON_KEY
    if not key:
        sys.exit("Set SUPABASE_SERVICE_KEY (real run) or SUPABASE_ANON_KEY (--dry-run).")
    if not args.dry_run and not SERVICE_KEY:
        sys.exit("A real run needs SUPABASE_SERVICE_KEY — catalog writes are RLS-gated. "
                 "Use --dry-run with the anon key.")

    log(f"release_date backfill — {'DRY RUN (nothing written)' if args.dry_run else 'LIVE'}")

    # 1. The bridge, already built by sync_tcgcsv.py. Scope comes from the map
    #    itself, so a new game added there is covered here for free.
    gm = page(key, "tcgplayer_group_map?select=group_id,set_code,category_id,game_type")
    if args.game:
        gm = [m for m in gm if m.get("game_type") == args.game]
    cats = sorted({(m["category_id"], m["game_type"]) for m in gm if m.get("category_id")})
    log(f"  group map: {len(gm)} rows across {len(cats)} categories "
        f"({', '.join(g for _, g in cats)})")

    # 2. publishedOn per group, per category
    pub = {}
    for cid, game in cats:
        try:
            groups = tcg_get(f"/tcgplayer/{cid}/groups")
        except Exception as e:
            log(f"  ! category {cid} ({game}) unreachable: {e}")
            continue
        n = 0
        for g in groups:
            if g.get("publishedOn"):
                pub[g["groupId"]] = g["publishedOn"][:10]
                n += 1
        log(f"  category {cid:<4} {game:<10} {len(groups):>4} groups, {n:>4} dated")

    # 3. group_id -> set_code -> date. A set_code can map to several groups
    #    (TCGplayer splits big sets); take the EARLIEST, which is the set's real
    #    release — a later sub-group is a reprint wave, not the debut.
    by_set = {}
    for m in gm:
        d = pub.get(m["group_id"])
        if not d or not m.get("set_code"):
            continue
        sc = m["set_code"]
        if sc not in by_set or d < by_set[sc]:
            by_set[sc] = d
    log(f"  resolved dates for {len(by_set)} set_codes")

    # 4. what actually needs it
    flt = "" if args.force else "&release_date=is.null"
    rows = page(key, f"catalog?select=set_code{flt}")
    need = collections.Counter(r["set_code"] for r in rows if r.get("set_code"))
    hit = {s: by_set[s] for s in need if s in by_set}
    cover = sum(need[s] for s in hit)
    log(f"\n  catalog rows needing a date : {sum(need.values()):>7,} across {len(need)} sets")
    log(f"  coverable from tcgcsv       : {cover:>7,} across {len(hit)} sets  "
        f"({cover / max(1, sum(need.values())) * 100:.0f}%)")

    eras = collections.Counter()
    for s, d in hit.items():
        y = int(d[:4])
        eras["vintage (<=2003)" if y <= 2003 else "mid (2004-2015)" if y <= 2015 else "modern (2016+)"] += need[s]
    log("  era split this produces:")
    for e in ("vintage (<=2003)", "mid (2004-2015)", "modern (2016+)"):
        log(f"    {e:<20} {eras.get(e, 0):>7,}")

    missed = sorted((s for s in need if s not in hit), key=lambda s: -need[s])
    if missed:
        log(f"\n  no date available for {sum(need[s] for s in missed):,} rows in {len(missed)} sets "
            f"(left NULL — a guessed date is worse than none)")
        log(f"    biggest: {', '.join(f'{s}({need[s]})' for s in missed[:8])}")

    if args.dry_run:
        log("\nDRY RUN — nothing written. Re-run with SUPABASE_SERVICE_KEY to apply.")
        return

    # 5. one PATCH per set_code, not per row
    log("")
    ok = fail = wrote = 0
    for s, d in sorted(hit.items(), key=lambda kv: -need[kv[0]]):
        url = f"{SUPABASE_URL}/rest/v1/catalog?set_code=eq.{requests.utils.quote(s)}{flt}"
        try:
            r = requests.patch(url, headers={**rest(SERVICE_KEY), "Content-Type": "application/json",
                                             "Prefer": "return=minimal"},
                               json={"release_date": d}, timeout=60)
            if r.status_code < 300:
                ok += 1
                wrote += need[s]
                log(f"  {s:<12} -> {d}   ({need[s]} rows)")
            else:
                fail += 1
                log(f"  ! {s}: HTTP {r.status_code} {r.text[:120]}")
        except Exception as e:
            fail += 1
            log(f"  ! {s}: {e}")

    log("\n" + "=" * 60)
    log(f"  sets updated : {ok}")
    log(f"  rows dated   : {wrote:,}")
    log(f"  failures     : {fail}")
    log("=" * 60)
    log("  The 'your era' Market rail (user_rails) lights up on its own now —")
    log("  it needs no code change, it was just waiting for these dates.")


if __name__ == "__main__":
    main()
