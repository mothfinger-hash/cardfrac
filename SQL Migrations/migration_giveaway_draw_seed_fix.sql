-- ============================================================
-- PathBinder — Giveaway draw: remove caller-supplied seed (anti-grinding)
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
--
-- Change vs the live function: the draw used
--   v_seed := coalesce(p_seed, md5(random()::text || clock_timestamp()::text))
-- i.e. it honored a CALLER-SUPPLIED seed. Because the winner is a deterministic
-- function of (seed, entrants, weights), a caller could grind seeds offline
-- until a chosen entrant lands in the top N, then draw with that seed. Now the
-- seed is ALWAYS generated internally and p_seed is ignored. The seed is still
-- stored in giveaway_winners.rng_seed, so the draw remains reproducible for
-- audit after the fact -- it just can't be predetermined by a caller.
--
-- The signature is kept as (uuid, text) so the admin UI call (no seed) and the
-- REVOKE on this signature are unaffected. Re-asserts the REVOKE for safety.
-- ============================================================

CREATE OR REPLACE FUNCTION public.giveaway_draw_winners(p_giveaway_id uuid, p_seed text DEFAULT NULL::text)
 RETURNS TABLE(prize_rank integer, user_id uuid, email text, entries_held integer, pool_total integer, rng_seed text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

  -- SECURITY: ignore any caller-supplied p_seed to prevent seed-grinding.
  -- Always generate a fresh, unpredictable seed server-side. It is stored on
  -- the winners rows (rng_seed) so the result is still auditable/reproducible.
  v_seed := md5(gen_random_uuid()::text || clock_timestamp()::text || random()::text);

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
    -- deterministic uniform u in [0,1) from a stable hash of (seed, entrant),
    -- then the Efraimidis-Spirakis key u^(1/weight). hashtextextended is a
    -- built-in stable hash; the bitmask clears the sign bit (no abs() overflow)
    -- and the modulo scales it into a 0..1e9 range.
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

  -- never-won reset for winning subscribers
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

-- Verify:
--   select pg_get_functiondef('public.giveaway_draw_winners(uuid, text)'::regprocedure)
--     not like '%coalesce(p_seed%';   -- expect t (caller seed no longer used)
-- ============================================================
