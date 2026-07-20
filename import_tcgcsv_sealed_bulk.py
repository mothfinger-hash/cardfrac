#!/usr/bin/env python3
"""
import_tcgcsv_sealed_bulk.py — one-shot backfill of the sealed products
(booster boxes, ETBs, bundles, blisters, build & battle boxes, and the
"Booster Pack Art Bundle [Set of 4]" *art sets*) that tcgcsv carries but our
catalog is missing, across EVERY Pokemon set at once.

WHY THIS EXISTS
---------------
`import_tcgcsv_set.py --sealed` does one group at a time with a hand-typed
--set-code, and it never checks whether a product we already have (as a
PriceCharting `sealed-en-pc-…` row) carries the same TCGplayer product id.
Run blind across 200+ groups that would (a) be tedious and (b) mint a
duplicate `sealed-en-tcg-{pid}` for every product already present as a
`sealed-en-pc-*` row — same booster box, two rows. This script fixes both:

  * SET RESOLUTION is automatic and by unique id, not fuzzy name-guessing:
    for each group we take the group's *singles* productIds, look them up in
    catalog.tcgplayer_product_id, and adopt the dominant (set_code, set_name)
    the singles already use. That is exactly the set_name the Sets-page sealed
    toggle matches on (migration_sealed_products.sql filters on
    game_type, product_type, set_name). Groups whose singles aren't linked by
    tcgplayer_product_id fall back to the locked tcgplayer_group_map row; if
    neither resolves, the group is SKIPPED and logged (this naturally drops the
    633-item "Miscellaneous Cards & Products" grab-bag and stray promo groups
    that don't map to one set).

  * DEDUP is by tcgplayer_product_id. Any sealed product whose id already
    exists on a catalog sealed row (any source / language) is skipped — we only
    write products that are genuinely new. The 430-ish PriceCharting rows that
    already link a TCGplayer id are left alone (they get spined separately).

Dry-run by default. Re-run with --commit to write. Needs the service key.

USAGE
-----
    # see the plan (no writes)
    python3 import_tcgcsv_sealed_bulk.py

    # just the first few groups, to eyeball rows
    python3 import_tcgcsv_sealed_bulk.py --limit-groups 5

    # write everything net-new for Pokemon EN
    python3 import_tcgcsv_sealed_bulk.py --commit

    # Japanese (category 85 -> sealed-jp-tcg-*), or another game's category
    python3 import_tcgcsv_sealed_bulk.py --category 85 --commit

ENVIRONMENT
-----------
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (same as sync_tcgcsv.py)
"""

import argparse
import json
import sys
from collections import Counter

import sync_tcgcsv as tc
from sync_sealed_products import detect_product_type
from import_tcgcsv_set import upgrade_image, card_number_raw, GAME_PREFIX

# category_id -> (game_type, id-language segment for the catalog id prefix).
# Pokemon splits EN (cat 3) vs JP (cat 85) even though both are game_type
# 'pokemon'; everything else derives its segment from GAME_PREFIX by game_type.
CATEGORY_LANG = {
    3:  ("pokemon", "en"),
    85: ("pokemon", "jp"),
}

# tcgcsv groups that are not a single sealed-able set — skip by name so they
# don't burn a resolution attempt or spam the skip log. Resolution would drop
# them anyway; this is just tidier.
SKIP_GROUP_SUBSTRINGS = (
    "miscellaneous",
    "world championship decks",
    "player placement",
)


def id_prefix_for(category_id, game_type):
    """`sealed-en-tcg-` / `sealed-jp-tcg-` for Pokemon, `sealed-<g>-tcg-`
    otherwise — matching the prefixes _renderSealedProductsForSet expects."""
    if category_id in CATEGORY_LANG:
        return "sealed-" + CATEGORY_LANG[category_id][1] + "-tcg-"
    seg = GAME_PREFIX.get(game_type, game_type)
    return "sealed-" + seg + "-tcg-"


def load_existing_sealed_pids():
    """Every tcgplayer_product_id already attached to a sealed catalog row
    (any language / source). This is the dedup key."""
    pids, offset = set(), 0
    while True:
        rows = tc.sb_get(
            "catalog?select=tcgplayer_product_id"
            "&product_type=not.in.(single,tcg_single)"
            "&tcgplayer_product_id=not.is.null"
            f"&limit=1000&offset={offset}"
        )
        if not rows:
            break
        for r in rows:
            pid = r.get("tcgplayer_product_id")
            if pid is not None:
                pids.add(int(pid))
        if len(rows) < 1000:
            break
        offset += 1000
    return pids


