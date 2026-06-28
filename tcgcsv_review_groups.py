#!/usr/bin/env python3
"""
PathBinder — TCGCSV group-map cleanup helper (interactive)
==========================================================
Resolves the fuzzy / unmatched rows in tcgplayer_group_map that the auto
sync (sync_tcgcsv.py) couldn't place with confidence. For each one it shows
the TCGplayer group name next to the best candidate catalog sets, and you
pick: map it, skip it forever, or leave it.

Decisions are STICKY — sync_tcgcsv.py preserves anything marked 'manual' or
'skip' and never re-fuzzes it.

ORDER OF OPERATIONS
-------------------
    1. python3 sync_tcgcsv.py --tcg all          # real run populates the map
    2. python3 tcgcsv_review_groups.py --tcg all # this tool — resolve the tail
    3. python3 sync_tcgcsv.py --tcg all          # backfills the newly mapped sets

WHAT EACH KEY DOES (per group)
------------------------------
    1 / 2 / 3   map to that numbered candidate  -> confidence='manual'
    s           skip permanently (you don't carry it) -> confidence='skip'
    m           mark MISSING — a real set you don't have yet but may want to
                import later -> confidence='missing' (captured, not discarded)
    c CODE      map to a set_code you type by hand     -> confidence='manual'
    <enter>     leave as-is, move on
    b           go back one
    q           save progress already made and quit

EXPORT THE MISSING SETS
-----------------------
    python3 tcgcsv_review_groups.py --tcg all --export-missing tcgcsv_missing_sets.csv

Writes every confidence='missing' group with its TCGplayer metadata + a card
count, so you have a worklist of sets to consider importing into the catalog.

Only rows with confidence in ('fuzzy','unmatched') are shown. 'exact' and
already-resolved 'manual'/'skip' rows are left alone.

USAGE
-----
    python3 tcgcsv_review_groups.py --tcg pokemon
    python3 tcgcsv_review_groups.py --tcg all
    python3 tcgcsv_review_groups.py --tcg pokemon --include-fuzzy=false  # unmatched only

ENVIRONMENT
-----------
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (same as sync_tcgcsv.py)
"""

import sys
import argparse
from datetime import datetime, timezone

# Reuse the sync script's helpers (HTTP sessions, normalizers, REST writers).
import sync_tcgcsv as tc


def top_candidates(gname, norm_index, n=3):
    """Return up to n (set_code, set_name, ratio) best matches for a group."""
    norm_cands = [c for c in (tc.norm_name(x) for x in tc.group_name_candidates(gname)) if c]
    scored = []
    for sc, sn, nsn in norm_index:
        if not nsn:
            continue
        best = max((tc.ratio(ncand, nsn) for ncand in norm_cands), default=0.0)
        scored.append((sc, sn, best))
    scored.sort(key=lambda x: x[2], reverse=True)
    return scored[:n]


def write_decision(group_id, category_id, game_type, gname, set_code, set_name, confidence):
    row = {
        "group_id":    group_id,
        "category_id": category_id,
        "game_type":   game_type,
        "group_name":  gname,
        "set_code":    set_code,
        "set_name":    set_name,
        "confidence":  confidence,
        "mapped_at":   datetime.now(timezone.utc).isoformat(),
    }
    tc.sb_upsert_group_map(row)


