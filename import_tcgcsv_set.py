#!/usr/bin/env python3
"""
PathBinder — import a missing set into the catalog from TCGCSV
=============================================================
Creates catalog rows for a single TCGplayer group (set) you don't carry
yet, straight from TCGCSV's product data (number, name, image, rarity,
productId, URL). Deliberate and per-set on purpose — you pass the exact
set_code, so nothing is auto-minted and catalog hygiene stays in your hands.

Rows follow pokedata_sync.py conventions:
    id          = "{prefix}-{set_code.lower()}-{card_number}"
    game_type   = canonical value (pokemon / magic / yugioh / onepiece / ...)
    product_type= "single"
Plus the Phase 1 linkage (tcgplayer_product_id + tcgplayer_url) is filled in
the same pass, so imported cards are TCGplayer-linked immediately.

SAFETY
------
  * DRY-RUN BY DEFAULT. Nothing is written without --commit.
  * --set-code is REQUIRED (no auto-mint).
  * Warns if the set_code already exists in the catalog under a different
    set name (possible collision) before you commit.

USAGE
-----
    # Preview what would be created (no writes)
    python3 import_tcgcsv_set.py --group 24688 --set-code ME05

    # Override the human set name / pick JP prefix for Pokemon
    python3 import_tcgcsv_set.py --group 24688 --set-code ME05 \
        --set-name "Pitch Black"

    # Actually write it
    python3 import_tcgcsv_set.py --group 24688 --set-code ME05 --commit

    # Non-Pokemon game that isn't in tcgplayer_group_map yet
    python3 import_tcgcsv_set.py --group 99999 --set-code XYZ --game magic

ENVIRONMENT
-----------
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (same as sync_tcgcsv.py)
"""

import sys
import json
import argparse

import sync_tcgcsv as tc

# game_type (catalog column value) -> catalog id prefix, mirroring
# get_id_prefix() in pokedata_sync.py. Pokemon defaults to EN; pass --lang JA
# for the jp- prefix.
GAME_PREFIX = {
    "pokemon":      "en",
    "magic":        "mtg",
    "yugioh":       "ygo",
    "onepiece":     "op",
    "digimon":      "dgm",
    "lorcana":      "lor",
    "fab":          "fab",
    "unionarena":   "ua",
    "dbfusion":     "dbf",
    "dbsccg":       "dbs",
    "dbz":          "dbz",
    "gundam":       "gun",
    "grandarchive": "ga",
    "metazoo":      "mz",
    "starwars":     "sw",
    "sorcery":      "sor",
}


def card_number_raw(product):
    """Canonical card number for storage: the part before '/', trimmed."""
    for ed in product.get("extendedData", []):
        if ed.get("name") == "Number":
            v = str(ed.get("value") or "").strip()
            if "/" in v:
                v = v.split("/", 1)[0].strip()
            return v.replace(" ", "") or None
    return None


def card_rarity(product):
    for ed in product.get("extendedData", []):
        if ed.get("name") == "Rarity":
            return (ed.get("value") or "").strip() or None
    return None


def upgrade_image(url):
    """TCGplayer thumbnails come as _200w; bump to the larger render."""
    return (url or "").replace("_200w", "_in_1000x1000") or None


def lookup_group(group_id):
    """Return (category_id, game_type, group_name) from group_map if present."""
    rows = tc.sb_get(
        f"tcgplayer_group_map?select=category_id,game_type,group_name"
        f"&group_id=eq.{group_id}&limit=1"
    )
    if rows:
        r = rows[0]
        return r.get("category_id"), r.get("game_type"), r.get("group_name")
    return None, None, None


def collision_check(set_code, game_type, intended_name):
    q = tc.requests.utils.quote(set_code, safe="")
    rows = tc.sb_get(
        f"catalog?select=set_name&game_type=eq.{game_type}&set_code=eq.{q}&limit=5"
    )
    names = {(r.get("set_name") or "").strip() for r in rows}
    names.discard("")
    if names and intended_name not in names:
        print(f"  ! WARNING: set_code '{set_code}' already exists for {game_type} "
              f"under: {', '.join(sorted(names))}")
        print(f"    You're about to add rows named '{intended_name}'. If that's a "
              f"different set, choose a different --set-code.")


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
            print(f"  ! upsert failed (HTTP {r.status_code}) on rows {i}-{i + len(chunk) - 1}")
            print(f"    response body: {r.text[:1000]}")
            r.raise_for_status()


