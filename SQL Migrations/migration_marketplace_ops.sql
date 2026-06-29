-- ============================================================
-- PathBinder — Marketplace ops additions
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Bundles three small additive schema changes that power upcoming
-- marketplace features. Each is independent — if one fails the
-- others still apply. Idempotent.
--
--   1. profiles.vacation_mode_until    (Shop tier "pause my shop")
--   2. profiles.subscription_grace_until (failed-renewal grace period)
--   3. blocked_users                    (block another user)
-- ============================================================


-- ── 0. Profile bio, socials, banner (vendor+ display) ────────────
-- New columns supersede the legacy shop_* set but coexist with them.
-- The seller profile modal reads both and prefers the new fields.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bio          text,
  ADD COLUMN IF NOT EXISTS social_links jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS banner_url   text,
  ADD COLUMN IF NOT EXISTS seller_rating numeric(3,2) DEFAULT 0;


-- ── 1. Shop vacation mode ─────────────────────────────────────────
-- When set to a future timestamp, the seller's listings are hidden
-- from browse and checkout is blocked server-side. Auto-clears the
-- next time a query reads it past the timestamp (no cron needed —
-- callers just check `vacation_mode_until > now()`).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS vacation_mode_until timestamptz;

COMMENT ON COLUMN public.profiles.vacation_mode_until IS
  'When > now(), seller listings are hidden + checkout blocked. NULL means active. Max 14 days enforced client-side.';


-- ── 2. Subscription grace period ──────────────────────────────────
-- When Stripe reports invoice.payment_failed for a recurring sub,
-- the webhook stamps this 3 days out. Tier-gated features keep
-- working until this passes; after that, the user falls back to free.
-- Pushes them toward updating their payment method or talking to us
-- on Discord without an immediate hard-down.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS subscription_grace_until timestamptz;

COMMENT ON COLUMN public.profiles.subscription_grace_until IS
  'When > now(), the user keeps their paid-tier features despite a failed renewal. Set by stripe-webhook on invoice.payment_failed; cleared on next successful charge.';


-- ── 3. Block users ────────────────────────────────────────────────
-- Mutual block table. blocker_id has blocked blocked_id. Single row
-- per direction (A blocking B does NOT auto-block B from A — they're
-- separate relationships). UI surfaces blocks both ways when filtering.
CREATE TABLE IF NOT EXISTS public.blocked_users (
  blocker_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

COMMENT ON TABLE public.blocked_users IS
  'Per-direction user blocks. Prevents messages, follows, and listing visibility.';

CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker ON public.blocked_users (blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked ON public.blocked_users (blocked_id);

ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;

-- A user can read + write their own block rows; they can't see who
-- else has blocked them (one-way visibility, same as Twitter/IG).
DROP POLICY IF EXISTS "Users manage their own blocks" ON public.blocked_users;
CREATE POLICY "Users manage their own blocks"
  ON public.blocked_users FOR ALL
  TO authenticated
  USING (blocker_id = auth.uid())
  WITH CHECK (blocker_id = auth.uid());


-- ============================================================
-- Verify:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='profiles'
--       AND column_name IN ('vacation_mode_until','subscription_grace_until');
--   SELECT count(*) FROM blocked_users;
-- ============================================================
