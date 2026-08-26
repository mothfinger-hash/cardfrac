-- ============================================================
-- PathBinder — Activation trial + generalized granted-tier expiry
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Idempotent (CREATE OR REPLACE / add column if not exists).
--
-- Ships two things:
--   1) claim_activation_trial() — a one-time "50 cards in your collection →
--      1 free month of Enthusiast" self-serve grant, gated SERVER-SIDE on the
--      real owned-card count (the client scan counter is localStorage-only and
--      not trustworthy). Uses the existing granted_tier machinery.
--   2) expire_granted_tiers() — a single daily sweep that reverts BOTH the
--      activation trial AND friend-invite (subsidiary_invite) grants back to
--      Free once they lapse. This supersedes expire_subsidiary_grants(): it
--      covers both sources AND adds the `stripe_subscription_id IS NULL` guard
--      the old one lacked (so a user who upgraded via Stripe mid-grant is never
--      downgraded). NOTE: nothing in production currently sweeps these grants,
--      so friend-invite grants have been effectively permanent — this + the
--      /api/expire-grants-cron wiring fixes that leak.
--
-- Depends on: tier_rank(text) and profiles.granted_tier_expires_at /
-- granted_tier_source from migration_subsidiary_invites.sql.
-- ============================================================

-- 1. One-time reclaim guard. WRITE-ONCE, never cleared by any sweep — the grant
-- fields (granted_tier_*) get NULLed on expiry, so they cannot double as the
-- "already used" record. This column is the authority on "trial consumed".
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS trial_claimed_at timestamptz;

-- 2. Claim the activation trial. Server-authoritative: re-checks the owned-card
-- count, the one-time guard, and that we're not downgrading a paid/higher user.
CREATE OR REPLACE FUNCTION public.claim_activation_trial()
RETURNS TABLE(success boolean, message text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_prof  public.profiles;
  v_cards int;
  v_exp   timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'Must be signed in', NULL::timestamptz; RETURN;
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE profiles.id = v_uid;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Profile not found', NULL::timestamptz; RETURN;
  END IF;

  -- One-time only (never re-grantable, even after the grant expires).
  IF v_prof.trial_claimed_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'You''ve already used your free month.', NULL::timestamptz; RETURN;
  END IF;

  -- Never touch a paying subscriber.
  IF v_prof.stripe_subscription_id IS NOT NULL THEN
    RETURN QUERY SELECT false, 'You already have a paid subscription.', NULL::timestamptz; RETURN;
  END IF;

  -- Only an upgrade — don't clobber an already-Enthusiast-or-higher tier
  -- (e.g. a friend-invite grant already in flight).
  IF tier_rank(coalesce(v_prof.subscription_tier, 'free')) >= tier_rank('enthusiast') THEN
    RETURN QUERY SELECT false, 'Your plan is already Enthusiast or higher.', NULL::timestamptz; RETURN;
  END IF;

  -- Server-verified eligibility: 50 owned (non-ghost, not sold-offline) cards.
  SELECT count(*) INTO v_cards FROM public.collection_items
    WHERE collection_items.user_id = v_uid
      AND coalesce(collection_items.is_ghost, false) = false
      AND coalesce(collection_items.sold_offline, false) = false;
  IF v_cards < 50 THEN
    RETURN QUERY SELECT false,
      ('Add ' || (50 - v_cards) || ' more card' || CASE WHEN (50 - v_cards) = 1 THEN '' ELSE 's' END
        || ' to unlock your free month.'),
      NULL::timestamptz;
    RETURN;
  END IF;

  v_exp := now() + interval '1 month';
  UPDATE public.profiles SET
    subscription_tier       = 'enthusiast',
    granted_tier_expires_at = v_exp,
    granted_tier_source     = 'activation_trial',
    trial_claimed_at        = now()
  WHERE profiles.id = v_uid;

  RETURN QUERY SELECT true, 'Enthusiast unlocked for 1 month — enjoy.', v_exp;
END $$;

GRANT EXECUTE ON FUNCTION public.claim_activation_trial() TO authenticated;

-- 3. Generalized expiry sweep — the ONLY thing that ends a temporary grant.
-- Reverts both activation trials and friend-invite grants to Free once lapsed.
-- The stripe_subscription_id guard is essential: a user who upgraded via Stripe
-- mid-grant keeps their paid tier. trial_claimed_at is deliberately NOT cleared
-- (it is the permanent "already used the trial" record).
CREATE OR REPLACE FUNCTION public.expire_granted_tiers()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.profiles SET
    subscription_tier       = 'free',
    granted_tier_expires_at = NULL,
    granted_tier_source     = NULL
  WHERE granted_tier_source IN ('subsidiary_invite', 'activation_trial')
    AND granted_tier_expires_at IS NOT NULL
    AND granted_tier_expires_at < now()
    AND stripe_subscription_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.expire_granted_tiers() TO service_role;

-- Verify:
--   SELECT proname FROM pg_proc WHERE proname IN ('claim_activation_trial','expire_granted_tiers');
--   -- Manual dry-run of the sweep (returns count downgraded):
--   SELECT public.expire_granted_tiers();
