-- ============================================================
-- PathBinder — Beta tier remap after vendor → enthusiast rename
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- The vendor → enthusiast rename (migration_tier_rename_vendor_to_enthusiast.sql)
-- handled existing PAID subscribers but the beta system's deployed RPC
-- functions still map:
--   • founding beta  → 'vendor'   (now the NEW $75/mo tier — over-grant!)
--   • shop-beta expiry downgrades → 'vendor'   (same issue)
--
-- After the rename, the "spiritual successor" to the OLD vendor tier
-- is enthusiast (same feature set, $20/mo, 40-listing cap). Founding
-- beta users were promised the old vendor's feature set, so they
-- should map to enthusiast — not the new $75 vendor tier which now
-- unlocks sealed + non-TCG products + product scanner.
--
-- This migration:
--   1. Recreates claim_beta_on_profile_create() — auto-claim path
--   2. Recreates admin_invite_beta() — direct invite path
--   3. Recreates claim_beta_code() — code-redeem path
--   4. Recreates downgrade_expired_shop_beta() — shop expiry sweep
--   5. Heals any current rows that ended up on the new vendor tier
--      via the over-granting code (defensive — should be empty
--      assuming migration_tier_rename_vendor_to_enthusiast.sql ran
--      before this one)
--
-- Idempotent — CREATE OR REPLACE everything. Safe to re-run.
-- ============================================================

-- 1. Auto-claim trigger function — maps founding → enthusiast.
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
    v_exp := CASE WHEN v_invite.tier = 'shop' THEN now() + INTERVAL '1 year' ELSE NULL END;
    UPDATE public.beta_testers
      SET user_id = NEW.id, claimed_at = now(), expires_at = v_exp
      WHERE id = v_invite.id;
    UPDATE public.profiles SET
      subscription_tier = CASE
        WHEN v_invite.tier = 'founding'  THEN 'enthusiast'
        WHEN v_invite.tier = 'shop'      THEN 'shop'
        ELSE 'collector' END,
      subscription_expires_at = COALESCE(v_exp, subscription_expires_at)
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Admin invite RPC — maps founding → enthusiast.
--
-- Drop any prior signatures of admin_invite_beta before recreating.
-- PostgreSQL allows multiple functions with the same name but different
-- argument lists to coexist (overloading), and CREATE OR REPLACE only
-- swaps the function with the EXACT matching signature. An earlier
-- deploy likely registered a 3-arg version (pre-p_notes); without
-- these explicit drops both versions live in the DB and PostgREST
-- throws PGRST203 ("Could not choose the best candidate function") on
-- every call — surfaced to the admin as "ref id is ambiguous" when
-- sending a beta code.
--
-- We drop every plausible historical signature. IF EXISTS makes each
-- line a no-op when that overload isn't present.
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
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  IF p_tier NOT IN ('founding','collector','shop') THEN
    RAISE EXCEPTION 'Invalid tier %', p_tier;
  END IF;
  IF p_email IS NULL AND p_code IS NULL THEN
    RAISE EXCEPTION 'Must supply email or code';
  END IF;
  SELECT count(*) INTO v_count FROM public.beta_testers
    WHERE tier = p_tier AND revoked_at IS NULL;
  IF p_tier = 'founding'  AND v_count >= 10 THEN RAISE EXCEPTION 'Founding beta is full (10/10)';   END IF;
  IF p_tier = 'collector' AND v_count >= 50 THEN RAISE EXCEPTION 'Collector beta is full (50/50)'; END IF;
  IF p_tier = 'shop'      AND v_count >= 10 THEN RAISE EXCEPTION 'Shop beta is full (10/10)';      END IF;
  IF p_email IS NOT NULL THEN
    SELECT id INTO v_user_id FROM public.profiles WHERE lower(email) = lower(p_email) LIMIT 1;
  END IF;
  v_exp := CASE WHEN p_tier = 'shop' AND v_user_id IS NOT NULL THEN now() + INTERVAL '1 year' ELSE NULL END;
  INSERT INTO public.beta_testers (tier, invited_email, invite_code, user_id, invited_by, claimed_at, expires_at, notes)
  VALUES (
    p_tier, p_email, p_code, v_user_id, auth.uid(),
    CASE WHEN v_user_id IS NOT NULL THEN now() ELSE NULL END,
    v_exp,
    p_notes
  ) RETURNING beta_testers.id INTO v_id;
  IF v_user_id IS NOT NULL THEN
    UPDATE public.profiles SET
      -- founding → enthusiast (was 'vendor' pre-rename).
      subscription_tier = CASE
        WHEN p_tier = 'founding'  THEN 'enthusiast'
        WHEN p_tier = 'shop'      THEN 'shop'
        ELSE 'collector' END,
      subscription_expires_at = COALESCE(v_exp, subscription_expires_at)
    WHERE id = v_user_id;
  END IF;
  RETURN QUERY SELECT v_id, (v_user_id IS NOT NULL), v_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.admin_invite_beta(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 3. User-facing claim-by-code RPC — maps founding → enthusiast.
CREATE OR REPLACE FUNCTION public.claim_beta_code(p_code TEXT)
RETURNS TABLE(tier TEXT, success BOOLEAN, message TEXT) AS $$
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
    WHERE invite_code = p_code AND user_id IS NULL AND revoked_at IS NULL LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::TEXT, FALSE, 'Invalid or already-claimed code'; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.beta_testers WHERE user_id = auth.uid() AND revoked_at IS NULL) THEN
    RETURN QUERY SELECT NULL::TEXT, FALSE, 'You already have an active beta slot'; RETURN;
  END IF;
  SELECT count(*) INTO v_count FROM public.beta_testers WHERE tier = v_invite.tier AND revoked_at IS NULL;
  IF v_invite.tier = 'founding'  AND v_count >= 10 THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Founding beta is full';  RETURN; END IF;
  IF v_invite.tier = 'collector' AND v_count >= 50 THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Collector beta is full'; RETURN; END IF;
  IF v_invite.tier = 'shop'      AND v_count >= 10 THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Shop beta is full';      RETURN; END IF;
  v_exp := CASE WHEN v_invite.tier = 'shop' THEN now() + INTERVAL '1 year' ELSE NULL END;
  UPDATE public.beta_testers
    SET user_id = auth.uid(), claimed_at = now(), expires_at = v_exp
    WHERE id = v_invite.id;
  UPDATE public.profiles SET
    -- founding → enthusiast (post-rename mapping).
    subscription_tier = CASE
      WHEN v_invite.tier = 'founding'  THEN 'enthusiast'
      WHEN v_invite.tier = 'shop'      THEN 'shop'
      ELSE 'collector' END,
    subscription_expires_at = COALESCE(v_exp, subscription_expires_at)
  WHERE id = auth.uid();
  v_msg := CASE WHEN v_invite.tier = 'shop'
    THEN 'Welcome — Shop tier active for 1 year. Renew before expiry to keep shop perks; otherwise you''ll drop to enthusiast.'
    ELSE 'Welcome to the beta' END;
  RETURN QUERY SELECT v_invite.tier, TRUE, v_msg;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.claim_beta_code(TEXT) TO authenticated;

