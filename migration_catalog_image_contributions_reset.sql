-- ============================================================
-- Catalog Image Contributions — RESET (v2)
-- Run this FIRST if a previous attempt to run the main migration
-- left things in a half-applied state.
--
-- v2 fix: dropping individual policies fails if the table doesn't
-- exist (no "DROP POLICY IF EXISTS ON <table-if-exists>" syntax in
-- Postgres). Instead we DROP TABLE CASCADE — that removes the
-- policies automatically, and the IF EXISTS makes it a no-op when
-- the table never got created.
-- ============================================================

-- Drop functions first (they're standalone; CASCADE removes anything
-- that depends on them, like view definitions — but nothing does).
DROP FUNCTION IF EXISTS public.apply_image_contribution(UUID, UUID)         CASCADE;
DROP FUNCTION IF EXISTS public.reject_image_contribution(UUID, UUID, TEXT)  CASCADE;
DROP FUNCTION IF EXISTS public.user_contribution_trust_tier(UUID)           CASCADE;
DROP FUNCTION IF EXISTS public.user_can_contribute_image(UUID)              CASCADE;

-- Drop the table — CASCADE removes RLS policies and any FK references.
-- IF EXISTS handles the "never created" case cleanly.
DROP TABLE IF EXISTS public.catalog_image_contributions CASCADE;

-- The catalog credit columns are harmless to keep — leave them alone
-- so the main migration's ADD COLUMN IF NOT EXISTS is a no-op next time.
-- Uncomment if you want a TRUE nuclear option:
--   ALTER TABLE public.catalog
--     DROP COLUMN IF EXISTS image_contributed_by,
--     DROP COLUMN IF EXISTS image_contributed_at;
--   DROP INDEX IF EXISTS idx_catalog_image_contributed_by;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- After this runs (it should always succeed, even on a fresh DB
-- where nothing existed), run migration_catalog_image_contributions.sql
-- in full.
-- ============================================================
