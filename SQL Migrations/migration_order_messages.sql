-- migration_order_messages.sql
--
-- Per-order buyer ↔ seller messaging.
--
-- Every marketplace order can have its own private chat thread. Only
-- the buyer and seller on that order can read or write to it. Admins
-- can read all threads (for dispute mediation) via SECURITY DEFINER
-- helpers if needed later.
--
-- Idempotent — re-running the migration is safe.

-- ── Table ───────────────────────────────────────────────────────────
create table if not exists public.order_messages (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  sender_id   uuid not null references public.profiles(id),
  body        text not null check (length(body) > 0 and length(body) <= 4000),
  created_at  timestamptz not null default now(),
  -- read_at flips from NULL → timestamptz the first time the
  -- counterparty (NOT the sender) views the message in the thread.
  -- Drives the unread-count badge on the Orders tab.
  read_at     timestamptz
);

create index if not exists order_messages_order_idx
  on public.order_messages (order_id, created_at);
create index if not exists order_messages_unread_idx
  on public.order_messages (order_id, read_at)
  where read_at is null;

-- ── RLS ─────────────────────────────────────────────────────────────
alter table public.order_messages enable row level security;

drop policy if exists "order_messages_select"   on public.order_messages;
drop policy if exists "order_messages_insert"   on public.order_messages;
drop policy if exists "order_messages_update"   on public.order_messages;

-- Anyone who's the buyer OR seller on the parent order can read the
-- thread. Plus admins, for dispute mediation.
create policy "order_messages_select"
  on public.order_messages
  for select
  using (
    exists (
      select 1 from public.orders o
       where o.id = order_messages.order_id
         and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    )
    or exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and coalesce(p.is_admin, false) = true
    )
  );

-- Buyer or seller can send. sender_id must match auth.uid() to prevent
-- impersonation; the order-side check ensures only the two parties can
-- post.
create policy "order_messages_insert"
  on public.order_messages
  for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.orders o
       where o.id = order_messages.order_id
         and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    )
  );

-- Updates are restricted to flipping read_at — used by the recipient
-- to mark a message as seen. The using clause limits visibility to
-- the two parties on the order; the with check ensures the user
-- can only mark messages they didn't send.
create policy "order_messages_update"
  on public.order_messages
  for update
  using (
    exists (
      select 1 from public.orders o
       where o.id = order_messages.order_id
         and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    )
  )
  with check (
    sender_id <> auth.uid()
  );

-- ── Helpers ─────────────────────────────────────────────────────────

-- Mark every unread message in a thread as read for the calling user.
-- Single round-trip from the client. Returns the number of messages
-- flipped. Buyer / seller / admin only — RLS gates the implicit access.
create or replace function public.mark_order_messages_read(p_order_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  if auth.uid() is null then
    return 0;
  end if;
  update public.order_messages
     set read_at = now()
   where order_messages.order_id = p_order_id
     and order_messages.sender_id <> auth.uid()
     and order_messages.read_at is null
     and exists (
       select 1 from public.orders o
        where o.id = p_order_id
          and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
     );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
grant execute on function public.mark_order_messages_read(uuid) to authenticated;

-- Returns the count of unread messages across every order the calling
-- user is a participant on. Drives the Orders nav-tab badge so the
-- user notices new messages without opening each order.
create or replace function public.unread_order_messages_count()
returns int
language sql
security definer
set search_path = public
as $$
  select count(*)::int
    from public.order_messages m
    join public.orders o on o.id = m.order_id
   where m.sender_id <> auth.uid()
     and m.read_at is null
     and (o.buyer_id = auth.uid() or o.seller_id = auth.uid());
$$;
grant execute on function public.unread_order_messages_count() to authenticated;

comment on table public.order_messages is
  'Buyer↔seller chat per marketplace order. RLS-scoped to the two parties.';