def resolve_set(group_id, game_type, cards):
    """Return (set_code, set_name, method) for a group, or (None, None, reason).

    Primary: id-join — the group's singles' productIds -> catalog singles ->
    the dominant (set_code, set_name) they already use. Precise, no guessing.
    Fallback: the locked tcgplayer_group_map row for this group.
    """
    sample = [str(c["productId"]) for c in cards[:40] if c.get("productId")]
    if sample:
        gt = tc.requests.utils.quote(game_type, safe="")
        rows = tc.sb_get(
            "catalog?select=set_code,set_name"
            f"&tcgplayer_product_id=in.({','.join(sample)})"
            f"&product_type=eq.single&game_type=eq.{gt}&limit=60"
        )
        tally = Counter()
        for r in rows:
            sc, sn = r.get("set_code"), r.get("set_name")
            if sc and sn:
                tally[(sc, sn)] += 1
        if tally:
            (sc, sn), _ = tally.most_common(1)[0]
            return sc, sn, "id-join"

    # Fallback: group map (locked when singles were imported for this group).
    gm = tc.sb_get(
        "tcgplayer_group_map?select=set_code,set_name"
        f"&group_id=eq.{group_id}&limit=1"
    )
    if gm and gm[0].get("set_code") and gm[0].get("set_name"):
        return gm[0]["set_code"], gm[0]["set_name"], "group-map"

    return None, None, "unresolved (singles not linked by tcgplayer id)"


def fetch_prices(category_id, group_id):
    """productId -> market price, preferring the 'Normal' subtype."""
    prices = {}
    try:
        for pr in tc.tcg_get(f"/tcgplayer/{category_id}/{group_id}/prices").get("results", []):
            pid = pr.get("productId")
            mp = pr.get("marketPrice") or pr.get("midPrice")
            if pid and mp and (pid not in prices or pr.get("subTypeName") == "Normal"):
                prices[pid] = mp
    except Exception as e:
        print(f"    ! price fetch failed for group {group_id}: {e}")
    return prices


def build_sealed_rows(prods, prices, prefix, game_type, set_code, set_name, have_pids, seen_pids):
    """New sealed rows for this group (dedup by tcgplayer_product_id)."""
    rows, art = [], 0
    for p in prods:
        if tc.is_card_product(p):
            continue
        pid = p.get("productId")
        if pid is None:
            continue
        pid = int(pid)
        if pid in have_pids or pid in seen_pids:
            continue  # already in catalog, or already queued this run
        name = (p.get("name") or p.get("cleanName") or "").strip()
        if not name or name.lower().startswith("code card"):
            continue
        ptype, _ = detect_product_type(name)
        if ptype == "single":
            ptype = "blister" if "blister" in name.lower() else "sealed_other"
        seen_pids.add(pid)
        if "art bundle" in name.lower():
            art += 1
        price = prices.get(pid)
        rows.append({
            "id":                   f"{prefix}{pid}",
            "game_type":            game_type,
            "set_code":             set_code,
            "set_name":             set_name,
            "product_type":         ptype,
            "tcgplayer_product_id": pid,
            "name":                 name,
            "image_url":            upgrade_image(p.get("imageUrl")) or None,
            "tcgplayer_url":        p.get("url") or None,
            "current_value":        price,
            # Price is TCGplayer's own market price (via tcgcsv) — put the row on
            # the TCG spine so the PriceCharting refresh (which skips
            # market_price_source='tcgplayer') can't clobber it. Null when the
            # product has no market price yet, so we don't mislabel a bare row.
            "market_price_source":  "tcgplayer" if price else None,
        })
    return rows, art


