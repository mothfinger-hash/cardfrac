-- ============================================================
-- PathBinder — Dedupe Blazing Dominion (BLZD) slug duplicates
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- The YGO catalog has two parallel rows for the same Blazing Dominion
-- cards:
--   • Canonical (pokedata):  set_code = 'BLZD'              (~101 rows)
--   • Slug (PriceCharting):  set_code = 'blazing-dominion'  (~3 rows)
-- The slug-style rows come from sync_pc_singles_enrich.py, which scrapes
-- PriceCharting console pages and writes lowercase-hyphenated ids
-- before any canonical pokedata set existed for them. Once pokedata
-- adds the set, we want users to see ONE row per card — the canonical
-- one — and any user data attached to the slug row needs to migrate
-- to its canonical twin.
--
-- Matching strategy
-- -----------------
-- Slug rows match canonical rows on (name lowercased, card_number).
-- Card numbers in pokedata are stored as bare integers ("15") while
-- PriceCharting can write them either way; we match against both
-- '15' and '015' to cover the common formats.
--
-- Reference rewiring
-- ------------------
-- Three tables reference catalog.id:
--   • collection_items.api_card_id  (text, no FK — update freely)
--   • card_prices.catalog_id        (FK + CASCADE delete + UNIQUE
--                                     on (catalog_id, source)) — delete
--                                     slug rows first to avoid the
--                                     unique-key conflict on UPDATE.
--   • catalog_price_history.catalog_id (FK + CASCADE delete + UNIQUE
--                                     on (catalog_id, recorded_at)) —
--                                     same handling as card_prices.
-- listings has no FK to catalog.id (it stores card name as free text),
-- so nothing to do there.
--
-- Slug rows that DON'T have a canonical match stay put — we don't want
-- to silently delete user data. Re-run the audit later if pokedata
-- backfills more BLZD rows.
--
-- Idempotent — re-running after a successful pass is a no-op because
-- the slug rows are already gone.
-- ============================================================


-- ─── Section 1 — AUDIT (read-only). Run first. ──────────────
-- Show the slug-row → canonical-row mapping we'll apply, plus any
-- slug rows that DON'T have a canonical match (those will be left
-- in place untouched).
with slug_rows as (
  select id as slug_id, name, card_number
    from public.catalog
   where set_code = 'blazing-dominion'
),
canonical_rows as (
  select id as canon_id, name, card_number
    from public.catalog
   where set_code = 'BLZD'
),
mapped as (
  select s.slug_id, s.name as slug_name, s.card_number as slug_num,
         c.canon_id, c.name as canon_name, c.card_number as canon_num
    from slug_rows s
    join canonical_rows c
      on lower(c.name) = lower(s.name)
     and (
       c.card_number = s.card_number
       or c.card_number = lpad(regexp_replace(s.card_number, '/.*$', ''), 3, '0')
       or c.card_number = regexp_replace(s.card_number, '/.*$', '')
     )
)
select 'mapped (will dedupe)' as status,
       slug_id, slug_name, slug_num,
       canon_id, canon_name, canon_num
  from mapped
union all
select 'unmatched (will keep)' as status,
       s.slug_id, s.name, s.card_number,
       null, null, null
  from slug_rows s
 where s.slug_id not in (select slug_id from mapped);

-- Reference counts per slug row — useful for understanding how much
-- user data needs to move.
select s.id as slug_id, s.name,
       (select count(*) from public.collection_items
         where api_card_id = s.id)        as collection_rows,
       (select count(*) from public.card_prices
         where catalog_id = s.id)         as price_rows,
       (select count(*) from public.catalog_price_history
         where catalog_id = s.id)         as history_rows
  from public.catalog s
 where s.set_code = 'blazing-dominion';


-- ─── Section 2 — WRITE (mutates rows). Run second. ──────────
-- Build the mapping CTE once, then drive every UPDATE/DELETE off it.

