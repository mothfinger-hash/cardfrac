-- ============================================================
-- PathBinder — Manual BG Review Queue Migration
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Adds a flag column for sealed products whose automated bg
-- removal failed (off-white background, photo-style background,
-- gradient, etc.). The admin Sealed BG Review queue lists every
-- catalog row WHERE needs_manual_bg = true so an admin can hand-
-- upload a cleaned image.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. catalog.needs_manual_bg — true when restore_sealed_bg.py
--    couldn't remove the background automatically (e.g. cream /
--    yellow / tinted background, flood-fill produced no change).
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS needs_manual_bg BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.catalog.needs_manual_bg IS
  'true when the automated bg removal cant strip the background — flagged for admin manual review / image replacement. Cleared when an admin uploads a cleaned image.';

-- 2. catalog.bg_failure_reason — short text describing WHY the
--    automated bg removal failed. Helps admins triage at a glance
--    (cream bg vs. photo bg vs. gradient).
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS bg_failure_reason TEXT;

COMMENT ON COLUMN public.catalog.bg_failure_reason IS
  'Set alongside needs_manual_bg: short reason ("output >= input", "corners not uniform white", "corners too dark", etc.) so admins can group similar failures.';

-- 3. catalog.bg_flagged_at — timestamp the row was last flagged.
--    Lets the admin queue sort by oldest-first or newest-first.
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS bg_flagged_at TIMESTAMPTZ;

-- 4. Index for the admin queue's "show me flagged rows" read.
CREATE INDEX IF NOT EXISTS idx_catalog_needs_manual_bg
  ON public.catalog (needs_manual_bg, product_type)
  WHERE needs_manual_bg = true;

-- 4b. catalog.bg_state — cached classification so restore_sealed_bg.py
--     doesn't have to re-download every image on each --only-opaque
--     run. Populated by the --detect pass (one-time scan), updated
--     automatically by --redo (sets 'transparent' on success) and
--     --revert (sets 'opaque' since revert restores the original
--     white background). 'unknown' is the migration default; rows
--     stay 'unknown' until the first classification pass runs.
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS bg_state TEXT NOT NULL DEFAULT 'unknown';

COMMENT ON COLUMN public.catalog.bg_state IS
  'Cached corner-alpha classification: opaque | transparent | unknown. Set by restore_sealed_bg.py so subsequent runs filter via SQL instead of re-downloading every image. unknown = never classified.';

-- 4c. Index for the redo flow's "give me opaque sealed products" read.
--     Composite with product_type so the filter is index-only.
CREATE INDEX IF NOT EXISTS idx_catalog_bg_state
  ON public.catalog (bg_state, product_type)
  WHERE product_type <> 'single';

-- 5. Convenience view for the admin queue — joins the existing
--    sealed fields with the flag columns, sorted by most-recently
--    flagged first.
CREATE OR REPLACE VIEW public.catalog_bg_review_queue AS
SELECT
  id,
  name,
  set_name,
  set_code,
  product_type,
  image_url,
  price_source_url,
  bg_failure_reason,
  bg_flagged_at
FROM public.catalog
WHERE needs_manual_bg = true
ORDER BY bg_flagged_at DESC NULLS LAST;

GRANT SELECT ON public.catalog_bg_review_queue TO anon, authenticated;

-- ============================================================
-- Verify after running:
--   select count(*) from catalog where needs_manual_bg = true;
--   select * from catalog_bg_review_queue limit 10;
-- ============================================================
