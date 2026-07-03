-- ============================================================
-- PathBinder — Trade session user ids
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Adds user_id_a / user_id_b columns to fair_trade_sessions so the
-- live-trade UI can resolve the partner's profile (for the Follow
-- button, future "trade history" features, abuse reports, etc.).
-- Both are nullable — anonymous guests still trade fine, they just
-- can't be followed since there's no account to follow.
-- ============================================================

ALTER TABLE public.fair_trade_sessions
  ADD COLUMN IF NOT EXISTS user_id_a uuid,
  ADD COLUMN IF NOT EXISTS user_id_b uuid;

COMMENT ON COLUMN public.fair_trade_sessions.user_id_a IS
  'Optional: auth.uid() of the trader on Side A. NULL for unauthenticated.';
COMMENT ON COLUMN public.fair_trade_sessions.user_id_b IS
  'Optional: auth.uid() of the trader on Side B. NULL for unauthenticated.';
