#!/usr/bin/env python3
"""
PathBinder — Sealed Pokémon English Catalog Sync
==================================================
Pulls sealed-product data (Elite Trainer Boxes, Ultra Premium
Collections, Booster Boxes, Booster Packs, Tins, etc.) from
PriceCharting and upserts them into the `catalog` table with
`product_type` != 'single'. Companion to pokedata_sync.py, which
handles individual cards. Idempotent — safe to re-run.

PREREQUISITES:
    1. Run migration_sealed_products.sql in Supabase first (adds
       product_type / release_date / msrp_usd / pricecharting_id
       columns + indexes).
    2. Get a PriceCharting API key from
       https://www.pricecharting.com/api-documentation
    3. pip3 install requests supabase --break-system-packages

USAGE:
    # Dry-run — show what would be written, don't touch the DB
    python3 sync_sealed_pokemon_en.py --dry-run

    # Real sync — upserts all sealed Pokémon EN products
    python3 sync_sealed_pokemon_en.py

    # Single query only — useful to test before committing to a full sync
    python3 sync_sealed_pokemon_en.py --query "scarlet violet elite trainer box"

ENVIRONMENT:
    SUPABASE_URL              your project URL (e.g. https://xxx.supabase.co)
    SUPABASE_SERVICE_KEY      service-role key (NOT anon)
    PRICECHARTING_API_KEY     token from PriceCharting

ID CONVENTION:
    `sealed-en-{pricecharting_id}` for English Pokémon sealed products.
    Mirrors the existing convention (en-, jp-, mtg-, ygo-, op-) used
    by pokedata_sync.py for singles.
"""

import os
import sys
import json
import time
import argparse
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing 'supabase'. Run: pip3 install supabase --break-system-packages")

# ─── Configuration ──────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
PC_API_KEY   = os.environ.get("PRICECHARTING_API_KEY")

if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")
if not PC_API_KEY:
    sys.exit(
        "Set PRICECHARTING_API_KEY. Get a key at "
        "https://www.pricecharting.com/api-documentation"
    )

PC_API_BASE = "https://www.pricecharting.com/api"

# Search queries that cover the bulk of modern + recent Pokémon EN sealed.
# Each runs as a separate /products?q= call. Results are deduped by
# product id before insert.
SEARCH_QUERIES = [
    "pokemon elite trainer box",
    "pokemon ultra premium collection",
    "pokemon premium collection",
    "pokemon booster box",
    "pokemon booster bundle",
    "pokemon booster pack",
    "pokemon collection box",
    "pokemon tin",
    "pokemon trainer box",
    "pokemon special collection",
    "pokemon mini tin",
    "pokemon build and battle",
]

# Maps PriceCharting console_name (set name) → our short set_code.
# Populated from a one-time mapping; new sets fall through to a slug
# derived from the console_name itself. The admin "needs review"
# view (catalog_sealed_needs_review) flags rows without a clean set_code.
SET_CODE_OVERRIDES = {
    "Pokemon Scarlet & Violet":            "sv1",
    "Pokemon Paldea Evolved":              "sv2",
    "Pokemon Obsidian Flames":             "sv3",
    "Pokemon 151":                         "mew",
    "Pokemon Paradox Rift":                "sv4",
    "Pokemon Paldean Fates":               "sv4pt5",
    "Pokemon Temporal Forces":             "sv5",
    "Pokemon Twilight Masquerade":         "sv6",
    "Pokemon Shrouded Fable":              "sv6pt5",
    "Pokemon Stellar Crown":               "sv7",
    "Pokemon Surging Sparks":              "sv8",
    "Pokemon Prismatic Evolutions":        "sv8pt5",
    "Pokemon Crown Zenith":                "swsh12pt5",
    "Pokemon Silver Tempest":              "swsh12",
    "Pokemon Lost Origin":                 "swsh11",
    "Pokemon Astral Radiance":             "swsh10",
    "Pokemon Brilliant Stars":             "swsh9",
    "Pokemon Fusion Strike":               "swsh8",
    "Pokemon Celebrations":                "swsh11pt5",
    "Pokemon Evolving Skies":              "swsh7",
}

# Detect product type from PriceCharting product name. Order matters
# (specific → generic). Anything not matched defaults to 'other_sealed'.
def detect_product_type(name: str) -> str:
    n = name.lower()
    if "ultra premium collection" in n or "upc" in n: return "utb"
    if "elite trainer box" in n or "etb" in n:        return "etb"
    if "premium collection" in n:                     return "premium_collection"
    if "booster box" in n:                            return "booster_box"
    if "booster bundle" in n:                         return "booster_bundle"
    if "build and battle" in n or "build & battle" in n: return "build_and_battle"
    if "booster pack" in n or " pack" in n:           return "booster_pack"
    if "mini tin" in n:                               return "mini_tin"
    if " tin" in n:                                   return "tin"
    if "collection box" in n or "special collection" in n: return "premium_collection"
    if "trainer box" in n:                            return "etb"
    return "other_sealed"


# Derive set_code: use the override map first, otherwise slugify console_name.
def derive_set_code(console_name: str) -> str:
    if console_name in SET_CODE_OVERRIDES:
        return SET_CODE_OVERRIDES[console_name]
    return (
        console_name.lower()
        .replace("pokemon ", "")
        .replace(" & ", "-")
        .replace(" ", "-")
        .replace("'", "")
    )


