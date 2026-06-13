-- migration_add_op16_set_metadata.sql
-- Register ONE PIECE OP16 "The Time of Battle" as a set in public.set_metadata.
--
-- Why this is needed
-- ------------------
-- The OP16 set already appears on the Sets page automatically, because the
-- list is derived from catalog rows (catalog_sets_summary groups by set_code).
-- This row adds the metadata the catalog can't supply on its own:
--   * release_date  -> sorts OP16 to the top (newest-first) and shows the date
--   * name / totals -> canonical set name + card counts
--
-- Key convention (see _enrichTcgSetsWithReleaseDate in pb-app.js):
--   set_metadata.id = '<idPrefix><set_code>'  ->  'op-' + 'OP16' = 'op-OP16'
--   The app strips the 'op-' prefix and lowercases the remainder to match
--   catalog.set_code ('op16'), so this id lines up with the OP16 catalog rows.
--
-- Counts:
--   printed_total = 119  (OP16-001 .. OP16-119, the base numbered cards)
--   total         = 155  (all OP16 catalog rows incl. alt-art parallels +
--                          the 6 SP reprints distributed in this product)
--
-- logo_url / symbol_url are left NULL — the Sets tile falls back to the
-- [OP] tag. Populate later via a logo mirror if desired.

INSERT INTO public.set_metadata (
  id, name, series, game_type, release_date, printed_total, total
)
VALUES (
  'op-OP16', 'The Time of Battle', 'One Piece', 'onepiece', '2026-06-12', 119, 155
)
ON CONFLICT (id) DO UPDATE SET
  name          = EXCLUDED.name,
  series        = EXCLUDED.series,
  game_type     = EXCLUDED.game_type,
  release_date  = EXCLUDED.release_date,
  printed_total = EXCLUDED.printed_total,
  total         = EXCLUDED.total;

-- Verify:
SELECT id, name, game_type, release_date, printed_total, total
FROM public.set_metadata
WHERE id = 'op-OP16';
