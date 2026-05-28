-- ============================================================
-- PathBinder — Beta tier remap after vendor → enthusiast rename
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Updates beta-tier RPCs to support the post-rename five-tier system:
--   founding   → NEW vendor ($75/mo)   — founders get sealed + scanner access
--   enthusiast → enthusiast ($20/mo)   — canonical name post-rename, cap 20
--   collector  → collector ($5/mo)
--   vendor     → vendor ($75/mo)       — direct invite for vendor tier (cap 5)
--   shop       → shop ($200/mo, 1yr)   — same as before
--
-- Also:
--   • Widens the beta_testers.tier CHECK constraint to accept the new
--     'enthusiast' + 'vendor' tier names
--   • Qualifies all unqualified `id` column references inside the SECURITY
--     DEFINER functions (the old code threw "column reference 'id' is
--     ambiguous" because RETURNS TABLE creates an implicit `id` OUT param
--     that conflicts with profiles.id / beta_testers.id)
--   • Heals existing founding-beta users to subscription_tier='vendor'
--     (the new $75 tier) so the founders' privilege promise is honored
--     under the post-rename naming.
--
-- This migration:
--   1. Recreates claim_beta_on_profile_create() — auto-claim path
--   2. Recreates admin_invite_beta() — direct invite path
--   3. Recreates claim_beta_code() — code-redeem path
--   4. Recreates downgrade_expired_beta() — sweep for ALL non-founding
--      tiers whose 1-year window has elapsed; drops them to Free.
--      (Renamed from downgrade_expired_shop_beta; old signature dropped.)
--   5. Heals any current rows that ended up on the new vendor tier
--      via the over-granting code (defensive — should be empty
--      assuming migration_tier_rename_vendor_to_enthusiast.sql ran
--      before this one)
--
-- Idempotent — CREATE OR REPLACE everything. Safe to re-run.
-- ============================================================

-- 0. Widen the beta_testers.tier CHECK constraint to accept the
-- post-rename tier names. The original constraint was
--   check (tier in ('founding','collector','shop'))
-- which blocks INSERTs with the new 'enthusiast' or 'vendor' values.
-- Re-creating the constraint by name is idempotent — the DROP IF
-- EXISTS handles re-runs cleanly.
--
-- Note: Postgres auto-generates a name like 'beta_testers_tier_check'
-- when the constraint is declared inline with the table. We'll drop by
-- that conventional name and any older variants, then add a fresh one.
ALTER TABLE public.beta_testers
  DROP CONSTRAINT IF EXISTS beta_testers_tier_check;
ALTER TABLE public.beta_testers
  DROP CONSTRAINT IF EXISTS beta_testers_tier_check_v2;
