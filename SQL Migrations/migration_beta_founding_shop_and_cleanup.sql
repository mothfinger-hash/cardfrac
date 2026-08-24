-- ============================================================
-- PathBinder — Founding-Shop tier + beta cleanup
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Supersedes the grant/claim/sweep functions from
-- migration_beta_tier_remap.sql. Idempotent (CREATE OR REPLACE).
--
-- Changes:
--   1. Founding cap 10 → 25 (room for early-partner outreach).
--   2. NEW tier 'founding_shop' — a SINGLE permanent Shop-tier partner.
--      Cap 1. Grants subscription_tier='shop' with NO expiry, exactly
--      like 'founding' but at the top tier. This is the flagship-shop
--      slot; every other partner uses 'founding' (permanent Vendor).
--   3. Beta pricing/tier cleanup: 'collector' was removed from the app
--      in the 2026 restructure. It is NOT hard-removed here (legacy
--      rows may exist and the CHECK stays permissive), but every grant
--      path now ALIASES collector → enthusiast so no new grant lands a
--      user on the dead tier, and no path errors.
--   4. Permanence is enforced two ways for founding + founding_shop:
--      expires_at = NULL (the sweep skips NULL) AND an explicit
--      tier NOT IN (...) guard in downgrade_expired_beta().
--   5. Stale copy fixed: the shop claim message said "drop to
--      enthusiast"; the sweep actually drops expired betas to Free.
--
-- Current tier prices (for reference; grants store a tier string, not a
-- price): enthusiast $10/mo, vendor $29/mo, shop $99/mo. Collector removed.
-- ============================================================

-- 0. Widen the CHECK constraint to accept 'founding_shop'. Collector is
-- kept in the allowed set so any legacy rows remain valid.
ALTER TABLE public.beta_testers
  DROP CONSTRAINT IF EXISTS beta_testers_tier_check;
ALTER TABLE public.beta_testers
  DROP CONSTRAINT IF EXISTS beta_testers_tier_check_v2;
ALTER TABLE public.beta_testers
  DROP CONSTRAINT IF EXISTS beta_testers_tier_check_v3;
ALTER TABLE public.beta_testers
  ADD  CONSTRAINT beta_testers_tier_check_v3
       CHECK (tier IN ('founding','founding_shop','enthusiast','collector','vendor','shop'));

-- 1. Auto-claim trigger — runs when an invited email creates an account.
CREATE OR REPLACE FUNCTION public.claim_beta_on_profile_create()
RETURNS TRIGGER AS $$
DECLARE
  v_invite public.beta_testers;
  v_exp    TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_invite FROM public.beta_testers
    WHERE lower(invited_email) = lower(NEW.email)
      AND user_id IS NULL AND revoked_at IS NULL
    ORDER BY invited_at ASC
    LIMIT 1;
  IF FOUND THEN
    -- founding + founding_shop are permanent (NULL). Everything else is a
    -- 1-year window that later converts to Free via downgrade_expired_beta().
    v_exp := CASE
      WHEN v_invite.tier IN ('founding','founding_shop') THEN NULL
      ELSE now() + INTERVAL '1 year'
    END;
    UPDATE public.beta_testers
      SET user_id = NEW.id, claimed_at = now(), expires_at = v_exp
      WHERE beta_testers.id = v_invite.id;
    UPDATE public.profiles SET
      subscription_tier = CASE
        WHEN v_invite.tier = 'founding'      THEN 'vendor'     -- founders → permanent Vendor
        WHEN v_invite.tier = 'founding_shop' THEN 'shop'       -- flagship → permanent Shop
        WHEN v_invite.tier = 'enthusiast'    THEN 'enthusiast'
        WHEN v_invite.tier = 'collector'     THEN 'enthusiast' -- collector retired → enthusiast
        WHEN v_invite.tier = 'vendor'        THEN 'vendor'
        WHEN v_invite.tier = 'shop'          THEN 'shop'
        ELSE 'enthusiast' END,
      subscription_expires_at = CASE
        -- Permanent tiers explicitly clear any prior expiry; timed tiers
        -- set the 1-year window.
        WHEN v_invite.tier IN ('founding','founding_shop') THEN NULL
        ELSE v_exp
      END
    WHERE profiles.id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Admin invite RPC (admin-only; auth.uid() must be an admin, so this
-- cannot be called from the SQL editor — use the in-app admin panel, or
-- the direct-SQL grant at the bottom of this file for the flagship shop).
drop function if exists public.admin_invite_beta(text);
drop function if exists public.admin_invite_beta(text, text);
drop function if exists public.admin_invite_beta(text, text, text);
drop function if exists public.admin_invite_beta(text, text, text, text);

