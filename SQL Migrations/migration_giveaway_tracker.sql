-- ============================================================
-- PathBinder — Subscriber Giveaway Tracker (Phase 1: the spine)
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key).
-- Idempotent (create ... if not exists / create or replace / drop policy if exists).
--
-- RESTORED: this file was accidentally overwritten with a 25-byte stub; it is
-- rebuilt here from the live DB (pg_get_functiondef) + session history so the
-- schema is reviewable and a DR rebuild works again.
--
-- SECURITY HARDENING LIVES IN FOLLOW-UP MIGRATIONS — run the full sequence for
-- a rebuild, and do NOT re-run this file alone against an already-hardened DB
-- (it would restore the pre-hardening function/grant versions):
--   1) migration_giveaway_privacy.sql        -- stats/winners lockdown, my_result
--   2) migration_giveaway_my_wins.sql         -- my_wins read helper
--   3) migration_giveaway_rpc_security.sql    -- REVOKE public/anon EXECUTE on draw/grant
--   4) migration_giveaway_neverwon_cap.sql    -- cap never-won at +50
--   5) migration_giveaway_draw_seed_fix.sql   -- draw ignores caller seed
--
-- Ships: 4 tables + RLS + 4 RPCs (grant, draw, my_entries, stats).
-- ============================================================

-- 0. profiles: capture billing interval (monthly vs yearly) ------------------
alter table public.profiles
  add column if not exists subscription_interval text;

-- 1. Tables ------------------------------------------------------------------

create table if not exists public.giveaways (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  prize       text,
  num_winners int  not null default 1 check (num_winners >= 1),
  status      text not null default 'draft'
              check (status in ('draft','open','closed','drawn')),
  opens_at    timestamptz,
  closes_at   timestamptz,
  drawn_at    timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.giveaway_entries (
  id          uuid primary key default gen_random_uuid(),
  giveaway_id uuid not null references public.giveaways(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,
  email       text,
  source      text not null check (source in (
                'subscriber','loyalty','never_won','referral',
                'social_follow','social_like','social_share',
                'free_base','manual')),
  entries     int  not null default 1 check (entries >= 0),
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists giveaway_entries_giveaway_idx
  on public.giveaway_entries (giveaway_id);
create index if not exists giveaway_entries_user_idx
  on public.giveaway_entries (user_id);

-- One row per (giveaway, entrant, source) for every auto/earned source so
-- re-running the grant (e.g. at open then again at close) is idempotent.
-- 'manual' admin adjustments are exempt so an admin can stack them.
create unique index if not exists giveaway_entries_user_src_uq
  on public.giveaway_entries (giveaway_id, user_id, source)
  where user_id is not null and source <> 'manual';
create unique index if not exists giveaway_entries_email_src_uq
  on public.giveaway_entries (giveaway_id, email, source)
  where email is not null and source <> 'manual';

create table if not exists public.giveaway_winners (
  id           uuid primary key default gen_random_uuid(),
  giveaway_id  uuid not null references public.giveaways(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  email        text,
  prize_rank   int  not null default 1,
  entries_held int,          -- how many entries this winner held at draw time
  pool_total   int,          -- total entries in the pool at draw time
  rng_seed     text,         -- audit: seed used, so the draw is reproducible
  created_at   timestamptz not null default now()
);
create unique index if not exists giveaway_winners_rank_uq
  on public.giveaway_winners (giveaway_id, prize_rank);

create table if not exists public.giveaway_subscriber_state (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  loyalty_streak     int not null default 0,  -- consecutive drawings entered as an active sub
  drawings_since_win int not null default 0,  -- drawings entered as a sub since last win
  last_giveaway_id   uuid,
  updated_at         timestamptz not null default now()
);

-- 2. RLS ---------------------------------------------------------------------
-- Writes happen through the SECURITY DEFINER RPCs below (which bypass RLS),
-- so normal users need no insert/update policies. Admins get a direct
-- for-all policy so the in-app admin panel can manage drawings with the anon
-- key as the logged-in admin (no service key needed for day-to-day running).

alter table public.giveaways enable row level security;
drop policy if exists giveaways_public_read on public.giveaways;
create policy giveaways_public_read on public.giveaways
  for select using (status <> 'draft');
drop policy if exists giveaways_admin_all on public.giveaways;
create policy giveaways_admin_all on public.giveaways
  for all
  using (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and coalesce(p.is_admin,false)))
  with check (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and coalesce(p.is_admin,false)));

alter table public.giveaway_entries enable row level security;
drop policy if exists giveaway_entries_own_read on public.giveaway_entries;
create policy giveaway_entries_own_read on public.giveaway_entries
  for select using (user_id = auth.uid());
drop policy if exists giveaway_entries_admin_all on public.giveaway_entries;
create policy giveaway_entries_admin_all on public.giveaway_entries
  for all
  using (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and coalesce(p.is_admin,false)))
  with check (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and coalesce(p.is_admin,false)));

