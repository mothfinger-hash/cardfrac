-- ============================================================
-- PathBinder — Giveaway: per-winner prize label
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
--
-- Lets the live-draw spinner assign a specific prize to each winner as it's
-- revealed (picked from the prize tiers, or typed custom). Stored here so the
-- winner email sends the EXACT prize that was announced on stream, instead of
-- deriving it from the rank. NULL = fall back to the rank's prize tier.
-- ============================================================

alter table public.giveaway_winners
  add column if not exists prize_label text;

-- Verify:  select prize_rank, prize_label from public.giveaway_winners limit 5;
-- ============================================================
