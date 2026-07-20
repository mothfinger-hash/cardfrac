#!/usr/bin/env python3
"""
sync_sealed_prices_tcgcsv.py — keep SEALED product prices fresh from tcgcsv by
feeding the TCGplayer price spine, exactly like singles.

WHY
---
Sealed catalog rows (product_type != 'single', e.g. booster_box / etb / blister /
booster_pack / bundle, ids 'sealed-*-tcg-*' and the older 'sealed-*-pc-*' rows
that carry a tcgplayer_product_id) get their price ONCE at import and then go
stale — nothing refreshes them and no history accumulates. The singles spine
already solves this: card_prices(source='tcgplayer') is the price feed, and two
product_type-AGNOSTIC RPCs propagate it:

    reseat_tcgplayer_batch()          card_prices -> catalog.current_value
                                      + market_price_source='tcgplayer'
    snapshot_tcgplayer_history_batch() catalog.current_value -> catalog_price_history
                                      (source='tcgplayer', one row per day)

Neither RPC filters on product_type, so the ONLY thing missing for sealed is a
job that writes card_prices(source='tcgplayer') for every sealed row. That is
this script. It does NOT touch catalog.current_value directly — reseat owns that
column for the whole spine, so writing it here too would let the two fight (and
reseat would win, stamping market_price_updated_at). Feed card_prices, then let
reseat + snapshot (reseat_tcgplayer.py) do the rest.

WHAT IT DOES
------------
  1. Load every sealed catalog row with a tcgplayer_product_id -> {pid: [id,...]}.
  2. Walk the tcgcsv category groups, hitting ONLY the /prices endpoint
     (~218 calls for Pokemon EN, no /products needed — we map by product id).
  3. For each product with a market price whose id we hold, upsert a
     card_prices(catalog_id, source='tcgplayer', value, recorded_at=now) row.
  4. (Downstream, in the workflow) reseat_tcgplayer.py sweeps card_prices into
     catalog.current_value and snapshots history — for singles AND sealed.

Sealed products carry only the 'Normal' subtype in tcgcsv, one price row per
product id that maps 1:1 to catalog.tcgplayer_product_id. Unpriced products are
skipped (never written as 0) so a blister with no comp doesn't chart $0.

Dry-run by default. --commit writes. Needs the service key.

USAGE
-----
    python3 sync_sealed_prices_tcgcsv.py                    # dry-run, Pokemon EN+JP
    python3 sync_sealed_prices_tcgcsv.py --commit           # write card_prices
    python3 sync_sealed_prices_tcgcsv.py --categories 3     # Pokemon EN only
    python3 sync_sealed_prices_tcgcsv.py --categories 1,2   # MTG + YuGiOh sealed

ENVIRONMENT
-----------
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (same as sync_tcgcsv.py)
"""

import argparse
from datetime import datetime, timezone

import sync_tcgcsv as tc

# tcgcsv categories that hold sealed products we track. Default is Pokemon
# EN (3) + JP (85); other games can be added via --categories.
DEFAULT_CATEGORIES = [3, 85]


# A marketPrice below this fraction of the lowest current ask is treated as a
# stale single-sale artifact, not a real market. marketPrice (recent-sales
# based) NORMALLY sits at or somewhat below the low ask — that is healthy, not
# garbage — so the threshold is deliberately extreme: only a market under a
# QUARTER of the low ask (a $100k box showing a $500 'market') is distrusted.
_MARKET_GARBAGE_RATIO = 0.25


def pick_price(pr):
    """Trustworthy price for a tcgcsv /prices row, or (None, _).

    Returns (value, used_fallback). Prefer marketPrice; fall back to mid, then
    low, when marketPrice is absent or is implausibly far below the low ask
    (see _MARKET_GARBAGE_RATIO). Never returns a value <= 0."""
    low = pr.get("lowPrice") or 0
    mkt = pr.get("marketPrice")
    mid = pr.get("midPrice")
    if mkt and mkt > 0 and not (low and mkt < low * _MARKET_GARBAGE_RATIO):
        return mkt, False
    if mid and mid > 0:
        return mid, True
    if low and low > 0:
        return low, True
    return None, False


