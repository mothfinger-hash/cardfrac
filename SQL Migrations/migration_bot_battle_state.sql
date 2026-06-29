-- ============================================================
-- PathBinder — /battle mode:full state table
--
-- Tier 2 battles are multi-turn (HP bars, type effectiveness,
-- pick-a-move buttons each turn). Discord interactions are stateless
-- so we persist the in-flight battle in the database; each move
-- button click reads the current state, applies the action, and
-- writes the new state back.
--
-- Run in: Supabase Dashboard → SQL Editor → New query.
-- Idempotent.
-- ============================================================

create table if not exists public.bot_battle_state (
  id                  uuid          primary key default gen_random_uuid(),

  -- Participants
  challenger_id       text          not null,
  opponent_id         text          not null,

  -- Snapshots of each side's Pokémon at battle start. JSON so we
  -- can store the full state (name, current form id, level, types,
  -- starter_id, original_pokemon_id) without joining bot_pokemon on
  -- every move resolution.
  challenger_pokemon  jsonb         not null,
  opponent_pokemon    jsonb         not null,

  -- Live HP per side. Initialized from level via pokemonHp(level)
  -- = level*10 + 35 (so a Lv 10 has 135 HP, Lv 36 has 395).
  challenger_hp       integer       not null,
  opponent_hp         integer       not null,
  challenger_max_hp   integer       not null,
  opponent_max_hp     integer       not null,

  -- Turn metadata. current_turn names which side picks next.
  -- 'challenger' on first move; alternates each click.
  current_turn        text          not null check (current_turn in ('challenger','opponent')),
  turn_count          integer       not null default 0,

  -- Lifecycle. 'pending' = accept button hasn't been clicked yet.
  -- 'in_progress' = battle accepted, players are taking turns.
  -- 'finished' = HP hit 0 on one side OR turn limit reached.
  status              text          not null check (status in ('pending','in_progress','finished','declined','expired')) default 'pending',
  winner_discord_id   text,

  -- Turn-by-turn event log. Each entry is { actor, move, damage,
  -- effectiveness, defenderHpAfter, missed }. Used to render the
  -- recap embed and (later) any analytics on which moves win most.
  log                 jsonb         not null default '[]'::jsonb,

  -- Discord context — channel + message ids for editing the battle
  -- message via the REST API once interaction tokens expire.
  channel_id          text,
  guild_id            text,
  message_id          text,

  -- XP awarded (populated when status flips to 'finished').
  challenger_xp_gained integer      not null default 0,
  opponent_xp_gained   integer      not null default 0,

  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now()
);

-- Lookup index for the move-button handler: 'find me the active
-- battle for this (challenger, opponent) pair'.
create index if not exists idx_bot_battle_state_active
  on public.bot_battle_state (challenger_id, opponent_id, status, created_at desc);

-- Sweep helper for the future expiration job — pending battles
-- that no one accepted should age out at, say, 5 minutes; in-progress
-- battles where someone walked away should age out at 15 minutes
-- (matches Discord's interaction-token window).
create index if not exists idx_bot_battle_state_age
  on public.bot_battle_state (status, created_at)
  where status in ('pending','in_progress');

alter table public.bot_battle_state enable row level security;

-- Service-role only — battles are bot-managed, no direct user access.
drop policy if exists "bot_battle_state service role only" on public.bot_battle_state;
create policy "bot_battle_state service role only"
  on public.bot_battle_state for all
  to service_role
  using (true) with check (true);

-- ============================================================
-- Verify:
--   SELECT count(*) FROM public.bot_battle_state;
--   SELECT column_name, data_type FROM information_schema.columns
--     WHERE table_name = 'bot_battle_state'
--     ORDER BY ordinal_position;
-- ============================================================
