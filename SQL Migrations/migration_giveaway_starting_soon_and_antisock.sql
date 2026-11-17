-- ============================================================
-- PathBinder — Giveaway: "starting soon" status + anti-sock hardening
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
--
-- Adds, for the Team Rocket Briefcase giveaway (and all future ones):
--   1) a 'scheduled' status  -> announced + publicly visible with a countdown,
--      but NOT yet accepting entries. Lifecycle: draft -> scheduled -> open ->
--      closed/drawn. ('scheduled' is public-read since the RLS policy exposes
--      everything except 'draft'; draw/grant still require open/closed.)
--   2) a >10-owned-cards gate on the FREE entry path (giveaway_enter_free).
--      Subscriber entries are untouched (they already require a paid Stripe
--      sub). Paying subscribers and admins are exempt from the card gate.
--   3) admin-reviewed shared-IP de-duplication:
--        - giveaway_disqualifications table (excluded from the draw)
--        - giveaway_ip_clusters()  -> read-only detector, groups entrants that
--          share an auth.sessions IP (>=2 distinct accounts on one IP)
--        - giveaway_disqualify() / giveaway_requalify() -> apply / undo.
--      A paying subscriber is NEVER disqualified by giveaway_disqualify (the
--      "they paid on both, so it's earned" rule is enforced server-side).
--      The collapse is NOT automatic — carriers/households legitimately share
--      IPs, so an admin reviews clusters and applies them by hand.
--
-- Depends on: migration_giveaway_tracker.sql, migration_giveaway_amoe.sql
--   (is_admin_current), migration_giveaway_draw_seed_fix.sql (current draw fn).
-- ============================================================

-- 1. 'scheduled' status ------------------------------------------------------
-- Drop whatever CHECK currently constrains status (name may be auto-generated),
-- then re-add including 'scheduled'. Idempotent.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.giveaways'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute 'alter table public.giveaways drop constraint ' || quote_ident(c);
  end loop;
end $$;
alter table public.giveaways add constraint giveaways_status_check
  check (status in ('draft','scheduled','open','closed','drawn'));

-- 2. >10-card gate on the free (AMOE) entry path -----------------------------
-- Reproduces migration_giveaway_amoe.sql's giveaway_enter_free + the gate.
create or replace function public.giveaway_enter_free(p_giveaway_id uuid, p_source text default 'free_base')
returns table(ok boolean, total int)
language plpgsql security definer set search_path = public as $$
declare
  v_status   text;
  v_src      text;
  v_is_sub   boolean;
  v_is_admin boolean;
  v_cards    int;
begin
  if auth.uid() is null then raise exception 'sign in to enter'; end if;
  v_src := lower(coalesce(p_source, 'free_base'));
  if v_src not in ('free_base','social_follow','social_share','social_like') then
    raise exception 'invalid entry source';
  end if;

  select status into v_status from public.giveaways where id = p_giveaway_id;
  if v_status is null then raise exception 'giveaway not found'; end if;
  if v_status <> 'open' then raise exception 'this giveaway is not open for entry'; end if;

  -- Anti-sock gate: a FREE account must be activated (more than 10 owned cards)
  -- to earn free entries. Paying subscribers and admins skip the gate — they
  -- are not the free-sock vector. Owned = non-ghost, non-sold (same filter as
  -- claim_activation_trial).
  select (p.stripe_subscription_id is not null), coalesce(p.is_admin,false)
    into v_is_sub, v_is_admin
    from public.profiles p where p.id = auth.uid();
  if not coalesce(v_is_sub,false) and not coalesce(v_is_admin,false) then
    select count(*) into v_cards from public.collection_items ci
      where ci.user_id = auth.uid()
        and coalesce(ci.is_ghost,false) = false
        and coalesce(ci.sold_offline,false) = false;
    if coalesce(v_cards,0) <= 10 then
      raise exception 'Add more than 10 cards to your collection to enter the free giveaway.';
    end if;
  end if;

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

-- 3. Admin-reviewed shared-IP de-duplication ---------------------------------

-- 3a. Disqualification ledger (entrants excluded from the draw).
create table if not exists public.giveaway_disqualifications (
  giveaway_id uuid not null references public.giveaways(id) on delete cascade,
  user_id     uuid not null references auth.users(id)   on delete cascade,
  reason      text,
  created_at  timestamptz not null default now(),
  primary key (giveaway_id, user_id)
);
alter table public.giveaway_disqualifications enable row level security;
drop policy if exists gdq_admin_all on public.giveaway_disqualifications;
create policy gdq_admin_all on public.giveaway_disqualifications
  for all to authenticated
  using (public.is_admin_current()) with check (public.is_admin_current());

