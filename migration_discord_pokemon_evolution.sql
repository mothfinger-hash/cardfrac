-- ============================================================
-- PathBinder — Discord Pokémon evolution columns
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Additive: extends bot_pokemon with the two columns needed for the
-- evolution system. No data loss; existing rows back-fill cleanly.
--
--   original_pokemon_id  — the starter the trainer first picked. Stays
--                          constant across evolutions so /profile can
--                          show "originally a Charmander" and so the
--                          evolution chain can be looked up correctly
--                          even after the pokemon has evolved twice.
--
--   allow_evolution      — if false, the pokemon never evolves on
--                          level-up. Matches the "press B to cancel
--                          evolution" toggle from the Pokémon games.
--                          Default true.
-- ============================================================

ALTER TABLE public.bot_pokemon
  ADD COLUMN IF NOT EXISTS original_pokemon_id int,
  ADD COLUMN IF NOT EXISTS allow_evolution     boolean NOT NULL DEFAULT true;

-- Back-fill: existing rows treat their current pokemon as the
-- "starter" so the evolution-chain lookup keeps working for them.
UPDATE public.bot_pokemon
  SET original_pokemon_id = pokemon_id
  WHERE original_pokemon_id IS NULL;

-- ============================================================
-- Verify:
--   SELECT discord_user_id, pokemon_name, original_pokemon_id,
--          allow_evolution FROM bot_pokemon LIMIT 5;
-- ============================================================
