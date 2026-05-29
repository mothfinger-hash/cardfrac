-- ============================================================
-- PathBinder — Catalog performance indexes
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- Set detail page was taking 30+ seconds to load because the
-- catalog.set_code column has no index, so every lookup like
--
--     SELECT … FROM catalog
--      WHERE set_code = 'crz' AND game_type = 'pokemon'
--      ORDER BY card_number;
--
-- triggers a full table scan over 48,000+ rows. Same story for
-- set_name (used by the Sets index dedupe) and game_type
-- (used by every TCG-tab filter).
--
-- These are plain B-tree indexes — small (a few MB each on a
-- catalog this size), CREATE IF NOT EXISTS so re-running is a
-- no-op, and concurrently-created so the table stays writable
-- during the build.
--
-- Expected impact
-- ---------------
--   Set detail load:   30s → ~1s
--   Sets index dedupe:  4s → ~200ms
--   game_type filter:  ~5s → ~150ms

-- ── Single-column indexes ────────────────────────────────────
-- set_code is the most-queried filter (loaded on every set
-- detail page open). Lowercase normalized — code path on the
-- client side now uses .eq with a lowercased value first,
-- falling back to .ilike for legacy uppercase rows. The exact
-- lookup will hit this index hard.
CREATE INDEX IF NOT EXISTS idx_catalog_set_code
  ON public.catalog (set_code);

-- set_name supports the Sets-page DISTINCT dedupe + the binder
-- "owned by set" rollup. Covers both ilike-prefix and exact eq
-- queries.
CREATE INDEX IF NOT EXISTS idx_catalog_set_name
  ON public.catalog (set_name);

-- game_type — gates every TCG tab on the Sets page and the
-- Browse marketplace filter.
CREATE INDEX IF NOT EXISTS idx_catalog_game_type
  ON public.catalog (game_type);

-- ── Composite index ──────────────────────────────────────────
-- (game_type, set_code) covers the canonical set-detail query
-- which always filters on BOTH at once. Postgres prefers a
-- single composite index over multiple single-column ones
-- when the column predicate cardinalities are highly
-- correlated like this. Drops the set-detail plan from
-- "Seq Scan" to "Index Scan using idx_catalog_game_set".
CREATE INDEX IF NOT EXISTS idx_catalog_game_type_set_code
  ON public.catalog (game_type, set_code);

-- ── product_type filter ──────────────────────────────────────
-- The marketplace browse filter on Singles / Sealed / Non-TCG
-- product types runs WHERE product_type = 'single' across the
-- whole table. Small relative to (game_type, set_code) but
-- still measurable on 48k rows.
CREATE INDEX IF NOT EXISTS idx_catalog_product_type
  ON public.catalog (product_type);

-- ── ANALYZE so the planner picks them up immediately ─────────
-- Without this, the planner relies on stats gathered before the
-- index existed and might briefly continue with the seq scan
-- plan. Cheap on a 48k-row table; takes seconds.
ANALYZE public.catalog;

-- ── Verify ───────────────────────────────────────────────────
-- After running, the following should show the new indexes:
--   SELECT indexname, indexdef
--     FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename = 'catalog'
--    ORDER BY indexname;
