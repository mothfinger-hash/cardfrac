-- migration_fix_subsidiary_invite_gen_random_bytes.sql
-- ---------------------------------------------------------------------------
-- Fix: "function gen_random_bytes(integer) does not exist" when a beta tester
-- generates a subsidiary invite code.
--
-- Cause: public.create_subsidiary_invite() is SECURITY DEFINER with
-- SET search_path = public, but gen_random_bytes() is provided by pgcrypto,
-- which lives in the `extensions` schema on Supabase — so the unqualified
-- call can't be resolved. (gen_random_uuid() keeps working because it's core.)
--
-- Fix: replace the pgcrypto call with a CORE-only random source —
-- uuid_send(gen_random_uuid()) yields 16 random bytes, and encode()/translate()
-- are all in pg_catalog. No extension or search_path change needed, and the
-- generated code format is unchanged (12-char, dashed, upper-cased).
--
-- Paste this WHOLE file into the Supabase SQL editor and run it. Idempotent
-- (CREATE OR REPLACE); safe to re-run.
-- ---------------------------------------------------------------------------

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

  -- Generate a unique 12-char dashed code. Core-only random source
  -- (uuid_send(gen_random_uuid()) = 16 random bytes) so no pgcrypto /
  -- search_path dependency. Retry on the vanishingly rare collision.
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
