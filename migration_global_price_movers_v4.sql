-- ============================================================
-- PathBinder — Global Price Movers RPC (v4)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- v4 changes:
--   - Stop relying on catalog_price_history.game_type to scope the
--     query. Older history rows (pre-column-addition) have NULL there,
--     which the v3 equality filter silently dropped. The new query
--     joins catalog first and filters on catalog.game_type — every row
--     has that populated, so the result set actually contains the
--     pokemon movers it should.
--   - GRANT EXECUTE to service_role as well, so the Discord bot
--     (calling with the SUPABASE_SERVICE_KEY) can invoke the RPC.
--     service_role usually has implicit access, but being explicit
--     keeps it from breaking if a later migration revokes broad
--     privileges.
--
-- Idempotent — safe to re-run. Drops every prior signature first to
-- avoid PostgREST PGRST203 ambiguity errors.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_global_price_movers(
  p_game_type    TEXT    DEFAULT 'pokemon',
  p_days_back    INT     DEFAULT 1,
  p_top_n        INT     DEFAULT 10,
  p_min_pct      NUMERIC DEFAULT 0.5,
  p_sort         TEXT    DEFAULT 'pct',     -- 'pct' or 'dollar'
  p_product_type TEXT    DEFAULT 'single'   -- 'single' | 'sealed' | 'all'
)
RETURNS TABLE (
  catalog_id    TEXT,
  name          TEXT,
  set_name      TEXT,
  image_url     TEXT,
  old_value     NUMERIC,
  current_value NUMERIC,
  delta         NUMERIC,
  delta_pct     NUMERIC,
  direction     TEXT
) LANGUAGE SQL STABLE SECURITY INVOKER AS $$
  WITH oldest_per_card AS (
    -- Pick the oldest in-window price for each catalog row. We DO NOT
    -- filter by history.game_type here because that column is nullable
    -- for legacy rows; the JOIN below uses catalog.game_type which is
    -- the authoritative source.
    SELECT DISTINCT ON (catalog_id)
      catalog_id,
      recorded_value AS old_value
    FROM catalog_price_history
    WHERE recorded_at >= CURRENT_DATE - p_days_back
    ORDER BY catalog_id, recorded_at ASC
  ),
  moves AS (
    SELECT
      o.catalog_id,
      c.name,
      c.set_name,
      c.image_url,
      o.old_value,
      c.current_value,
      (c.current_value - o.old_value)::NUMERIC                              AS delta,
      ROUND(((c.current_value - o.old_value) / NULLIF(o.old_value, 0) * 100)::numeric, 2) AS delta_pct
    FROM oldest_per_card o
    JOIN catalog c ON c.id = o.catalog_id
    WHERE c.game_type      = p_game_type
      AND c.current_value IS NOT NULL
      AND o.old_value     IS NOT NULL
      AND ABS(c.current_value - o.old_value) > 0.01
      AND ABS((c.current_value - o.old_value) / NULLIF(o.old_value, 0) * 100) >= p_min_pct
      AND (
        p_product_type = 'all'
        OR (p_product_type = 'single' AND COALESCE(c.product_type, 'single') = 'single')
        OR (p_product_type = 'sealed' AND COALESCE(c.product_type, 'single') <> 'single')
      )
  )
  (SELECT catalog_id, name, set_name, image_url, old_value, current_value,
          delta, delta_pct, 'up'::TEXT AS direction
   FROM moves
   WHERE delta > 0
   ORDER BY
     CASE WHEN p_sort = 'dollar' THEN ABS(delta)    ELSE NULL END DESC NULLS LAST,
     CASE WHEN p_sort = 'pct'    THEN ABS(delta_pct) ELSE NULL END DESC NULLS LAST
   LIMIT p_top_n)
  UNION ALL
  (SELECT catalog_id, name, set_name, image_url, old_value, current_value,
          delta, delta_pct, 'down'::TEXT AS direction
   FROM moves
   WHERE delta < 0
   ORDER BY
     CASE WHEN p_sort = 'dollar' THEN ABS(delta)    ELSE NULL END DESC NULLS LAST,
     CASE WHEN p_sort = 'pct'    THEN ABS(delta_pct) ELSE NULL END DESC NULLS LAST
   LIMIT p_top_n);
$$;

GRANT EXECUTE ON FUNCTION public.get_global_price_movers TO anon, authenticated, service_role;

-- ============================================================
-- Verify (should now return data even though history.game_type is NULL
-- for most rows):
--   SELECT * FROM get_global_price_movers('pokemon', 1, 10, 0.5, 'pct', 'single');
--   SELECT * FROM get_global_price_movers('pokemon', 7, 10, 0.5, 'pct', 'single');
--
-- Sanity check (compare row counts):
--   SELECT COUNT(*) FROM catalog_price_history
--   WHERE recorded_at >= CURRENT_DATE - 1;
-- ============================================================
