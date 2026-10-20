-- ============================================================
-- PathBinder — Giveaway "my wins" read helper
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
-- Runs after migration_giveaway_privacy.sql.
--
-- Powers the "You won" dashboard banner. Returns ONLY the caller's own
-- winning rows joined to the giveaway's public display fields -- no entry
-- counts, no pool size, nothing about any other entrant. (giveaway_winners
-- itself is admin-only after the privacy migration; this is the one safe,
-- self-scoped window into it for a user.)
-- ============================================================

create or replace function public.giveaway_my_wins()
returns table(giveaway_id uuid, name text, prize text, num_winners int,
              prize_rank int, drawn_at timestamptz)
language sql security definer set search_path = public as $$
  select g.id, g.name, g.prize, g.num_winners, w.prize_rank, g.drawn_at
  from public.giveaway_winners w
  join public.giveaways g on g.id = w.giveaway_id
  where w.user_id = auth.uid()
  order by g.drawn_at desc nulls last;
$$;

grant execute on function public.giveaway_my_wins() to authenticated;

-- Verify (as anon -> expect 0 rows; as a winner -> their wins):
--   select * from public.giveaway_my_wins();
-- ============================================================
