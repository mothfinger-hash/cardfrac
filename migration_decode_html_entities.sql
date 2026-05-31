-- ============================================================
-- PathBinder — decode HTML entities in card / set / listing names
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- Some upstream APIs (pokemontcg.io, certain TCGdex endpoints, the
-- pokedata mirror, and a few hand-imported CSVs) return strings that
-- went through one round of HTML-entity encoding before they hit us.
-- Cards from those sources land in the catalog with literals like:
--     Goku&#39;s Energy
--     Magikarp &amp; Wailord
--     Pok&eacute;dex
--     Boss&rsquo;s Orders
-- instead of the decoded text the user expects to read on the card.
--
-- This migration scans every user-visible text column for the most
-- common entities and rewrites them in-place. It's idempotent — once
-- the entities are gone, a second run is a no-op.
--
-- AUDIT FIRST
-- -----------
-- Section 1 counts the affected rows per table so you can see how
-- bad the problem is before changing anything. Run section 1 alone
-- the first time; if the counts look right, run section 2 to fix.
-- Section 3 re-counts so you can confirm the cleanup landed.
--
-- AFFECTED TABLES / COLUMNS
-- -------------------------
--   catalog          → name, set_name
--   collection_items → card_name, set_name  (user copies snapshot at add-time)
--   listings         → name
--
-- ENTITY ORDER
-- ------------
-- &amp; is decoded LAST. If we decoded it first, a double-encoded
-- string like "Goku&amp;#39;s" would lose its outer &amp; and the
-- remaining &#39; would NOT then be decoded in the same statement
-- (Postgres REPLACE doesn't loop). Leaving &amp; for last means
-- single-encoded data decodes correctly and double-encoded data
-- becomes single-encoded (running the migration twice finishes the
-- job — exactly what "idempotent" guarantees).
-- ============================================================


-- ─── Helper ────────────────────────────────────────────────
-- Wraps the REPLACE chain so we can apply it to any text column
-- without duplicating the list. CREATE OR REPLACE is safe to re-run.
create or replace function pb_decode_html_entities(s text) returns text
language sql
immutable
as $$
  select
    -- Curly quotes (Microsoft / Apple smart-quote autocorrect leaks)
    replace(replace(replace(replace(
      -- Numeric entities for common accented chars in card names
      replace(replace(replace(replace(replace(replace(
        -- Named entities for typography
        replace(replace(replace(replace(replace(
          -- Quotes + apostrophes
          replace(replace(replace(replace(replace(replace(
            -- Whitespace + comparison + final ampersand decode
            replace(replace(replace(replace(
              coalesce(s, '')
            ,'&nbsp;', ' ')
            ,'&lt;', '<')
            ,'&gt;', '>')
            ,'&amp;', '&')             -- KEEP LAST among &amp/&lt/&gt — see note above
          ,'&#39;', '''')
          ,'&apos;', '''')
          ,'&#34;', '"')
          ,'&quot;', '"')
          ,'&#x27;', '''')
          ,'&#x22;', '"')
        ,'&hellip;', '…')
        ,'&mdash;', '—')
        ,'&ndash;', '–')
        ,'&middot;', '·')
        ,'&bull;', '•')
      ,'&eacute;', 'é')               -- Pokémon
      ,'&Eacute;', 'É')
      ,'&egrave;', 'è')
      ,'&agrave;', 'à')
      ,'&acirc;', 'â')
      ,'&ocirc;', 'ô')
    ,'&rsquo;', '’')                  -- Curly right single (Boss’s Orders)
    ,'&lsquo;', '‘')
    ,'&rdquo;', '”')
    ,'&ldquo;', '“')
$$;


-- ============================================================
-- Section 1 — AUDIT (read-only). Run this first.
-- ============================================================
select 'catalog.name'             as column_,
       count(*)                   as affected_rows,
       count(*) filter (where name like '%&#39;%')   as has_amp_39,
       count(*) filter (where name like '%&amp;%')   as has_amp_amp,
       count(*) filter (where name like '%&quot;%')  as has_amp_quot,
       count(*) filter (where name like '%&rsquo;%') as has_amp_rsquo,
       count(*) filter (where name like '%&hellip;%')as has_amp_hellip,
       count(*) filter (where name like '%&eacute;%')as has_amp_eacute
  from public.catalog
 where name is not null
   and name <> pb_decode_html_entities(name)
union all
select 'catalog.set_name',
       count(*),
       count(*) filter (where set_name like '%&#39;%'),
       count(*) filter (where set_name like '%&amp;%'),
       count(*) filter (where set_name like '%&quot;%'),
       count(*) filter (where set_name like '%&rsquo;%'),
       count(*) filter (where set_name like '%&hellip;%'),
       count(*) filter (where set_name like '%&eacute;%')
  from public.catalog
 where set_name is not null
   and set_name <> pb_decode_html_entities(set_name)
union all
select 'collection_items.card_name',
       count(*),
       count(*) filter (where card_name like '%&#39;%'),
       count(*) filter (where card_name like '%&amp;%'),
       count(*) filter (where card_name like '%&quot;%'),
       count(*) filter (where card_name like '%&rsquo;%'),
       count(*) filter (where card_name like '%&hellip;%'),
       count(*) filter (where card_name like '%&eacute;%')
  from public.collection_items
 where card_name is not null
   and card_name <> pb_decode_html_entities(card_name)
union all
select 'collection_items.set_name',
       count(*),
       count(*) filter (where set_name like '%&#39;%'),
       count(*) filter (where set_name like '%&amp;%'),
       count(*) filter (where set_name like '%&quot;%'),
       count(*) filter (where set_name like '%&rsquo;%'),
       count(*) filter (where set_name like '%&hellip;%'),
       count(*) filter (where set_name like '%&eacute;%')
  from public.collection_items
 where set_name is not null
   and set_name <> pb_decode_html_entities(set_name)
union all
select 'listings.name',
       count(*),
       count(*) filter (where name like '%&#39;%'),
       count(*) filter (where name like '%&amp;%'),
       count(*) filter (where name like '%&quot;%'),
       count(*) filter (where name like '%&rsquo;%'),
       count(*) filter (where name like '%&hellip;%'),
       count(*) filter (where name like '%&eacute;%')
  from public.listings
 where name is not null
   and name <> pb_decode_html_entities(name);


-- Sample of catalog rows that will change — handy for spot-checking
-- before you commit. Comment out if you don't need it.
select id, name as before_, pb_decode_html_entities(name) as after_
  from public.catalog
 where name <> pb_decode_html_entities(name)
 limit 50;


-- ============================================================
-- Section 2 — WRITE (mutates rows). Run this second.
-- ============================================================
-- catalog
update public.catalog
   set name = pb_decode_html_entities(name)
 where name is not null
   and name <> pb_decode_html_entities(name);

update public.catalog
   set set_name = pb_decode_html_entities(set_name)
 where set_name is not null
   and set_name <> pb_decode_html_entities(set_name);

-- collection_items (user snapshots — these don't auto-refresh from catalog)
update public.collection_items
   set card_name = pb_decode_html_entities(card_name)
 where card_name is not null
   and card_name <> pb_decode_html_entities(card_name);

update public.collection_items
   set set_name = pb_decode_html_entities(set_name)
 where set_name is not null
   and set_name <> pb_decode_html_entities(set_name);

-- listings (marketplace)
update public.listings
   set name = pb_decode_html_entities(name)
 where name is not null
   and name <> pb_decode_html_entities(name);


-- ============================================================
-- Section 3 — VERIFY (re-run audit; should return zero rows or
-- a small "no-op" set where the function returns the input unchanged).
-- ============================================================
select 'catalog.name'              as column_, count(*) as remaining from public.catalog          where name      is not null and name      <> pb_decode_html_entities(name)
union all
select 'catalog.set_name',                  count(*)              from public.catalog          where set_name  is not null and set_name  <> pb_decode_html_entities(set_name)
union all
select 'collection_items.card_name',        count(*)              from public.collection_items where card_name is not null and card_name <> pb_decode_html_entities(card_name)
union all
select 'collection_items.set_name',         count(*)              from public.collection_items where set_name  is not null and set_name  <> pb_decode_html_entities(set_name)
union all
select 'listings.name',                     count(*)              from public.listings         where name      is not null and name      <> pb_decode_html_entities(name);


-- If section 3 reports zero across the board you're done. The helper
-- function can stay in place — it's harmless and useful for future
-- one-off cleanups (e.g. `select pb_decode_html_entities(name) from
-- catalog where ...`). To drop it:
--     drop function if exists pb_decode_html_entities(text);
