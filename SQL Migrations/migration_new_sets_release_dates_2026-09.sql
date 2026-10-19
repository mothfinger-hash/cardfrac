-- migration_new_sets_release_dates_2026-09.sql
--
-- Puts the sets ingested ~2026-09-15 (batch ingest, which landed with NO
-- release_date) into correct release-date order on the Sets page.
--
-- IMPORTANT: the Sets page reads release_date from set_metadata, NOT from
-- catalog, on BOTH code paths:
--   * Pokemon EN (_loadEnSetsFromDb)      -> set_metadata rows keyed by the
--     bare set_code (e.g. '30C'). A set absent from set_metadata is INVISIBLE
--     on the Pokemon Sets page even though its cards are in catalog.
--   * Other TCG (loadTcgSetsPage ->        -> set_metadata rows keyed by
--     _enrichTcgSetsWithReleaseDate)          '<idPrefix><set_code>' lower-cased
--     (e.g. One Piece 'op-st-31', Lorcana 'lor-aov'). The list RPC only returns
--     total / max_created_at, so a set with no set_metadata row falls back to
--     catalog-insertion order -- which is why the new One Piece / Lorcana /
--     DB Fusion sets currently sort by "recently added", not by release date.
--   * Yu-Gi-Oh "Magnificent Monsters" already has set_metadata 'ygo-mamo'
--     (2026-09-04) and sorts correctly -> NO ACTION.
--
-- So the ordering fix is set_metadata rows for every game (parts 1 + 2).
-- Part 3 also stamps catalog.release_date for data hygiene (used elsewhere,
-- e.g. per-card sorting) -- it is NOT what orders the Sets page.
--
-- set_metadata.id must match how each page looks it up (verified against live
-- catalog set_codes/prefixes):
--   Pokemon -> bare set_code ('30C','30CC') so loadSetDetail resolves cards.
--   TCG     -> '<prefix><set_code>' lower-cased ('op-st-31', 'lor-aov', ...).
--
-- Dates from new_sets_2026-09-15.md (reported / web sources, not independently
-- verified). Idempotent (ON CONFLICT upsert). Run with the SERVICE key.

begin;

------------------------------------------------------------------------------
-- 1. Pokemon EN 30th Celebration -> set_metadata (makes them APPEAR + sort top)
--    id = bare set_code; total/printed_total = EN-single counts we hold.
------------------------------------------------------------------------------
insert into public.set_metadata (id, name, series, game_type, release_date, total, printed_total)
values
  ('30C',  '30th Celebration',                     '30th Celebration', 'pokemon', date '2026-09-16', 154, 154),
  ('30CC', '30th Celebration: Classic Collection', '30th Celebration', 'pokemon', date '2026-09-16',  30,  30)
on conflict (id) do update set
  name = excluded.name, series = excluded.series, game_type = excluded.game_type,
  release_date = excluded.release_date, total = excluded.total,
  printed_total = excluded.printed_total, updated_at = now();

------------------------------------------------------------------------------
-- 2. TCG sets -> set_metadata keyed by '<prefix><set_code>' (THE ordering fix).
--    Enrichment matches id.slice(len(prefix)).lower() to catalog set_code.lower().
------------------------------------------------------------------------------
insert into public.set_metadata (id, name, game_type, release_date)
values
  -- One Piece Starter Decks 31-36 (2026-07-31)
  ('op-st-31', 'Starter Deck 31: RED Monkey.D.Luffy',            'onepiece', date '2026-07-31'),
  ('op-st-32', 'Starter Deck 32: GREEN Roronoa Zoro',            'onepiece', date '2026-07-31'),
  ('op-st-33', 'Starter Deck 33: BLUE Kuzan',                    'onepiece', date '2026-07-31'),
  ('op-st-34', 'Starter Deck 34: PURPLE Charlotte Katakuri',     'onepiece', date '2026-07-31'),
  ('op-st-35', 'Starter Deck 35: RED/BLACK Sabo',                'onepiece', date '2026-07-31'),
  ('op-st-36', 'Starter Deck 36: YELLOW Eustass "Captain" Kid',  'onepiece', date '2026-07-31'),
  -- One Piece OP17 + its release-event cards (2026-08-28)
  ('op-op17',    'The World''s Strongest Warriors',                'onepiece', date '2026-08-28'),
  ('op-op17 re', 'The World''s Strongest Warriors Release Event',  'onepiece', date '2026-08-28'),
  -- Lorcana "Attack of the Vine!" (Set 13) (2026-07-24)
  ('lor-aov', 'Attack of the Vine!', 'lorcana', date '2026-07-24'),
  -- Dragon Ball Fusion World "Story Booster 01" (2026-08-21)
  ('dbf-st01', 'Story Booster 01', 'dbfusion', date '2026-08-21')
on conflict (id) do update set
  name = excluded.name, game_type = excluded.game_type,
  release_date = excluded.release_date, updated_at = now();

------------------------------------------------------------------------------
-- 3. catalog.release_date (data hygiene; NOT the Sets-page ordering source).
--    Row counts verified against live catalog. Safe to re-run.
------------------------------------------------------------------------------
update public.catalog set release_date = date '2026-07-31'
where game_type = 'onepiece' and set_code in ('ST-31','ST-32','ST-33','ST-34','ST-35','ST-36');
update public.catalog set release_date = date '2026-08-28'
where game_type = 'onepiece' and set_code in ('OP17','OP17 RE');
update public.catalog set release_date = date '2026-07-24'
where game_type = 'lorcana' and set_code = 'AOV';
update public.catalog set release_date = date '2026-08-21'
where game_type = 'dbfusion' and set_code = 'ST01';

------------------------------------------------------------------------------
-- TODO -- needs a CONFIRMED date before uncommenting:
-- One Piece "OP16 RE" (Time of Battle Release Event, 75 rows). No verified
-- date (probe omits it; catalog OP16 = 2021-06-12 is a bad placeholder). This
-- set also has 75 broken tcgplayer-cdn images -- handled with the image work.
--
-- insert into public.set_metadata (id, name, game_type, release_date)
-- values ('op-op16 re', 'The Time of Battle Release Event', 'onepiece', date '2026-__-__')
-- on conflict (id) do update set release_date = excluded.release_date, updated_at = now();
-- update public.catalog set release_date = date '2026-__-__'
-- where game_type = 'onepiece' and set_code = 'OP16 RE';
------------------------------------------------------------------------------

commit;

------------------------------------------------------------------------------
-- Verify after running (the app caches the Sets list ~24h in localStorage,
-- so hard-refresh to see the new order immediately):
--
-- select id, name, release_date from public.set_metadata
-- where id in ('30C','30CC','op-st-31','op-st-36','op-op17','op-op17 re','lor-aov','dbf-st01')
-- order by release_date desc;
------------------------------------------------------------------------------
