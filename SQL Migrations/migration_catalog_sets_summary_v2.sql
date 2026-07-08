-- ============================================================
-- PathBinder — catalog_sets_summary_v2 RPC
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- The non-Pokemon Sets tabs (Magic, Yu-Gi-Oh, One Piece, etc.)
-- were paginating the catalog client-side in 1000-row batches and
-- doing the GROUP BY in JavaScript. Magic took 14 seconds, YGO
-- took 7 seconds on a cold visit. This RPC does the same work
-- server-side in a single query.
--
-- It returns everything the loadTcgSetsPage UI needs:
--   set_code, set_name, total, has_singles, has_sealed, max_created_at
--
-- has_singles / has_sealed drive the Singles ↔ Sealed toggle.
-- max_created_at gives us "newest first" sort without paginating.
--
-- Prerequisite indexes (see migration_catalog_perf_indexes.sql):
--   idx_catalog_set_code, idx_catalog_set_name,
--   idx_catalog_game_type_set_code, catalog_id_prefix_idx
--
-- With those in place, this query is an index scan + hash aggregate;
-- ~50ms instead of 14s for Magic.
--
-- Idempotent. CREATE OR REPLACE so re-running is safe.

CREATE OR REPLACE FUNCTION public.catalog_sets_summary_v2(p_prefix text)
RETURNS TABLE (
  set_code        text,
  set_name        text,
  total           bigint,
  has_singles     boolean,
  has_sealed      boolean,
  max_created_at  timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT
    set_code,
    set_name,
    COUNT(*)::bigint AS total,
    bool_or(COALESCE(product_type, 'single')  = 'single') AS has_singles,
    bool_or(COALESCE(product_type, 'single') <> 'single') AS has_sealed,
    MAX(created_at) AS max_created_at
  FROM public.catalog
  WHERE set_code IS NOT NULL
    AND set_name IS NOT NULL
    -- Same Pokemon-EN legacy-id awareness as catalog_sets_summary:
    -- when called with 'en-', also include bare-prefix legacy rows.
    --
    -- Sealed products live under a 'sealed-<prefix>' id namespace
    -- (e.g. sealed-op-pc-123 / sealed-lor-pc-45), NOT the bare singles
    -- prefix (op- / lor-). Include BOTH arms so a set that has only
    -- sealed rows still reports has_sealed = true and surfaces under the
    -- Sealed toggle. Without the 'sealed-' arm, One Piece / Lorcana / MTG
    -- / YGO sealed products exist in catalog but never appear on the Sets
    -- page (has_sealed was computed only from singles-prefixed rows).
    AND (
      (p_prefix = 'en-' AND (public.is_pokemon_en_id(id) OR id ILIKE 'sealed-en-%'))
      OR (p_prefix <> 'en-' AND (id ILIKE p_prefix || '%' OR id ILIKE 'sealed-' || p_prefix || '%'))
    )
  GROUP BY set_code, set_name;
$$;

GRANT EXECUTE ON FUNCTION public.catalog_sets_summary_v2(text) TO anon, authenticated;

-- Verification — run after the function is created and you should see
-- Magic come back in well under a second with the supporting indexes
-- in place:
--   SELECT * FROM catalog_sets_summary_v2('mtg-') LIMIT 5;
