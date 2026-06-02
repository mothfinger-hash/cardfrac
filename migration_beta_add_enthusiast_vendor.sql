-- ============================================================
-- PathBinder — Add Enthusiast + Vendor beta tiers
-- Run in: Supabase Dashboard → SQL Editor → New query
-- PASTE THE ENTIRE FILE AT ONCE.
--
-- What this does:
--   - Drops + recreates admin_invite_beta and claim_beta_code so
--     they accept two new tier values: 'enthusiast' (cap 20) and
--     'vendor' (cap 5).
--   - Existing 'founding', 'collector', and 'shop' invites keep
--     working exactly as they do today — same return shapes, same
--     row insertions, same profile updates. No beta_testers data is
--     touched.
--   - Return column names match the originals so the existing JS
--     RPC callers keep working without any client-side changes.
--   - Uses $func$ delimiter + `:=` scalar assignment + scalar
--     variables only (no composite row-type vars). This dodges the
--     "relation v_count / v_invite does not exist" parser errors
--     Supabase was throwing on the SELECT INTO form.
-- ============================================================


-- ── admin_invite_beta ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS admin_invite_beta(text);
DROP FUNCTION IF EXISTS admin_invite_beta(text, text);
DROP FUNCTION IF EXISTS admin_invite_beta(text, text, text);
DROP FUNCTION IF EXISTS admin_invite_beta(text, text, text, text);

