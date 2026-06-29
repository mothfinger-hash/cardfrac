-- ============================================================
-- PathBinder — Multi-Category Marketplace (Pilot: Funko Pop)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Adds non-TCG product support to the marketplace. Pilot category is
-- Funko Pop. Other categories are pre-seeded but flagged inactive so
-- they can be enabled individually as we validate each one.
--
-- Schema strategy:
--   - listings gets a product_category column (default 'tcg_single' so
--     all existing rows are valid without backfill)
--   - listings gets an attributes JSONB column for category-specific
--     fields that don't fit the TCG-shaped schema (Funko number,
--     exclusivity, series, etc.)
--   - product_categories lookup table holds UI metadata (display name,
--     icon hint, preferred photo aspect ratio, active/inactive flag)
--
-- Idempotent — safe to re-run. Adds columns IF NOT EXISTS, upserts
-- categories with ON CONFLICT.
-- ============================================================

-- ── listings: category + attributes ─────────────────────────────────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS product_category TEXT NOT NULL DEFAULT 'tcg_single';

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Index for category-filtered browse queries
CREATE INDEX IF NOT EXISTS idx_listings_category_status
  ON public.listings (product_category, status);

COMMENT ON COLUMN public.listings.product_category IS
  'High-level marketplace category. References product_categories.key. Defaults to tcg_single for backward compat.';
COMMENT ON COLUMN public.listings.attributes IS
  'Free-form JSONB for category-specific fields. Schema enforced by the UI per category (see PRODUCT_CATEGORIES in index.html).';

-- ── product_categories lookup ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_categories (
  key             TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  icon            TEXT,                              -- icon hint (resolved client-side)
  photo_aspect    TEXT NOT NULL DEFAULT '1:1',       -- preferred photo aspect ratio
  sort_order      INT  NOT NULL DEFAULT 100,
  is_active       BOOLEAN NOT NULL DEFAULT false,    -- only active categories appear in selectors
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT ON public.product_categories TO anon, authenticated;

-- ── RLS: read-only for the public, writes only via service-role ────
-- product_categories is reference data — every user needs to read it
-- to render the category picker, but no one should be able to write.
-- Enable RLS + add an explicit public SELECT policy. Writes flow
-- through the service-role key (admin tools), which bypasses RLS.
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read product_categories"
  ON public.product_categories;

CREATE POLICY "Anyone can read product_categories"
  ON public.product_categories
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ── Seed categories ────────────────────────────────────────────────
INSERT INTO public.product_categories (key, display_name, icon, photo_aspect, sort_order, is_active) VALUES
  ('tcg_single',   'TCG Singles',    'card',     '245:342', 10,  true),
  ('tcg_sealed',   'TCG Sealed',     'box',      '1:1',     20,  true),
  ('funko_pop',    'Funko Pop',      'figure',   '4:5',     30,  true),   -- PILOT
  ('figure',       'Figures',        'figure',   '4:5',     40,  false),
  ('manga',        'Manga',          'book',     '3:5',     50,  false),
  ('poster',       'Posters',        'poster',   '4:5',     60,  false),
  ('apparel',      'Apparel',        'shirt',    '1:1',     70,  false),
  ('pin',          'Pins',           'pin',      '1:1',     80,  false),
  ('plush',        'Plush',          'plush',    '1:1',     90,  false),
  ('art_print',    'Art Prints',     'poster',   '4:5',    100,  false),
  ('statue',       'Statues',        'figure',   '4:5',    110,  false),
  ('accessory',    'Accessories',    'box',      '1:1',    120,  false),
  ('other',        'Other',          'box',      '1:1',    999,  false)
ON CONFLICT (key) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      icon         = EXCLUDED.icon,
      photo_aspect = EXCLUDED.photo_aspect,
      sort_order   = EXCLUDED.sort_order;

-- Note: existing categories' is_active is preserved on re-run via the
-- ON CONFLICT clause (we don't include is_active in the UPDATE list).
-- To flip a category active, run:
--   UPDATE product_categories SET is_active = true WHERE key = 'manga';

-- ============================================================
-- Verify:
--   SELECT key, display_name, is_active FROM product_categories ORDER BY sort_order;
--   SELECT product_category, count(*) FROM listings GROUP BY 1;
-- ============================================================
