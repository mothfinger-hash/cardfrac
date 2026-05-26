-- ============================================================
-- PathBinder — Catalog image-review flag (sealed products)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Adds an admin-only flag to catalog rows so we can mark sealed
-- products (booster boxes, ETBs, tins, decks, etc.) whose photos
-- need to be replaced — wrong angle, watermark, poor crop,
-- restore_sealed_bg.py failures the automated bg_failure_reason
-- queue didn't catch, etc.
--
-- This is the SUCCESSOR to migration_listings_image_review.sql.
-- That older migration added the same trio of columns to the
-- LISTINGS table; we've since decided the flag belongs on the
-- catalog row (single source of truth — listings inherit the
-- image from the catalog when they reference api_card_id).
-- The listings columns are still in the schema but unused.
-- Leave them; harmless and removing would orphan any older
-- listings that ever set them.
--
-- Idempotent — ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- ============================================================

ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS needs_image_review BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS image_review_note TEXT;

ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS image_review_flagged_at TIMESTAMPTZ;

-- Partial index — most catalog rows have needs_image_review=false
-- so we only index the flagged ones for fast admin-queue queries.
CREATE INDEX IF NOT EXISTS idx_catalog_needs_image_review
  ON public.catalog (image_review_flagged_at DESC)
  WHERE needs_image_review = TRUE;

COMMENT ON COLUMN public.catalog.needs_image_review IS
  'Admin-only flag — true when this catalog row''s image needs to be replaced (wrong product, watermarked, poor crop, etc.). Surfaced in the admin queue + the sealed product detail modal. Hidden from regular users.';
COMMENT ON COLUMN public.catalog.image_review_note IS
  'Optional admin note explaining what needs fixing (e.g. "wrong angle", "shows back of box").';
COMMENT ON COLUMN public.catalog.image_review_flagged_at IS
  'Timestamp when the flag was set — used to sort the admin queue oldest-first.';

-- ============================================================
-- Verify:
--   SELECT id, name, set_name, product_type, image_review_note, image_review_flagged_at
--   FROM public.catalog WHERE needs_image_review = TRUE
--   ORDER BY image_review_flagged_at DESC NULLS LAST;
-- ============================================================
