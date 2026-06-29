-- migration_beta_testers_dedupe_unique.sql
--
-- Hardens beta_testers against the duplicate-row bug that silently hid the
-- "Invite Friends" menu:
--
--   * beta_testers had no unique constraint on user_id, so a user could
--     accumulate multiple rows (e.g. collector + vendor).
--   * beta_subsidiary_quota() / create_subsidiary_invite() read the caller's
--     tier with `SELECT tier INTO ... LIMIT 1`, which picks a row
--     non-deterministically. If it landed on a tier with no invite quota
--     (vendor/shop), the menu stayed hidden even though another row qualified.
--
-- This migration:
--   1. Dedupes beta_testers — keeps ONE row per user (highest tier, preferring
--      non-revoked).
--   2. Adds unique(user_id) so duplicates can never recur.
--   3. Recreates both RPCs to ORDER BY a tier rank before LIMIT 1 (belt-and-
--      suspenders; with the unique constraint there is only one row anyway).
--
-- Tier privilege rank (best -> least): founding, shop, vendor, enthusiast,
-- collector. founding is ranked top because it is the special founding-member
-- status that grants subsidiary invites.
--
-- Idempotent: safe to run more than once.

BEGIN;

-- ── 1. Dedupe: keep the best row per user ────────────────────────────
WITH ranked AS (
  SELECT ctid,
         row_number() OVER (
           PARTITION BY user_id
           ORDER BY (revoked_at IS NULL) DESC,   -- prefer active over revoked
                    CASE tier
                      WHEN 'founding'   THEN 1
                      WHEN 'shop'       THEN 2
                      WHEN 'vendor'     THEN 3
                      WHEN 'enthusiast' THEN 4
                      WHEN 'collector'  THEN 5
                      ELSE 6
                    END ASC,
                    ctid ASC                       -- stable tiebreak
         ) AS rn
  FROM public.beta_testers
)
DELETE FROM public.beta_testers bt
USING ranked r
WHERE bt.ctid = r.ctid
  AND r.rn > 1;

-- ── 2. Enforce one beta row per user ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.beta_testers'::regclass
      AND contype  = 'u'
      AND conname  = 'beta_testers_user_id_key'
  ) THEN
    ALTER TABLE public.beta_testers
      ADD CONSTRAINT beta_testers_user_id_key UNIQUE (user_id);
  END IF;
END $$;

COMMIT;

-- ── 3. Recreate RPCs to pick the highest tier defensively ────────────
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
  SELECT invite_quota, granted_tier, duration_months
    INTO v_quota, v_granted, v_dur
    FROM public.subsidiary_invite_config(v_beta_tier);
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
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- skip I, O, 0, 1 for legibility
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
  SELECT invite_quota, granted_tier, duration_months
    INTO v_quota, v_granted, v_dur
    FROM public.subsidiary_invite_config(v_beta_tier);
  IF v_quota = 0 OR v_granted IS NULL THEN
    RAISE EXCEPTION 'beta tier % does not include subsidiary invites', v_beta_tier;
  END IF;
  SELECT count(*)::int INTO v_used
    FROM public.subsidiary_invites
    WHERE inviter_id = v_uid AND revoked_at IS NULL;
  IF v_used >= v_quota THEN
    RAISE EXCEPTION 'quota exhausted: % of % used', v_used, v_quota;
  END IF;

  -- Generate a unique 12-char dashed code. Retry on the (vanishingly
  -- rare) collision against the unique index.
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