CREATE OR REPLACE FUNCTION public.admin_invite_beta(
  p_tier  TEXT,
  p_email TEXT DEFAULT NULL,
  p_code  TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
) RETURNS TABLE(id UUID, claimed BOOLEAN, claimed_user_id UUID) AS $$
DECLARE
  v_id      UUID;
  v_count   INT;
  v_user_id UUID;
  v_exp     TIMESTAMPTZ;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = TRUE) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  -- Caps:
  --   founding      25 → permanent Vendor (standard partner offer)
  --   founding_shop  1 → permanent Shop   (the single flagship partner)
  --   enthusiast    20 → Enthusiast (1yr → Free)
  --   collector     50 → aliased to Enthusiast (tier retired)
  --   vendor         5 → Vendor (1yr → Free)
  --   shop           3 → Shop   (1yr → Free)
  IF p_tier NOT IN ('founding','founding_shop','enthusiast','collector','vendor','shop') THEN
    RAISE EXCEPTION 'Invalid tier %', p_tier;
  END IF;
  IF p_email IS NULL AND p_code IS NULL THEN
    RAISE EXCEPTION 'Must supply email or code';
  END IF;
  SELECT count(*) INTO v_count FROM public.beta_testers
    WHERE beta_testers.tier = p_tier AND beta_testers.revoked_at IS NULL;
  IF p_tier = 'founding'      AND v_count >= 25 THEN RAISE EXCEPTION 'Founding beta is full (25/25)';      END IF;
  IF p_tier = 'founding_shop' AND v_count >= 1  THEN RAISE EXCEPTION 'Founding Shop is taken (1/1)';       END IF;
  IF p_tier = 'enthusiast'    AND v_count >= 20 THEN RAISE EXCEPTION 'Enthusiast beta is full (20/20)';    END IF;
  IF p_tier = 'collector'     AND v_count >= 50 THEN RAISE EXCEPTION 'Collector beta is full (50/50)';     END IF;
  IF p_tier = 'vendor'        AND v_count >= 5  THEN RAISE EXCEPTION 'Vendor beta is full (5/5)';          END IF;
  IF p_tier = 'shop'          AND v_count >= 3  THEN RAISE EXCEPTION 'Shop beta is full (3/3)';            END IF;
  IF p_email IS NOT NULL THEN
    SELECT profiles.id INTO v_user_id FROM public.profiles
      WHERE lower(profiles.email) = lower(p_email) LIMIT 1;
  END IF;
  v_exp := CASE
    WHEN p_tier IN ('founding','founding_shop') THEN NULL
    ELSE now() + INTERVAL '1 year'
  END;
  INSERT INTO public.beta_testers (tier, invited_email, invite_code, user_id, invited_by, claimed_at, expires_at, notes)
  VALUES (
    p_tier, p_email, p_code, v_user_id, auth.uid(),
    CASE WHEN v_user_id IS NOT NULL THEN now() ELSE NULL END,
    v_exp,
    p_notes
  ) RETURNING beta_testers.id INTO v_id;
  IF v_user_id IS NOT NULL THEN
    UPDATE public.profiles SET
      subscription_tier = CASE
        WHEN p_tier = 'founding'      THEN 'vendor'
        WHEN p_tier = 'founding_shop' THEN 'shop'
        WHEN p_tier = 'enthusiast'    THEN 'enthusiast'
        WHEN p_tier = 'collector'     THEN 'enthusiast'
        WHEN p_tier = 'vendor'        THEN 'vendor'
        WHEN p_tier = 'shop'          THEN 'shop'
        ELSE 'enthusiast' END,
      subscription_expires_at = CASE
        WHEN p_tier IN ('founding','founding_shop') THEN NULL
        ELSE v_exp
      END
    WHERE profiles.id = v_user_id;
  END IF;
  RETURN QUERY SELECT v_id, (v_user_id IS NOT NULL), v_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.admin_invite_beta(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 3. User-facing claim-by-code RPC.
drop function if exists public.claim_beta_code(text);

CREATE OR REPLACE FUNCTION public.claim_beta_code(p_code TEXT)
RETURNS TABLE(out_tier TEXT, success BOOLEAN, message TEXT) AS $$
DECLARE
  v_invite public.beta_testers;
  v_count  INT;
  v_exp    TIMESTAMPTZ;
  v_msg    TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN QUERY SELECT NULL::TEXT, FALSE, 'Must be signed in'; RETURN;
  END IF;
  SELECT * INTO v_invite FROM public.beta_testers
    WHERE beta_testers.invite_code = p_code
      AND beta_testers.user_id IS NULL
      AND beta_testers.revoked_at IS NULL LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::TEXT, FALSE, 'Invalid or already-claimed code'; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.beta_testers
               WHERE beta_testers.user_id = auth.uid() AND beta_testers.revoked_at IS NULL) THEN
    RETURN QUERY SELECT NULL::TEXT, FALSE, 'You already have an active beta slot'; RETURN;
  END IF;
  SELECT count(*) INTO v_count FROM public.beta_testers
    WHERE beta_testers.tier = v_invite.tier AND beta_testers.revoked_at IS NULL;
  IF v_invite.tier = 'founding'      AND v_count >= 25 THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Founding beta is full';  RETURN; END IF;
  IF v_invite.tier = 'founding_shop' AND v_count >= 1  THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Founding Shop is taken'; RETURN; END IF;
  IF v_invite.tier = 'enthusiast'    AND v_count >= 20 THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Enthusiast beta is full';RETURN; END IF;
  IF v_invite.tier = 'collector'     AND v_count >= 50 THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Collector beta is full'; RETURN; END IF;
  IF v_invite.tier = 'vendor'        AND v_count >= 5  THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Vendor beta is full';    RETURN; END IF;
  IF v_invite.tier = 'shop'          AND v_count >= 3  THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Shop beta is full';      RETURN; END IF;
  v_exp := CASE
    WHEN v_invite.tier IN ('founding','founding_shop') THEN NULL
    ELSE now() + INTERVAL '1 year'
  END;
  UPDATE public.beta_testers
    SET user_id    = auth.uid(),
        claimed_at = now(),
        expires_at = v_exp
    WHERE beta_testers.id = v_invite.id;
  UPDATE public.profiles SET
    subscription_tier = CASE
      WHEN v_invite.tier = 'founding'      THEN 'vendor'
      WHEN v_invite.tier = 'founding_shop' THEN 'shop'
      WHEN v_invite.tier = 'enthusiast'    THEN 'enthusiast'
      WHEN v_invite.tier = 'collector'     THEN 'enthusiast'
      WHEN v_invite.tier = 'vendor'        THEN 'vendor'
      WHEN v_invite.tier = 'shop'          THEN 'shop'
      ELSE 'enthusiast' END,
    subscription_expires_at = CASE
      WHEN v_invite.tier IN ('founding','founding_shop') THEN NULL
      ELSE v_exp
    END
  WHERE profiles.id = auth.uid();
  v_msg := CASE
    WHEN v_invite.tier IN ('founding','founding_shop')
      THEN 'Welcome, founding partner — your access is permanent.'
    WHEN v_invite.tier = 'shop'
      THEN 'Welcome — Shop tier is active for 1 year. Subscribe any time during the window to keep it; otherwise your account converts to Free (with 30 days notice, no auto-billing).'
    ELSE 'Welcome to the beta — 1 year at this tier, then it converts to Free unless you subscribe.'
  END;
  RETURN QUERY SELECT v_invite.tier, TRUE, v_msg;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.claim_beta_code(TEXT) TO authenticated;

