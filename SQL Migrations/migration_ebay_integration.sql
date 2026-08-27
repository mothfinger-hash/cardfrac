-- ============================================================
-- PathBinder — eBay integration (Phase 1 foundation)
-- Run in: Supabase Dashboard → SQL Editor → New query. Idempotent.
--
-- Multi-channel inventory sync with eBay: when a seller marks an item sold in
-- PathBinder, we end/decrement the matching eBay listing (and, later, poll
-- eBay orders to decrement PathBinder shelf stock). This migration ships only
-- the DATA MODEL + safe client accessors; the OAuth flow, token refresh, and
-- the eBay API calls live in the Vercel /api/ebay/* serverless functions and
-- run with the SERVICE ROLE (never the client — tokens must not reach the
-- browser).
--
-- Two tables:
--   ebay_connections   — per-user OAuth tokens (service-role-only; NO client
--                        read policy, so a stolen anon key can't exfiltrate a
--                        refresh token). Clients see status via my_ebay_connection().
--   ebay_listing_links — maps a PathBinder item → an eBay listing, so a sale
--                        can find and decrement the right listing. No secrets,
--                        so the owner may read these directly.
-- ============================================================

-- 1. Per-user eBay OAuth connection (SERVICE-ROLE ONLY) --------------------
CREATE TABLE IF NOT EXISTS public.ebay_connections (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  ebay_user_id     text,                              -- eBay username / user id
  refresh_token    text not null,                     -- long-lived (~18mo); mints access tokens server-side
  access_token     text,                              -- short-lived cache (optional)
  token_expires_at timestamptz,                       -- access-token expiry
  scopes           text,
  status           text not null default 'active',    -- active / revoked / error
  last_error       text,
  connected_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id)                                    -- one eBay account per user (v1)
);
CREATE INDEX IF NOT EXISTS idx_ebay_connections_user ON public.ebay_connections(user_id);

ALTER TABLE public.ebay_connections ENABLE ROW LEVEL SECURITY;
-- Deliberately NO anon/authenticated policies: the service role bypasses RLS,
-- so only the serverless sync code can read tokens. The client reads status
-- through my_ebay_connection() below, never the tokens themselves.
DROP POLICY IF EXISTS "no client access to ebay tokens" ON public.ebay_connections;

-- 1b. Short-lived OAuth state (CSRF + maps the eBay redirect back to the user).
-- Mirrors shippo_oauth_states. Service-role only (the /api/ebay-* endpoints
-- read/write it); no client policies.
CREATE TABLE IF NOT EXISTS public.ebay_oauth_states (
  state      text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
ALTER TABLE public.ebay_oauth_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no client access to ebay oauth states" ON public.ebay_oauth_states;

-- 2. PathBinder item ↔ eBay listing map (owner-readable; no secrets) -------
CREATE TABLE IF NOT EXISTS public.ebay_listing_links (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  collection_item_id uuid references public.collection_items(id) on delete set null,
  api_card_id        text,                            -- catalog link (fallback match key)
  variant            text default 'normal',
  condition          text,
  ebay_item_id       text not null,                   -- eBay ItemID (Trading-model listing)
  ebay_sku           text,
  ebay_title         text,
  quantity           int,                             -- last-known eBay quantity
  last_synced_at     timestamptz,
  created_at         timestamptz not null default now(),
  unique (user_id, ebay_item_id)
);
CREATE INDEX IF NOT EXISTS idx_ebay_links_user       ON public.ebay_listing_links(user_id);
CREATE INDEX IF NOT EXISTS idx_ebay_links_item       ON public.ebay_listing_links(collection_item_id);
CREATE INDEX IF NOT EXISTS idx_ebay_links_card       ON public.ebay_listing_links(user_id, api_card_id, variant);

ALTER TABLE public.ebay_listing_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner reads own ebay links" ON public.ebay_listing_links;
CREATE POLICY "owner reads own ebay links" ON public.ebay_listing_links
  FOR SELECT TO authenticated USING (user_id = auth.uid());
-- Writes are service-role only (the sync worker populates + updates these).

-- 3. Safe client accessors --------------------------------------------------
-- Connection status WITHOUT exposing tokens.
CREATE OR REPLACE FUNCTION public.my_ebay_connection()
RETURNS TABLE(connected boolean, ebay_username text, status text, connected_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT true, c.ebay_user_id, c.status, c.connected_at
    FROM public.ebay_connections c
   WHERE c.user_id = auth.uid()
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.my_ebay_connection() TO authenticated;

-- Let a user disconnect eBay (revokes the stored grant on our side). The
-- serverless side should also revoke the token with eBay when it can.
CREATE OR REPLACE FUNCTION public.disconnect_ebay()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Must be signed in'; END IF;
  DELETE FROM public.ebay_connections WHERE user_id = auth.uid();
  DELETE FROM public.ebay_listing_links WHERE user_id = auth.uid();
END $$;
GRANT EXECUTE ON FUNCTION public.disconnect_ebay() TO authenticated;

-- Verify:
--   SELECT proname FROM pg_proc WHERE proname IN ('my_ebay_connection','disconnect_ebay');
--   SELECT * FROM public.my_ebay_connection();   -- empty until a seller connects
