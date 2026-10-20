-- ============================================================
-- PathBinder — Cap the never-won entry bonus at +50
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
--
-- Change vs the live function: never-won was uncapped (v_since * 5), so a
-- long-tenured non-winner could accrue unbounded entries and dominate the
-- pool. Now capped at +50 (= 10 drawings) via least(), matching how loyalty
-- is already capped. Everything else (payment gate, idempotency, loyalty
-- lapse-reset) is unchanged from the live definition.
--
-- Also re-asserts the REVOKE from public/anon (CREATE OR REPLACE preserves
-- grants, so this is belt-and-suspenders only).
-- ============================================================

CREATE OR REPLACE FUNCTION public.giveaway_grant_subscriber_entries(p_giveaway_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  caller_is_admin boolean;
  v_status text;
  v_granted int := 0;
  -- ---- tunable entry weights -------------------------------------------
  c_base_month   int := 10;
  c_base_year    int := 25;
  c_loyalty_per  int := 2;
  c_loyalty_cap  int := 20;   -- caps loyalty at 10 consecutive drawings
  c_neverwon_per int := 5;
  c_neverwon_cap int := 50;   -- caps never-won at 10 drawings since last win
  -- ----------------------------------------------------------------------
  r record;
  v_base int; v_loyalty int; v_neverwon int;
  v_streak int; v_since int;
begin
  -- Admin when called from the app; service_role/cron has a null auth.uid().
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
    v_neverwon := least(v_since * c_neverwon_per, c_neverwon_cap);

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

  -- Lapsed subscribers break their loyalty streak (reset to 0) but keep their
  -- never-won progress. Only touches rows for users not currently paying subs.
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
end $function$;

revoke execute on function public.giveaway_grant_subscriber_entries(uuid) from public, anon;

-- Verify:
--   select pg_get_functiondef('public.giveaway_grant_subscriber_entries(uuid)'::regprocedure)
--     like '%least(v_since * c_neverwon_per, c_neverwon_cap)%';  -- expect t
-- ============================================================
