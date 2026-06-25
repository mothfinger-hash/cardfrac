-- migration_subsidiary_invite_config_v2.sql
--
-- Updates the subsidiary-invite rules to match the intended design:
--
--   Beta tier   | invites | invite grants | duration
--   ------------+---------+---------------+---------
--   founding    |    3    | vendor        | 12 months
--   vendor      |    2    | vendor        | 12 months
--   enthusiast  |    1    | enthusiast    | 12 months
--   collector   |    1    | collector     | 12 months
--   shop        |    1    | shop          | 12 months
--
-- ASSUMPTION (easy to change): each invite grants the inviter's OWN tier.
-- This matches the original pattern (founding/enthusiast/collector all
-- granted their own tier). If a friend should get something LOWER than the
-- inviter's tier, edit the granted_tier CASE below.
--
-- Also widens two CHECK constraints so vendor + shop can be recorded as
-- inviters, and so 'shop' is a valid granted tier.
--
-- Idempotent.

BEGIN;

-- ── Widen constraints: vendor + shop may now invite; shop may be granted ──
ALTER TABLE public.subsidiary_invites
  DROP CONSTRAINT IF EXISTS subsidiary_invites_inviter_tier_check;
ALTER TABLE public.subsidiary_invites
  ADD CONSTRAINT subsidiary_invites_inviter_tier_check
  CHECK (inviter_tier IN ('founding','vendor','enthusiast','collector','shop'));

ALTER TABLE public.subsidiary_invites
  DROP CONSTRAINT IF EXISTS subsidiary_invites_granted_tier_check;
ALTER TABLE public.subsidiary_invites
  ADD CONSTRAINT subsidiary_invites_granted_tier_check
  CHECK (granted_tier IN ('vendor','enthusiast','collector','shop'));

-- ── New config: counts, granted tier, 12-month duration for all ──────────
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
      ELSE 0
    END AS invite_quota,
    CASE p_beta_tier
      WHEN 'founding'   THEN 'vendor'
      WHEN 'vendor'     THEN 'vendor'
      WHEN 'enthusiast' THEN 'enthusiast'
      WHEN 'collector'  THEN 'collector'
      WHEN 'shop'       THEN 'shop'
      ELSE NULL
    END AS granted_tier,
    CASE
      WHEN p_beta_tier IN ('founding','vendor','enthusiast','collector','shop') THEN 12
      ELSE 0
    END AS duration_months;
$$;
GRANT EXECUTE ON FUNCTION public.subsidiary_invite_config(text) TO authenticated;

COMMIT;
