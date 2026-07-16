-- ============================================================
-- PathBinder — normalise Dragon Ball sealed game_type to slugs
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- What's wrong
-- ------------
-- 134 catalog rows carry a DISPLAY NAME in game_type where every other row
-- and every consumer uses the lowercase slug:
--
--   'Dragon Ball Super CCG'           102 rows  (should be 'dbsccg')
--   'Dragon Ball Super Fusion World'   32 rows  (should be 'dbfusion')
--
-- All 134 are SEALED products (id prefix 'sealed-dbs-pc-*' / 'sealed-dbf-pc-*',
-- product_type booster_box / booster_pack). Their SINGLES are filed correctly:
-- 10,069 rows under 'dbsccg' and 3,154 under 'dbfusion'. So each game is
-- currently split across two game_type values — singles under the slug, sealed
-- under the display name.
--
-- NOTE: this is NOT a duplicate shard. Checked before writing this: the 140
-- 'Awakened Pulse' rows under 'dbfusion' are product_type='single' with id
-- prefix 'dbf', the 32 under the display name are sealed with id prefix
-- 'sealed', and there is ZERO id overlap. Sealed and singles sharing a set_name
-- is normal and correct. Only the game_type label is wrong.
--
-- Where it came from
-- ------------------
-- dbz_modern_sealed_config.draft.py lines 23 and 40 hardcode the display name:
--     "game_type": "Dragon Ball Super CCG",
--     "game_type": "Dragon Ball Super Fusion World",
-- while pokedata_sync.py's get_game_type() (line ~457) correctly returns the
-- slug: `if "fusion world" in t: return "dbfusion"`. The draft config is fixed
-- in the same commit as this migration; without that fix the next ingest run
-- re-creates these rows.
--
-- Why it's safe — every consumer already expects the slug (all verified):
--   pokedata_sync.py:457    get_game_type() -> 'dbfusion'          (slug)
--   pb-scanner.js:3985      scores = { …, dbsccg: 0, dbfusion: 0 } (slug)
--   pb-scanner.js:2149-50   dbsccg: 'Dragon Ball Super CCG'        (slug -> display MAP;
--                           the display name is the VALUE, never compared against)
--   pb-app.js:26243-44      m['dbsccg'] / m['dbfusion'] card-backs  (slug)
-- Grepped for anything comparing game_type to the display-name form: nothing.
-- So these rows are currently INVISIBLE to the scanner's game filter, the
-- card-back lookup and the game dropdowns; this makes them visible.
--
-- The Sets page sealed toggle is unaffected either way — catalog_sets_summary_v2
-- keys the sealed arm on the 'sealed-<prefix>' id namespace, not on game_type.
--
-- Also required so `backfill_image_variants.py --game dbsccg` actually reaches
-- these rows: it filters on game_type=eq.<slug>, so today it would silently skip
-- 101 of the 102 mirrored sealed images.
--
-- Idempotent — re-running matches zero rows.
-- ============================================================

UPDATE public.catalog
   SET game_type = 'dbsccg'
 WHERE game_type = 'Dragon Ball Super CCG';

UPDATE public.catalog
   SET game_type = 'dbfusion'
 WHERE game_type = 'Dragon Ball Super Fusion World';

-- ============================================================
-- Verify — expect ZERO rows:
--
--   SELECT game_type, COUNT(*) FROM public.catalog
--    WHERE game_type IN ('Dragon Ball Super CCG', 'Dragon Ball Super Fusion World')
--    GROUP BY game_type;
--
-- And the slugs should absorb them (singles + sealed now together):
--
--   SELECT game_type, product_type, COUNT(*) FROM public.catalog
--    WHERE game_type IN ('dbsccg', 'dbfusion')
--    GROUP BY game_type, product_type ORDER BY game_type, product_type;
--   -- dbsccg   | single       | 10069
--   -- dbsccg   | booster_box  |   ~30   <- newly unified
--   -- dbsccg   | booster_pack |   ~72   <- newly unified
--   -- dbfusion | single       |  3154
--   -- dbfusion | booster_box  |    10   <- newly unified
--   -- dbfusion | booster_pack |    22   <- newly unified
--
-- Belt-and-braces — no display-name game_type should survive anywhere:
--   SELECT DISTINCT game_type FROM public.catalog WHERE game_type ~ '[ A-Z]';
-- ============================================================
