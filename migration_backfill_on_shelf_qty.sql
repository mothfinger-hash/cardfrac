-- Backfill on_shelf_qty for vendor+ cards that ended up at 0 because
-- the scanner-add path forgot to set the column (DB DEFAULT 0 applied
-- to every scan-added row before this fix landed).
--
-- This is safe to run multiple times — only touches rows where the
-- math doesn't add up:
--   * vendor / shop tier owner
--   * not a ghost / sold-offline placeholder
--   * on_shelf_qty + listed_online_qty < quantity
--     (i.e. some units are "missing" from both buckets)
--
-- For each such row, push the missing units back onto the shelf so
-- POS scan can ring them up. listed_online_qty is left alone — those
-- units are accounted for by active marketplace listings.

UPDATE public.collection_items ci
   SET on_shelf_qty = greatest(0, coalesce(ci.quantity, 0) - coalesce(ci.listed_online_qty, 0))
  FROM public.profiles p
 WHERE ci.user_id = p.id
   AND p.subscription_tier IN ('vendor','shop')
   AND coalesce(ci.is_ghost, false)     = false
   AND coalesce(ci.sold_offline, false) = false
   AND coalesce(ci.on_shelf_qty, 0) + coalesce(ci.listed_online_qty, 0) < coalesce(ci.quantity, 0);

-- Verify — show how many rows changed and a sample so you can spot-check
-- before assuming everything's right.
SELECT
  count(*) FILTER (WHERE on_shelf_qty = 0 AND listed_online_qty = 0 AND quantity > 0) AS still_zero_with_stock,
  count(*) FILTER (WHERE on_shelf_qty > 0) AS rows_with_shelf_stock,
  sum(quantity)     AS total_units_owned,
  sum(on_shelf_qty) AS total_units_on_shelf
FROM public.collection_items ci
JOIN public.profiles p ON p.id = ci.user_id
WHERE p.subscription_tier IN ('vendor','shop')
  AND coalesce(ci.is_ghost, false)     = false
  AND coalesce(ci.sold_offline, false) = false;
