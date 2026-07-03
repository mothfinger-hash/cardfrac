-- migration_pokemon_en_sets_index.sql
--
-- Speeds up the Pokemon-EN Sets page, which was the only slow TCG.
--
-- catalog_sets_summary('en-') filters rows with is_pokemon_en_id(id) — a
-- per-row function call, so a plain `id LIKE 'prefix-%'` index can't be used
-- and Postgres full-scans ~169k catalog rows for every load. Other TCGs use a
-- simple indexable prefix match, which is why only Pokemon lagged.
--
-- is_pokemon_en_id is IMMUTABLE, so we can build a PARTIAL index whose
-- predicate is that function and whose columns are the GROUP BY keys. The
-- summary then becomes an index-only scan over just the Pokemon-EN rows.
--
-- Prereq: run migration_pokemon_en_legacy_ids.sql first (it defines
-- is_pokemon_en_id + catalog_sets_summary). Idempotent.

CREATE INDEX IF NOT EXISTS idx_catalog_pokemon_en_sets
  ON public.catalog (set_code, set_name)
  WHERE public.is_pokemon_en_id(id);

-- Refresh planner stats so it picks the new index immediately.
ANALYZE public.catalog;
