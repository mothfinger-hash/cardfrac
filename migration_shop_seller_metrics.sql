-- ============================================================
-- PathBinder — Shop Tier Seller Metrics
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Two views that aggregate marketplace order data per shop-tier seller.
-- Used to demonstrate the value of the Shop subscription to prospective
-- vendors / consignment shops considering the tier.
--
-- - shop_seller_metrics:        per-seller breakdown (one row per shop)
-- - shop_tier_platform_metrics: single-row platform-wide rollup
--
-- Both views are read-only and idempotent — safe to re-run any time
-- the orders table schema or status enum changes.
-- ============================================================

-- ── PER-SELLER METRICS ──────────────────────────────────────────────
CREATE OR REPLACE VIEW public.shop_seller_metrics AS
SELECT
  p.id                              AS seller_id,
  p.username,
  p.name,
  p.created_at                      AS shop_joined_at,
  -- Lifetime totals (orders in money-changed-hands states)
  COUNT(o.id) FILTER (
    WHERE o.status IN ('paid','shipped','completed')
  )                                                                   AS confirmed_sales,
  COUNT(o.id) FILTER (
    WHERE o.status = 'completed'
  )                                                                   AS completed_sales,
  COALESCE(SUM(o.amount) FILTER (
    WHERE o.status IN ('paid','shipped','completed')
  ), 0)                                                               AS gross_gmv,
  COALESCE(SUM(o.seller_payout) FILTER (
    WHERE o.status IN ('paid','shipped','completed')
  ), 0)                                                               AS seller_earnings,
  COUNT(DISTINCT o.buyer_id) FILTER (
    WHERE o.status IN ('paid','shipped','completed')
  )                                                                   AS unique_buyers,
  -- Time anchors
  MIN(o.created_at) FILTER (
    WHERE o.status IN ('paid','shipped','completed')
  )                                                                   AS first_sale_at,
  MAX(o.created_at) FILTER (
    WHERE o.status IN ('paid','shipped','completed')
  )                                                                   AS last_sale_at,
  -- Rolling 30-day window (recent traction is the most persuasive)
  COUNT(o.id) FILTER (
    WHERE o.status IN ('paid','shipped','completed')
      AND o.created_at > NOW() - INTERVAL '30 days'
  )                                                                   AS sales_last_30d,
  COALESCE(SUM(o.amount) FILTER (
    WHERE o.status IN ('paid','shipped','completed')
      AND o.created_at > NOW() - INTERVAL '30 days'
  ), 0)                                                               AS gmv_last_30d
FROM public.profiles p
LEFT JOIN public.orders o
  ON o.seller_id = p.id
WHERE p.subscription_tier = 'shop'
GROUP BY p.id, p.username, p.name, p.created_at;

GRANT SELECT ON public.shop_seller_metrics TO anon, authenticated;

-- ── PLATFORM-WIDE ROLLUP (single row) ───────────────────────────────
CREATE OR REPLACE VIEW public.shop_tier_platform_metrics AS
SELECT
  COUNT(*)                                                            AS active_shops,
  COALESCE(SUM(confirmed_sales), 0)                                   AS total_confirmed_sales,
  COALESCE(SUM(gross_gmv), 0)                                         AS total_platform_gmv,
  COALESCE(SUM(seller_earnings), 0)                                   AS total_seller_earnings,
  COALESCE(SUM(sales_last_30d), 0)                                    AS sales_last_30d,
  COALESCE(SUM(gmv_last_30d), 0)                                      AS gmv_last_30d,
  COALESCE(AVG(NULLIF(gross_gmv, 0)), 0)                              AS avg_lifetime_gmv_per_shop,
  COALESCE(AVG(NULLIF(sales_last_30d, 0)), 0)                         AS avg_sales_per_shop_last_30d
FROM public.shop_seller_metrics
WHERE confirmed_sales > 0;  -- only count shops that have actually sold

GRANT SELECT ON public.shop_tier_platform_metrics TO anon, authenticated;

-- ============================================================
-- Sample queries you can run after applying:
--
-- 1. Top-grossing shops:
--    SELECT username, gross_gmv, confirmed_sales, last_sale_at
--    FROM shop_seller_metrics
--    ORDER BY gross_gmv DESC
--    LIMIT 10;
--
-- 2. Platform pitch numbers (one row):
--    SELECT * FROM shop_tier_platform_metrics;
--
-- 3. Active shops in last 30 days:
--    SELECT COUNT(*) FROM shop_seller_metrics WHERE sales_last_30d > 0;
-- ============================================================
