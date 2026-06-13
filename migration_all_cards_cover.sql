-- All-Cards binder cover: lets a user replace the virtual "All Cards"
-- binder's preset cover (it has no binders row to hang a cover on).
-- The image lives in the binder-covers bucket at <uid>/all-cards.webp;
-- this column stores the resolved public URL so it syncs across devices.
-- Idempotent.
alter table public.profiles
  add column if not exists all_cards_cover_url text;
