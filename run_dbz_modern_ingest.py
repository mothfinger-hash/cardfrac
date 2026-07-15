#!/usr/bin/env python3
"""
Batch-import the modern Dragon Ball games from dbz_modern_ingest_manifest.csv.

Wraps import_tcgcsv_set.py once per set. DRY-RUN BY DEFAULT (no --commit passed
through) so you can eyeball counts first. Needs SUPABASE_URL +
SUPABASE_SERVICE_KEY in the environment (same as the import tool).

    # Preview everything (no writes)
    python3 run_dbz_modern_ingest.py

    # One game only
    python3 run_dbz_modern_ingest.py --game dbfusion

    # Actually write (Fusion World first — it's the closer-to-wired game)
    python3 run_dbz_modern_ingest.py --game dbfusion --commit
    python3 run_dbz_modern_ingest.py --game dbsccg  --commit

    # Cap for a quick smoke test
    python3 run_dbz_modern_ingest.py --game dbfusion --limit 2 --commit

Each set is bootstrapped with --category (these game_types start at 0 catalog
rows, so import_tcgcsv_set.py's category auto-resolve guard needs the bypass).
"""
import csv, sys, time, argparse, subprocess, os

MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "dbz_modern_ingest_manifest.csv")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", default="all", choices=["all", "dbsccg", "dbfusion"])
    ap.add_argument("--commit", action="store_true", help="pass --commit through (default: dry-run)")
    ap.add_argument("--limit", type=int, default=0, help="only run first N matching sets")
    ap.add_argument("--sleep", type=float, default=0.3, help="seconds between sets (tcgcsv etiquette)")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(MANIFEST)))
    rows = [r for r in rows if args.game == "all" or r["game"] == args.game]
    if args.limit:
        rows = rows[:args.limit]

    print(f"{'COMMIT' if args.commit else 'DRY-RUN'} — {len(rows)} sets "
          f"(game={args.game})\n")
    ok = fail = 0
    for i, r in enumerate(rows, 1):
        cmd = [sys.executable, "import_tcgcsv_set.py",
               "--group", str(r["group_id"]),
               "--set-code", r["set_code"],
               "--game", r["game"],
               "--category", str(r["category"]),
               "--set-name", r["set_name"]]
        if args.commit:
            cmd.append("--commit")
        print(f"[{i}/{len(rows)}] {r['game']} {r['set_code']:<10} {r['set_name']}")
        res = subprocess.run(cmd)
        if res.returncode == 0:
            ok += 1
        else:
            fail += 1
            print(f"    ! non-zero exit ({res.returncode}) for {r['set_code']}")
        time.sleep(args.sleep)

    print(f"\nDone. ok={ok} fail={fail} "
          f"({'writes committed' if args.commit else 'dry-run, nothing written'})")

if __name__ == "__main__":
    main()
