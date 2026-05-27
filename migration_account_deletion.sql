-- migration_account_deletion.sql
--
-- Self-service account deletion (App Store Guideline 5.1.1(v) — required
-- for every app that lets users create accounts). The flow:
--
--   1. User clicks "Delete Account" → confirmation modal.
--   2. /api/delete-account stamps deletion_requested_at = now() and
--      deletion_scheduled_for = now() + 30 days on profiles. Also
--      cancels any active Stripe subscription + deactivates listings
--      so the account stops accruing obligations during the grace.
--   3. User can cancel by signing in any time before the scheduled date
--      (clears both columns).
--   4. A daily sweeper (admin-run for now; cron later) selects
--      profiles where deletion_scheduled_for < now() and runs the hard
--      purge — auth.users delete + content anonymization.
--
-- We do NOT cascade-delete the user's marketplace history. Orders and
-- listings get anonymized in place (seller_id stays pointing at the
-- profile row; the row's name becomes 'Deleted User') so the
-- COUNTERPARTY can still see their own purchase / sale history. Apple's
-- guideline only requires deleting the USER's personal data, not the
-- shared transaction record (which the counterparty has a legitimate
-- reason to retain).

alter table public.profiles
  add column if not exists deletion_requested_at  timestamptz,
  add column if not exists deletion_scheduled_for timestamptz,
  add column if not exists deleted_at             timestamptz,
  add column if not exists is_deleted             boolean not null default false;

-- Index supporting the daily sweep query.
create index if not exists profiles_deletion_scheduled_idx
  on public.profiles (deletion_scheduled_for)
  where deletion_scheduled_for is not null and deleted_at is null;

-- ── Sign-in gate ────────────────────────────────────────────────────────
-- The client calls this right after auth.signInWithPassword resolves —
-- if it returns true the client immediately signs out and shows a
-- "deleted" message.
create or replace function public.is_account_deleted(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(is_deleted, false)
    from profiles
   where id = p_user_id
   limit 1;
$$;
grant execute on function public.is_account_deleted(uuid) to authenticated, anon;

-- ── Counterparty display ────────────────────────────────────────────────
-- A view to use anywhere the client currently joins profiles for display
-- (seller name on a listing, buyer name on an order row). When the
-- underlying profile is deleted, name/username return the generic
-- placeholder rather than a real handle. Built dynamically because we
-- don't know which display columns exist on this database (some have
-- `name`, some `username`, some both). The view picks up whichever
-- exist and falls back to '(unknown)' if neither is present.
do $$
declare
  has_name        boolean := exists (select 1 from information_schema.columns
                                       where table_schema='public' and table_name='profiles' and column_name='name');
  has_username    boolean := exists (select 1 from information_schema.columns
                                       where table_schema='public' and table_name='profiles' and column_name='username');
  has_avatar      boolean := exists (select 1 from information_schema.columns
                                       where table_schema='public' and table_name='profiles' and column_name='avatar_url');
  has_avatar_st   boolean := exists (select 1 from information_schema.columns
                                       where table_schema='public' and table_name='profiles' and column_name='avatar_state');
  has_sub_tier    boolean := exists (select 1 from information_schema.columns
                                       where table_schema='public' and table_name='profiles' and column_name='subscription_tier');
  name_expr       text;
  username_expr   text;
  avatar_expr     text;
  avatar_st_expr  text;
  sub_tier_expr   text;
  cols            text;
begin
  -- name column
  if has_name then
    name_expr := 'case when p.is_deleted then ''Deleted User'' else p.name end as name';
  else
    name_expr := '''Deleted User''::text as name';
  end if;

  -- username column
  if has_username then
    username_expr := 'case when p.is_deleted then ''deleted_user'' else p.username end as username';
  else
    username_expr := '''deleted_user''::text as username';
  end if;

  -- avatar_url column (optional)
  if has_avatar then
    avatar_expr := 'case when p.is_deleted then null else p.avatar_url end as avatar_url';
  else
    avatar_expr := 'null::text as avatar_url';
  end if;

  -- avatar_state column (optional — used by our hologram avatar widget)
  if has_avatar_st then
    avatar_st_expr := 'case when p.is_deleted then null else p.avatar_state end as avatar_state';
  else
    avatar_st_expr := 'null::jsonb as avatar_state';
  end if;

  -- subscription_tier column
  if has_sub_tier then
    sub_tier_expr := 'p.subscription_tier';
  else
    sub_tier_expr := 'null::text as subscription_tier';
  end if;

  cols := 'p.id, ' || name_expr || ', ' || username_expr || ', '
       || avatar_expr || ', ' || avatar_st_expr || ', '
       || 'p.is_deleted, ' || sub_tier_expr;

  execute 'create or replace view public.public_profiles_display as
             select ' || cols || ' from public.profiles p';
end $$;

grant select on public.public_profiles_display to authenticated, anon;

-- ── Hard-purge helper ───────────────────────────────────────────────────
-- Called by the sweep job (or an admin button) for each profile whose
-- deletion_scheduled_for has elapsed. Anonymizes the row, marks
-- deleted_at, and clears every PII column that EXISTS on this database.
-- We use dynamic SQL so the function works regardless of which optional
-- profile fields (bio, address, phone, etc.) are present.
--
-- The original id stays so foreign keys (orders.seller_id etc.) still
-- join correctly — they just join to a stripped row.
create or replace function public.purge_user_profile(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Columns we'd like to clear if present. Each entry is (column_name,
  -- value_expression). The function probes information_schema for each
  -- and skips any that don't exist on this database.
  candidates text[][] := array[
    ['name',                              quote_literal('Deleted User')],
    ['username',                          quote_literal('deleted_user_' || replace(p_user_id::text,'-',''))],
    ['email',                             'null'],
    ['avatar_url',                        'null'],
    ['avatar_state',                      'null'],
    ['bio',                               'null'],
    ['address',                           'null'],
    ['city',                              'null'],
    ['state',                             'null'],
    ['zip',                               'null'],
    ['country',                           'null'],
    ['phone',                             'null'],
    ['stripe_customer_id',                'null'],
    ['stripe_subscription_id',            'null'],
    ['stripe_connect_account_id',         'null'],
    ['stripe_connect_charges_enabled',    'false'],
    ['stripe_connect_payouts_enabled',    'false'],
    ['stripe_connect_details_submitted',  'false'],
    ['stripe_connect_requirements',       'null'],
    ['watchlist',                         '''[]''::jsonb'],
    ['referred_by',                       'null']
  ];
  parts  text[] := '{}';
  i      int;
  col    text;
  expr   text;
  sql    text;
begin
  for i in 1 .. array_length(candidates, 1) loop
    col  := candidates[i][1];
    expr := candidates[i][2];
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name = col
    ) then
      parts := array_append(parts, format('%I = %s', col, expr));
    end if;
  end loop;

  -- Always set is_deleted + deleted_at (we added these unconditionally
  -- above). These flip last so any concurrent reader sees cleaned data
  -- before the flag flips.
  parts := array_append(parts, 'is_deleted = true');
  parts := array_append(parts, 'deleted_at = now()');

  sql := 'update public.profiles set ' || array_to_string(parts, ', ')
      || ' where id = ' || quote_literal(p_user_id::text) || '::uuid';
  execute sql;

  -- Deactivate any still-active listings so nobody can buy from a ghost.
  -- DON'T delete them — admin / dispute resolution may still need the row.
  update public.listings
     set status = 'deactivated'
   where seller_id = p_user_id
     and status in ('active','available');
end;
$$;
grant execute on function public.purge_user_profile(uuid) to service_role;

-- ── Daily sweep helper ──────────────────────────────────────────────────
-- Returns the list of user ids whose grace has elapsed. The caller (admin
-- script or cron) iterates and calls purge_user_profile() on each.
create or replace function public.list_pending_account_purges()
returns table(user_id uuid, scheduled_for timestamptz)
language sql
security definer
set search_path = public
as $$
  select id, deletion_scheduled_for
    from profiles
   where deletion_scheduled_for is not null
     and deletion_scheduled_for < now()
     and (is_deleted = false or deleted_at is null);
$$;
grant execute on function public.list_pending_account_purges() to service_role;

comment on column public.profiles.deletion_requested_at is
  'Self-service deletion request timestamp. NULL = no pending request.';
comment on column public.profiles.deletion_scheduled_for is
  '30-day grace period end. Hard-purge sweep selects rows past this.';
comment on column public.profiles.is_deleted is
  'True once purge_user_profile() has stripped the PII columns.';
