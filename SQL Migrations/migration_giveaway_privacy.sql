-- ============================================================
-- PathBinder — Giveaway Tracker privacy hardening
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
-- Runs AFTER migration_giveaway_tracker.sql.
--
-- Requirement: a user may see ONLY their own entry count. No user may see
-- the total entry pool, anyone else's entries, or how many entries a winner
-- held. This closes two over-permissive grants from the first migration:
--   1) giveaway_stats was executable by anon/authenticated and returned the
--      full pool size + entrant count -> now admin-only.
--   2) giveaway_winners was publicly readable, exposing pool_total,
--      entries_held, and winner email to everyone -> now admin-only, with a
--      safe self-check function so a user can learn only whether THEY won.
--
-- After this, non-admin exposure is limited to:
--   giveaways            : public promo fields only (name, prize, dates) -- no counts
--   giveaway_entries     : own rows only (RLS, unchanged)
--   giveaway_my_entries(): own total + own breakdown (unchanged)
--   giveaway_my_result() : only whether the caller won (new)
--   subscriber_state     : own streak only (RLS, unchanged)
-- ============================================================

-- 1. Lock giveaway_stats to admins -------------------------------------------
-- (was language sql granted to anon/authenticated; drop + recreate admin-gated)
drop function if exists public.giveaway_stats(uuid);

create or replace function public.giveaway_stats(p_giveaway_id uuid)
returns table(total_entries int, entrants int)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles
                 where id = auth.uid() and coalesce(is_admin,false)) then
    raise exception 'admin only';
  end if;
  return query
    select coalesce(sum(entries),0)::int,
           count(distinct coalesce(user_id::text, 'email:' || email))::int
    from public.giveaway_entries
    where giveaway_id = p_giveaway_id;
end $$;

revoke execute on function public.giveaway_stats(uuid) from anon;
grant  execute on function public.giveaway_stats(uuid) to authenticated, service_role;

-- 2. Make giveaway_winners non-public ----------------------------------------
-- Drop the public read policy; admins keep full access via the existing
-- giveaway_winners_admin_all policy. The draw RPC is SECURITY DEFINER so it
-- still writes/reads winners regardless of RLS.
drop policy if exists giveaway_winners_public_read on public.giveaway_winners;

-- 3. Safe self-result check --------------------------------------------------
-- Lets a user learn ONLY whether they personally won (and which prize), with
-- no pool size, no entry counts, no other entrants. Always returns one row.
create or replace function public.giveaway_my_result(p_giveaway_id uuid)
returns table(won boolean, prize_rank int)
language plpgsql security definer set search_path = public as $$
begin
  return query
    select exists (select 1 from public.giveaway_winners w
                   where w.giveaway_id = p_giveaway_id and w.user_id = auth.uid()),
           (select w.prize_rank from public.giveaway_winners w
            where w.giveaway_id = p_giveaway_id and w.user_id = auth.uid()
            order by w.prize_rank limit 1);
end $$;

grant execute on function public.giveaway_my_result(uuid) to authenticated;

-- ============================================================
-- Verify (run as a NON-admin user's JWT, or anon, to confirm the lockdown):
--   select * from public.giveaway_stats('<id>');   -- expect: ERROR admin only
--   select * from public.giveaway_winners;          -- expect: 0 rows (no policy)
--   select * from public.giveaway_my_entries('<id>');-- expect: only your own total
--   select * from public.giveaway_my_result('<id>'); -- expect: (false,null) unless you won
-- ============================================================
