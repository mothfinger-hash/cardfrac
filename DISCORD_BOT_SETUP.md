# PathBinder Discord Bot — Setup

End-to-end walk-through. Should take ~15 minutes from "no bot" to "users running /price".

## 1. Run the schema migration

Paste `migration_discord_bot.sql` into Supabase → SQL Editor → run. Creates `discord_links`, `discord_link_codes`, `bug_reports`.

## 2. Create the Discord application

1. Go to https://discord.com/developers/applications → **New Application** → name it "PathBinder".
2. On the **General Information** tab, copy the **Application ID** — you'll need this as `DISCORD_APP_ID`.
3. Scroll down on the same page to **Public Key** — copy this as `DISCORD_PUBLIC_KEY`.
4. Click **Bot** in the left sidebar. Click **Reset Token** and copy it as `DISCORD_BOT_TOKEN` (only shown once — save it now).
5. Under **Privileged Gateway Intents**, leave everything off (the bot uses HTTP interactions, not gateway).
6. Under **Bot Permissions**, tick **Manage Roles**, **Send Messages**, **Send Messages in Threads**, **Embed Links**, **Use Application Commands**.

## 3. Install the dependency

```bash
npm install
```

`tweetnacl` is now in `package.json` for ed25519 signature verification.

## 4. Deploy to Vercel

Push and let Vercel redeploy. Your endpoint will be:

```
https://pathbinder.gg/api/discord-bot
```

## 5. Set env vars in Vercel

Settings → Environment Variables, add:

| Variable | Value |
|---|---|
| `DISCORD_APP_ID` | from step 2.2 |
| `DISCORD_PUBLIC_KEY` | from step 2.3 |
| `DISCORD_BOT_TOKEN` | from step 2.4 |
| `DISCORD_GUILD_ID` | right-click your server in Discord (with Developer Mode on) → Copy Server ID |
| `DISCORD_ROLE_FREE` | role ID for the Free tier (Step 6) |
| `DISCORD_ROLE_COLLECTOR` | role ID for Collector |
| `DISCORD_ROLE_ENTHUSIAST` | role ID for Enthusiast |
| `DISCORD_ROLE_VENDOR` | role ID for Vendor |
| `DISCORD_ROLE_SHOP` | role ID for Shop |

Then redeploy so the new env vars are picked up.

## 6. Create tier roles in Discord

In your server, create one role per tier (Free, Collector, Enthusiast, Vendor, Shop). For each: right-click the role → Copy Role ID → paste into the matching `DISCORD_ROLE_*` env var. Make sure the bot's role sits **above** all of these in the role list, otherwise it can't assign them (Discord permissions are hierarchical).

## 7. Tell Discord about the endpoint

Back in the Discord developer portal → **General Information** → **Interactions Endpoint URL** → paste:

```
https://pathbinder.gg/api/discord-bot
```

Click **Save Changes**. Discord will PING the endpoint to verify it. If the save fails:
- Endpoint not deployed yet — wait for Vercel to finish.
- `DISCORD_PUBLIC_KEY` env var not set or wrong — re-check step 5.
- Vercel function crashing on PING — check Vercel logs.

## 8. Invite the bot to your server

Build an OAuth URL (replace `APP_ID`):

```
https://discord.com/oauth2/authorize?client_id=APP_ID&permissions=268435472&scope=bot+applications.commands
```

Open it in a browser, pick your server, authorize. The bot appears in your member list.

## 9. Register the slash commands

```bash
DISCORD_APP_ID=... \
DISCORD_BOT_TOKEN=... \
DISCORD_GUILD_ID=... \
  node scripts/register_discord_commands.js
```

Per-guild registration is instant. Type `/` in any channel and you'll see `/link`, `/tier`, `/price`, `/bug`.

## 10. Test it

In your server:

