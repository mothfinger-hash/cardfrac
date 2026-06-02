#!/usr/bin/env node
// scripts/register_discord_commands.js
// ──────────────────────────────────────────────────────────────────────
// One-time setup: POST the slash command definitions to Discord so they
// appear in the slash autocomplete UI. Run this:
//   • Once after the bot is first added to your server.
//   • Every time you add / change a command definition in this file.
//
// Discord caches command definitions globally OR per-guild. Per-guild
// registration propagates in seconds (handy for iterating during beta);
// global registration takes up to an hour. We default to per-guild for
// PathBinder's single-server use case.
//
// USAGE:
//   DISCORD_APP_ID=...  \
//   DISCORD_BOT_TOKEN=... \
//   DISCORD_GUILD_ID=... \
//     node scripts/register_discord_commands.js
//
//   # Or for global registration (only if running multiple servers):
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... \
//     node scripts/register_discord_commands.js --global
// ──────────────────────────────────────────────────────────────────────

const APP_ID    = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID  = process.env.DISCORD_GUILD_ID;
const GLOBAL    = process.argv.includes('--global');

if (!APP_ID || !BOT_TOKEN) {
  console.error('Missing DISCORD_APP_ID and/or DISCORD_BOT_TOKEN env vars.');
  process.exit(1);
}
if (!GLOBAL && !GUILD_ID) {
  console.error('Missing DISCORD_GUILD_ID. Pass --global to register globally instead.');
  process.exit(1);
}

