-- ============================================================
-- PathBinder — Listings image-review flag
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Adds a boolean flag admins can set on listings whose photos
-- need to be replaced (low quality, wrong product, watermark, etc.).
-- The flag is admin-only — non-admin users never see it in UI.
-- A small index keeps the "show flagged listings" admin query fast.
--
-- Idempotent — ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- ============================================================

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS needs_image_review BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS image_review_note TEXT;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS image_review_flagged_at TIMESTAMPTZ;

-- Partial index — most listings have needs_image_review=false so we
-- only index the flagged ones for fast admin-queue queries.
CREATE INDEX IF NOT EXISTS idx_listings_needs_image_review
  ON public.listings (image_review_flagged_at DESC)
  WHERE needs_image_review = TRUE;

COMMENT ON COLUMN public.listings.needs_image_review IS
  'Admin-only flag — true when the listing photos need to be replaced (poor quality, wrong product, watermarked, etc.). Surfaced via admin queue, hidden in public UI.';
COMMENT ON COLUMN public.listings.image_review_note IS
  'Optional admin note explaining what needs fixing (e.g. "wrong angle", "blurry box").';
COMMENT ON COLUMN public.listings.image_review_flagged_at IS
  'Timestamp when the flag was set — used to sort the admin queue oldest-first.';

-- ============================================================
-- Verify:
--   SELECT id, name, needs_image_review, image_review_note, image_review_flagged_at
--   FROM public.listings WHERE needs_image_review = TRUE
--   ORDER BY image_review_flagged_at DESC NULLS LAST;
-- ============================================================