-- 4. Shop expiry sweep — drops expired shop betas to enthusiast.
CREATE OR REPLACE FUNCTION public.downgrade_expired_shop_beta()
RETURNS INT AS $$
DECLARE
  v_count INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  WITH expired AS (
    SELECT bt.user_id FROM public.beta_testers bt
    JOIN public.profiles p ON p.id = bt.user_id
    WHERE bt.tier = 'shop'
      AND bt.expires_at IS NOT NULL
      AND bt.expires_at < now()
      AND bt.revoked_at IS NULL
      AND p.subscription_tier = 'shop'
  )
  UPDATE public.profiles p SET
    subscription_tier = 'enthusiast',  -- was 'vendor' pre-rename
    subscription_expires_at = NULL
  FROM expired e WHERE p.id = e.user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.beta_testers SET revoked_at = now()
  WHERE tier = 'shop'
    AND expires_at IS NOT NULL
    AND expires_at < now()
    AND revoked_at IS NULL;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.downgrade_expired_shop_beta() TO authenticated;

-- ============================================================
-- 5. Heal any rows accidentally on the new vendor tier from beta
--    over-granting. If migration_tier_rename_vendor_to_enthusiast.sql
--    already ran, this should affect 0 rows — anyone on 'vendor' at
--    that point got renamed to 'enthusiast'.
--
--    Skip this block if you want to leave currently-on-vendor users
--    where they are (e.g. if anyone has paid for the new $75 vendor
--    tier already and you don't want to clobber that).
-- ============================================================
DO $$
DECLARE
  v_affected INT;
BEGIN
  -- Only fix rows that look like beta-granted vendor (not paid).
  -- A founding beta tester whose subscription_expires_at is NULL and
  -- whose tier currently reads 'vendor' is over-granted.
  UPDATE public.profiles p
  SET    subscription_tier = 'enthusiast'
  WHERE  p.subscription_tier = 'vendor'
    AND  EXISTS (
      SELECT 1 FROM public.beta_testers bt
      WHERE bt.user_id = p.id
        AND bt.tier = 'founding'
        AND bt.revoked_at IS NULL
    )
    AND  p.subscription_expires_at IS NULL;  -- skip if paid-renewal exp is set
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RAISE NOTICE 'Beta over-grant heal: % founding-beta user(s) moved from vendor → enthusiast.', v_affected;
END $$;

-- ============================================================
-- Verify:
--   -- Expected: 0 founding-beta users on the new vendor tier after this runs
--   SELECT count(*)
--   FROM public.profiles p
--   JOIN public.beta_testers bt ON bt.user_id = p.id
--   WHERE bt.tier = 'founding'
--     AND bt.revoked_at IS NULL
--     AND p.subscription_tier = 'vendor';
--
--   -- Should return the four updated functions
--   SELECT proname FROM pg_proc
--   WHERE proname IN ('claim_beta_on_profile_create','admin_invite_beta',
--                     'claim_beta_code','downgrade_expired_shop_beta');
-- ============================================================
