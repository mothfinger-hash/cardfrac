-- ============================================================
-- PathBinder — Giveaway media (photo + video)
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
--
-- Lets an admin attach a photo and/or a video to a giveaway so it can be shown
-- on the public giveaway page (and the dashboard banner) and shared. Stored in
-- a public-read bucket; only admins can write. URLs live on the giveaway row.
--
-- Depends on migration_giveaway_amoe.sql (public.is_admin_current()).
-- ============================================================

-- 1. URL columns on the giveaway --------------------------------------------
alter table public.giveaways
  add column if not exists image_url text,
  add column if not exists video_url text;

-- 2. Public-read storage bucket (admins write) ------------------------------
-- 100 MB per file so short prize/pull clips fit. Public so the static giveaway
-- page (anon key) and crawlers can load the media by URL.
insert into storage.buckets (id, name, public, file_size_limit)
values ('giveaway-media', 'giveaway-media', true, 104857600)
on conflict (id) do update set public = true, file_size_limit = 104857600;

-- Anyone may READ (the bucket is public; this makes the select explicit).
drop policy if exists "giveaway_media_public_read" on storage.objects;
create policy "giveaway_media_public_read" on storage.objects
  for select to public
  using (bucket_id = 'giveaway-media');

-- Only admins may upload / replace / remove.
drop policy if exists "giveaway_media_admin_insert" on storage.objects;
create policy "giveaway_media_admin_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'giveaway-media' and public.is_admin_current());

drop policy if exists "giveaway_media_admin_update" on storage.objects;
create policy "giveaway_media_admin_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'giveaway-media' and public.is_admin_current())
  with check (bucket_id = 'giveaway-media' and public.is_admin_current());

drop policy if exists "giveaway_media_admin_delete" on storage.objects;
create policy "giveaway_media_admin_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'giveaway-media' and public.is_admin_current());

-- ============================================================
-- Verify:
--   select image_url, video_url from public.giveaways limit 1;   -- columns exist
--   select id, public, file_size_limit from storage.buckets where id='giveaway-media';
-- ============================================================
