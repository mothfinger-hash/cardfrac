-- Content abuse reports (Apple App Store Guideline 1.2 / Google Play UGC).
-- Lets any signed-in user flag a listing, seller profile, review, uploaded
-- photo, or message for moderator review. This is DISTINCT from card_reports,
-- which is for card-DATA corrections (wrong name/number/image), not abuse.
--
-- Idempotent: safe to re-run. Surfaced in the admin Moderation queue.

create table if not exists public.content_reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references auth.users(id) on delete cascade,
  target_type  text not null check (target_type in ('listing','profile','review','photo','message')),
  target_id    text not null,
  target_label text,
  reason       text not null,
  details      text,
  status       text not null default 'open' check (status in ('open','reviewed','actioned','dismissed')),
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz,
  reviewed_by  uuid references auth.users(id)
);

create index if not exists content_reports_status_idx on public.content_reports(status, created_at desc);
create index if not exists content_reports_target_idx on public.content_reports(target_type, target_id);

alter table public.content_reports enable row level security;

-- Any authenticated user may file a report as themselves.
drop policy if exists "users submit content reports" on public.content_reports;
create policy "users submit content reports" on public.content_reports
  for insert to authenticated
  with check (auth.uid() = reporter_id);

-- Reporters can read their own reports; admins can read all.
drop policy if exists "read own or admin content reports" on public.content_reports;
create policy "read own or admin content reports" on public.content_reports
  for select to authenticated
  using (
    auth.uid() = reporter_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- Only admins can triage (update status) reports.
drop policy if exists "admins update content reports" on public.content_reports;
create policy "admins update content reports" on public.content_reports
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));
