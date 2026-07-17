-- ============================================================
-- PathBinder — a listing may not go live without a live Connect account
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- WHY THIS EXISTS
-- ---------------
-- A marketplace listing must not be purchasable unless the seller can
-- actually RECEIVE the money. Without a live Stripe Connect account
-- (charges_enabled), a buyer's payment would land in the platform
-- account with no compliant way out — that is custodial money
-- transmission, which CLAUDE.md's Stripe ToS section forbids
-- independent of any intent to "pay out manually later."
--
-- DEFENSE IN DEPTH — this is the third of three layers, and the only
-- one a determined client can't bypass:
--   1. Client gate  — saveMarketplaceListing() blocks the insert and
--                      routes the seller to onboarding. (UX, bypassable
--                      via the REST API or patched JS.)
--   2. Checkout 409 — /api/marketplace-checkout.js refuses to charge a
--                      buyer when the seller isn't Connect-ready. (This
--                      is the layer that actually guards the MONEY.)
--   3. THIS trigger — refuses the INSERT itself, so a bypassed client
--                      can't even create a dead, unbuyable listing.
--
-- Mirrors the shape of enforce_listing_cap (migration_listing_cap_rls.sql):
-- BEFORE INSERT, SECURITY DEFINER so it can read profiles regardless of
-- the caller's RLS, admins exempt.
--
-- FIRST-PARTY CARVE-OUT: admins are exempt. An admin/platform listing is
-- the platform selling its OWN inventory and keeping its OWN proceeds —
-- first-party, not money transmission — so platform-only is legitimate
-- there. Every non-admin seller must be charges_enabled.
--
-- Idempotent. Re-running drops and recreates the trigger + helper.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_listing_requires_connect()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin        BOOLEAN;
  v_charges_enabled BOOLEAN;
BEGIN
  SELECT COALESCE(is_admin, FALSE),
         COALESCE(stripe_connect_charges_enabled, FALSE)
  INTO v_is_admin, v_charges_enabled
  FROM public.profiles
  WHERE id = NEW.seller_id;

  -- Admin / platform listing is first-party — platform-only is legitimate.
  IF v_is_admin = TRUE THEN
    RETURN NEW;
  END IF;

  -- Every other seller must be able to receive the sale before it can list.
  IF v_charges_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'Finish Stripe payout setup before listing — your listings go live once your Connect account can receive payments.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_listing_requires_connect ON public.listings;
CREATE TRIGGER trg_enforce_listing_requires_connect
  BEFORE INSERT ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_listing_requires_connect();

-- ============================================================
-- Notes:
--
-- • Reads the MIRRORED capability flag profiles.stripe_connect_charges_enabled,
--   which /api/connect-status.js and the account.updated webhook keep in
--   sync with Stripe. It is NOT a live Stripe call — if the mirror lags, a
--   just-onboarded seller could be briefly blocked at insert; the client
--   refreshes status before saving, so in practice the flag is fresh. The
--   fail-closed direction is deliberate: better a brief false block than a
--   listing that can take a buyer's money with nowhere to send it.
--
-- • INSERT only, like enforce_listing_cap. A seller who lists while
--   charges_enabled and later has Stripe disable their account keeps their
--   existing rows — but the checkout 409 (layer 2) still refuses the money,
--   so no custodial hold can occur. If you later want live listings pulled
--   when a seller's capability lapses, do it from the account.updated webhook,
--   not here.
--
-- • Verify after running:
--     -- an admin seller can still insert (should succeed):
--     --   insert a test row with seller_id = <an admin profile id>
--     -- a non-Connect seller cannot (should raise check_violation):
--     --   insert a test row with seller_id = <a seller with
--     --   stripe_connect_charges_enabled = false>
-- ============================================================