alter table public.giveaway_winners enable row level security;
drop policy if exists giveaway_winners_public_read on public.giveaway_winners;
create policy giveaway_winners_public_read on public.giveaway_winners
  for select using (true);
drop policy if exists giveaway_winners_admin_all on public.giveaway_winners;
create policy giveaway_winners_admin_all on public.giveaway_winners
  for all
  using (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and coalesce(p.is_admin,false)))
  with check (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and coalesce(p.is_admin,false)));

alter table public.giveaway_subscriber_state enable row level security;
drop policy if exists gss_own_read on public.giveaway_subscriber_state;
create policy gss_own_read on public.giveaway_subscriber_state
  for select using (user_id = auth.uid());
drop policy if exists gss_admin_all on public.giveaway_subscriber_state;
create policy gss_admin_all on public.giveaway_subscriber_state
  for all
  using (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and coalesce(p.is_admin,false)))
  with check (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and coalesce(p.is_admin,false)));

-- 3. Auto-enter active PAYING subscribers ------------------------------------
-- ORIGINAL definition (never-won uncapped; public EXECUTE). Superseded by
-- migration_giveaway_neverwon_cap.sql (+50 cap) and migration_giveaway_rpc_
-- security.sql (revoke public/anon execute).
create or replace function public.giveaway_grant_subscriber_entries(p_giveaway_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  caller_is_admin boolean;
  v_status text;
  v_granted int := 0;
  c_base_month   int := 10;
  c_base_year    int := 25;
  c_loyalty_per  int := 2;
  c_loyalty_cap  int := 20;
  c_neverwon_per int := 5;
  r record;
  v_base int; v_loyalty int; v_neverwon int;
  v_streak int; v_since int;
begin
  select coalesce(is_admin,false) into caller_is_admin
    from public.profiles where id = auth.uid();
  if auth.uid() is not null and not coalesce(caller_is_admin,false) then
    raise exception 'admin only';
  end if;

  select status into v_status from public.giveaways where id = p_giveaway_id;
  if v_status is null then raise exception 'giveaway not found'; end if;
  if v_status not in ('open','closed') then
    raise exception 'giveaway must be open or closed to grant entries (status=%)', v_status;
  end if;

  for r in
    select p.id as user_id,
           coalesce(p.subscription_interval,'month') as billing_interval
    from public.profiles p
    where p.subscription_tier in ('enthusiast','vendor','shop')
      and p.stripe_subscription_id is not null
      and coalesce(p.granted_tier_source,'') not in ('activation_trial','subsidiary_invite')
      and not exists (
        select 1 from public.giveaway_entries e
        where e.giveaway_id = p_giveaway_id
          and e.user_id = p.id
          and e.source = 'subscriber')
  loop
    select coalesce(loyalty_streak,0), coalesce(drawings_since_win,0)
      into v_streak, v_since
      from public.giveaway_subscriber_state where user_id = r.user_id;
    v_streak := coalesce(v_streak,0);
    v_since  := coalesce(v_since,0);

    v_base     := case when r.billing_interval = 'year' then c_base_year else c_base_month end;
    v_loyalty  := least(v_streak * c_loyalty_per, c_loyalty_cap);
    v_neverwon := v_since * c_neverwon_per;

    insert into public.giveaway_entries (giveaway_id, user_id, source, entries, note)
      values (p_giveaway_id, r.user_id, 'subscriber', v_base,
              'auto: ' || r.billing_interval || ' subscriber');
    if v_loyalty > 0 then
      insert into public.giveaway_entries (giveaway_id, user_id, source, entries, note)
        values (p_giveaway_id, r.user_id, 'loyalty', v_loyalty,
                'auto: ' || v_streak || ' consecutive drawings');
    end if;
    if v_neverwon > 0 then
      insert into public.giveaway_entries (giveaway_id, user_id, source, entries, note)
        values (p_giveaway_id, r.user_id, 'never_won', v_neverwon,
                'auto: ' || v_since || ' drawings since last win');
    end if;

    insert into public.giveaway_subscriber_state
        (user_id, loyalty_streak, drawings_since_win, last_giveaway_id, updated_at)
      values (r.user_id, v_streak + 1, v_since + 1, p_giveaway_id, now())
      on conflict (user_id) do update
        set loyalty_streak     = excluded.loyalty_streak,
            drawings_since_win = excluded.drawings_since_win,
            last_giveaway_id   = excluded.last_giveaway_id,
            updated_at         = now();

    v_granted := v_granted + 1;
  end loop;

  update public.giveaway_subscriber_state s
     set loyalty_streak = 0, updated_at = now()
   where s.loyalty_streak > 0
     and not exists (
       select 1 from public.profiles p
       where p.id = s.user_id
         and p.subscription_tier in ('enthusiast','vendor','shop')
         and p.stripe_subscription_id is not null
         and coalesce(p.granted_tier_source,'') not in ('activation_trial','subsidiary_invite'));

  return v_granted;
end $$;

grant execute on function public.giveaway_grant_subscriber_entries(uuid) to authenticated, service_role;

-- 4. Seeded weighted random draw ---------------------------------------------
-- ORIGINAL definition (honors caller seed; public EXECUTE). Superseded by
-- migration_giveaway_draw_seed_fix.sql (server-only seed) and the rpc_security
-- migration (revoke public/anon execute).
create or replace function public.giveaway_draw_winners(
  p_giveaway_id uuid,
  p_seed        text default null)
returns table(prize_rank int, user_id uuid, email text, entries_held int, pool_total int, rng_seed text)
language plpgsql security definer set search_path = public as $$
declare
  caller_is_admin boolean;
  v_status      text;
  v_num_winners int;
  v_seed        text;
begin
  select coalesce(is_admin,false) into caller_is_admin
    from public.profiles where id = auth.uid();
  if auth.uid() is not null and not coalesce(caller_is_admin,false) then
    raise exception 'admin only';
  end if;

  select g.status, g.num_winners into v_status, v_num_winners
    from public.giveaways g where g.id = p_giveaway_id;
  if v_status is null then raise exception 'giveaway not found'; end if;
  if v_status = 'drawn' then
    raise exception 'giveaway already drawn (delete its giveaway_winners rows first to redraw)';
  end if;
  if v_status not in ('open','closed') then
    raise exception 'giveaway must be open or closed to draw (status=%)', v_status;
  end if;
  if not exists (select 1 from public.giveaway_entries
                 where giveaway_id = p_giveaway_id and entries > 0) then
    raise exception 'no entries to draw from';
  end if;

  v_seed := coalesce(p_seed, md5(random()::text || clock_timestamp()::text));

  with pool as (
    select coalesce(e.user_id::text, 'email:' || e.email) as entrant_key,
           (array_agg(e.user_id))[1] as user_id,
           (array_agg(e.email))[1]   as email,
           sum(e.entries)::int        as w
    from public.giveaway_entries e
    where e.giveaway_id = p_giveaway_id
    group by coalesce(e.user_id::text, 'email:' || e.email)
    having sum(e.entries) > 0
  ),
  keyed as (
    select pool.*,
           power(
             ((hashtextextended(v_seed || '|' || entrant_key, 0) & 9223372036854775807) % 1000000000)::double precision
               / 1000000000.0,
             1.0 / w
           ) as k
    from pool
  ),
  ranked as (
    select keyed.*, row_number() over (order by k desc) as rnk from keyed
  )
  insert into public.giveaway_winners
      (giveaway_id, user_id, email, prize_rank, entries_held, pool_total, rng_seed)
  select p_giveaway_id, ranked.user_id, ranked.email, ranked.rnk, ranked.w,
         (select sum(w) from pool), v_seed
  from ranked
  where ranked.rnk <= v_num_winners;

  update public.giveaway_subscriber_state s
     set drawings_since_win = 0, updated_at = now()
   where s.user_id in (select w.user_id from public.giveaway_winners w
                       where w.giveaway_id = p_giveaway_id and w.user_id is not null);

  update public.giveaways
     set status = 'drawn', drawn_at = now(), updated_at = now()
   where id = p_giveaway_id;

  return query
    select w.prize_rank, w.user_id, w.email, w.entries_held, w.pool_total, w.rng_seed
    from public.giveaway_winners w
    where w.giveaway_id = p_giveaway_id
    order by w.prize_rank;
end $$;

grant execute on function public.giveaway_draw_winners(uuid, text) to authenticated, service_role;

-- 5. Read helpers ------------------------------------------------------------
-- Caller's own entry total + per-source breakdown (dashboard "Your entries").
create or replace function public.giveaway_my_entries(p_giveaway_id uuid)
returns table(total int, breakdown jsonb)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with agg as (
    select e.source, sum(e.entries)::int as entries
    from public.giveaway_entries e
    where e.giveaway_id = p_giveaway_id and e.user_id = auth.uid()
    group by e.source
  )
  select coalesce(sum(agg.entries),0)::int,
         coalesce(jsonb_object_agg(agg.source, agg.entries), '{}'::jsonb)
  from agg;
end $$;

grant execute on function public.giveaway_my_entries(uuid) to authenticated;

-- Public pool stats. ORIGINAL (anon-readable). Superseded by
-- migration_giveaway_privacy.sql which makes it admin-gated and revokes anon.
create or replace function public.giveaway_stats(p_giveaway_id uuid)
returns table(total_entries int, entrants int)
language sql security definer set search_path = public as $$
  select coalesce(sum(entries),0)::int,
         count(distinct coalesce(user_id::text, 'email:' || email))::int
  from public.giveaway_entries
  where giveaway_id = p_giveaway_id;
$$;

grant execute on function public.giveaway_stats(uuid) to anon, authenticated;
-- ============================================================
