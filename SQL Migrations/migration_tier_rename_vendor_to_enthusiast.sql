-- ============================================================
-- PathBinder — Tier rename: 'vendor' → 'enthusiast'
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- The original 'vendor' tier ($25/mo) is being renamed to 'enthusiast'
-- and repriced at $20/mo. It keeps the same feature set BUT adds a
-- 40-listing concurrent active marketplace cap.
--
-- A brand-NEW 'vendor' tier ($75/mo) is being added on top:
--   • 150 concurrent active listings
--   • Non-TCG product listings (Funko, Manga, Posters, etc.)
--   • Product scanner access
--
-- The 'shop' tier ($200/mo unlimited) is unchanged.
--
-- This migration ONLY handles the data rename. The new vendor tier
-- definition lives in the client (TIER_DEFS in index.html). When a
-- subscriber upgrades from enthusiast → new-vendor, their
-- subscription_tier column gets set to 'vendor' fresh via the upgrade
-- checkout flow; this migration doesn't touch them automatically.
--
-- Existing 'vendor' subscribers get auto-migrated to 'enthusiast' so
-- they don't lose access mid-billing-cycle.
--
-- Idempotent — no-op if there are no 'vendor' rows left.
-- ============================================================

-- 1. Rename all existing 'vendor' subscriptions to 'enthusiast'.
--    Use a transaction so a failure mid-migration doesn't leave a
--    partial state.
BEGIN;

UPDATE public.profiles
SET    subscription_tier = 'enthusiast'
WHERE  subscription_tier = 'vendor';

-- 2. Verify count of newly-renamed rows. PRINT-style notice will
--    show up in the Supabase SQL output panel.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.profiles
  WHERE subscription_tier = 'enthusiast';
  RAISE NOTICE 'PathBinder tier rename: % profile(s) now on the enthusiast tier.', v_count;
END $$;

COMMIT;

-- ============================================================
-- Optional: if you also want to update the legacy is_vendor boolean
-- to be more semantically accurate going forward, run this. The
-- client treats is_vendor=true as "enthusiast or higher" already, so
-- it's safe to leave as-is — this is purely cosmetic data cleanup.
--
-- The boolean is read as a fallback only when subscription_tier is
-- NULL, so renaming has no functional effect for accounts that have
-- a subscription_tier set.
-- ============================================================

-- (No data cleanup needed unless desired — leaving for now.)

-- ============================================================
-- Verify:
--   SELECT subscription_tier, COUNT(*)
--   FROM public.profiles
--   WHERE subscription_tier IS NOT NULL
--   GROUP BY subscription_tier
--   ORDER BY COUNT(*) DESC;
--
-- Expected:
--   collector  | <count>
--   enthusiast | <count, includes auto-migrated old-vendor users>
--   shop       | <count>
--   vendor     | 0  (no one subscribed to NEW vendor tier yet)
--   free       | <count, optional>
-- ============================================================