// Discord command types:
//   1 = CHAT_INPUT (slash command)
//   2 = USER (right-click user → Apps)
//   3 = MESSAGE (right-click message → Apps)
// Option types we use: 3 = STRING, 4 = INTEGER, 10 = NUMBER (float).
const commands = [
  // ── Linking & roles ─────────────────────────
  { name: 'link', type: 1, description: 'Link your Discord account to PathBinder' },
  { name: 'tier', type: 1, description: 'Re-sync your Discord role with your PathBinder subscription tier' },

  // ── Look-up ─────────────────────────────────
  { name: 'price', type: 1, description: 'Look up the price of a card', options: [
    { name: 'card', description: 'Card name (e.g. Charizard, Blue-Eyes White Dragon)', type: 3, required: true },
  ] },
  { name: 'set', type: 1, description: 'Set info: card count, completion %, most valuable', options: [
    { name: 'name', description: 'Set name or code (e.g. "Blazing Dominion", BLZD)', type: 3, required: true },
  ] },
  { name: 'random', type: 1, description: 'Surprise me with a random card', options: [
    { name: 'game', description: 'pokemon (default), magic, yugioh, onepiece, gundam, dbz', type: 3, required: false },
  ] },
  { name: 'marketplace', type: 1, description: 'Cheapest active listings for a card', options: [
    { name: 'card', description: 'Card name', type: 3, required: true },
  ] },

  // ── Personal / DM ───────────────────────────
  { name: 'portfolio', type: 1, description: 'DM yourself a collection summary' },
  { name: 'wishlist',  type: 1, description: 'DM your top wishlist cards + savings progress' },
  { name: 'listings',  type: 1, description: 'Your active marketplace listings' },
  { name: 'sales',     type: 1, description: 'Sales summary (Enthusiast+)', options: [
    { name: 'period', description: 'week | month (default) | year', type: 3, required: false },
  ] },
  { name: 'badge',     type: 1, description: 'Your earned badges' },

  // ── Community ───────────────────────────────
  { name: 'showcase', type: 1, description: 'Public spotlight on a card', options: [
    { name: 'card', description: 'Card name', type: 3, required: true },
  ] },
  { name: 'movers',   type: 1, description: 'Biggest movers — your collection (if linked) or market', options: [
    { name: 'period', description: '7d (default) | 24h', type: 3, required: false },
    { name: 'scope',  description: 'global (default) | personal', type: 3, required: false },
    { name: 'game',   description: 'all (cross-TCG) | pokemon (default) | magic | yugioh | onepiece | gundam | dbz', type: 3, required: false, choices: [
      { name: 'All TCGs',                value: 'all'      },
      { name: 'Pokémon',                 value: 'pokemon'  },
      { name: 'Magic: The Gathering',    value: 'magic'    },
      { name: 'Yu-Gi-Oh!',               value: 'yugioh'   },
      { name: 'One Piece',               value: 'onepiece' },
      { name: 'Gundam',                  value: 'gundam'   },
      { name: 'Dragon Ball Z',           value: 'dbz'      },
    ] },
  ] },
  { name: 'duel', type: 1, description: 'Challenge someone to a card duel — they accept, then play', options: [
    { name: 'opponent', description: 'Who to duel', type: 6, required: true },
    { name: 'game',     description: 'pokemon (default), magic, yugioh, onepiece, gundam, dbz', type: 3, required: false },
    { name: 'rounds',   description: '3 (default, best of 3) | 1 (single pull)', type: 4, required: false },
  ] },

  // ── Pokémon game loop ──────────────────────────
  { name: 'starter', type: 1, description: 'Pick (or change) your starter Pokémon', options: [
    { name: 'pokemon',     description: 'Your starter (autocompletes — type a few letters)', type: 3, required: true, autocomplete: true },
    { name: 'auto_evolve', description: 'Evolve at standard levels? Default true. Set false to keep your starter form forever.', type: 5, required: false },
  ] },
  { name: 'profile', type: 1, description: 'Show your starter Pokémon, level, XP, and W/L', options: [
    { name: 'user', description: 'Whose profile to view (defaults to you)', type: 6, required: false },
  ] },
  { name: 'leaderboard', type: 1, description: 'Top portfolios (opt-in only)' },
  { name: 'trade-open',  type: 1, description: 'Start a Trade Analyzer session you can share' },

  // ── Alerts ─────────────────────────────────
  { name: 'track', type: 1, description: 'DM me when a card crosses a price threshold', options: [
    { name: 'card',      description: 'Card name', type: 3, required: true },
    { name: 'threshold', description: 'USD threshold (e.g. 50)', type: 10, required: true },
    { name: 'direction', description: 'above (default) | below', type: 3, required: false },
  ] },
  { name: 'untrack', type: 1, description: 'Stop tracking a card', options: [
    { name: 'card', description: 'Card name', type: 3, required: true },
  ] },

  // ── Feedback ───────────────────────────────
  { name: 'bug', type: 1, description: 'Report a bug to the PathBinder team', options: [
    { name: 'description', description: 'What happened? Include steps to reproduce if you can.', type: 3, required: true },
  ] },

  // ── Admin ───────────────────────────────────
  { name: 'usercount', type: 1, description: '[admin] Total users + recent signups' },

  // ── Discovery ──────────────────────────────
  { name: 'help', type: 1, description: 'List every PathBinder bot command' },

  // ── Message-context (right-click message → Apps) ─────────────
  { name: 'File as Bug',      type: 3 },
  { name: 'Track Card Price', type: 3 },
];

const url = GLOBAL
  ? `https://discord.com/api/v10/applications/${APP_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`;

(async () => {
  console.log(`Registering ${commands.length} commands (${GLOBAL ? 'global' : 'guild ' + GUILD_ID})…`);
  const r = await fetch(url, {
    method: 'PUT', // PUT replaces the full command list — idempotent
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!r.ok) {
    const body = await r.text();
    console.error(`Failed (${r.status}):`, body);
    process.exit(1);
  }
  const data = await r.json();
  console.log(`✓ Registered ${data.length} commands:`);
  data.forEach(c => console.log(`  /${c.name} — ${c.description}`));
  if (!GLOBAL) console.log('Per-guild registration — slash commands should appear immediately.');
  else        console.log('Global registration — may take up to an hour to propagate.');
})();