def upsert_catalog(rows):
    for i in range(0, len(rows), 100):
        chunk = rows[i:i + 100]
        r = tc._sb.post(
            f"{tc.SUPABASE_URL.rstrip('/')}/rest/v1/catalog?on_conflict=id",
            headers={
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
            data=json.dumps(chunk),
            timeout=60,
        )
        if not r.ok:
            print(f"  ! upsert failed (HTTP {r.status_code}) rows {i}-{i + len(chunk) - 1}: {r.text[:800]}")
            r.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", type=int, default=3,
                    help="tcgcsv category id (3=Pokemon EN default, 85=Pokemon JP)")
    ap.add_argument("--limit-groups", type=int, default=0, help="cap groups processed (testing)")
    ap.add_argument("--only-art", action="store_true",
                    help="import ONLY the 'Art Bundle' art-set products")
    ap.add_argument("--commit", action="store_true", help="actually write (default: dry-run)")
    args = ap.parse_args()

    cat = args.category
    default_gt = CATEGORY_LANG.get(cat, (None, None))[0]

    print(f"Loading existing sealed tcgplayer product ids (dedup key)…")
    have_pids = load_existing_sealed_pids()
    print(f"  {len(have_pids):,} product ids already on sealed rows.\n")

    groups = tc.tcg_get(f"/tcgplayer/{cat}/groups").get("results", [])
    if args.limit_groups:
        groups = groups[:args.limit_groups]
    print(f"Scanning {len(groups)} groups in category {cat}…\n")

    all_rows, seen_pids = [], set()
    resolved = skipped = art_total = 0
    skip_log, per_set = [], []

    for g in groups:
        gid, gname = g["groupId"], g.get("name") or str(g["groupId"])
        if any(s in gname.lower() for s in SKIP_GROUP_SUBSTRINGS):
            skipped += 1
            skip_log.append((gname, "non-set group (name filter)"))
            continue
        try:
            prods = tc.tcg_get(f"/tcgplayer/{cat}/{gid}/products").get("results", [])
        except Exception as e:
            skipped += 1
            skip_log.append((gname, f"product fetch failed: {e}"))
            continue
        cards = [p for p in prods if tc.is_card_product(p)]
        sealed = [p for p in prods if not tc.is_card_product(p)]
        if not sealed:
            continue

        game_type = default_gt or (tc.sb_get(
            f"tcgplayer_group_map?select=game_type&group_id=eq.{gid}&limit=1") or [{}])[0].get("game_type")
        if not game_type:
            skipped += 1
            skip_log.append((gname, "unknown game_type"))
            continue

        set_code, set_name, method = resolve_set(gid, game_type, cards)
        if not set_code:
            skipped += 1
            skip_log.append((gname, method))
            continue

        prefix = id_prefix_for(cat, game_type)
        prices = fetch_prices(cat, gid)
        rows, art = build_sealed_rows(prods, prices, prefix, game_type,
                                      set_code, set_name, have_pids, seen_pids)
        if args.only_art:
            rows = [r for r in rows if "art bundle" in r["name"].lower()]
            art = len(rows)
        if not rows:
            continue
        resolved += 1
        art_total += art
        all_rows.extend(rows)
        per_set.append((set_name, set_code, len(rows), art, method))

    # ---- report ----
    print("=" * 74)
    print(f"Sets resolved with net-new sealed: {resolved}   groups skipped: {skipped}")
    print(f"Net-new sealed rows to write: {len(all_rows)}   (art-set products: {art_total})")
    print("=" * 74)
    print("\nPer-set (set_name  [set_code]  +new / art  via):")
    for sn, sc, n, art, method in sorted(per_set, key=lambda r: -r[2]):
        print(f"   +{n:>3}  art:{art:<2}  {sn}  [{sc}]  ({method})")

    if skip_log:
        print(f"\nSkipped groups ({len(skip_log)}) — no reliable set to attach to:")
        for nm, why in skip_log[:40]:
            print(f"   - {nm}: {why}")
        if len(skip_log) > 40:
            print(f"   … and {len(skip_log) - 40} more")

    print("\nSample rows:")
    for r in all_rows[:8]:
        print(f"   {r['id']:<24} [{r['product_type']:<14}] ${r['current_value']}  {r['name'][:44]}  -> {r['set_name']}")

    if not args.commit:
        print(f"\nDRY RUN — nothing written. Re-run with --commit to create {len(all_rows)} rows.")
        return
    if not all_rows:
        print("\nNothing net-new to write.")
        return

    print(f"\nWriting {len(all_rows)} rows…")
    upsert_catalog(all_rows)
    print(f"Done — {len(all_rows)} sealed rows imported across {resolved} sets "
          f"({art_total} art sets). They attach to their set via set_name and "
          f"carry tcgplayer_product_id, ready for the price spine.")


if __name__ == "__main__":
    main()