ALTER TABLE public.beta_testers
  ADD  CONSTRAINT beta_testers_tier_check_v2
       CHECK (tier IN ('founding','enthusiast','collector','vendor','shop'));

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
    -- 1-year expiry for every non-founding tier. Founding is the only
    -- permanent grant (the original founders' promise); all other betas
    -- expire after a year and either drop to Free (enthusiast / collector
    -- / vendor) or step down one tier (shop → vendor) — see the
    -- downgrade_expired_beta() sweep function below for the conversion
    -- logic. The email template (api/_lib/beta-invite-template.js)
    -- communicates this expectation to invitees upfront so the timeline
    -- isn't a surprise.
    v_exp := CASE
      WHEN v_invite.tier = 'founding' THEN NULL
      ELSE now() + INTERVAL '1 year'
    END;
    UPDATE public.beta_testers
      SET user_id = NEW.id, claimed_at = now(), expires_at = v_exp
      WHERE beta_testers.id = v_invite.id;
    UPDATE public.profiles SET
      subscription_tier = CASE
        WHEN v_invite.tier = 'founding'   THEN 'vendor'      -- founders → new $75 Vendor tier (sealed + non-TCG + scanner)
        WHEN v_invite.tier = 'enthusiast' THEN 'enthusiast'
        WHEN v_invite.tier = 'collector'  THEN 'collector'
        WHEN v_invite.tier = 'vendor'     THEN 'vendor'
        WHEN v_invite.tier = 'shop'       THEN 'shop'
        ELSE 'collector' END,
      subscription_expires_at = COALESCE(v_exp, subscription_expires_at)
    WHERE profiles.id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1b. Heal founding-beta users to the new Vendor tier.
--
-- Tier hierarchy (low → high): free, collector ($5), enthusiast ($20),
-- vendor ($75), shop ($200, unlimited).
--
-- Founding members got the OLD "vendor" tier on sign-up (which carried
-- the bulk-import / archive / multi-binder features at the time). After
-- the rename, the OLD vendor became "enthusiast" at $20/mo. PathBinder
-- now uses "vendor" as the name for a NEW $75/mo tier that adds sealed
-- + non-TCG product listings + product scanner.
--
-- Founders get the NEW vendor tier going forward — meaningfully more
-- valuable than enthusiast (sealed access alone) without escalating
-- them all the way to unlimited Shop.
--
-- Two heal paths covered here:
--   1. Founders who were caught by the old rename migration sit on
--      'enthusiast' today — bump them up to 'vendor'.
--   2. Founders who slipped past the rename are already on 'vendor';
--      they stay where they are (which is now correct).
-- Either way, every active founding-beta user ends on subscription_tier='vendor'.
UPDATE public.profiles p
   SET subscription_tier = 'vendor'
  FROM public.beta_testers b
 WHERE b.user_id = p.id
   AND b.tier = 'founding'
   AND b.revoked_at IS NULL
   AND p.subscription_tier IN ('enthusiast', 'vendor', 'collector', 'free')
   AND p.stripe_subscription_id IS NULL;

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
  -- IMPORTANT: every unqualified column reference to `id` inside this
  -- function MUST be table-qualified (profiles.id, beta_testers.id),
  -- because the RETURNS TABLE(id UUID, ...) declaration above creates
  -- an implicit OUT parameter also named `id`. Without qualification,
  -- PostgreSQL can't tell whether `id` refers to the table column or
  -- the return-table variable and throws "column reference 'id' is
  -- ambiguous" — which is what surfaces to the admin UI as "ref id is
  -- ambiguous" when trying to send a beta code.
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = TRUE) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  -- Five tiers can be invited. Caps:
  --   founding   10  → grants Vendor (new $75 tier; founders honored
  --                    with the most-feature-rich non-Shop tier)
  --   enthusiast 20  → grants Enthusiast (post-rename canonical name;
  --                    use this for new bulk seeding)
  --   collector  50  → grants Collector
  --   vendor      5  → grants Vendor (direct invite path, separate from
  --                    founding so the founder bucket stays distinct)
  --   shop        3  → grants Shop (1-year expiry; intentionally small
  --                    since Shop = unlimited $200/mo top tier)
  IF p_tier NOT IN ('founding','enthusiast','collector','vendor','shop') THEN
    RAISE EXCEPTION 'Invalid tier %', p_tier;
  END IF;
  IF p_email IS NULL AND p_code IS NULL THEN
    RAISE EXCEPTION 'Must supply email or code';
  END IF;
  SELECT count(*) INTO v_count FROM public.beta_testers
    WHERE beta_testers.tier = p_tier AND beta_testers.revoked_at IS NULL;
  IF p_tier = 'founding'   AND v_count >= 10 THEN RAISE EXCEPTION 'Founding beta is full (10/10)';     END IF;
  IF p_tier = 'enthusiast' AND v_count >= 20 THEN RAISE EXCEPTION 'Enthusiast beta is full (20/20)';   END IF;
  IF p_tier = 'collector'  AND v_count >= 50 THEN RAISE EXCEPTION 'Collector beta is full (50/50)';   END IF;
  IF p_tier = 'vendor'     AND v_count >= 5  THEN RAISE EXCEPTION 'Vendor beta is full (5/5)';        END IF;
  IF p_tier = 'shop'       AND v_count >= 3  THEN RAISE EXCEPTION 'Shop beta is full (3/3)';          END IF;
  IF p_email IS NOT NULL THEN
    SELECT profiles.id INTO v_user_id FROM public.profiles
      WHERE lower(profiles.email) = lower(p_email) LIMIT 1;
  END IF;
  -- All non-founding tiers get a 1-year expiry. Founding is permanent.
  -- v_user_id check on shop is no longer relevant since we now apply the
  -- 1-year window even to email-only invites that haven't claimed yet —
  -- once they sign up, claim_beta_on_profile_create reads expires_at.
  v_exp := CASE
    WHEN p_tier = 'founding' THEN NULL
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
      -- Beta tier → subscription tier mapping.
      -- founding grants the new $75/mo Vendor tier (sealed + non-TCG
      -- products + product scanner) — a meaningful step up from
      -- Enthusiast without escalating to unlimited Shop.
      subscription_tier = CASE
        WHEN p_tier = 'founding'   THEN 'vendor'
        WHEN p_tier = 'enthusiast' THEN 'enthusiast'
        WHEN p_tier = 'collector'  THEN 'collector'
        WHEN p_tier = 'vendor'     THEN 'vendor'
        WHEN p_tier = 'shop'       THEN 'shop'
        ELSE 'collector' END,
      subscription_expires_at = COALESCE(v_exp, subscription_expires_at)
    WHERE profiles.id = v_user_id;
  END IF;
  RETURN QUERY SELECT v_id, (v_user_id IS NOT NULL), v_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.admin_invite_beta(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 3. User-facing claim-by-code RPC — supports the five beta tiers and
-- maps each to the corresponding subscription tier on claim.
-- Drop prior signatures (same overloading rationale as admin_invite_beta).
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
  IF v_invite.tier = 'founding'   AND v_count >= 10 THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Founding beta is full';   RETURN; END IF;
  IF v_invite.tier = 'enthusiast' AND v_count >= 20 THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Enthusiast beta is full'; RETURN; END IF;
  IF v_invite.tier = 'collector'  AND v_count >= 50 THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Collector beta is full';  RETURN; END IF;
  IF v_invite.tier = 'vendor'     AND v_count >= 5  THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Vendor beta is full';     RETURN; END IF;
  IF v_invite.tier = 'shop'       AND v_count >= 3  THEN RETURN QUERY SELECT NULL::TEXT, FALSE, 'Shop beta is full';       RETURN; END IF;
  v_exp := CASE
    WHEN v_invite.tier = 'founding' THEN NULL
    ELSE now() + INTERVAL '1 year'
  END;
  UPDATE public.beta_testers
    SET user_id    = auth.uid(),
        claimed_at = now(),
        expires_at = v_exp
    WHERE beta_testers.id = v_invite.id;
  UPDATE public.profiles SET
    subscription_tier = CASE
      WHEN v_invite.tier = 'founding'   THEN 'vendor'      -- founders → new $75 Vendor tier
      WHEN v_invite.tier = 'enthusiast' THEN 'enthusiast'
      WHEN v_invite.tier = 'collector'  THEN 'collector'
      WHEN v_invite.tier = 'vendor'     THEN 'vendor'
      WHEN v_invite.tier = 'shop'       THEN 'shop'
      ELSE 'collector' END,
    subscription_expires_at = COALESCE(v_exp, subscription_expires_at)
  WHERE profiles.id = auth.uid();
  v_msg := CASE WHEN v_invite.tier = 'shop'
    THEN 'Welcome — Shop tier active for 1 year. Renew before expiry to keep shop perks; otherwise you''ll drop to enthusiast.'
    ELSE 'Welcome to the beta' END;
  RETURN QUERY SELECT v_invite.tier, TRUE, v_msg;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.claim_beta_code(TEXT) TO authenticated;

-- 4. Shop expiry sweep — drops expired shop betas to enthusiast.
-- Beta expiry sweep. Runs over EVERY non-founding tier whose expires_at
-- has elapsed, drops the user's profile to subscription_tier='free',
-- and revokes the beta row so they can't re-claim. Founding-beta users
-- are never touched (their grants are permanent by design).
--
-- Skips users who:
--   • Already have a Stripe subscription (they upgraded during the
--     beta window — don't clobber a paid plan)
--   • Have already been moved off the beta tier (e.g. cancelled,
--     downgraded manually, or revoked already)
--
-- Run nightly via cron / scheduled task / admin button.
-- Returns the number of profiles actually downgraded.
--
-- Drop the old shop-only signature too so re-runs don't leave it lying
-- around alongside the new generic one.
DROP FUNCTION IF EXISTS public.downgrade_expired_shop_beta();

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
     WHERE bt.tier <> 'founding'
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
   WHERE beta_testers.tier <> 'founding'
     AND beta_testers.expires_at IS NOT NULL
     AND beta_testers.expires_at < now()
     AND beta_testers.revoked_at IS NULL;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.downgrade_expired_beta() TO authenticated;

-- (Removed: an older "founding-beta vendor → enthusiast" heal block
-- lived here. That block was the OPPOSITE of current policy — founders
-- now correctly land on the new Vendor tier. The heal step that moves
-- founders TO vendor lives at the top of this file (section 1b).)

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
--                     'claim_beta_code','downgrade_expired_beta');
-- ============================================================
