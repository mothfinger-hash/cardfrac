-- ============================================================
-- PathBinder — catalog_price_history retention
-- Run in: Supabase Dashboard -> SQL Editor
--
-- WHY: catalog_price_history is append-only with NO retention. As of
-- 2026-11-03 it holds ~20.7M rows (oldest 2026-05-21) and grows ~168K
-- rows/day forever. It is the dominant consumer of the project disk and
-- the reason the disk auto-scaled past the 8 GB included size.
--
-- SAFE TO PRUNE: the app never reads price history older than 30 days.
--   - Movers panel: 24h + 7d windows only (get_global_price_movers,
--     p_days_back in {1,7}; query window = period+1, max 8 days).
--   - Single-card price chart: 30-day window (pb-app.js ~3318).
-- 90-day retention keeps 3x the longest window any feature uses.
--
-- Idempotent — safe to re-run.
-- ============================================================


-- ------------------------------------------------------------
-- 1) ONE-TIME CLEANUP: delete rows older than 90 days.
--    Batched by month so each statement is its own transaction
--    (gentler on WAL / locks than one ~7.5M-row delete).
--    Each runs independently; re-running is a no-op once empty.
--    Cutoff target = current_date - 90d = 2026-08-05.
-- ------------------------------------------------------------
delete from public.catalog_price_history where recorded_at < '2026-06-01';
delete from public.catalog_price_history where recorded_at < '2026-07-01';
delete from public.catalog_price_history where recorded_at < '2026-08-01';
delete from public.catalog_price_history where recorded_at < '2026-08-05';


-- ------------------------------------------------------------
-- 2) RECURRING RETENTION: nightly prune via pg_cron so this never
--    builds back up. Steady state ~15M rows instead of unbounded.
--    Runs 04:30 UTC, after the ~03:00 snapshot insert.
--
--    >>> REQUIRES pg_cron. Enable it FIRST, or this block errors with
--    >>> "schema cron does not exist":
--    >>>   Dashboard -> Database -> Extensions -> search "pg_cron" -> Enable
--    >>> Then run this block. (Prefer not to? Skip it — the nightly
--    >>> refresh_catalog_prices.py can do the prune instead; see chat.)
--
--    Run this block SEPARATELY from section 1 above, so a cron error can
--    never roll back the cleanup deletes again.
-- ------------------------------------------------------------
do $$
begin
  perform cron.unschedule('prune-catalog-price-history');
exception when others then
  null;  -- job did not exist yet; ignore
end $$;

select cron.schedule(
  'prune-catalog-price-history',
  '30 4 * * *',
  $$ delete from public.catalog_price_history
       where recorded_at < current_date - interval '90 days' $$
);


-- ------------------------------------------------------------
-- 3) OPTIONAL — physically shrink the table file back to the OS.
--    The deletes above free space for REUSE by future inserts, but do
--    NOT return it to the OS, so provisioned disk will not drop on its
--    own. Only run this if you want to reduce the provisioned disk size
--    afterward. VACUUM FULL takes a brief exclusive lock and needs free
--    space ~= the live table size. It CANNOT run inside a transaction
--    block — run this line on its own, not as part of the batch above.
-- ------------------------------------------------------------
-- vacuum full public.catalog_price_history;


-- ============================================================
-- Verify after running:
--   select count(*) from catalog_price_history;                    -- ~13.2M right after step 1
--   select min(recorded_at), max(recorded_at) from catalog_price_history;
--   select jobname, schedule from cron.job where jobname = 'prune-catalog-price-history';
-- ============================================================
