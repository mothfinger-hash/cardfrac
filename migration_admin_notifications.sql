-- migration_admin_notifications.sql
--
-- Admin notification feed. Triggered automatically when something
-- requires an admin's attention (currently: a marketplace order being
-- escalated to disputed status). Future event types — high-value
-- listings flagged, vendor application submitted, etc. — drop into the
-- same table by adding a new `type` value.
--
-- Channel split:
--   - In-app (this table): always fires, even if email is broken
--   - Email (Resend, via /api/admin-notify-dispute.js): best-effort,
--     called by the client immediately after the status flip. The
--     trigger doesn't try to send email itself; it just inserts the
--     notification row.
--
-- Columns:
--   id              uuid pk
--   created_at      when the event happened
--   type            'order_disputed' | future values
--   title           short headline rendered in the admin bell list
--   message         longer body shown in the notifications panel
--   link_path       deep-link the admin clicks to act on it
--                   (e.g. '/admin?tab=disputes&order=xyz')
--   related_order_id   nullable FK-ish reference (no hard FK so
--                      hard-deleting orders later won't cascade)
--   related_user_id    nullable — buyer/seller/etc. who triggered it
--   read_by         uuid[] — admins who've marked this read (per-admin
--                            read tracking on a shared row, simpler than
--                            a join table for the volume we'll have)
--   dismissed_by    uuid[] — admins who've dismissed it from the bell

create table if not exists public.admin_notifications (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  type              text not null,
  title             text not null,
  message           text,
  link_path         text,
  related_order_id  uuid,
  related_user_id   uuid,
  read_by           uuid[] not null default '{}',
  dismissed_by      uuid[] not null default '{}'
);

create index if not exists admin_notifications_created_at_idx
  on public.admin_notifications (created_at desc);
create index if not exists admin_notifications_type_idx
  on public.admin_notifications (type);

-- ── RLS — admin reads + per-admin updates only ─────────────────────────
alter table public.admin_notifications enable row level security;

drop policy if exists "admin_notifications_admin_read"   on public.admin_notifications;
drop policy if exists "admin_notifications_admin_update" on public.admin_notifications;
drop policy if exists "admin_notifications_service_all"  on public.admin_notifications;

-- Admins can read every notification.
create policy "admin_notifications_admin_read"
  on public.admin_notifications
  for select
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and coalesce(p.is_admin, false) = true
    )
  );

-- Admins can update (toggle read/dismissed for themselves) any row.
-- The "for themselves" part is enforced application-side via array_append
-- of auth.uid() — RLS lets admins write any row, but the client only
-- ever appends their own uid.
create policy "admin_notifications_admin_update"
  on public.admin_notifications
  for update
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and coalesce(p.is_admin, false) = true
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and coalesce(p.is_admin, false) = true
    )
  );

-- Service role (used by triggers + admin-notify endpoint) bypasses RLS
-- by default; the explicit policy is documentation more than enforcement.

-- ── Trigger: order escalated to disputed ───────────────────────────────
-- Fires on UPDATE when status transitions INTO 'disputed'. Idempotent —
-- repeated updates that keep the status at 'disputed' do NOT spam new
-- notifications. Insert is wrapped in a function so the trigger body
-- stays tiny.

create or replace function public.on_order_disputed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  short_id text;
  card_name text;
begin
  -- Only fire on the actual transition, not on every update that
  -- happens to have status='disputed'.
  if (tg_op = 'UPDATE' and new.status = 'disputed' and old.status is distinct from 'disputed') then
    short_id := upper(substring(new.id::text, 1, 8));

    -- Try to pull a card name for the notification body. If the listing
    -- has been deleted in the meantime fall back to a generic label.
    select l.name into card_name
      from public.listings l
     where l.id = new.listing_id
     limit 1;
    card_name := coalesce(card_name, 'Marketplace order');

    insert into public.admin_notifications (
      type, title, message, link_path, related_order_id, related_user_id
    ) values (
      'order_disputed',
      'Order #' || short_id || ' escalated to dispute',
      card_name || ' — seller declined the return. Reason on file: '
        || coalesce(new.return_reason, 'unspecified')
        || case
             when new.return_reason_detail is not null and length(new.return_reason_detail) > 0
               then ' — "' || left(new.return_reason_detail, 200) || '"'
             else ''
           end,
      '/?admin=disputes&order=' || new.id::text,
      new.id,
      new.buyer_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_order_disputed on public.orders;
create trigger trg_order_disputed
  after update on public.orders
  for each row
  execute function public.on_order_disputed();

-- ── Helper: list admin emails ──────────────────────────────────────────
-- Used by /api/admin-notify-dispute.js to fan out the email. Returns
-- email + name so the API can personalize the greeting. SECURITY DEFINER
-- so the endpoint (running with the user's JWT) can call it without
-- having direct read access to all profile emails — the function itself
-- checks the caller IS an admin before returning anything.
create or replace function public.list_admin_recipients()
returns table(email text, name text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid() and coalesce(is_admin, false) = true
  ) then
    return; -- non-admins get an empty result, not an error
  end if;

  return query
    select p.email, coalesce(p.name, p.username, 'Admin')::text
      from public.profiles p
     where coalesce(p.is_admin, false) = true
       and p.email is not null
       and coalesce(p.is_deleted, false) = false;
end;
$$;
grant execute on function public.list_admin_recipients() to authenticated;

comment on table public.admin_notifications is
  'Admin-facing event feed. Currently populated by trg_order_disputed; future event types drop in via the type column.';
