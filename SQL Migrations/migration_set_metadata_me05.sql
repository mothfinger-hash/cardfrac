-- ============================================================
-- PathBinder — surface ME05 "Pitch Black" on the Pokemon Sets page
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- WHY
-- ---
-- The Pokemon EN Sets page lists sets from public.set_metadata
-- (_loadEnSetsFromDb: game_type='pokemon', ordered by release_date). That
-- table is populated ONLY from pokemontcg.io (mirror_set_logos.py), which has
-- no entry for a brand-new tcgcsv-only set. ME05 was imported into `catalog`
-- (120 en-me05-* rows) but has no set_metadata row, so it never appears — even
-- though the data is all there.
--
-- The Sets page primary list reads set_metadata; the catalog-append fallback
-- only runs when set_metadata is EMPTY, and it can't be used generally because
-- set_metadata.id is pokemontcg-style ('sv8') while catalog.set_code is
-- TCGplayer-style ('SV08') — no shared key, so a blanket append would add ~54
-- duplicate rows. The correct fix is a single set_metadata row.
--
-- ID CHOICE: use the catalog set_code 'ME05'. loadSetDetail(id) resolves cards
-- by `catalog.set_code = id` (case-insensitive ilike fallback), so id='ME05'
-- both lists the set AND loads its 120 cards on click. When pokemontcg.io later
-- ingests this set (likely id 'me5'), mirror_set_logos.py will add a proper
-- row with a logo; de-dupe then by deleting this 'ME05' row (they share the
-- name 'Pitch Black').
--
-- Idempotent (upsert on id).
-- ============================================================

INSERT INTO public.set_metadata (id, name, series, game_type, release_date, total, printed_total)
VALUES ('ME05', 'Pitch Black', 'Mega Evolution', 'pokemon', '2026-07-17', 120, 120)
ON CONFLICT (id) DO UPDATE
  SET name          = EXCLUDED.name,
      series        = EXCLUDED.series,
      game_type     = EXCLUDED.game_type,
      release_date  = EXCLUDED.release_date,
      total         = EXCLUDED.total,
      printed_total = EXCLUDED.printed_total;

-- Verify:
--   SELECT id, name, release_date, total FROM set_metadata WHERE id='ME05';
--   -- Pitch Black should now appear at the top of the Pokemon Sets list
--   -- (newest release_date), and clicking it loads the 120 en-me05- cards.
-- ============================================================
