-- migration_new_sets_release_dates_2026-09.sql
--
-- Fix for the sets ingested ~2026-09-15 (batch ingest) that landed with NO
-- release_date. Two different Sets-page code paths mean two symptoms:
--
--   * One Piece / Lorcana / DB Fusion  -> loadTcgSetsPage() groups catalog by
--     set_code and sorts by max(catalog.release_date). These games have ZERO
--     set_metadata rows, so an undated set sinks to the BOTTOM of the list
--     (below sets from years ago) instead of sorting to the top.
--
--   * Pokemon EN  -> the Sets page is driven ONLY by set_metadata
--     (_loadEnSetsFromDb; it never falls back once other Pokemon sets exist).
--     A set with no set_metadata row is INVISIBLE on the Sets page even though
--     its cards are in catalog. 30th Celebration (30C, 30CC) is currently
--     missing for exactly this reason.
--
--   * Yu-Gi-Oh "Magnificent Monsters" already has set_metadata id 'ygo-mamo'
--     dated 2026-09-04 and sorts correctly -> NO ACTION.
--
-- So: Pokemon gets set_metadata INSERTs; the TCG games get catalog.release_date
-- UPDATEs (which is what their Sets page actually reads).
--
-- Pokemon set_metadata.id is set to the catalog set_code ('30C' / '30CC') so
-- loadSetDetail()'s set_code lookup resolves the cards WITHOUT needing a
-- set_map bridge (verified: '30C' -> 154 EN singles, '30CC' -> 30).
--
-- Dates are from new_sets_2026-09-15.md (reported / web sources, not
-- independently verified). Idempotent: re-running is safe.
-- Run with the SERVICE key (writes to catalog + set_metadata).

begin;

------------------------------------------------------------------------------
-- 1. Pokemon EN 30th Celebration -> set_metadata (makes them APPEAR + sort top)
--    total/printed_total are the EN-single counts we actually hold in catalog
--    (official set totals unknown; adjust later if desired).
------------------------------------------------------------------------------
insert into public.set_metadata (id, name, series, game_type, release_date, total, printed_total)
values
  ('30C',  '30th Celebration',                     '30th Celebration', 'pokemon', date '2026-09-16', 154, 154),
  ('30CC', '30th Celebration: Classic Collection', '30th Celebration', 'pokemon', date '2026-09-16',  30,  30)
on conflict (id) do update set
  name          = excluded.name,
  series        = excluded.series,
  game_type     = excluded.game_type,
  release_date  = excluded.release_date,
  total         = excluded.total,
  printed_total = excluded.printed_total,
  updated_at    = now();

------------------------------------------------------------------------------
-- 2. TCG sets (no set_metadata for these games) -> catalog.release_date.
--    Row counts verified against live catalog before writing this file.
------------------------------------------------------------------------------
-- One Piece Starter Decks 31-36 (2026-07-31) -- 71 rows
update public.catalog set release_date = date '2026-07-31'
where game_type = 'onepiece'
  and set_code in ('ST-31','ST-32','ST-33','ST-34','ST-35','ST-36');

-- One Piece "The World's Strongest Warriors" OP17 + its release-event cards
-- (OP17 RE ships with the set) (2026-08-28) -- 137 + 75 = 212 rows
update public.catalog set release_date = date '2026-08-28'
where game_type = 'onepiece'
  and set_code in ('OP17','OP17 RE');

-- Lorcana "Attack of the Vine!" (Set 13) (2026-07-24) -- 254 rows
update public.catalog set release_date = date '2026-07-24'
where game_type = 'lorcana'
  and set_code = 'AOV';

-- Dragon Ball Fusion World "Story Booster 01" (2026-08-21 EN) -- 77 rows
update public.catalog set release_date = date '2026-08-21'
where game_type = 'dbfusion'
  and set_code = 'ST01';

------------------------------------------------------------------------------
-- TODO -- needs a CONFIRMED date before uncommenting:
-- One Piece "OP16 RE" (Time of Battle Release Event, 75 rows). The probe does
-- not list its date and catalog's OP16 release_date (2021-06-12) is a bad
-- placeholder, so we do NOT guess here. This set ALSO has 75 broken
-- tcgplayer-cdn images -- handled separately with the broken-image work.
--
-- update public.catalog set release_date = date '2026-__-__'
-- where game_type = 'onepiece' and set_code = 'OP16 RE';
------------------------------------------------------------------------------

commit;

------------------------------------------------------------------------------
-- Verify after running:
--
-- select id, name, release_date from public.set_metadata where id in ('30C','30CC');
--
-- select set_code, game_type, count(*) as rows, max(release_date) as release_date
-- from public.catalog
-- where (game_type = 'onepiece' and set_code in
--          ('ST-31','ST-32','ST-33','ST-34','ST-35','ST-36','OP17','OP17 RE'))
--    or (game_type = 'lorcana'  and set_code = 'AOV')
--    or (game_type = 'dbfusion' and set_code = 'ST01')
-- group by 1, 2
-- order by max(release_date) desc nulls last;
--
-- (In the app, the Sets list is cached in localStorage for 24h; a hard refresh
--  or waiting for the background refresh picks up the new order.)
------------------------------------------------------------------------------
