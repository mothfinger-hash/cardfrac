-- ============================================================
-- PathBinder — Sealed Product Tracking Migration
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Adds sealed-product support (booster boxes, ETBs, UTBs, etc.)
-- alongside the existing single-card catalog. Idempotent — safe to
-- re-run; only ADDs columns that don't already exist.
-- ============================================================

-- 1. catalog: product_type discriminator (default 'single' for all
--    existing rows; new sealed products get 'booster_pack',
--    'booster_box', 'etb', 'utb', 'premium_collection', 'tin', etc.)
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'single';

COMMENT ON COLUMN public.catalog.product_type IS
  'Product category: single | booster_pack | booster_box | etb | utb | premium_collection | tin | other_sealed';

-- 2. catalog: release_date — meaningful for sealed (lets us sort by
--    release, show "Released March 2023", etc.). Nullable; populated
--    by the sealed sync script for sealed rows.
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS release_date DATE;

-- 3. catalog: msrp_usd — manufacturer's suggested retail. Sealed-only
--    in practice. Useful for showing market premium/discount.
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS msrp_usd NUMERIC(10,2);

-- 4. catalog: pricecharting_id — direct cross-reference to PriceCharting.
--    Singles already store this in card_prices.api_card_id; for sealed
--    products we mirror it on the catalog row so the sync can do
--    idempotent upserts without juggling the prices table.
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS pricecharting_id TEXT;

-- 5. Index for fast Sets-page browse filtering: when the user toggles
--    Singles → Sealed inside a set, we filter by (game_type, product_type,
--    set_name). The default catalog index on (id) covers individual
--    card lookups; this new index covers the new toggle's read path.
CREATE INDEX IF NOT EXISTS idx_catalog_game_product_set
  ON public.catalog (game_type, product_type, set_name);

-- 6. listings (marketplace): product_type mirror so search and filter
--    can branch without joining the catalog. Defaults to 'single' for
--    backwards compatibility with every existing marketplace listing.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'single';

COMMENT ON COLUMN public.listings.product_type IS
  'Mirror of catalog.product_type — single | booster_pack | booster_box | etb | utb | premium_collection | tin | other_sealed';

CREATE INDEX IF NOT EXISTS idx_listings_product_type
  ON public.listings (product_type, status);

-- 7. collection_items: product_type mirror so the binder render knows
--    whether to use the card-shape image and grade badge, or the
--    product-shape image with SEALED badge.
ALTER TABLE public.collection_items
  ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'single';

-- 8. Helper view: catalog_sealed — convenience for the sync script's
--    "needs review" admin tool. Lists sealed rows without a release_date
--    or msrp_usd so we can fill them in by hand.
CREATE OR REPLACE VIEW public.catalog_sealed_needs_review AS
SELECT id, name, set_name, set_code, product_type, release_date, msrp_usd, image_url
FROM public.catalog
WHERE product_type <> 'single'
  AND (release_date IS NULL OR msrp_usd IS NULL);

GRANT SELECT ON public.catalog_sealed_needs_review TO anon, authenticated;

-- ============================================================
-- Verify after running:
--   select count(*) from catalog where product_type = 'single';   -- pre-existing rows
--   select count(*) from catalog where product_type <> 'single';  -- empty until sync runs
--   select * from information_schema.columns
--     where table_name = 'catalog' and column_name in
--       ('product_type','release_date','msrp_usd','pricecharting_id');
-- ============================================================
