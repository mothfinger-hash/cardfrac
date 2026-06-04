-- ============================================================
-- PathBinder — Detect catalog rows where the image_url is shared by
-- multiple DIFFERENT card names, OR where the URL slug references a
-- known card name that doesn't match the stored name.
--
-- v2 — replaces the original heuristic which flagged any row whose
-- name didn't appear in the URL. That generated hundreds of false
-- positives because many image URLs are named by card NUMBER
-- (SWSH001.webp, HGSS01.webp) rather than card name — completely
-- correct, just not name-based. v2 only fires on actual evidence of
-- a wrong tag.
--
-- Two stronger signals it catches:
--
--   QUERY A: image_url is referenced by ≥2 different catalog names.
--     The same JPEG can't legitimately be both "Charizard" and
--     "Hitmonchan" — one row is wrong (or both are wrong and they
--     collided into the same wrong image).
--
--   QUERY B: image_url slug contains a recognizable card name from
--     OUR OWN catalog that ISN'T the row's stored name. e.g. URL has
--     "rockets-hitmonchan-11" but the stored name is "Charizard EX".
--     Requires the URL to be name-slug-style (so SWSH-numbered URLs
--     don't get flagged).
--
-- Run in: Supabase Dashboard → SQL Editor → New query.
-- Returns at most 200 suspect rows per query.
-- ============================================================


-- ─── QUERY A — image_url shared across multiple different names ────
with shared_imgs as (
  select image_url, count(distinct name) as name_count
  from public.catalog
  where image_url is not null and image_url <> ''
  group by image_url
  having count(distinct name) > 1
)
select
  c.id,
  c.name              as stored_name,
  c.set_name,
  c.card_number,
  c.game_type,
  c.image_url,
  s.name_count        as also_used_by_n_names,
  '⚠ same image used by another catalog row with a different name' as flag
from public.catalog c
join shared_imgs s on s.image_url = c.image_url
order by s.name_count desc, c.image_url, c.name
limit 200;


-- ─── QUERY B — URL slug names a different card than the row stores ──
-- Run this as a SEPARATE statement in the SQL editor (Supabase only
-- returns the last result; comment out QUERY A above if you want B).
--
-- with normalized as (
--   select
--     id, name, set_name, card_number, game_type, image_url,
--     -- Pull just the filename (no extension, no path) from image_url.
--     lower(regexp_replace(
--       coalesce(substring(image_url from '([^/]+)\.[a-zA-Z]+$'), ''),
--       '[^a-zA-Z]', '', 'g'
--     )) as url_slug,
--     lower(regexp_replace(name, '[^a-zA-Z]', '', 'g')) as name_norm
--   from public.catalog
--   where image_url is not null and image_url <> ''
--     -- Only check URLs whose filename has 6+ alpha chars (skip
--     -- number-only filenames like SWSH001 which don't carry a name).
--     and length(regexp_replace(
--           coalesce(substring(image_url from '([^/]+)\.[a-zA-Z]+$'), ''),
--           '[^a-zA-Z]', '', 'g'
--         )) >= 6
-- ),
-- name_index as (
--   -- Build a lookup of every distinct normalized name in the catalog
--   -- so we can detect when a URL slug references a real OTHER card.
--   select distinct lower(regexp_replace(name, '[^a-zA-Z]', '', 'g')) as name_norm,
--                   name as canonical_name
--   from public.catalog
--   where name is not null and length(name) >= 4
-- )
-- select
--   n.id,
--   n.name              as stored_name,
--   ni.canonical_name   as url_appears_to_be,
--   n.set_name,
--   n.card_number,
--   n.game_type,
--   n.image_url
-- from normalized n
-- join name_index ni
--   on ni.name_norm <> n.name_norm
--  and length(ni.name_norm) >= 5
--  and position(ni.name_norm in n.url_slug) > 0
--  and position(n.name_norm  in n.url_slug) = 0   -- stored name NOT in url
-- order by n.game_type, n.set_name, n.card_number
-- limit 200;


-- ============================================================
-- Once you find a confirmed bad row, fix with a direct UPDATE.
-- Example for the Charizard/Hitmonchan case:
--
--   UPDATE public.catalog
--     SET name = 'Rocket''s Hitmonchan'   -- the correct name
--     WHERE id = '<catalog-id-from-report>';
--
-- For a row where the IMAGE is wrong but the name is right, clear
-- image_url instead and re-run the image-backfill script for that
-- set, so the next sync re-pulls a fresh URL:
--
--   UPDATE public.catalog
--     SET image_url = NULL
--     WHERE id = '<catalog-id>';
-- ============================================================