def main():
    ap = argparse.ArgumentParser(description="Import a TCGCSV set into the catalog")
    ap.add_argument("--group", type=int, required=True, help="TCGplayer groupId")
    ap.add_argument("--set-code", required=True, help="catalog set_code to assign (REQUIRED)")
    ap.add_argument("--set-name", default=None, help="override the set name (else derived)")
    ap.add_argument("--game", default=None, help="game_type if the group isn't in group_map yet")
    ap.add_argument("--category", type=int, default=None,
                    help="TCGplayer categoryId — bypasses category auto-resolve. Needed to "
                         "bootstrap a game_type that has 0 catalog rows yet (e.g. a brand-new game).")
    ap.add_argument("--lang", default="EN", help="Pokemon language for id prefix (EN/JA)")
    ap.add_argument("--limit", type=int, default=0, help="cap cards (testing)")
    ap.add_argument("--commit", action="store_true", help="actually write (default: dry-run)")
    args = ap.parse_args()

    set_code = args.set_code.strip()

    # Resolve category + game_type.
    category_id, game_type, group_name = lookup_group(args.group)
    if args.game:
        game_type = args.game.strip()
    if not game_type:
        sys.exit("Group not in tcgplayer_group_map — pass --game <game_type>.")
    # Explicit --category bypasses resolve_categories(), which otherwise
    # refuses to map a game_type that has 0 catalog rows yet (a guard against
    # typo'd game types). That guard blocks the very FIRST import of a new
    # game (chicken-and-egg), so pass --category <id> to bootstrap it.
    if args.category is not None:
        category_id = args.category
    if category_id is None:
        cats = tc.resolve_categories([game_type])
        category_id = cats.get(game_type)
        if category_id is None:
            sys.exit(f"Could not resolve a TCGplayer category for game_type '{game_type}'.")

    prefix = GAME_PREFIX.get(game_type)
    if prefix == "en" and args.lang.upper() in ("JA", "JP", "JAPANESE"):
        prefix = "jp"
    if not prefix:
        sys.exit(f"No id prefix configured for game_type '{game_type}' "
                 f"(add it to GAME_PREFIX).")

    # Fetch products for the group.
    prods = tc.tcg_get(f"/tcgplayer/{category_id}/{args.group}/products").get("results", [])
    if not prods:
        sys.exit(f"No products returned for group {args.group}.")

    # Derive the human set name.
    derived_name, _abbr = tc.set_name_from_group(group_name or "")
    set_name = args.set_name or derived_name or (group_name or set_code)

    print(f"Group {args.group}: '{group_name}'  ->  game_type={game_type}, "
          f"set_code={set_code}, set_name='{set_name}', prefix={prefix}")
    collision_check(set_code, game_type, set_name)

    rows, skipped_sealed, skipped_nonum = [], 0, 0
    for p in prods:
        if args.limit and len(rows) >= args.limit:
            break
        if not tc.is_card_product(p):
            skipped_sealed += 1
            continue
        num = card_number_raw(p)
        if not num:
            skipped_nonum += 1
            continue
        cat_id = f"{prefix}-{set_code.lower()}-{num}"
        row = {
            "id":                   cat_id,
            "game_type":            game_type,
            "set_code":             set_code,
            "set_name":             set_name,
            "card_number":          num,
            "product_type":         "single",
            "tcgplayer_product_id": p["productId"],
        }
        name = (p.get("cleanName") or p.get("name") or "").strip()
        img  = upgrade_image(p.get("imageUrl"))
        rar  = card_rarity(p)
        url  = p.get("url")
        if name: row["name"] = name
        if img:  row["image_url"] = img
        if rar:  row["rarity"] = rar
        if url:  row["tcgplayer_url"] = url
        rows.append(row)

    # Dedupe by catalog id. MTG (and some other games) ship multiple products
    # that share one collector number — borderless / extended-art / showcase /
    # promo treatments. Our id scheme is one row per (set, number), so those
    # collapse to the same `{prefix}-{set}-{num}` id. A batch upsert with
    # on_conflict=id raises "ON CONFLICT DO UPDATE command cannot affect row a
    # second time" (Postgres 500) if the same id appears twice in one statement.
    # Keep the first occurrence per id and report how many were folded.
    seen, deduped, dup_count = set(), [], 0
    for row in rows:
        if row["id"] in seen:
            dup_count += 1
            continue
        seen.add(row["id"])
        deduped.append(row)
    rows = deduped

    print(f"  {len(rows)} card rows ready "
          f"({skipped_sealed} sealed-skipped, {skipped_nonum} no-number-skipped"
          f"{f', {dup_count} duplicate-id folded' if dup_count else ''})")
    for r in rows[:5]:
        print(f"    {r['id']:<28} {r.get('name','')}  [{r.get('rarity','')}]")
    if len(rows) > 5:
        print(f"    … and {len(rows) - 5} more")

    if not args.commit:
        print("\nDRY RUN — nothing written. Re-run with --commit to create these rows.")
        return

    if not rows:
        print("Nothing to write.")
        return

    upsert_catalog(rows)
    # Lock the group -> set_code mapping so the regular sync treats it as resolved.
    tc.sb_upsert_group_map({
        "group_id":    args.group,
        "category_id": category_id,
        "game_type":   game_type,
        "group_name":  group_name,
        "set_code":    set_code,
        "set_name":    set_name,
        "confidence":  "manual",
        "mapped_at":   tc.datetime.now(tc.timezone.utc).isoformat(),
    })
    print(f"\nWrote {len(rows)} catalog rows for {set_code} and locked the group map.")


if __name__ == "__main__":
    main()
