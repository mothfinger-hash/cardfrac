-- ─────────────────────────────────────────────────────────────────────────
-- Phase 2: per-seller Shippo accounts via OAuth.
--
-- Each seller connects their OWN Shippo account; label purchases then bill
-- the seller directly (Authorization: Bearer <their token>). The OAuth access
-- token never expires (per Shippo docs), so no refresh column is needed.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists shippo_oauth_token  text;
alter table public.profiles add column if not exists shippo_connected_at timestamptz;

-- Short-lived CSRF state for the OAuth handshake: maps the random `state` we
-- send to Shippo back to the user who initiated it, so the callback knows
-- whose token to store. Written/read only by the service-role OAuth functions.
create table if not exists public.shippo_oauth_states (
  state      text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.shippo_oauth_states enable row level security;
-- No policies on purpose: only the service role (the OAuth Vercel functions)
-- touches this table, and service role bypasses RLS. anon/authenticated get
-- no access.
