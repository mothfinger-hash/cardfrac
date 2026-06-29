-- ─────────────────────────────────────────────────────────────────────────
-- Security hardening — lock down revenue metrics + per-user DM counts.
--
-- Fixes three Security-Advisor findings that are genuine leaks:
--   • shop_seller_metrics        — was readable by anon: every shop's GMV /
--                                  earnings / unique-buyers exposed publicly.
--   • shop_tier_platform_metrics — was readable by anon: platform-wide GMV +
--                                  total seller earnings exposed publicly.
--   • dm_unread_counts           — returned EVERY user's unread count to any
--                                  logged-in user (no self-filter).
--
-- Legitimate readers keep working unchanged:
--   • Admins        → full shop table + platform rollup (via RPCs below)
--   • A shop owner  → their OWN shop_seller_metrics row only
--   • A user        → their OWN unread DM count only
--
-- Also flips the two catalog review-queue views to security_invoker so they
-- stop tripping the "Security Definer View" check (they read public catalog
-- data, so behavior is unchanged).
--
-- Admin = profiles.is_admin (same mechanism as migration_admin_moderation.sql).
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Shop metrics — revoke public access, expose via gated RPCs ─────────────
revoke select on public.shop_seller_metrics        from anon, authenticated;
revoke select on public.shop_tier_platform_metrics from anon, authenticated;

-- Per-shop metrics: a shop sees ONLY its own row; admins see all (top 50 by GMV).
create or replace function public.get_shop_seller_metrics(p_seller_id uuid default null)
returns setof public.shop_seller_metrics
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_is_admin boolean;
begin
  select coalesce(is_admin, false) into caller_is_admin
  from public.profiles where id = auth.uid();

  if caller_is_admin then
    return query
      select * from public.shop_seller_metrics
      where (p_seller_id is null or seller_id = p_seller_id)
      order by gross_gmv desc
      limit 50;
  else
    -- Non-admins can only ever read their OWN shop row.
    return query
      select * from public.shop_seller_metrics
      where seller_id = auth.uid();
  end if;
end;
$$;

-- Platform-wide rollup: admins only (returns nothing for everyone else).
create or replace function public.get_shop_platform_metrics()
returns setof public.shop_tier_platform_metrics
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_is_admin boolean;
begin
  select coalesce(is_admin, false) into caller_is_admin
  from public.profiles where id = auth.uid();

  if caller_is_admin then
    return query select * from public.shop_tier_platform_metrics;
  end if;
  return;  -- non-admins: empty
end;
$$;

revoke all on function public.get_shop_seller_metrics(uuid) from public;
revoke all on function public.get_shop_platform_metrics()   from public;
grant execute on function public.get_shop_seller_metrics(uuid) to authenticated;
grant execute on function public.get_shop_platform_metrics()   to authenticated;

-- 2) DM unread counts — only ever return the caller's own row ───────────────
create or replace view public.dm_unread_counts as
  select recipient_id as user_id, count(*)::int as unread
  from public.direct_messages
  where read_at is null
    and recipient_id = auth.uid()
  group by recipient_id;
alter view public.dm_unread_counts set (security_invoker = true);
grant select on public.dm_unread_counts to authenticated;

-- 3) Catalog review queues — respect caller RLS, clears the definer-view flag.
--    Underlying catalog is public-read, so behavior is unchanged.
alter view public.catalog_bg_review_queue     set (security_invoker = true);
alter view public.catalog_sealed_needs_review set (security_invoker = true);
