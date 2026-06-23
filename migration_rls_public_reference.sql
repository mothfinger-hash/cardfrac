-- ─────────────────────────────────────────────────────────────────────────
-- Security hardening — lock public reference tables to READ-ONLY.
--
-- catalog (cards) and set_map (set-code → name) are public reference data, so
-- open reads are intentional. But with RLS OFF, the anon/authenticated roles
-- could also WRITE/DELETE them. This enables RLS with a public SELECT policy
-- (every read keeps working) and NO write policies, so:
--   • anon / authenticated  → can SELECT, cannot INSERT/UPDATE/DELETE
--   • service_role (sync scripts, definer functions) → bypasses RLS, unaffected
--
-- Clears the "RLS Disabled in Public" (catalog, set_map) and the
-- "Sensitive Columns Exposed: catalog" advisor findings.
--
-- TEST AFTER RUNNING: Sets browse, card search/scanner, and the public binder
-- (all read catalog) should work unchanged. If an ADMIN catalog edit done from
-- the browser (authenticated key, not service-role) stops working, tell me and
-- we'll route it through a definer function.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- catalog ────────────────────────────────────────────────────────────────
alter table public.catalog enable row level security;
drop policy if exists "catalog_public_read" on public.catalog;
create policy "catalog_public_read" on public.catalog
  for select to anon, authenticated
  using (true);

-- set_map ────────────────────────────────────────────────────────────────
alter table public.set_map enable row level security;
drop policy if exists "set_map_public_read" on public.set_map;
create policy "set_map_public_read" on public.set_map
  for select to anon, authenticated
  using (true);
