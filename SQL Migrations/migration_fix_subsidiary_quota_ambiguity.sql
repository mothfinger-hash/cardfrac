-- migration_fix_subsidiary_quota_ambiguity.sql
--
-- THE fix for the "Invite Friends" menu never appearing.
--
-- beta_subsidiary_quota() and create_subsidiary_invite() both do:
--
--   SELECT invite_quota, granted_tier, duration_months
--     INTO v_quota, v_granted, v_dur
--     FROM public.subsidiary_invite_config(v_beta_tier);
--
-- But `granted_tier` and `duration_months` are ALSO the names of the
-- functions' own RETURNS TABLE output columns, so Postgres raises
-- "column reference is ambiguous" at runtime -> PostgREST returns 400.
-- This only fires for an actual beta tester (non-beta users return early),
-- which is why the menu silently stayed hidden and why it couldn't be
-- reproduced in the SQL editor (no auth.uid() there).
--
-- Fix: alias the config function (... AS c) and reference c.granted_tier /
-- c.duration_months / c.invite_quota so there is no collision.
--
-- This is the authoritative version of both functions (keeps the
-- highest-tier ordering from the dedupe migration). Idempotent.

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
  IF v_beta_tier IS NULL THEN
    RETURN QUERY SELECT 0, 0, NULL::text, 0;
    RETURN;
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
    RAISE EXCEPTION 'caller is not a beta tester';
  END IF;
  SELECT c.invite_quota, c.granted_tier, c.duration_months
    INTO v_quota, v_granted, v_dur
    FROM public.subsidiary_invite_config(v_beta_tier) AS c;
  IF v_quota = 0 OR v_granted IS NULL THEN
    RAISE EXCEPTION 'beta tier % does not include subsidiary invites', v_beta_tier;
  END IF;
  SELECT count(*)::int INTO v_used
    FROM public.subsidiary_invites
    WHERE inviter_id = v_uid AND revoked_at IS NULL;
  IF v_used >= v_quota THEN
    RAISE EXCEPTION 'quota exhausted: % of % used', v_used, v_quota;
  END IF;

  FOR i IN 1..20 LOOP
    v_code := substr(translate(encode(gen_random_bytes(12), 'base64'), '+/=', 'XXX'), 1, 12);
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
