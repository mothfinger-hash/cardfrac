-- ============================================================
-- PathBinder — Giveaway RPC security hardening (URGENT)
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
--
-- BUG (confirmed live): giveaway_grant_subscriber_entries and
-- giveaway_draw_winners were created with the default PUBLIC execute grant
-- AND an admin gate written as `if auth.uid() is not null and not is_admin
-- then raise` — which lets a NULL-uid (anonymous, publishable-key) caller fall
-- straight through the gate. An anon curl to /rest/v1/rpc/giveaway_draw_winners
-- could force/re-run a draw (with a chosen seed) or spray grant calls.
--
-- FIX: remove the default PUBLIC execute grant. After this, only the explicit
-- grantees (authenticated — gated to admins inside the function — and
-- service_role) can execute. anon gets "permission denied for function".
-- Zero behavior change for the admin UI or service_role.
-- ============================================================

revoke execute on function public.giveaway_grant_subscriber_entries(uuid) from public;
revoke execute on function public.giveaway_draw_winners(uuid, text)        from public;

-- Belt-and-suspenders: also drop any stray anon grant.
revoke execute on function public.giveaway_grant_subscriber_entries(uuid) from anon;
revoke execute on function public.giveaway_draw_winners(uuid, text)        from anon;

-- ============================================================
-- Verify (as anon / publishable key — expect: "permission denied for function"):
--   select has_function_privilege('anon',
--     'public.giveaway_draw_winners(uuid, text)', 'EXECUTE');   -- expect f
--   select has_function_privilege('anon',
--     'public.giveaway_grant_subscriber_entries(uuid)', 'EXECUTE'); -- expect f
--   select has_function_privilege('authenticated',
--     'public.giveaway_draw_winners(uuid, text)', 'EXECUTE');   -- expect t (admin-gated inside)
-- ============================================================
