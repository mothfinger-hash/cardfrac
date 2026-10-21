-- ============================================================
-- PathBinder — Giveaway AMOE (free entry) + anon-read regression fix
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
--
-- Part A (regression fix): the giveaway tables' admin RLS policies subquery
-- `profiles` directly. Once anon lost SELECT on profiles (the PII lockdown),
-- anon reading `giveaways` (the public /giveaway page) started erroring with
-- "permission denied for table profiles" because Postgres still evaluates the
-- admin policy. Fix: scope the admin policies to `authenticated` and check
-- admin via a SECURITY DEFINER helper (runs as owner, so the invoker never
-- needs profiles access). anon then only hits the public-read policy.
--
-- Part B (AMOE): a free, no-purchase entry path. giveaway_enter_free lets any
-- signed-in user (free accounts included) add one free entry per source per
-- drawing. free_base is the core AMOE; social_* are honor-system bonuses. The
-- (giveaway,user,source) unique index makes each idempotent.
-- ============================================================

-- Part A ---------------------------------------------------------------------

-- Admin check that does NOT require the caller to have profiles access.
create or replace function public.is_admin_current()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;
grant execute on function public.is_admin_current() to authenticated, service_role;

-- Re-point every giveaway admin policy to the definer check, scoped to
-- authenticated so anon never evaluates a profiles subquery.
drop policy if exists giveaways_admin_all on public.giveaways;
create policy giveaways_admin_all on public.giveaways
  for all to authenticated
  using (public.is_admin_current()) with check (public.is_admin_current());

drop policy if exists giveaway_entries_admin_all on public.giveaway_entries;
create policy giveaway_entries_admin_all on public.giveaway_entries
  for all to authenticated
  using (public.is_admin_current()) with check (public.is_admin_current());

drop policy if exists giveaway_winners_admin_all on public.giveaway_winners;
create policy giveaway_winners_admin_all on public.giveaway_winners
  for all to authenticated
  using (public.is_admin_current()) with check (public.is_admin_current());

drop policy if exists gss_admin_all on public.giveaway_subscriber_state;
create policy gss_admin_all on public.giveaway_subscriber_state
  for all to authenticated
  using (public.is_admin_current()) with check (public.is_admin_current());

-- Part B ---------------------------------------------------------------------

-- Free / no-purchase entry. One entry per (giveaway, user, source); the partial
-- unique index on giveaway_entries makes a repeat call a no-op. Only works
-- while the giveaway is open. SECURITY DEFINER so it can insert past the
-- entries RLS (which is read-only to users).
create or replace function public.giveaway_enter_free(p_giveaway_id uuid, p_source text default 'free_base')
returns table(ok boolean, total int)
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_src    text;
begin
  if auth.uid() is null then raise exception 'sign in to enter'; end if;
  v_src := lower(coalesce(p_source, 'free_base'));
  if v_src not in ('free_base','social_follow','social_share','social_like') then
    raise exception 'invalid entry source';
  end if;

  select status into v_status from public.giveaways where id = p_giveaway_id;
  if v_status is null then raise exception 'giveaway not found'; end if;
  if v_status <> 'open' then raise exception 'this giveaway is not open for entry'; end if;

  insert into public.giveaway_entries (giveaway_id, user_id, source, entries, note)
    values (p_giveaway_id, auth.uid(), v_src, 1, 'free entry')
    on conflict do nothing;

  return query
    select true,
           coalesce((select sum(entries)::int from public.giveaway_entries
                     where giveaway_id = p_giveaway_id and user_id = auth.uid()), 0);
end $$;

grant  execute on function public.giveaway_enter_free(uuid, text) to authenticated;
revoke execute on function public.giveaway_enter_free(uuid, text) from public, anon;

-- ============================================================
-- Verify:
--   -- anon can read the public page's giveaways again (expect rows or [], not an error):
--   --   GET /rest/v1/giveaways?select=id,name,status&status=neq.draft   (as anon)
--   -- free entry (as a signed-in user):
--   --   select * from public.giveaway_enter_free('<open giveaway id>');  -- {ok,total}
-- ============================================================
