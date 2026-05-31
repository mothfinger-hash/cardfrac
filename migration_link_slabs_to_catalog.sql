-- ============================================================
-- PathBinder — backfill api_card_id on historical graded slabs
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- Up through v391-ish, the slab scanner (_openModalFromSlabCert) wrote
-- api_card_id = NULL when adding a graded card. Without that link the
-- card never picks up multi-source comp prices (_enrichOwnedFromComps
-- and _renderBinderExtrasPlaceholder both key on api_card_id) and the
-- PRICE_TREND chart has no catalog_price_history series to draw.
--
-- New slab scans link automatically (see _linkSlabToCatalog in
-- index.html). This migration backfills the same link for slabs that
-- were saved before that fix.
--
-- Strategy
-- --------
-- For every collection_items row that:
--   - is graded (condition <> 'raw'), AND
--   - has api_card_id IS NULL, AND
--   - has a non-null card_name + card_number,
-- find catalog rows where:
--   - id LIKE 'en-%'  (slab path is Pokemon-EN only today), AND
--   - card_number matches one of the common storage variants ('15',
--     '015', '15/86', etc. — see _pbCardNumberVariants in JS), AND
--   - lower(name) equals lower(card_name)  (exact match — fuzzy
--     name matches are too risky to do unsupervised at scale).
--
-- Only EXACT-one-match rows get the link. Multi-hit rows stay NULL —
-- the user can correct them manually via the card-edit modal. This is
-- the same principle as _linkSlabToCatalog's logic on the live path,
-- minus the heuristic scoring (which is hard to express portably in
-- pure SQL and not worth the complexity for a one-shot backfill).
--
-- Idempotent — re-running is a no-op because the WHERE clause already
-- filters out rows that have api_card_id set.
-- ============================================================


-- ─── Section 1 — AUDIT (read-only). Run first. ──────────────
-- How many slabs are eligible for backfill, and how many have an
-- unambiguous catalog match.
with eligible as (
  select id, card_name, card_number
    from public.collection_items
   where api_card_id is null
     and condition is not null and condition <> 'raw'
     and card_name is not null
     and card_number is not null
),
-- For each eligible slab, count how many en- catalog rows have a
-- matching name + card_number. We treat the stored card_number
-- liberally — '15' / '015' / '15/86' / '015/86' / '015/086' all count.
matches as (
  select e.id as ci_id,
         count(distinct c.id) as catalog_hits
    from eligible e
    join public.catalog c
      on c.id ilike 'en-%'
     and lower(c.name) = lower(e.card_name)
     and (
       c.card_number = e.card_number
       or c.card_number = lpad(regexp_replace(e.card_number, '/.*$', ''), 3, '0')
       or c.card_number = regexp_replace(e.card_number, '/.*$', '')
       or c.card_number = e.card_number || '/' || coalesce((select max(card_number) from public.catalog c2 where c2.set_code = c.set_code), '')
     )
   group by e.id
)
select
  (select count(*) from eligible)                              as eligible_slabs,
  (select count(*) from matches where catalog_hits = 1)        as unique_match,
  (select count(*) from matches where catalog_hits > 1)        as ambiguous_match,
  (select count(*) from eligible) - (select count(*) from matches) as no_match;


-- ─── Section 2 — WRITE (mutates rows). Run second. ──────────
-- Update only the slabs with exactly one en- catalog match.
with eligible as (
  select id, card_name, card_number
    from public.collection_items
   where api_card_id is null
     and condition is not null and condition <> 'raw'
     and card_name is not null
     and card_number is not null
),
matches as (
  select e.id as ci_id,
         array_agg(distinct c.id) as catalog_ids
    from eligible e
    join public.catalog c
      on c.id ilike 'en-%'
     and lower(c.name) = lower(e.card_name)
     and (
       c.card_number = e.card_number
       or c.card_number = lpad(regexp_replace(e.card_number, '/.*$', ''), 3, '0')
       or c.card_number = regexp_replace(e.card_number, '/.*$', '')
     )
   group by e.id
),
unique_hits as (
  select ci_id, catalog_ids[1] as catalog_id
    from matches
   where array_length(catalog_ids, 1) = 1
)
update public.collection_items ci
   set api_card_id = uh.catalog_id
  from unique_hits uh
 where ci.id = uh.ci_id;


-- ─── Section 3 — VERIFY (re-run audit). ─────────────────────
-- Should show eligible_slabs == ambiguous_match + no_match
-- (unique_match drops to 0 because they all got updated).
with eligible as (
  select id, card_name, card_number
    from public.collection_items
   where api_card_id is null
     and condition is not null and condition <> 'raw'
     and card_name is not null
     and card_number is not null
),
matches as (
  select e.id as ci_id, count(distinct c.id) as catalog_hits
    from eligible e
    join public.catalog c
      on c.id ilike 'en-%'
     and lower(c.name) = lower(e.card_name)
     and (
       c.card_number = e.card_number
       or c.card_number = lpad(regexp_replace(e.card_number, '/.*$', ''), 3, '0')
       or c.card_number = regexp_replace(e.card_number, '/.*$', '')
     )
   group by e.id
)
select
  (select count(*) from eligible)                              as remaining_eligible,
  (select count(*) from matches where catalog_hits = 1)        as remaining_unique,
  (select count(*) from matches where catalog_hits > 1)        as ambiguous_match,
  (select count(*) from eligible) - (select count(*) from matches) as no_match;
