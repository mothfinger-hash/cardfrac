-- giveaway_draw_selftest.sql — side-effect-free verification of the weighted draw
-- Run in Supabase SQL editor. Creates NOTHING, touches NO tables. It just
-- replays the EXACT Efraimidis-Spirakis keying the real draw uses
-- (power(uniform, 1/weight), pick the max) 10,000 times over three synthetic
-- entrants with weights 1 / 5 / 50, and tallies the winners.
--
-- Expect wins ≈ proportional to weight: light ~1.8%, mid ~8.9%, heavy ~89.3%.
-- (A Python replay of the same algorithm gave 1.80 / 8.99 / 89.21.)

with entrants(name, w) as (
  values ('light', 1), ('mid', 5), ('heavy', 50)
),
seeds as (
  select md5(gs::text || clock_timestamp()::text || random()::text) as seed
  from generate_series(1, 10000) gs
),
draws as (
  select (
    select e.name
    from entrants e
    order by power(
      ((hashtextextended(s.seed || '|' || e.name, 0) & 9223372036854775807) % 1000000000)::double precision
        / 1000000000.0,
      1.0 / e.w
    ) desc
    limit 1
  ) as winner
  from seeds s
)
select winner,
       count(*)                                              as wins,
       round(100.0 * count(*) / sum(count(*)) over (), 2)    as pct
from draws
group by winner
order by wins desc;

-- ── Live end-to-end smoke test (admin UI, ~2 min) ───────────────────────────
-- 1. Admin → Giveaways → Create: name, prize, winners, STARTS, CLOSES → draft.
-- 2. "Announce (starting soon)" → log in as a normal user → dashboard shows the
--    "Starting soon" banner with a live countdown to STARTS and NO entry button.
-- 3. "Open & enter subscribers" → banner flips to "Live" with a countdown to
--    CLOSES; any paying subscriber shows 10/25 entries automatically.
-- 4. As a FREE account with <=10 cards: "Enter free" is rejected with
--    "Add more than 10 cards…". Add 11+ cards → it succeeds (+1).
-- 5. "Review duplicates": any two entrants sharing an IP appear as a cluster;
--    Disqualify is hidden for subscribers; disqualified entrants drop from the
--    pool at draw time.
-- 6. "Draw winners" → winners recorded; re-check pct distribution above matches.