- `/link` — bot DMs you a code. Paste it on PathBinder Account page (you'll wire that UI next; see task #95).
- `/price card:Charizard` — bot responds publicly with an embed showing prices.
- `/bug description:scanner crashed on Mega Pyroar` — bot says "Bug filed", row appears in `bug_reports` table.

## Ops

- **Bug triage**: query `select * from bug_reports where status='new' order by created_at desc;` from Supabase. Update status via SQL or build a small admin page.
- **Role drift**: run `/tier` to re-sync after a user upgrades. Eventually wire this into the Stripe webhook so it happens automatically.
- **Code spam**: `discord_link_codes` self-cleans on every `/link` invocation via the helper function. If you want a belt-and-suspenders cron, schedule `select public.cleanup_expired_discord_codes();` daily.

## Full command list (Phase 2)

After running `register_discord_commands.js` you'll have:

**Linking / roles:** `/link`, `/tier`
**Lookup:** `/price`, `/set`, `/random`, `/marketplace`
**Personal (DM):** `/portfolio`, `/wishlist`, `/listings`, `/sales` (Enthusiast+), `/badge`
**Community:** `/showcase`, `/movers` (personal+global), `/leaderboard` (opt-in), `/trade-open`, `/duel`, `/starter`, `/profile`
**Alerts:** `/track`, `/untrack`
**Feedback:** `/bug`
**Admin:** `/usercount`
**Discovery:** `/help`
**Right-click message → Apps:** "File as Bug", "Track Card Price"

`/track` + `/untrack` write to a `price_alerts` table. The bot WRITES the alert subscriptions; firing them needs a separate scheduled job (`price_alert_dispatcher.py` — not yet written) that polls `catalog.current_value` against each alert's threshold and DMs the user via the bot when crossed. Without that dispatcher, alerts are silent — `/track` is a no-op from a notification standpoint until you add the polling cron.

`/leaderboard` needs `migration_discord_phase2.sql` which adds `profiles.leaderboard_optin` (default `false`). Users opt in from their Account page.

## A note on Discord reactions

Discord's emoji-reaction events (e.g. 🐛 on a message → file as bug) require a **persistent Gateway connection**, which can't run on Vercel serverless. Implementing those would mean either a separate always-on relay (Railway, Fly, etc.) or migrating the whole bot to a worker. **We use Discord's right-click "Apps" menu instead** — same one-action UX, works with the existing HTTP-only setup. The two message commands ("File as Bug", "Track Card Price") appear on every message via right-click → Apps → \<command\>.

## Pokémon game loop (`/starter`, `/duel`, `/profile`)

Beta-community engagement layer. Run `migration_discord_pokemon.sql`
in Supabase to create the two tables (`bot_pokemon`, `bot_duel_log`)
before deploying.

- `/starter pokemon:Charmander` — pick one of the 27 starters (Gens
  1-9). Discord-autocomplete; type a few letters to filter. Re-running
  swaps your starter without losing XP/wins.
- `/duel opponent:@someone` — sends an Accept/Decline challenge. Pulls
  + XP only happen after the opponent clicks Accept. Cooldowns: 10s
  per challenger, 30s per pair.
- `/profile [user:@someone]` — shows starter art, level, XP bar,
  W/L/T record.

XP curve: total XP to reach level N is `10 * (N-1)^2`. Win against
same-level = 30 XP; bonus/penalty scales ±10% per level diff (clamped
10..100). Loss = 8, tie = 15. Max level 99. Both players need a
starter for any XP to be awarded; if either is missing, the duel
still runs but the embed footer reminds them to `/starter`.

## Real Phase 2 ideas

- **Price-alert dispatcher** — a `price_alert_dispatcher.py` cron that reads `price_alerts`, compares against `catalog.current_value`, and DMs users via the bot's existing `tryDmUser` flow when thresholds cross. Add `last_notified_at` + `cooldown_until` checks (already in the schema) to prevent spam if a price hovers around the threshold.
- **Stripe webhook → automatic `syncDiscordRole`** on subscription change (currently manual via `/tier`). Hook into `api/stripe-webhook.js`.
- **Forum-channel mode for `#bugs`** so each report gets its own thread that can be tagged with status. Pure Discord config change, no bot work.
- **`/scan-stats`** — last 30 days of scan accuracy / failures (needs a `scan_logs` table that doesn't exist yet).
