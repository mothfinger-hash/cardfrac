-- ============================================================
-- PathBinder — Global Price Movers RPC (v10)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- v10 change — SOURCE-CONSISTENT BASELINE + SANITY CAP
-- ---------------------------------------------------
-- v9 computed delta_pct as (catalog.current_value - catalog_price_history
-- .recorded_value) with NO tie between the two endpoints' price SOURCE.
-- After the TCGplayer-spine reseat, ~85% of catalog rows carry a TCGplayer
-- current_value (market_price_source='tcgplayer') while their only history
-- points are PriceCharting ('pricecharting*') — source='tcgplayer' history
-- does not exist yet. So the movers delta was TCG-current ÷ PC-baseline: a
-- pure cross-source fabrication. Live v9 returned physically-impossible top
-- movers (One Piece Chopper $0.51 → $2855 = +559,868%, Zoro $42,000 → $9.40
-- = -99.98%), which dominated the daily Discord post, /movers, and the
-- website's default "Biggest Movers" panel.
--
-- v10 fixes it exactly like the spike-alert RPC (get_owned_card_spikes):
--   1. SOURCE-CONSISTENCY: a card whose current_value is on the TCGplayer
--      spine baselines ONLY against source='tcgplayer' history; non-spine
--      (NULL / pricecharting) cards keep comparing PC-current vs PC-history.
--      Spine cards with no same-source baseline (all of them, until the
--      daily snapshot_tcgplayer_history_batch accrues points) simply drop
--      out of movers instead of showing a fake spike.
--   2. p_max_pct SANITY CAP (optional, bidirectional on ABS(delta_pct)):
--      even within one source a collided PriceCharting link can jump wildly
--      day-over-day. A physically-implausible 24h move is a data artifact,
--      not a real mover. NULL = no cap; callers pass 500.
--
-- Everything else (latest-snapshot anchor, p_min_value floor, product_type,
-- sort, thresholds, idx_catalog_game_value) is unchanged from v9.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_catalog_game_value
  ON public.catalog (game_type, current_value DESC, id)
  WHERE current_value IS NOT NULL;

DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC);

CREATE OR REPLACE FUNCTION public.get_global_price_movers(
  p_game_type    TEXT    DEFAULT 'pokemon',
  p_days_back    INT     DEFAULT 1,
  p_top_n        INT     DEFAULT 10,
  p_min_pct      NUMERIC DEFAULT 0.5,
  p_sort         TEXT    DEFAULT 'pct',
  p_product_type TEXT    DEFAULT 'single',
  p_min_value    NUMERIC DEFAULT 1.0,
  p_max_pct      NUMERIC DEFAULT NULL
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
  WITH anchor AS (
    -- Newest snapshot date that actually exists for this game.
    SELECT max(recorded_at) AS latest
    FROM catalog_price_history
    WHERE game_type = p_game_type
  ),
  moves AS (
    SELECT
      c.id   AS catalog_id,
      c.name,
      c.set_name,
      c.image_url,
      h.recorded_value AS old_value,
      c.current_value,
      (c.current_value - h.recorded_value)::NUMERIC                                       AS delta,
      ROUND(((c.current_value - h.recorded_value) / NULLIF(h.recorded_value, 0) * 100)::numeric, 2) AS delta_pct
    FROM catalog c
    CROSS JOIN anchor a
    JOIN LATERAL (
      SELECT recorded_value
      FROM catalog_price_history h2
      WHERE h2.catalog_id  = c.id
        AND h2.recorded_at >= a.latest - p_days_back   -- window anchored on newest snapshot
        AND h2.recorded_at <  a.latest
        -- SOURCE-CONSISTENCY: baseline against the same source as current_value.
        -- TCGplayer-spine rows only see source='tcgplayer' history; everything
        -- else (NULL / pricecharting market_price_source) sees any history.
        AND (c.market_price_source IS DISTINCT FROM 'tcgplayer' OR h2.source = 'tcgplayer')
      ORDER BY h2.recorded_at ASC
      LIMIT 1
    ) h ON TRUE
    WHERE c.game_type      = p_game_type
      AND c.current_value IS NOT NULL
      AND c.current_value >= p_min_value
      AND h.recorded_value IS NOT NULL
      AND (
        p_product_type = 'all'
        OR (p_product_type = 'single' AND COALESCE(c.product_type, 'single') = 'single')
        OR (p_product_type = 'sealed' AND COALESCE(c.product_type, 'single') <> 'single')
      )
      AND ABS(c.current_value - h.recorded_value) > 0.01
      AND ABS((c.current_value - h.recorded_value) / NULLIF(h.recorded_value, 0) * 100) >= p_min_pct
      -- Sanity ceiling: drop physically-implausible moves (collided links).
      AND (p_max_pct IS NULL
           OR ABS((c.current_value - h.recorded_value) / NULLIF(h.recorded_value, 0) * 100) <= p_max_pct)
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
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verify — top movers should no longer contain cross-source fabrications
-- (e.g. no +500,000% One Piece rows); spine cards drop out until tcgplayer
-- history accrues:
--   SELECT name, old_value, current_value, delta_pct, direction
--   FROM get_global_price_movers('onepiece', 1, 5, 0.5, 'pct', 'single', 1.0, 500);
--   SELECT count(*) FROM get_global_price_movers('pokemon', 1, 1000, 0.5, 'pct', 'single', 1.0, 500);
-- ============================================================
