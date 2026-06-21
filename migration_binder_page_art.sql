-- Michi Method page artwork.
-- Stores a per-page background image + pan/zoom transform on the binder,
-- keyed by 1-based page number. Empty pockets on that page reveal the art;
-- cards render on top. x/y are translate offsets normalised to the page
-- frame (fraction of width/height) so a saved position reproduces at any
-- render size. scale is a zoom multiplier (1 = cover-fit baseline).
--
--   page_art = {
--     "1": { "url": "https://…", "scale": 1.4, "x": 0.05, "y": -0.12 },
--     "3": { "url": "https://…", "scale": 1.0, "x": 0,    "y": 0 }
--   }
--
-- Idempotent.
alter table public.binders
  add column if not exists page_art jsonb not null default '{}'::jsonb;
