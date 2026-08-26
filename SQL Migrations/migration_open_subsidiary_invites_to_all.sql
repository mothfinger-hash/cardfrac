-- ============================================================
-- PathBinder — Open the friend-invite (subsidiary) loop to ALL users
-- Run in: Supabase Dashboard → SQL Editor → New query. Idempotent.
--
-- Until now, friend invites were gated to beta testers (the quota/create RPCs
-- keyed off the caller's beta_testers row; a non-beta user got quota 0 and the
-- "Invite Friends" button stayed hidden). This adds a 'default' config branch so
-- ANY signed-in user gets an allotment:
--
--   Inviter          | invites | friend gets            | duration
--   -----------------+---------+------------------------+---------
--   (non-beta) user  |    3    | Enthusiast trial       | 1 month (~30 days)
--   beta testers     |   (unchanged — see config v2)     |
--
-- Friend-only reward (the inviter gets nothing extra) — deliberately, so there's
-- no incentive to farm fake accounts. The friend's grant is a normal
-- granted_tier_source='subsidiary_invite' grant, so it is reverted to Free by
-- expire_granted_tiers() / the daily /api/expire-grants-cron once it lapses.
-- ============================================================

BEGIN;

-- 1. Allow the public/non-beta inviter marker in the inviter_tier CHECK.
-- (granted_tier CHECK already permits 'enthusiast' from config v2 — unchanged.)
ALTER TABLE public.subsidiary_invites
  DROP CONSTRAINT IF EXISTS subsidiary_invites_inviter_tier_check;
ALTER TABLE public.subsidiary_invites
  ADD CONSTRAINT subsidiary_invites_inviter_tier_check
  CHECK (inviter_tier IN ('founding','vendor','enthusiast','collector','shop','default'));

-- 2. Config: add the 'default' branch (non-beta users). Beta tiers unchanged.
CREATE OR REPLACE FUNCTION public.subsidiary_invite_config(p_beta_tier text)
RETURNS TABLE(invite_quota int, granted_tier text, duration_months int)
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    CASE p_beta_tier
      WHEN 'founding'   THEN 3
      WHEN 'vendor'     THEN 2
      WHEN 'enthusiast' THEN 1
      WHEN 'collector'  THEN 1
      WHEN 'shop'       THEN 1
      WHEN 'default'    THEN 3
      ELSE 0
    END AS invite_quota,
    CASE p_beta_tier
      WHEN 'founding'   THEN 'vendor'
      WHEN 'vendor'     THEN 'vendor'
      WHEN 'enthusiast' THEN 'enthusiast'
      WHEN 'collector'  THEN 'collector'
      WHEN 'shop'       THEN 'shop'
      WHEN 'default'    THEN 'enthusiast'
      ELSE NULL
    END AS granted_tier,
    CASE
      WHEN p_beta_tier IN ('founding','vendor','enthusiast','collector','shop') THEN 12
      WHEN p_beta_tier = 'default' THEN 1
      ELSE 0
    END AS duration_months;
$$;
GRANT EXECUTE ON FUNCTION public.subsidiary_invite_config(text) TO authenticated;

-- 3. Quota: non-beta callers fall back to the 'default' config instead of 0.
CREATE OR REPLACE FUNCTION public.beta_subsidiary_quota()
RETURNS TABLE(
  used int,
  remaining int,
  granted_tier text,
  duration_months int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_beta_tier text;
  v_used int;
  v_quota int;
  v_granted text;
  v_dur int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT 0, 0, NULL::text, 0;
    RETURN;
  END IF;
  SELECT tier INTO v_beta_tier
    FROM public.beta_testers
    WHERE user_id = v_uid AND revoked_at IS NULL
    ORDER BY CASE tier
               WHEN 'founding'   THEN 1
               WHEN 'shop'       THEN 2
               WHEN 'vendor'     THEN 3
               WHEN 'enthusiast' THEN 4
               WHEN 'collector'  THEN 5
               ELSE 6
             END
    LIMIT 1;
  -- Non-beta users get the public 'default' allotment instead of nothing.
  IF v_beta_tier IS NULL THEN
    v_beta_tier := 'default';
  END IF;
  SELECT c.invite_quota, c.granted_tier, c.duration_months
    INTO v_quota, v_granted, v_dur
    FROM public.subsidiary_invite_config(v_beta_tier) AS c;
  IF v_quota = 0 THEN
    RETURN QUERY SELECT 0, 0, NULL::text, 0;
    RETURN;
  END IF;
  SELECT count(*)::int INTO v_used
    FROM public.subsidiary_invites
    WHERE inviter_id = v_uid AND revoked_at IS NULL;
  RETURN QUERY SELECT v_used, greatest(v_quota - v_used, 0), v_granted, v_dur;
END;
$$;
GRANT EXECUTE ON FUNCTION public.beta_subsidiary_quota() TO authenticated;

-- 4. Create: same fallback. Non-beta invites store inviter_tier='default'.
-- (Core-only random code source — uuid_send(gen_random_uuid()) — no pgcrypto.)
CREATE OR REPLACE FUNCTION public.create_subsidiary_invite()
RETURNS TABLE(
  id uuid,
  code text,
  granted_tier text,
  duration_months int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_beta_tier text;
  v_quota int;
  v_granted text;
  v_dur int;
  v_used int;
  v_code text;
  v_id uuid;
  i int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  SELECT tier INTO v_beta_tier
    FROM public.beta_testers
    WHERE user_id = v_uid AND revoked_at IS NULL
    ORDER BY CASE tier
               WHEN 'founding'   THEN 1
               WHEN 'shop'       THEN 2
               WHEN 'vendor'     THEN 3
               WHEN 'enthusiast' THEN 4
               WHEN 'collector'  THEN 5
               ELSE 6
             END
    LIMIT 1;
  IF v_beta_tier IS NULL THEN
    v_beta_tier := 'default';
  END IF;
  SELECT c.invite_quota, c.granted_tier, c.duration_months
    INTO v_quota, v_granted, v_dur
    FROM public.subsidiary_invite_config(v_beta_tier) AS c;
  IF v_quota = 0 OR v_granted IS NULL THEN
    RAISE EXCEPTION 'tier % does not include invites', v_beta_tier;
  END IF;
  SELECT count(*)::int INTO v_used
    FROM public.subsidiary_invites
    WHERE inviter_id = v_uid AND revoked_at IS NULL;
  IF v_used >= v_quota THEN
    RAISE EXCEPTION 'quota exhausted: % of % used', v_used, v_quota;
  END IF;

  FOR i IN 1..20 LOOP
    v_code := substr(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/=', 'XXX'), 1, 12);
    IF v_code ~ '^[A-Za-z0-9]{12}$' THEN
      v_code := upper(substr(v_code,1,4) || '-' || substr(v_code,5,4) || '-' || substr(v_code,9,4));
      EXIT;
    END IF;
  END LOOP;

  INSERT INTO public.subsidiary_invites (code, inviter_id, inviter_tier, granted_tier, duration_months)
    VALUES (v_code, v_uid, v_beta_tier, v_granted, v_dur)
    RETURNING subsidiary_invites.id, subsidiary_invites.code,
              subsidiary_invites.granted_tier, subsidiary_invites.duration_months
    INTO v_id, v_code, v_granted, v_dur;

  RETURN QUERY SELECT v_id, v_code, v_granted, v_dur;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_subsidiary_invite() TO authenticated;

COMMIT;

-- Verify:
--   SELECT * FROM public.subsidiary_invite_config('default');  -- 3 / enthusiast / 1
