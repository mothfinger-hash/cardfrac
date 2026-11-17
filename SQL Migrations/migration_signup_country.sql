-- migration_signup_country.sql
-- Durable per-account country stamp.
--
-- Captured server-side from Vercel's edge geo header (x-vercel-ip-country)
-- on the account's first authenticated request, by /api/stamp-geo.js.
-- Country-level only (ISO 3166-1 alpha-2) — no raw IP is stored, matching
-- the profiles PII posture (raw IPs are personal data; a country code isn't
-- the same exposure).
--
-- Why this exists: signup runs client-side (sb.auth.signUp / signInWithOtp
-- goes browser -> Supabase directly), so it never touches a Vercel function,
-- and Supabase's auth.audit_log_entries is empty/pruned. That left no durable
-- record of where accounts came from. This closes that gap going forward.
--
-- Idempotent: safe to re-run.

alter table public.profiles
  add column if not exists signup_country text;

comment on column public.profiles.signup_country is
  'ISO 3166-1 alpha-2 country of the account''s first authenticated request, '
  'stamped once (write-once) by /api/stamp-geo. NULL = not yet captured '
  '(pre-feature accounts stay NULL until their next login stamps them).';

-- Optional: a tiny index for the "signups by country" rollup query.
create index if not exists idx_profiles_signup_country
  on public.profiles (signup_country)
  where signup_country is not null;