-- 4. Expiry sweep — drops expired NON-permanent betas to Free and revokes
-- the row. founding + founding_shop are permanent and never touched (both
-- by the explicit tier guard AND by their NULL expires_at).
CREATE OR REPLACE FUNCTION public.downgrade_expired_beta()
RETURNS INT AS $$
DECLARE
  v_count INT := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE profiles.id = auth.uid()
       AND profiles.is_admin = TRUE
  ) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  WITH expired AS (
    SELECT bt.user_id
      FROM public.beta_testers bt
      JOIN public.profiles p ON p.id = bt.user_id
     WHERE bt.tier NOT IN ('founding','founding_shop')
       AND bt.expires_at IS NOT NULL
       AND bt.expires_at < now()
       AND bt.revoked_at IS NULL
       AND p.stripe_subscription_id IS NULL
       AND p.subscription_tier IN ('enthusiast','collector','vendor','shop')
  )
  UPDATE public.profiles p SET
    subscription_tier = 'free',
    subscription_expires_at = NULL
  FROM expired e
  WHERE p.id = e.user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.beta_testers SET revoked_at = now()
   WHERE beta_testers.tier NOT IN ('founding','founding_shop')
     AND beta_testers.expires_at IS NOT NULL
     AND beta_testers.expires_at < now()
     AND beta_testers.revoked_at IS NULL;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.downgrade_expired_beta() TO authenticated;

