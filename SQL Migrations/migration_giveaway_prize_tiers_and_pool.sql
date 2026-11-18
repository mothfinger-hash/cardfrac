-- ============================================================
-- PathBinder — Catch-up: prize_tiers column + giveaway_entrant_pool RPC
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
--
-- WHY THIS EXISTS: these two pieces were appended to
-- migration_giveaway_starting_soon_and_antisock.sql AFTER that file had already
-- been run, so they never got applied. Symptom:
--   "Could not find the 'prize_tiers' column of 'giveaways' in the schema cache"
-- on Create Giveaway, and the live-draw spinner can't load the entrant pool.
-- This applies just the missing bits. (A from-scratch DR run of the antisock
-- migration already includes them, so nothing there needs changing.)
--
-- Dependencies already in place: giveaway_entries, giveaway_disqualifications,
-- profiles, public.is_admin_current().
-- ============================================================

-- 1. Per-rank prize labels (rank 1 = grand, ranks 2+ = TBD pulls, etc.) -------
alter table public.giveaways
  add column if not exists prize_tiers jsonb not null default '[]'::jsonb;

-- 2. Live-draw entrant pool (admin, for the stream spinner) -------------------
create or replace function public.giveaway_entrant_pool(p_giveaway_id uuid)
returns table(entrant_key text, label text, weight int, is_subscriber boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_current() then raise exception 'admin only'; end if;
  return query
  select coalesce(e.user_id::text, 'email:' || e.email)                  as entrant_key,
         coalesce(max(p.username), 'guest-' || left(md5(coalesce(e.email,'')),4)) as label,
         sum(e.entries)::int                                             as weight,
         coalesce(bool_or(p.stripe_subscription_id is not null), false)  as is_subscriber
  from public.giveaway_entries e
  left join public.profiles p on p.id = e.user_id
  where e.giveaway_id = p_giveaway_id
    and not exists (select 1 from public.giveaway_disqualifications d
                    where d.giveaway_id = e.giveaway_id and d.user_id = e.user_id)
  group by coalesce(e.user_id::text, 'email:' || e.email)
  having sum(e.entries) > 0
  order by weight desc, label;
end $$;
grant execute on function public.giveaway_entrant_pool(uuid) to authenticated;

-- If the Create form still errors right after running this, PostgREST's schema
-- cache hasn't reloaded yet — run:  notify pgrst, 'reload schema';
-- (Supabase usually reloads it automatically within a few seconds.)

-- ============================================================
-- Verify:
--   select prize_tiers from public.giveaways limit 1;            -- column exists
--   select * from public.giveaway_entrant_pool('<giveaway id>'); -- 'admin only' from anon, rows for admin
-- ============================================================
