-- ============================================================
-- PathBinder — set_metadata table
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- The Sets page was pulling set logos + symbols straight from
-- pokemontcg.io's CDN — Lighthouse showed 35 MB transferred from
-- that origin on a single page visit. By mirroring the logos to
-- Supabase Storage and tracking them in this table, we cut the
-- third-party dependency and serve everything from a host the
-- service worker can cache aggressively.
--
-- The table also stores release_date and printed/total card counts
-- which pokemontcg.io carries but our catalog doesn't, so we don't
-- have to round-trip the API just for those fields.
--
-- Populated by:
--   python3 mirror_set_logos.py
--
-- Read by:
--   loadSetsPage() in index.html (enriches the pokemontcg.io fetch
--   results with mirrored URLs when a row exists for that set id).

CREATE TABLE IF NOT EXISTS public.set_metadata (
  -- Set id matches pokemontcg.io's id field (e.g. "sv8", "crz",
  -- "swsh12pt5"). For non-Pokemon TCGs we mirror this from our own
  -- catalog set_code.
  id              text PRIMARY KEY,
  name            text NOT NULL,
  series          text,                     -- e.g. "Scarlet & Violet", "Sword & Shield"
  game_type       text NOT NULL DEFAULT 'pokemon',
  release_date    date,
  printed_total   int,                      -- the printed numbering total
  total           int,                      -- includes secret rares
  -- Mirrored Supabase Storage URLs. logo is the full set logo
  -- (wider, includes set name text); symbol is the tiny ~100x100
  -- icon. UI prefers logo for the sets index and symbol for compact
  -- contexts.
  logo_url        text,
  symbol_url      text,
  -- Track when we last fetched so a periodic re-mirror can skip
  -- recently-updated rows.
  mirrored_at     timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Index for the loadSetsPage enrichment lookup. The page fetches
-- pokemontcg.io's full sets list (~250 rows) and then joins each
-- by id against this table. A PK index already covers id lookup,
-- but having a composite (game_type, release_date) helps the
-- non-Pokemon TCG paths that want to list mirrored sets by
-- recency.
CREATE INDEX IF NOT EXISTS idx_set_metadata_game_release
  ON public.set_metadata (game_type, release_date DESC);

-- RLS — public read, service-role write. The Sets page is
-- visible to logged-out users so we need anon access to read.
ALTER TABLE public.set_metadata ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "set_metadata_public_read" ON public.set_metadata;
CREATE POLICY "set_metadata_public_read"
  ON public.set_metadata
  FOR SELECT
  USING (true);

-- updated_at auto-bump trigger so we don't have to remember to
-- set it on every upsert.
CREATE OR REPLACE FUNCTION public.set_metadata_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_metadata_touch_updated_at ON public.set_metadata;
CREATE TRIGGER set_metadata_touch_updated_at
  BEFORE UPDATE ON public.set_metadata
  FOR EACH ROW
  EXECUTE FUNCTION public.set_metadata_touch_updated_at();

-- ── Storage bucket for set logos ─────────────────────────────
-- Public bucket so the URLs in logo_url / symbol_url resolve
-- without auth. Cached by the SW + browser. mirror_set_logos.py
-- creates the bucket via the storage API if missing, but
-- doing it here too is harmless and useful for fresh project
-- setups.
INSERT INTO storage.buckets (id, name, public)
  VALUES ('set-logos', 'set-logos', true)
  ON CONFLICT (id) DO NOTHING;

-- Allow public read on objects in the set-logos bucket. The
-- service role bypasses RLS for writes from the Python script.
DROP POLICY IF EXISTS "set_logos_public_read" ON storage.objects;
CREATE POLICY "set_logos_public_read"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'set-logos');