-- Step 2a: migrate collection_items.api_card_id. Plain UPDATE — no
-- unique constraint to worry about (a single user can own multiple
-- collection_items rows pointing at the same catalog id).
with slug_rows as (
  select id as slug_id, name, card_number
    from public.catalog
   where set_code = 'blazing-dominion'
),
canonical_rows as (
  select id as canon_id, name, card_number
    from public.catalog
   where set_code = 'BLZD'
),
map as (
  select s.slug_id, c.canon_id
    from slug_rows s
    join canonical_rows c
      on lower(c.name) = lower(s.name)
     and (
       c.card_number = s.card_number
       or c.card_number = lpad(regexp_replace(s.card_number, '/.*$', ''), 3, '0')
       or c.card_number = regexp_replace(s.card_number, '/.*$', '')
     )
)
update public.collection_items ci
   set api_card_id = m.canon_id
  from map m
 where ci.api_card_id = m.slug_id;

-- Step 2b: card_prices has UNIQUE (catalog_id, source). If both the
-- slug and canonical row have a price for the same source, the UPDATE
-- would collide. Delete slug-side prices first — the canonical row
-- has the authoritative pokedata-sourced price anyway.
with slug_rows as (
  select id as slug_id, name, card_number
    from public.catalog
   where set_code = 'blazing-dominion'
),
canonical_rows as (
  select id as canon_id, name, card_number
    from public.catalog
   where set_code = 'BLZD'
),
map as (
  select s.slug_id, c.canon_id
    from slug_rows s
    join canonical_rows c
      on lower(c.name) = lower(s.name)
     and (
       c.card_number = s.card_number
       or c.card_number = lpad(regexp_replace(s.card_number, '/.*$', ''), 3, '0')
       or c.card_number = regexp_replace(s.card_number, '/.*$', '')
     )
)
delete from public.card_prices cp
 using map m
 where cp.catalog_id = m.slug_id;

-- Step 2c: same handling for catalog_price_history (UNIQUE on
-- (catalog_id, recorded_at) — duplicate rows for the same date would
-- collide). Slug-side history is short-lived and not worth preserving.
with slug_rows as (
  select id as slug_id, name, card_number
    from public.catalog
   where set_code = 'blazing-dominion'
),
canonical_rows as (
  select id as canon_id, name, card_number
    from public.catalog
   where set_code = 'BLZD'
),
map as (
  select s.slug_id, c.canon_id
    from slug_rows s
    join canonical_rows c
      on lower(c.name) = lower(s.name)
     and (
       c.card_number = s.card_number
       or c.card_number = lpad(regexp_replace(s.card_number, '/.*$', ''), 3, '0')
       or c.card_number = regexp_replace(s.card_number, '/.*$', '')
     )
)
delete from public.catalog_price_history h
 using map m
 where h.catalog_id = m.slug_id;

-- Step 2d: now safe to delete the slug catalog rows. ON DELETE CASCADE
-- on the price/history FKs would also clean those up, but we already
-- did the deletes explicitly above for clarity. Only delete slug rows
-- that had a successful canonical mapping — unmatched ones stay.
with slug_rows as (
  select id as slug_id, name, card_number
    from public.catalog
   where set_code = 'blazing-dominion'
),
canonical_rows as (
  select id as canon_id, name, card_number
    from public.catalog
   where set_code = 'BLZD'
),
map as (
  select s.slug_id
    from slug_rows s
    join canonical_rows c
      on lower(c.name) = lower(s.name)
     and (
       c.card_number = s.card_number
       or c.card_number = lpad(regexp_replace(s.card_number, '/.*$', ''), 3, '0')
       or c.card_number = regexp_replace(s.card_number, '/.*$', '')
     )
)
delete from public.catalog
 where id in (select slug_id from map);


-- ─── Section 3 — VERIFY (read-only). Run last. ──────────────
-- Slug rows remaining: should be 0 (or only the unmatched ones from
-- section 1's "unmatched" report).
select 'slug rows remaining' as check_, count(*) as count_
  from public.catalog
 where set_code = 'blazing-dominion';

-- Canonical row count: unchanged (~101).
select 'BLZD canonical rows'  as check_, count(*) as count_
  from public.catalog
 where set_code = 'BLZD';

-- Any orphan collection_items rows still pointing at deleted ids?
-- Should be 0 — the UPDATE in step 2a moved them all to canonical.
select 'orphan collection_items pointing at deleted slug ids' as check_,
       count(*) as count_
  from public.collection_items ci
 where ci.api_card_id is not null
   and ci.api_card_id like 'blazing-dominion%'
   and not exists (select 1 from public.catalog c where c.id = ci.api_card_id);
