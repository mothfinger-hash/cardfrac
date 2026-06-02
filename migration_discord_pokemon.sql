-- ============================================================
-- PathBinder — Discord Bot Pokémon Game Loop
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Paste the entire file at once.
--
-- Adds two tables that power the /starter, /duel, and /profile
-- commands:
--
--   bot_pokemon    — one row per linked Discord user. Holds the
--                    chosen starter, level, total xp, and W/L/T
--                    counts. Keyed by discord_user_id (text — same
--                    shape Discord sends) so we never depend on the
--                    PathBinder auth user_id being present.
--
--   bot_duel_log   — append-only log of every challenge sent. Used
--                    for cooldown checks ("did you challenge anyone
--                    in the last 10s?") and historical lookups.
--
-- Idempotent — safe to re-run. RLS is on; service-role bypasses it
-- so the bot can write, anon/authenticated get a read-only view via
-- the leaderboard query path.
-- ============================================================


-- ── bot_pokemon ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_pokemon (
  discord_user_id text        PRIMARY KEY,
  pokemon_id      int         NOT NULL,    -- national pokedex number
  pokemon_name    text        NOT NULL,    -- denormalized for display
  level           int         NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 99),
  xp              int         NOT NULL DEFAULT 0 CHECK (xp >= 0),
  wins            int         NOT NULL DEFAULT 0,
  losses          int         NOT NULL DEFAULT 0,
  ties            int         NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bot_pokemon IS
  'Per-Discord-user pokemon record for the bot duel game loop. One row per user.';

CREATE INDEX IF NOT EXISTS idx_bot_pokemon_level
  ON public.bot_pokemon (level DESC, xp DESC);

ALTER TABLE public.bot_pokemon ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read bot_pokemon" ON public.bot_pokemon;
CREATE POLICY "Public can read bot_pokemon"
  ON public.bot_pokemon FOR SELECT
  TO anon, authenticated USING (true);


-- ── bot_duel_log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_duel_log (
  id                    bigserial PRIMARY KEY,
  challenger_discord_id text        NOT NULL,
  opponent_discord_id   text        NOT NULL,
  game                  text        NOT NULL DEFAULT 'pokemon',
  rounds                int         NOT NULL DEFAULT 3,
  status                text        NOT NULL DEFAULT 'pending',
                        -- pending | accepted | declined | expired
  winner_discord_id     text,
  challenger_xp_gained  int         NOT NULL DEFAULT 0,
  opponent_xp_gained    int         NOT NULL DEFAULT 0,
  result_summary        jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz
);

COMMENT ON TABLE public.bot_duel_log IS
  'Append-only audit + cooldown source for /duel challenges. Pending rows become accepted/declined/expired.';

-- Cooldown lookups: "what was the challenger's most recent send?"
CREATE INDEX IF NOT EXISTS idx_bot_duel_log_challenger_recent
  ON public.bot_duel_log (challenger_discord_id, created_at DESC);
-- "what was the most recent challenge in either direction between this pair?"
CREATE INDEX IF NOT EXISTS idx_bot_duel_log_pair_recent
  ON public.bot_duel_log (challenger_discord_id, opponent_discord_id, created_at DESC);

ALTER TABLE public.bot_duel_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read bot_duel_log" ON public.bot_duel_log;
CREATE POLICY "Public can read bot_duel_log"
  ON public.bot_duel_log FOR SELECT
  TO anon, authenticated USING (true);


-- ============================================================
-- Verify after running:
--   SELECT count(*) FROM bot_pokemon;
--   SELECT count(*) FROM bot_duel_log;
-- ============================================================