# Load MSRP seed file if present. Maps lower(product_name) → msrp dollars.
def load_msrp_seed() -> dict:
    p = Path(__file__).parent / "data" / "msrp_sealed_pokemon_en.json"
    if not p.exists():
        return {}
    try:
        return {k.lower(): v for k, v in json.loads(p.read_text()).items()}
    except Exception as e:
        print(f"  [warn] MSRP seed parse failed: {e}", file=sys.stderr)
        return {}


# ─── PriceCharting client ───────────────────────────────────────────────────

def pc_search(query: str) -> list[dict]:
    """Search products by free-text query. Returns up to 20 results."""
    url = f"{PC_API_BASE}/products"
    r = requests.get(url, params={"q": query, "t": PC_API_KEY}, timeout=15)
    if r.status_code != 200:
        print(f"  [warn] search failed q={query!r} status={r.status_code}", file=sys.stderr)
        return []
    data = r.json()
    return data.get("products", []) if isinstance(data, dict) else (data or [])


def pc_product_detail(pc_id: str) -> dict | None:
    """Fetch one product with full price detail (loose/new/cib + history)."""
    url = f"{PC_API_BASE}/product"
    r = requests.get(url, params={"id": pc_id, "t": PC_API_KEY}, timeout=15)
    if r.status_code != 200:
        return None
    return r.json()


# ─── Mapping ────────────────────────────────────────────────────────────────

def to_catalog_row(pc_product: dict, msrp_seed: dict) -> dict | None:
    """Convert a PriceCharting product dict into a catalog row."""
    pc_id   = str(pc_product.get("id") or "").strip()
    name    = (pc_product.get("product-name") or pc_product.get("name") or "").strip()
    console = (pc_product.get("console-name") or pc_product.get("set") or "").strip()
    if not (pc_id and name):
        return None
    # Sealed is English Pokémon only in this sync; skip anything else
    if "pokemon" not in console.lower():
        return None

    product_type = detect_product_type(name)
    set_code     = derive_set_code(console)
    image_url    = pc_product.get("image-url") or pc_product.get("image") or None

    # Prices arrive as integer cents in the API; convert to USD float.
    def cents_to_usd(v):
        try:    return round(int(v) / 100.0, 2)
        except: return None

    loose_usd = cents_to_usd(pc_product.get("loose-price"))
    new_usd   = cents_to_usd(pc_product.get("new-price"))
    cib_usd   = cents_to_usd(pc_product.get("cib-price"))

    # MSRP: try the seed file first, then PriceCharting's manufacturer field.
    msrp = msrp_seed.get(name.lower()) or pc_product.get("retail-price-loose") or None
    if msrp:
        msrp = cents_to_usd(msrp) if isinstance(msrp, (int, str)) and str(msrp).isdigit() else msrp

    # release_date — PriceCharting doesn't always return this; leave null
    # if absent and let the admin "needs review" view surface it.
    release_date = pc_product.get("release-date") or None

    return {
        "id":              f"sealed-en-{pc_id}",
        "name":            name,
        "set_name":        console.replace("Pokemon ", "").strip(),
        "set_code":        set_code,
        "card_number":     None,                # not meaningful for sealed
        "rarity":          None,
        "supertype":       "Sealed Product",
        "image_url":       image_url,
        "game_type":       "Pokémon",
        "product_type":    product_type,
        "release_date":    release_date,
        "msrp_usd":        msrp,
        "pricecharting_id": pc_id,
        # Current prices written to card_prices via a separate
        # update-prices.js path — we don't duplicate them on catalog.
    }


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would be written; don't touch the DB")
    ap.add_argument("--query", help="Run a single search instead of the full list")
    ap.add_argument("--limit", type=int, default=0,
                    help="Stop after N products (debugging)")
    args = ap.parse_args()

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    msrp_seed = load_msrp_seed()
    if msrp_seed:
        print(f"  Loaded {len(msrp_seed)} MSRP seed entries.")

    queries = [args.query] if args.query else SEARCH_QUERIES
    seen_ids = set()
    rows_to_upsert = []

    for q in queries:
        print(f"  Querying PriceCharting: {q!r}")
        products = pc_search(q)
        print(f"    → {len(products)} results")
        for p in products:
            row = to_catalog_row(p, msrp_seed)
            if not row:
                continue
            if row["id"] in seen_ids:
                continue
            seen_ids.add(row["id"])
            rows_to_upsert.append(row)
            if args.limit and len(rows_to_upsert) >= args.limit:
                break
        time.sleep(0.4)  # be polite to PriceCharting
        if args.limit and len(rows_to_upsert) >= args.limit:
            break

    print(f"\n  Total unique sealed products to upsert: {len(rows_to_upsert)}")

    if args.dry_run:
        print("\n  --dry-run — printing first 5 rows and exiting.")
        for r in rows_to_upsert[:5]:
            print(json.dumps(r, indent=2, default=str))
        return

    # Batch upsert in chunks of 50
    BATCH = 50
    written = 0
    for i in range(0, len(rows_to_upsert), BATCH):
        chunk = rows_to_upsert[i:i + BATCH]
        try:
            sb.table("catalog").upsert(chunk, on_conflict="id").execute()
            written += len(chunk)
            print(f"  Upserted {written}/{len(rows_to_upsert)}")
        except Exception as e:
            print(f"  [error] batch {i}-{i + len(chunk)} failed: {e}", file=sys.stderr)

    print(f"\n  Done. {written} sealed-product rows written to catalog.")


if __name__ == "__main__":
    main()