def load_sealed_by_pid():
    """{ tcgplayer_product_id(int): [ (catalog_id, market_price_source), ... ] }
    for every sealed catalog row that carries a tcgplayer_product_id."""
    by_pid, offset = {}, 0
    while True:
        rows = tc.sb_get(
            "catalog?select=id,tcgplayer_product_id,market_price_source"
            "&product_type=not.in.(single,tcg_single)"
            "&tcgplayer_product_id=not.is.null"
            f"&limit=1000&offset={offset}"
        )
        if not rows:
            break
        for r in rows:
            pid = r.get("tcgplayer_product_id")
            if pid is None:
                continue
            by_pid.setdefault(int(pid), []).append(
                (r["id"], (r.get("market_price_source") or "").lower())
            )
        if len(rows) < 1000:
            break
        offset += 1000
    return by_pid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--categories", default=",".join(map(str, DEFAULT_CATEGORIES)),
                    help="comma-separated tcgcsv category ids (default '3,85' = Pokemon EN+JP)")
    ap.add_argument("--commit", action="store_true", help="actually write (default: dry-run)")
    args = ap.parse_args()
    categories = [int(c) for c in args.categories.split(",") if c.strip()]
    now = datetime.now(timezone.utc).isoformat()

    print("Loading sealed rows that carry a tcgplayer_product_id…")
    by_pid = load_sealed_by_pid()
    n_rows = sum(len(v) for v in by_pid.values())
    print(f"  {n_rows:,} sealed rows across {len(by_pid):,} distinct product ids.\n")

    price_rows, seen = [], set()   # dedup by catalog_id (one tcgplayer price per row)
    matched_pids = set()
    collided_pids = set()          # product ids shared by >1 distinct catalog row
    used_mid = 0
    would_flip = 0                 # rows not currently on the tcgplayer spine

    for cat in categories:
        try:
            groups = tc.tcg_get(f"/tcgplayer/{cat}/groups").get("results", [])
        except Exception as e:
            print(f"  ! category {cat}: groups fetch failed: {e}")
            continue
        print(f"Category {cat}: scanning {len(groups)} groups for sealed prices…")
        for g in groups:
            gid = g["groupId"]
            try:
                prs = tc.tcg_get(f"/tcgplayer/{cat}/{gid}/prices").get("results", [])
            except Exception as e:
                print(f"    ! group {gid} prices failed: {e}")
                continue
            for pr in prs:
                pid = pr.get("productId")
                if pid is None or int(pid) not in by_pid:
                    continue
                pid = int(pid)
                targets = by_pid[pid]
                # A productId shared by >1 distinct catalog row is a fuzzy /
                # collided tcgplayer_product_id link (only older sealed-*-pc-*
                # rows carry these). Writing one price to all of them would smear
                # a single number across genuinely different SKUs, and reseat
                # would then collapse their individually-correct values — the
                # exact cross-product smear the tcgplayer spine exists to kill.
                # Never trust an ambiguous id: leave the whole cluster untouched.
                if len(targets) != 1:
                    collided_pids.add(pid)
                    continue
                mp, was_mid = pick_price(pr)
                if mp is None:
                    continue
                if was_mid:
                    used_mid += 1
                matched_pids.add(pid)
                cid, mps = targets[0]
                if cid in seen:
                    continue
                seen.add(cid)
                if mps != "tcgplayer":
                    would_flip += 1
                # source_url omitted deliberately: tcgcsv /prices carries no url,
                # and card_prices uses merge-duplicates on (catalog_id, source),
                # so writing null here would clobber the real tcgplayer_url the
                # singles pass already stored. The card-detail link falls back to
                # catalog.tcgplayer_url regardless.
                price_rows.append({
                    "catalog_id":  cid,
                    "source":      "tcgplayer",
                    "value":       mp,
                    "currency":    "USD",
                    "recorded_at": now,
                })

    collided_rows = sum(len(by_pid[p]) for p in collided_pids)
    unmatched = n_rows - len(price_rows) - collided_rows
    print("\n" + "=" * 70)
    print(f"Sealed rows with a fresh tcgcsv price: {len(price_rows):,} "
          f"(of {n_rows:,} sealed rows carrying a product id)")
    print(f"  product ids matched: {len(matched_pids):,} / {len(by_pid):,}")
    print(f"  ambiguous/collided ids skipped (fuzzy links, left on old price): "
          f"{len(collided_pids):,} ids / {collided_rows:,} rows")
    print(f"  no tcgcsv market price (left untouched): {unmatched:,}")
    print(f"  would move onto the TCGplayer spine (market_price_source flips): {would_flip:,}")
    if used_mid:
        print(f"  used midPrice fallback (marketPrice absent or below low ask): {used_mid:,}")
    print("=" * 70)
    for r in price_rows[:8]:
        print(f"   {r['catalog_id']:<26} ${r['value']}")

    if not args.commit:
        print(f"\nDRY RUN — nothing written. Re-run with --commit to upsert "
              f"{len(price_rows):,} card_prices rows.")
        print("Then run  python3 reseat_tcgplayer.py  (reseat + snapshot) to push "
              "these into catalog.current_value + catalog_price_history.")
        return
    if not price_rows:
        print("\nNothing to write.")
        return

    print(f"\nUpserting {len(price_rows):,} card_prices rows…")
    tc.sb_upsert_card_prices(price_rows)
    print("Done. Now run  python3 reseat_tcgplayer.py  to reseat current_value "
          "and snapshot today's history for the whole TCGplayer spine (singles + sealed).")


if __name__ == "__main__":
    main()