-- 3b. Read-only cluster detector. One row per (shared-IP account). Groups
-- entrants whose auth.sessions IPs intersect; a cluster is an IP used by >=2
-- distinct entrants. Raw IP is NOT returned — cluster_key is a stable hash and
-- ip_hint masks the host — so the client only sees the grouping, not the PII.
create or replace function public.giveaway_ip_clusters(p_giveaway_id uuid)
returns table(
  cluster_key    text,
  ip_hint        text,
  cluster_size   int,
  user_id        uuid,
  username       text,
  total_entries  int,
  is_subscriber  boolean,
  is_disqualified boolean
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_current() then raise exception 'admin only'; end if;
  return query
  with entrants as (
    select e.user_id, sum(e.entries)::int as total_entries
    from public.giveaway_entries e
    where e.giveaway_id = p_giveaway_id and e.user_id is not null
    group by e.user_id
    having sum(e.entries) > 0
  ),
  user_ips as (
    select distinct en.user_id, host(s.ip)::text as ip
    from auth.sessions s
    join entrants en on en.user_id = s.user_id
    where s.ip is not null
  ),
  shared as (
    select ip, count(distinct user_id) as n
    from user_ips
    group by ip
    having count(distinct user_id) >= 2
  ),
  members as (
    select ui.user_id, ui.ip, sh.n as cluster_size
    from user_ips ui
    join shared sh on sh.ip = ui.ip
  )
  select md5(m.ip)                                   as cluster_key,
         case when m.ip like '%.%.%.%'
              then split_part(m.ip,'.',1)||'.'||split_part(m.ip,'.',2)||'.x.x'
              else left(m.ip, 8) || '…' end          as ip_hint,
         m.cluster_size::int,
         m.user_id,
         p.username,
         en.total_entries,
         (p.stripe_subscription_id is not null)      as is_subscriber,
         exists(select 1 from public.giveaway_disqualifications d
                where d.giveaway_id = p_giveaway_id and d.user_id = m.user_id) as is_disqualified
  from members m
  join entrants en on en.user_id = m.user_id
  join public.profiles p on p.id = m.user_id
  order by m.ip, en.total_entries desc, p.username;
end $$;
grant execute on function public.giveaway_ip_clusters(uuid) to authenticated;

-- 3c. Apply / undo. giveaway_disqualify NEVER disqualifies a paying subscriber
-- (the "subscribed on both accounts, so it's earned" rule, enforced here).
create or replace function public.giveaway_disqualify(
  p_giveaway_id uuid, p_user_ids uuid[], p_reason text default 'shared-IP duplicate')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin_current() then raise exception 'admin only'; end if;
  insert into public.giveaway_disqualifications (giveaway_id, user_id, reason)
  select p_giveaway_id, p.id, p_reason
  from unnest(p_user_ids) u
  join public.profiles p on p.id = u
  where p.stripe_subscription_id is null         -- never DQ a paying subscriber
  on conflict (giveaway_id, user_id) do update set reason = excluded.reason;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.giveaway_disqualify(uuid, uuid[], text) to authenticated;

create or replace function public.giveaway_requalify(p_giveaway_id uuid, p_user_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin_current() then raise exception 'admin only'; end if;
  delete from public.giveaway_disqualifications
   where giveaway_id = p_giveaway_id and user_id = any(p_user_ids);
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.giveaway_requalify(uuid, uuid[]) to authenticated;

-- 3d. Draw now excludes disqualified entrants. Identical to
-- migration_giveaway_draw_seed_fix.sql except the pool CTE skips any user_id in
-- giveaway_disqualifications. Re-run-safe (create or replace).
CREATE OR REPLACE FUNCTION public.giveaway_draw_winners(p_giveaway_id uuid, p_seed text DEFAULT NULL::text)
 RETURNS TABLE(prize_rank integer, user_id uuid, email text, entries_held integer, pool_total integer, rng_seed text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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

  v_seed := md5(gen_random_uuid()::text || clock_timestamp()::text || random()::text);

  with pool as (
    select coalesce(e.user_id::text, 'email:' || e.email) as entrant_key,
           (array_agg(e.user_id))[1] as user_id,
           (array_agg(e.email))[1]   as email,
           sum(e.entries)::int        as w
    from public.giveaway_entries e
    where e.giveaway_id = p_giveaway_id
      and not exists (                     -- admin-reviewed disqualifications
        select 1 from public.giveaway_disqualifications d
        where d.giveaway_id = e.giveaway_id and d.user_id = e.user_id)
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
end $function$;
revoke execute on function public.giveaway_draw_winners(uuid, text) from public, anon;

-- ============================================================
-- Verify:
--   -- 'scheduled' accepted:
--   --   update public.giveaways set status='scheduled' where id='<draft id>';
--   -- free gate (as a <=10-card free user): expect the "Add more than 10 cards" error.
--   -- clusters (as admin): select * from public.giveaway_ip_clusters('<giveaway id>');
--   -- disqualify is subscriber-safe: giveaway_disqualify returns 0 for a sub.
-- ============================================================
