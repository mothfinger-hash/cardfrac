-- ============================================================
-- DIAGNOSTIC: try creating ONLY the two helper functions.
-- This file has no table dependencies, no RLS policies, no
-- anything else that could fail before reaching the functions.
-- If THIS runs cleanly and the SELECTs below return values,
-- the issue was earlier in the main migration. If THIS fails
-- with a specific error, we know exactly which line of the
-- function definition is the problem.
-- ============================================================

-- ── Eligibility check ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.user_can_contribute_image(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_account_age_days INT;
  v_tier             TEXT;
  v_card_count       INT;
  v_strikes          INT;
  v_is_admin         BOOLEAN;
BEGIN
  SELECT COALESCE(is_admin, false) INTO v_is_admin
    FROM public.profiles WHERE id = p_user_id;
  IF v_is_admin THEN RETURN true; END IF;

  SELECT EXTRACT(DAY FROM (now() - created_at))::INT
    INTO v_account_age_days
    FROM public.profiles
    WHERE id = p_user_id;
  IF v_account_age_days IS NULL OR v_account_age_days < 30 THEN
    RETURN false;
  END IF;

  SELECT COALESCE(subscription_tier, 'free') INTO v_tier
    FROM public.profiles WHERE id = p_user_id;
  IF v_tier NOT IN ('collector','enthusiast','vendor','shop') THEN
    RETURN false;
  END IF;

  SELECT COUNT(*) INTO v_card_count
    FROM public.collection_items
    WHERE user_id = p_user_id
      AND COALESCE(is_ghost, false) = false
      AND COALESCE(sold_offline, false) = false;
  IF v_card_count < 50 THEN RETURN false; END IF;

  -- Strikes check skipped here — we don't know if the table exists yet.
  -- Real version reads catalog_image_contributions; this diagnostic
  -- skips it so the function compiles without the table dependency.

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.user_can_contribute_image TO anon, authenticated;

-- ── Trust tier (also strike-free for diagnostic purposes) ──
CREATE OR REPLACE FUNCTION public.user_contribution_trust_tier(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
  -- Without the contributions table, every user is "first_time".
  -- This is just a sanity test that the function definition itself
  -- compiles and is callable.
  RETURN 'first_time';
END;
$$;

GRANT EXECUTE ON FUNCTION public.user_contribution_trust_tier TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Smoke tests ────────────────────────────────────────────
SELECT public.user_can_contribute_image(auth.uid());
SELECT public.user_contribution_trust_tier(auth.uid());

-- Should both return values without "function does not exist".
-- If they do — the main migration's function definitions are fine
-- and the issue is something else (likely an error in an earlier
-- statement that stopped the SQL editor before reaching the function
-- definitions). Paste the full output of the main migration run
-- and we'll find the silent failure.
-- ============================================================