-- 5. Admin revoke — powers the per-row "Revoke" button. Drops the user to
-- Free (clearing any expiry) and frees the slot. This is ALSO how you switch
-- the flagship shop: revoke the current founding_shop holder, then invite the
-- new one (the cap-1 check counts only rows where revoked_at IS NULL).
-- (Previously this function only existed inside the stale "Print SQL"
-- generator; defining it here guarantees it's present and correct.)
CREATE OR REPLACE FUNCTION public.admin_revoke_beta(p_id UUID)
RETURNS VOID AS $$
DECLARE
  v_tester public.beta_testers;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = TRUE) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  SELECT * INTO v_tester FROM public.beta_testers WHERE beta_testers.id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such beta tester'; END IF;
  IF v_tester.user_id IS NOT NULL THEN
    UPDATE public.profiles
       SET subscription_tier = 'free', subscription_expires_at = NULL
     WHERE profiles.id = v_tester.user_id
       AND profiles.stripe_subscription_id IS NULL;  -- never clobber a paid plan
  END IF;
  UPDATE public.beta_testers SET revoked_at = now() WHERE beta_testers.id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.admin_revoke_beta(UUID) TO authenticated;

-- ============================================================
-- FLAGSHIP SHOP GRANT (run separately, AFTER the shop owner has created
-- their PathBinder account). admin_invite_beta can't run from the SQL
-- editor (its admin check needs auth.uid()), so grant directly here.
-- Permanent because expires_at = NULL is skipped by the sweep.
-- Replace OWNER_EMAIL_HERE with the shop owner's account email.
-- ------------------------------------------------------------
-- do $$
-- declare v_uid uuid;
-- begin
--   select id into v_uid from public.profiles
--    where lower(email) = lower('OWNER_EMAIL_HERE') limit 1;
--   if v_uid is null then
--     raise exception 'No account for % — have them sign up first', 'OWNER_EMAIL_HERE';
--   end if;
--   if exists (select 1 from public.beta_testers where tier = 'founding_shop' and revoked_at is null) then
--     raise exception 'Founding Shop slot is already taken';
--   end if;
--   insert into public.beta_testers
--     (tier, invited_email, invite_code, user_id, invited_by, claimed_at, expires_at, notes)
--   values ('founding_shop','OWNER_EMAIL_HERE','FLAGSHIP-SHOP', v_uid, v_uid, now(), NULL,
--           'Permanent flagship Shop partner.');
--   update public.profiles set subscription_tier='shop', subscription_expires_at=NULL
--    where id = v_uid;
-- end $$;
-- ============================================================

-- Verify:
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('claim_beta_on_profile_create','admin_invite_beta','claim_beta_code','downgrade_expired_beta');
--   -- The flagship, once granted:
--   SELECT user_id, tier, expires_at FROM public.beta_testers WHERE tier = 'founding_shop';