def review_game(game_type, category_id, include_fuzzy):
    catalog_sets = tc.fetch_catalog_sets(game_type)
    norm_index = [(sc, sn, tc.norm_name(sn)) for sc, sn in catalog_sets.items()]
    code_set = {sc.upper(): sc for sc in catalog_sets}

    conf_filter = "in.(fuzzy,unmatched)" if include_fuzzy else "eq.unmatched"
    rows = tc.sb_get(
        f"tcgplayer_group_map?select=group_id,category_id,game_type,group_name,"
        f"set_code,set_name,confidence&category_id=eq.{category_id}"
        f"&confidence={conf_filter}&order=confidence.asc,group_name.asc"
    )
    if not rows:
        print(f"  Nothing to review for {game_type} (run sync_tcgcsv.py first if this is unexpected).")
        return 0

    print(f"\n=== {game_type}: {len(rows)} group(s) to review ===")
    print("  keys: [1/2/3] map  [s] skip  [m] missing  [c CODE] code  [enter] leave  [b] back  [q] quit\n")

    decided = 0
    i = 0
    while i < len(rows):
        r = rows[i]
        gname = r.get("group_name") or ""
        cur = r.get("confidence")
        cur_note = f"  (currently fuzzy -> {r.get('set_code')})" if cur == "fuzzy" and r.get("set_code") else ""
        cands = top_candidates(gname, norm_index)

        print(f"[{i+1}/{len(rows)}] {gname}{cur_note}")
        for n, (sc, sn, rt) in enumerate(cands, 1):
            print(f"    {n}) {sc:<14} {sn}   ({rt:.2f})")
        if not cands:
            print("    (no candidate sets)")

        try:
            choice = input("  > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n  Quitting (progress saved).")
            break

        if choice == "" :
            i += 1
            continue
        if choice == "q":
            print("  Saved. Bye.")
            break
        if choice == "b":
            i = max(0, i - 1)
            continue
        if choice == "s":
            write_decision(r["group_id"], category_id, game_type, gname, None, None, "skip")
            print("    -> skipped\n")
            decided += 1
            i += 1
            continue
        if choice == "m":
            write_decision(r["group_id"], category_id, game_type, gname, None, None, "missing")
            print("    -> marked MISSING (candidate to import later)\n")
            decided += 1
            i += 1
            continue
        if choice in ("1", "2", "3"):
            idx = int(choice) - 1
            if idx < len(cands):
                sc, sn, _ = cands[idx]
                write_decision(r["group_id"], category_id, game_type, gname, sc, sn, "manual")
                print(f"    -> mapped to {sc} ({sn})\n")
                decided += 1
                i += 1
            else:
                print("    no such candidate\n")
            continue
        if choice.startswith("c"):
            code = choice[1:].strip()
            if not code:
                print("    usage: c SETCODE\n")
                continue
            real = code_set.get(code.upper())
            if not real:
                print(f"    '{code}' is not a known {game_type} set_code\n")
                continue
            write_decision(r["group_id"], category_id, game_type, gname, real, catalog_sets[real], "manual")
            print(f"    -> mapped to {real} ({catalog_sets[real]})\n")
            decided += 1
            i += 1
            continue
        print("    ? unrecognized — [1/2/3] [s] [c CODE] [enter] [b] [q]\n")

    return decided


def export_missing(cats, path):
    """Dump every confidence='missing' group + a card count to CSV."""
    import csv
    rows_out = []
    for game_type, category_id in cats.items():
        miss = tc.sb_get(
            f"tcgplayer_group_map?select=group_id,group_name,abbreviation,game_type"
            f"&category_id=eq.{category_id}&confidence=eq.missing&order=group_name.asc"
        )
        for r in miss:
            prods = tc.tcg_get(
                f"/tcgplayer/{category_id}/{r['group_id']}/products"
            ).get("results", [])
            cards = sum(1 for p in prods if tc.is_card_product(p))
            rows_out.append({
                "game_type":     r.get("game_type") or game_type,
                "category_id":   category_id,
                "group_id":      r["group_id"],
                "group_name":    r.get("group_name") or "",
                "abbreviation":  r.get("abbreviation") or "",
                "cards":         cards,
                "products_total": len(prods),
                "products_url":  f"{tc.TCGCSV_BASE}/tcgplayer/{category_id}/{r['group_id']}/products",
            })
    cols = ["game_type", "category_id", "group_id", "group_name", "abbreviation",
            "cards", "products_total", "products_url"]
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows_out)
    print(f"Wrote {len(rows_out)} missing set(s) -> {path}")


def main():
    ap = argparse.ArgumentParser(description="TCGCSV group-map cleanup (interactive)")
    ap.add_argument("--tcg", default="all", help="game_type or 'all'")
    ap.add_argument("--include-fuzzy", default="true",
                    help="also review fuzzy matches (true/false). false = unmatched only")
    ap.add_argument("--export-missing", metavar="PATH", nargs="?",
                    const="tcgcsv_missing_sets.csv", default=None,
                    help="non-interactive: dump confidence='missing' groups to CSV and exit "
                         "(default file: tcgcsv_missing_sets.csv)")
    args = ap.parse_args()

    wanted = list(tc.CATEGORY_MATCHERS.keys()) if args.tcg == "all" else [args.tcg]
    cats = tc.resolve_categories(wanted)
    if not cats:
        sys.exit("No categories resolved.")

    if args.export_missing:
        export_missing(cats, args.export_missing)
        return

    include_fuzzy = str(args.include_fuzzy).lower() not in ("false", "0", "no")
    total = 0
    for game_type, category_id in cats.items():
        total += review_game(game_type, category_id, include_fuzzy)

    print(f"\nDone. {total} decision(s) written. "
          f"Re-run: python3 sync_tcgcsv.py --tcg {args.tcg}  to backfill the newly mapped sets.")


if __name__ == "__main__":
    main()
