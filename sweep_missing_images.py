#!/usr/bin/env python3
"""
PathBinder — Missing-image sweep (singles + sealed, one command)
================================================================
Catalog images live on two upstream CDNs before we mirror them:
  * SINGLES  → tcgplayer-cdn.tcgplayer.com   (from import_tcgcsv_set.py)
  * SEALED   → *.pricecharting.com            (from sync_sealed_products.py)

Two proven, idempotent mirrors already cover each source; this wraps them
so a single call sweeps everything still pointing at an upstream CDN for the
games you name. Anything already on Supabase Storage is skipped automatically
(each child mirror filters on the remote host), so re-running is safe.

    # Preview what would be mirrored for both new DBZ games (no writes)
    python3 sweep_missing_images.py --game dbsccg,dbfusion --dry-run

    # Do it, 8 workers
    python3 sweep_missing_images.py --game dbsccg,dbfusion --workers 8

    # Singles only (skip the sealed pass)
    python3 sweep_missing_images.py --game dbsccg --singles-only

Under the hood, per run:
  1. mirror_tcgplayer_images.py --all --game <g>   (once per --game, tcgplayer-cdn singles)
  2. mirror_sealed_images.py                        (once, ALL pricecharting-hosted rows)

Note on step 2: mirror_sealed_images.py has no game filter — it sweeps every
still-unmirrored PriceCharting row across all games. That's usually what you
want for a "fix all missing sealed" pass; it just may also mirror sealed from
other games that were pending. Use --singles-only to skip it.

ENVIRONMENT (read by the child scripts):
    SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
import sys, argparse, subprocess

def run(cmd):
    print(f"\n$ {' '.join(cmd)}\n" + "-" * 60)
    return subprocess.run([sys.executable] + cmd).returncode

def main():
    ap = argparse.ArgumentParser(description="Sweep missing singles + sealed images in one pass.")
    ap.add_argument("--game", required=True,
                    help="comma-separated game_type(s), e.g. dbsccg,dbfusion")
    ap.add_argument("--dry-run", action="store_true", help="pass through to each mirror (no writes)")
    ap.add_argument("--workers", type=int, default=6, help="parallel workers for each mirror (default 6)")
    ap.add_argument("--singles-only", action="store_true", help="skip the pricecharting sealed pass")
    ap.add_argument("--sealed-only", action="store_true", help="skip the tcgplayer singles pass")
    args = ap.parse_args()

    games = [g.strip() for g in args.game.split(",") if g.strip()]
    common = (["--dry-run"] if args.dry_run else []) + ["--workers", str(args.workers)]
    rc = 0

    # 1) SINGLES — tcgplayer-cdn, per game
    if not args.sealed_only:
        for g in games:
            rc |= run(["mirror_tcgplayer_images.py", "--all", "--game", g] + common)

    # 2) SEALED — pricecharting, global (no per-game filter in that script)
    if not args.singles_only:
        rc |= run(["mirror_sealed_images.py"] + common)

    print("\n" + "=" * 60)
    print("Sweep complete." if rc == 0 else f"Sweep finished with a non-zero child exit (rc={rc}).")
    return rc

if __name__ == "__main__":
    sys.exit(main())
