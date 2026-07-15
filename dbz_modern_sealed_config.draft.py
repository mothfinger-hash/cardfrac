# =============================================================================
# DRAFT — sealed config for the two modern Dragon Ball games
# Target: sync_sealed_products.py  →  TCG_CONFIG  (add these two entries)
# Uses the proven explicit_slugs path (same as the existing "dbz"/"gundam"
# entries), because PriceCharting has no clean per-game /category/ index for
# Dragon Ball — the three DB games are only separable by slug prefix:
#     vintage dbz   -> dragon-ball-z-*
#     Super CCG     -> dragon-ball-super-*
#     Fusion World  -> dragon-ball-fusion-world-*
#
# The explicit_slugs below are CANDIDATES auto-derived from the tcgcsv set
# names (see dbsccg_pc_slugs.txt / dbfusion_pc_slugs.txt). PriceCharting slug
# spelling is mostly mechanical (verified against live pages: cross-force,
# ultimate-advent, three-glorious-fighters, history-of-z, saiyan's-pride all
# match) but a few will differ. VERIFY before a full run:
#     python3 sync_sealed_products.py --tcg dbfusion --debug-dump
#     python3 sync_sealed_products.py --tcg dbsccg  --debug-dump
# Any slug with no live PC page fetches empty and is skipped harmlessly.
# =============================================================================

    "dbsccg": {
        "category_path": None,
        "game_type":     "Dragon Ball Super CCG",
        "slug_prefix":   "dragon-ball-super-",
        "id_segment":    "dbs",   # matches singles prefix (GAME_PREFIX dbsccg->dbs)
        "lang_aware":    False,
        "explicit_slugs": [
            # paste the 74 lines from dbsccg_pc_slugs.txt here, e.g.:
            "dragon-ball-super-galactic-battle",
            "dragon-ball-super-union-force",
            "dragon-ball-super-ultimate-advent",
            "dragon-ball-super-prismatic-clash",
            "dragon-ball-super-three-glorious-fighters",
            "dragon-ball-super-impact-beyond-dimensions",
            # … (full list in dbsccg_pc_slugs.txt)
        ],
    },
    "dbfusion": {
        "category_path": None,
        "game_type":     "Dragon Ball Super Fusion World",
        "slug_prefix":   "dragon-ball-fusion-world-",
        "id_segment":    "dbf",   # matches singles prefix (GAME_PREFIX dbfusion->dbf)
        "lang_aware":    False,
        "explicit_slugs": [
            # paste the 26 lines from dbfusion_pc_slugs.txt here, e.g.:
            "dragon-ball-fusion-world-awakened-pulse",
            "dragon-ball-fusion-world-blazing-aura",
            "dragon-ball-fusion-world-dual-evolution",
            "dragon-ball-fusion-world-cross-force",
            "dragon-ball-fusion-world-saiyan's-pride",
            # … (full list in dbfusion_pc_slugs.txt)
        ],
    },

# NOTE on id_segment: the sealed rows will get ids like
# {id_segment}-{setcode}-... — confirm you want 'dbs'/'dbf' to match the
# singles prefix from import_tcgcsv_set.py (GAME_PREFIX: dbsccg->dbs,
# dbfusion->dbf). If so, set id_segment to 'dbs' / 'dbf' instead of the
# game_type key, to keep sealed and singles under the same prefix.
