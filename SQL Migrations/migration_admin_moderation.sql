-- migration_admin_moderation.sql
--
-- Admin moderation primitives:
--   1. profiles.is_banned         — sign-in gate for ToS violations
--   2. profiles.banned_at / banned_reason — audit trail on bans
--   3. listings.status='suspended' — admin-hidden listing (vs. seller-
--      driven 'deactivated' which the seller can reverse themselves)
--   4. listings.suspended_reason — what the admin flagged
--   5. orders.admin_resolved_at / admin_resolution_note — closing notes
--      on a dispute resolved in the seller's favor (refunds are tracked
--      by the existing refunded_at + refund_id columns)
--
-- The 'suspended' listing status isn't a true enum so no schema change
-- needed — status is already a free-text column. We just standardize
-- the value here so the rest of the app can filter consistently.

alter table public.profiles
  add column if not exists is_banned     boolean not null default false,
  add column if not exists banned_at     timestamptz,
  add column if not exists banned_reason text,
  add column if not exists banned_by     uuid;

create index if not exists profiles_is_banned_idx
  on public.profiles (is_banned)
  where is_banned = true;

alter table public.listings
  add column if not exists suspended_reason text,
  add column if not exists suspended_at     timestamptz,
  add column if not exists suspended_by     uuid;

alter table public.orders
  add column if not exists admin_resolved_at      timestamptz,
  add column if not exists admin_resolution_note  text,
  add column if not exists admin_resolved_by      uuid;

-- ── Sign-in gate ────────────────────────────────────────────────────────
-- Mirrors is_account_deleted(). The client calls this right after
-- signInWithPassword; if true, immediate signOut + "account suspended"
-- toast. SECURITY DEFINER so banned users (whose RLS may be restricted)
-- can still read their own ban flag.
create or replace function public.is_account_banned(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(is_banned, false)
    from profiles
   where id = p_user_id
   limit 1;
$$;
grant execute on function public.is_account_banned(uuid) to authenticated, anon;

-- ── Admin actions ───────────────────────────────────────────────────────
-- Wrappers so the admin client doesn't need direct write access to the
-- moderation columns. Each function checks the caller IS an admin
-- before applying the change, so even if a malicious user got a JWT
-- they couldn't toggle bans.

create or replace function public.admin_set_user_banned(
  p_user_id uuid,
  p_banned  boolean,
  p_reason  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_is_admin boolean;
begin
  select coalesce(is_admin, false) into caller_is_admin
    from profiles where id = auth.uid();
  if not caller_is_admin then
    raise exception 'admin only';
  end if;

  if p_banned then
    update profiles set
      is_banned     = true,
      banned_at     = now(),
      banned_reason = p_reason,
      banned_by     = auth.uid()
    where id = p_user_id;

    -- Pull active listings off the market on ban so nobody buys from
    -- someone who can't sign in to ship.
    update listings
       set status = 'suspended',
           suspended_reason = coalesce(p_reason, 'Seller account banned'),
           suspended_at     = now(),
           suspended_by     = auth.uid()
     where seller_id = p_user_id
       and status in ('active', 'available');
  else
    update profiles set
      is_banned     = false,
      banned_at     = null,
      banned_reason = null,
      banned_by     = null
    where id = p_user_id;
    -- Note: we DON'T auto-reactivate listings on unban. Admin or seller
    -- has to do that explicitly — safer default.
  end if;
end;
$$;
grant execute on function public.admin_set_user_banned(uuid, boolean, text) to authenticated;

create or replace function public.admin_set_listing_suspended(
  p_listing_id uuid,
  p_suspended  boolean,
  p_reason     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_is_admin boolean;
begin
  select coalesce(is_admin, false) into caller_is_admin
    from profiles where id = auth.uid();
  if not caller_is_admin then
    raise exception 'admin only';
  end if;

  if p_suspended then
    update listings set
      status           = 'suspended',
      suspended_reason = p_reason,
      suspended_at     = now(),
      suspended_by     = auth.uid()
    where id = p_listing_id;
  else
    update listings set
      status           = 'available',
      suspended_reason = null,
      suspended_at     = null,
      suspended_by     = null
    where id = p_listing_id;
  end if;
end;
$$;
grant execute on function public.admin_set_listing_suspended(uuid, boolean, text) to authenticated;

-- Resolve a dispute IN THE SELLER's favor — no refund issued, order
-- status flips to 'completed' and the admin's notes are stamped on the
-- row. Buyer-favor resolution goes through the existing /api/refund-order
-- path which already exists.
create or replace function public.admin_resolve_dispute_for_seller(
  p_order_id uuid,
  p_note     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_is_admin boolean;
  current_status text;
begin
  select coalesce(is_admin, false) into caller_is_admin
    from profiles where id = auth.uid();
  if not caller_is_admin then
    raise exception 'admin only';
  end if;

  select status into current_status from orders where id = p_order_id;
  if current_status is null then
    raise exception 'order not found';
  end if;
  if current_status <> 'disputed' then
    raise exception 'order is not disputed (status: %)', current_status;
  end if;

  update orders set
    status                = 'completed',
    admin_resolved_at     = now(),
    admin_resolution_note = p_note,
    admin_resolved_by     = auth.uid()
  where id = p_order_id;
end;
$$;
grant execute on function public.admin_resolve_dispute_for_seller(uuid, text) to authenticated;

comment on column public.profiles.is_banned is
  'When true the user cannot sign in. Set via admin_set_user_banned().';
comment on column public.listings.suspended_reason is
  'Admin-supplied reason a listing was pulled. Surfaced to the seller so they know what to fix.';