CREATE FUNCTION admin_invite_beta(
  p_tier  text,
  p_email text DEFAULT NULL,
  p_code  text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS TABLE(id uuid, claimed boolean, claimed_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE
  v_id        uuid;
  v_count     int;
  v_user_id   uuid;
  v_exp       timestamptz;
  v_is_admin  boolean;
BEGIN
  v_is_admin := (SELECT p.is_admin FROM profiles p WHERE p.id = auth.uid());
  IF NOT coalesce(v_is_admin, false) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  IF p_tier NOT IN ('founding','enthusiast','vendor','collector','shop') THEN
    RAISE EXCEPTION 'Invalid tier %', p_tier;
  END IF;
  IF p_email IS NULL AND p_code IS NULL THEN
    RAISE EXCEPTION 'Must supply email or code';
  END IF;

  v_count := (SELECT count(*) FROM beta_testers b
              WHERE b.tier = p_tier AND b.revoked_at IS NULL);

  IF p_tier = 'founding'   AND v_count >= 10 THEN RAISE EXCEPTION 'Founding beta is full (10/10)';     END IF;
  IF p_tier = 'enthusiast' AND v_count >= 20 THEN RAISE EXCEPTION 'Enthusiast beta is full (20/20)';   END IF;
  IF p_tier = 'vendor'     AND v_count >= 5  THEN RAISE EXCEPTION 'Vendor beta is full (5/5)';         END IF;
  IF p_tier = 'collector'  AND v_count >= 50 THEN RAISE EXCEPTION 'Collector beta is full (50/50)';    END IF;
  IF p_tier = 'shop'       AND v_count >= 3  THEN RAISE EXCEPTION 'Shop beta is full (3/3)';           END IF;

  IF p_email IS NOT NULL THEN
    v_user_id := (SELECT p.id FROM profiles p
                  WHERE lower(p.email) = lower(p_email) LIMIT 1);
  END IF;

  v_exp := CASE WHEN p_tier = 'shop' AND v_user_id IS NOT NULL
                THEN now() + interval '1 year'
                ELSE NULL END;

  INSERT INTO beta_testers (tier, invited_email, invite_code, user_id, invited_by, claimed_at, expires_at, notes)
  VALUES (
    p_tier, p_email, p_code, v_user_id, auth.uid(),
    CASE WHEN v_user_id IS NOT NULL THEN now() ELSE NULL END,
    v_exp,
    p_notes
  )
  RETURNING beta_testers.id INTO v_id;

  IF v_user_id IS NOT NULL THEN
    UPDATE profiles SET
      subscription_tier = CASE
        WHEN p_tier = 'founding'   THEN 'enthusiast'
        WHEN p_tier = 'enthusiast' THEN 'enthusiast'
        WHEN p_tier = 'vendor'     THEN 'vendor'
        WHEN p_tier = 'shop'       THEN 'shop'
        ELSE 'collector' END,
      subscription_expires_at = coalesce(v_exp, subscription_expires_at)
    WHERE profiles.id = v_user_id;
  END IF;

  admin_invite_beta.id              := v_id;
  admin_invite_beta.claimed         := (v_user_id IS NOT NULL);
  admin_invite_beta.claimed_user_id := v_user_id;
  RETURN NEXT;
END;
$func$;

GRANT EXECUTE ON FUNCTION admin_invite_beta(text, text, text, text) TO authenticated;


-- ── claim_beta_code ────────────────────────────────────────────────
-- All variables are SCALARS so there's no row-type lookup the
-- parser can mistake for a relation reference.
DROP FUNCTION IF EXISTS claim_beta_code(text);

CREATE FUNCTION claim_beta_code(p_code text)
RETURNS TABLE(tier text, success boolean, message text)
LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE
  v_invite_id   uuid;
  v_invite_tier text;
  v_count       int;
  v_exp         timestamptz;
  v_msg         text;
  v_has_active  boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    claim_beta_code.tier    := NULL;
    claim_beta_code.success := false;
    claim_beta_code.message := 'Must be signed in';
    RETURN NEXT;
    RETURN;
  END IF;

  v_invite_id := (
    SELECT b.id FROM beta_testers b
    WHERE b.invite_code = p_code
      AND b.user_id IS NULL
      AND b.revoked_at IS NULL
    LIMIT 1
  );
  IF v_invite_id IS NULL THEN
    claim_beta_code.tier    := NULL;
    claim_beta_code.success := false;
    claim_beta_code.message := 'Invalid or already-claimed code';
    RETURN NEXT;
    RETURN;
  END IF;
  v_invite_tier := (SELECT b.tier FROM beta_testers b WHERE b.id = v_invite_id);

  v_has_active := EXISTS (
    SELECT 1 FROM beta_testers b
    WHERE b.user_id = auth.uid() AND b.revoked_at IS NULL
  );
  IF v_has_active THEN
    claim_beta_code.tier    := NULL;
    claim_beta_code.success := false;
    claim_beta_code.message := 'You already have an active beta slot';
    RETURN NEXT;
    RETURN;
  END IF;

  v_count := (
    SELECT count(*) FROM beta_testers b
    WHERE b.tier = v_invite_tier
      AND b.user_id IS NOT NULL
      AND b.revoked_at IS NULL
  );

  IF v_invite_tier = 'founding'   AND v_count >= 10 THEN
    claim_beta_code.tier := NULL; claim_beta_code.success := false; claim_beta_code.message := 'Founding beta is full';
    RETURN NEXT; RETURN;
  END IF;
  IF v_invite_tier = 'enthusiast' AND v_count >= 20 THEN
    claim_beta_code.tier := NULL; claim_beta_code.success := false; claim_beta_code.message := 'Enthusiast beta is full';
    RETURN NEXT; RETURN;
  END IF;
  IF v_invite_tier = 'vendor'     AND v_count >= 5  THEN
    claim_beta_code.tier := NULL; claim_beta_code.success := false; claim_beta_code.message := 'Vendor beta is full';
    RETURN NEXT; RETURN;
  END IF;
  IF v_invite_tier = 'collector'  AND v_count >= 50 THEN
    claim_beta_code.tier := NULL; claim_beta_code.success := false; claim_beta_code.message := 'Collector beta is full';
    RETURN NEXT; RETURN;
  END IF;
  IF v_invite_tier = 'shop'       AND v_count >= 3  THEN
    claim_beta_code.tier := NULL; claim_beta_code.success := false; claim_beta_code.message := 'Shop beta is full';
    RETURN NEXT; RETURN;
  END IF;

  v_exp := CASE WHEN v_invite_tier = 'shop' THEN now() + interval '1 year' ELSE NULL END;

  UPDATE beta_testers b
    SET user_id    = auth.uid(),
        claimed_at = now(),
        expires_at = v_exp
    WHERE b.id = v_invite_id;

  UPDATE profiles SET
    subscription_tier = CASE
      WHEN v_invite_tier = 'founding'   THEN 'enthusiast'
      WHEN v_invite_tier = 'enthusiast' THEN 'enthusiast'
      WHEN v_invite_tier = 'vendor'     THEN 'vendor'
      WHEN v_invite_tier = 'shop'       THEN 'shop'
      ELSE 'collector' END,
    subscription_expires_at = coalesce(v_exp, subscription_expires_at)
  WHERE profiles.id = auth.uid();

  v_msg := CASE WHEN v_invite_tier = 'shop'
    THEN 'Welcome — Shop tier active for 1 year. Renew before expiry to keep shop perks; otherwise you''ll drop to enthusiast.'
    ELSE 'Welcome to the beta' END;

  claim_beta_code.tier    := v_invite_tier;
  claim_beta_code.success := true;
  claim_beta_code.message := v_msg;
  RETURN NEXT;
END;
$func$;

GRANT EXECUTE ON FUNCTION claim_beta_code(text) TO authenticated;


-- ============================================================
-- Verify after running:
--   SELECT proname, pg_get_function_arguments(oid)
--   FROM pg_proc WHERE proname IN ('admin_invite_beta','claim_beta_code');
-- ============================================================
