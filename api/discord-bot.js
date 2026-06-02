// api/discord-bot.js
// ──────────────────────────────────────────────────────────────────────
// PathBinder — Discord interactions endpoint (slash commands)
//
// Handles Discord HTTP interactions for the PathBinder server. Set this
// URL as your Discord application's "Interactions Endpoint URL" in the
// developer portal: https://pathbinder.gg/api/discord-bot
//
// Slash commands implemented:
//   /link          — generate a 6-char code, DM it to the user, instruct
//                    them to paste it on the PathBinder Account page.
//   /tier          — re-read the linked user's subscription_tier and
//                    sync their Discord role (Free/Collector/Enthusiast/
//                    Vendor/Shop). Use after upgrading.
//   /price <name>  — look up a card by name in the catalog and return
//                    an embed with PriceCharting + TCGplayer values.
//   /bug <text>    — file a bug report. Writes to bug_reports table.
//
// Required env (Vercel → Settings → Environment Variables):
//   DISCORD_PUBLIC_KEY   — application public key (for sig verification)
//   DISCORD_BOT_TOKEN    — bot token (for follow-up REST calls)
//   DISCORD_GUILD_ID     — your server's snowflake (for role assignment)
//   DISCORD_ROLE_FREE    — Discord role IDs, one per tier
//   DISCORD_ROLE_COLLECTOR
//   DISCORD_ROLE_ENTHUSIAST
//   DISCORD_ROLE_VENDOR
//   DISCORD_ROLE_SHOP
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Required deps (add to package.json):
//   "tweetnacl": "^1.0.3"        — for ed25519 signature verification
// ──────────────────────────────────────────────────────────────────────

const nacl = require('tweetnacl');
const { createClient } = require('@supabase/supabase-js');

// CRITICAL: tell Vercel NOT to parse the request body. Discord signs
// the exact bytes of the request, and any JSON re-serialization (key
// order, whitespace) would break the signature verification. Must be
// exported at the TOP of the module — Vercel reads this at build time
// before the handler runs.
module.exports.config = { api: { bodyParser: false } };

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Discord interaction types (https://discord.com/developers/docs/interactions/receiving-and-responding)
const INTERACTION_TYPE = {
  PING:                  1,
  APPLICATION_COMMAND:   2,
  MESSAGE_COMPONENT:     3,
  AUTOCOMPLETE:          4,
  MODAL_SUBMIT:          5,
};
const INTERACTION_RESPONSE_TYPE = {
  PONG:                            1,
  CHANNEL_MESSAGE_WITH_SOURCE:     4,
  DEFERRED_CHANNEL_MESSAGE:        5,
  DEFERRED_UPDATE_MESSAGE:         6,  // ack a component without showing "thinking"
  UPDATE_MESSAGE:                  7,  // edit the message a component lives on
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
};

// Commands that touch the DB or do real work — we defer the response
// so cold-start latency doesn't blow past Discord's 3-second window.
// Listed by whether the eventual response is public or ephemeral (the
// deferral type has to match, otherwise the final message renders
// wrong). Anything NOT in either set responds synchronously.
const DEFER_PUBLIC_SLASH = new Set([
  'movers', 'duel', 'showcase', 'random', 'set',
  'price', 'marketplace', 'usercount', 'leaderboard',
]);
const DEFER_EPHEMERAL_SLASH = new Set([
  'portfolio', 'wishlist', 'listings', 'sales', 'badge',
  'track', 'untrack', 'trade-open', 'starter', 'profile',
]);
// Flags bitfield. 64 = EPHEMERAL (only the caller sees the response).
const EPHEMERAL = 1 << 6;

// Tier → role-env-var-name mapping. Each role's actual Discord ID lives
// in the env var; lookup happens at runtime so a missing role var
// degrades to "no role assigned" instead of crashing.
const TIER_ROLE_ENV = {
  free:       'DISCORD_ROLE_FREE',
  collector:  'DISCORD_ROLE_COLLECTOR',
  enthusiast: 'DISCORD_ROLE_ENTHUSIAST',
  vendor:     'DISCORD_ROLE_VENDOR',
  shop:       'DISCORD_ROLE_SHOP',
};


// ─── Vercel entrypoint ──────────────────────────────────────────────
// Discord POSTs the raw JSON body and signs it with their ed25519
// key. We have to read the raw bytes BEFORE Vercel's JSON parser
// touches them — the signature is over the exact bytes of the body,
// not the parsed object. Vercel exposes the raw body via the `req`
// stream when bodyParser is off.
const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Discord interactions are POST-only' });
  }

  if (!process.env.DISCORD_PUBLIC_KEY) {
    console.error('[discord-bot] DISCORD_PUBLIC_KEY env var not set');
    return res.status(500).json({ error: 'DISCORD_PUBLIC_KEY missing' });
  }

  // Read raw body bytes for signature verification. Vercel sometimes
  // pre-parses the body even with bodyParser:false config (depends on
  // runtime version), so fall back to req.body / req.rawBody if the
  // stream is already drained.
  let rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    let gotAny = false;
    req.on('data', c => { gotAny = true; chunks.push(c); });
    req.on('end', () => resolve(gotAny ? Buffer.concat(chunks).toString('utf8') : ''));
    req.on('error', reject);
  });
  if (!rawBody && req.rawBody) {
    rawBody = typeof req.rawBody === 'string' ? req.rawBody : req.rawBody.toString('utf8');
  }
  if (!rawBody && req.body) {
    // Last resort — Vercel parsed it. Re-stringify and hope key order
    // matches what Discord sent. This usually FAILS signature check
    // but logs help diagnose that we got here.
    rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    console.warn('[discord-bot] body was pre-parsed by Vercel — signature will likely fail');
  }

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  if (!signature || !timestamp) {
    console.error('[discord-bot] missing signature headers');
    return res.status(401).json({ error: 'Missing signature headers' });
  }

  // Verify ed25519 signature with Discord's public key for this app.
  // The message is `timestamp + rawBody` concatenated as UTF-8 bytes.
  let verified = false;
  try {
    const pub = Buffer.from(process.env.DISCORD_PUBLIC_KEY, 'hex');
    const sig = Buffer.from(signature, 'hex');
    const msg = Buffer.from(timestamp + rawBody);
    verified = nacl.sign.detached.verify(msg, sig, pub);
  } catch (e) {
    console.error('[discord-bot] verify threw:', e.message);
  }
  if (!verified) {
    console.error('[discord-bot] signature mismatch (body length:', rawBody.length, ')');
    return res.status(401).json({ error: 'Invalid request signature' });
  }

  let interaction;
  try { interaction = JSON.parse(rawBody); }
  catch (_) { return res.status(400).json({ error: 'Bad JSON' }); }

  // PING handshake — Discord pings the endpoint on registration to
  // confirm it's alive. Reply PONG with no body content.
  if (interaction.type === INTERACTION_TYPE.PING) {
    return res.status(200).json({ type: INTERACTION_RESPONSE_TYPE.PONG });
  }

  // Slash command + message-context-menu dispatch. Both arrive as
  // APPLICATION_COMMAND with different `type` values on data:
  //   1 = CHAT_INPUT (slash command)
  //   2 = USER (user context menu — not used yet)
  //   3 = MESSAGE (right-click "Apps" menu on a message)
  if (interaction.type === INTERACTION_TYPE.APPLICATION_COMMAND) {
    const name    = interaction.data && interaction.data.name;
    const cmdType = (interaction.data && interaction.data.type) || 1;

    // Decide whether to defer this command. Deferring sends an empty
    // "Bot is thinking..." ack inside Discord's 3s window, then we
    // PATCH the real result in via the webhook (up to 15 min later).
    // This is what lets cold-start invocations succeed.
    const willDefer = cmdType !== 3 && (
      DEFER_PUBLIC_SLASH.has(name) || DEFER_EPHEMERAL_SLASH.has(name)
    );
    const deferEphemeral = DEFER_EPHEMERAL_SLASH.has(name);

    if (willDefer) {
      // Send the deferred ack immediately. The handler keeps running
      // because we don't return — Vercel waits for the awaits below
      // to settle before terminating the function.
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE,
        data: deferEphemeral ? { flags: EPHEMERAL } : {},
      });
      try {
        const reply = await runSlashHandler(name, interaction);
        await patchOriginalInteractionResponse(interaction, reply);
      } catch (e) {
        console.error('[discord-bot] deferred handler error:', name, e);
        await patchOriginalInteractionResponse(interaction,
          ephemeral('Sorry, that command hit an error. The team has been notified.'));
      }
      return;
    }

    // Non-deferred path — synchronous, must finish in <3s.
    try {
      let reply;
      if (cmdType === 3) {
        switch (name) {
          case 'File as Bug':       reply = await handleFileAsBugMessage(interaction); break;
          case 'Track Card Price':  reply = await handleTrackFromMessage(interaction); break;
          default: reply = ephemeral(`Unknown message command: ${name}`);
        }
      } else {
        reply = await runSlashHandler(name, interaction);
      }
      return res.status(200).json(reply);
    } catch (e) {
      console.error('[discord-bot] handler error:', name, e);
      return res.status(200).json(ephemeral(
        'Sorry, that command hit an error. The team has been notified.'
      ));
    }
  }

  // Autocomplete — Discord sends this as the user types in a slash-
  // command STRING option that's marked `autocomplete: true`. We return
  // up to 25 suggestions. Used by /starter so all 27 starters are
  // reachable even though Discord caps static `choices` at 25.
  if (interaction.type === INTERACTION_TYPE.AUTOCOMPLETE) {
    try {
      const name = interaction.data && interaction.data.name;
      if (name === 'starter') {
        return res.status(200).json(handleStarterAutocomplete(interaction));
      }
    } catch (e) {
      console.error('[discord-bot] autocomplete error:', e);
    }
    return res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
      data: { choices: [] },
    });
  }

  // Message component (button / select). Used by /duel's Accept and
  // Decline buttons. custom_id encodes which action + the participants.
  if (interaction.type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
    const cid = (interaction.data && interaction.data.custom_id) || '';
    // duel_accept is slow (card pulls + DB writes). Defer it with
    // type 6 (DEFERRED_UPDATE_MESSAGE — no "thinking..." UI on the
    // button click), then PATCH the message with the resolved
    // result. duel_decline is fast — handle inline.
    if (cid.startsWith('duel_accept:')) {
      res.status(200).json({ type: INTERACTION_RESPONSE_TYPE.DEFERRED_UPDATE_MESSAGE });
      try {
        const reply = await handleDuelComponent(interaction);
        await patchOriginalInteractionResponse(interaction, reply);
      } catch (e) {
        console.error('[discord-bot] component error:', e);
        await patchOriginalInteractionResponse(interaction,
          ephemeral('That button hit an error.'));
      }
      return;
    }
    try {
      if (cid.startsWith('duel_decline:')) {
        const reply = await handleDuelComponent(interaction);
        return res.status(200).json(reply);
      }
      return res.status(200).json(ephemeral('Unknown button.'));
    } catch (e) {
      console.error('[discord-bot] component error:', e);
      return res.status(200).json(ephemeral('That button hit an error.'));
    }
  }

  // Anything else (modal submits etc.) — not used yet.
  return res.status(400).json({ error: 'Unhandled interaction type' });
};
module.exports = handler;
// Re-attach config — assigning module.exports above overwrote the
// config property we set at the top. Vercel reads it from
// module.exports.config so both have to live on the same object.
module.exports.config = { api: { bodyParser: false } };


// ─── Command handlers ──────────────────────────────────────────────

// /link — generate a 6-char code, store it, DM to the user, tell them
// where to paste it.
async function handleLink(interaction) {
  const u = (interaction.member && interaction.member.user) || interaction.user;
  const discordUserId   = u.id;
  const discordUsername = u.username || (u.global_name || '');

  // Best-effort cleanup of expired codes. Cheap, idempotent.
  try { await sb.rpc('cleanup_expired_discord_codes'); } catch (_) {}

  // Already linked? Tell them.
  const existing = await sb.from('discord_links')
    .select('user_id').eq('discord_user_id', discordUserId).maybeSingle();
  if (existing && existing.data) {
    return ephemeral(
      'Your Discord is already linked to a PathBinder account. Run `/tier` to refresh your role.'
    );
  }

  // Generate a fresh code. Loop up to 5 times in the rare case of a
  // primary-key collision (live-window is small, but be safe).
  let code = null;
  for (let i = 0; i < 5; i++) {
    const candidate = randomLinkCode();
    const ins = await sb.from('discord_link_codes').insert({
      code:              candidate,
      discord_user_id:   discordUserId,
      discord_username:  discordUsername,
      expires_at:        new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).select('code').maybeSingle();
    if (!ins.error) { code = candidate; break; }
  }
  if (!code) {
    return ephemeral('Couldn\'t generate a code right now. Try again in a moment.');
  }

  // DM the code so it never appears in a public channel.
  await tryDmUser(discordUserId,
    `**PathBinder linking code:** \`${code}\`\n\n` +
    'Paste this on your PathBinder Account page (https://pathbinder.gg/?page=account) under "Connect Discord". ' +
    'The code is valid for 10 minutes.'
  );

  return ephemeral(
    'Check your DMs — I\'ve sent you a code to paste into PathBinder. ' +
    'If you didn\'t get the DM, allow DMs from server members and run `/link` again.'
  );
}

// /tier — re-read subscription_tier from profiles and update the
// Discord role accordingly. Removes any conflicting tier roles.
async function handleTier(interaction) {
  const u = (interaction.member && interaction.member.user) || interaction.user;
  const discordUserId = u.id;

  const link = await sb.from('discord_links')
    .select('user_id').eq('discord_user_id', discordUserId).maybeSingle();
  if (!link.data) {
    return ephemeral('You haven\'t linked yet. Run `/link` first.');
  }

  const prof = await sb.from('profiles')
    .select('subscription_tier,is_admin,is_vendor,is_premium')
    .eq('id', link.data.user_id).maybeSingle();
  if (!prof.data) return ephemeral('PathBinder account not found.');

  const tier = resolveTier(prof.data);
  await syncDiscordRole(discordUserId, tier);
  return ephemeral(`Synced. Your tier is **${tier}**.`);
}

// /price <name> — look up a card by name in catalog, return an embed
// with the latest values from card_prices.
async function handlePrice(interaction) {
  const opts = (interaction.data && interaction.data.options) || [];
  const nameOpt = opts.find(o => o.name === 'card');
  if (!nameOpt || !nameOpt.value) return ephemeral('Usage: `/price card:<name>`');

  const q = String(nameOpt.value).trim();
  const cards = await sb.from('catalog')
    .select('id,name,set_name,card_number,image_url,current_value,game_type')
    .ilike('name', `%${q}%`)
    .order('current_value', { ascending: false, nullsFirst: false })
    .limit(3);
  if (cards.error || !cards.data || !cards.data.length) {
    return ephemeral(`No results for **${q}**.`);
  }

  const top = cards.data[0];
  const comps = await sb.from('card_prices')
    .select('source,value,source_url')
    .eq('catalog_id', top.id);

  const lines = [];
  const pc = (comps.data || []).find(p => p.source === 'pricecharting');
  const tc = (comps.data || []).find(p => p.source === 'tcgplayer');
  if (pc && Number(pc.value) > 0) lines.push(`PriceCharting: **$${Number(pc.value).toFixed(2)}**`);
  if (tc && Number(tc.value) > 0) lines.push(`TCGplayer: **$${Number(tc.value).toFixed(2)}**`);
  if (!lines.length && top.current_value) {
    lines.push(`Latest: **$${Number(top.current_value).toFixed(2)}**`);
  }

  const otherHits = cards.data.slice(1).map(c =>
    `• ${c.name}${c.set_name ? ` — ${c.set_name}` : ''}${c.card_number ? ` #${c.card_number}` : ''}`
  ).join('\n');

  return publicReply({
    embeds: [{
      title: top.name,
      description: [
        top.set_name ? `${top.set_name}${top.card_number ? ` · #${top.card_number}` : ''}` : '',
        '',
        lines.join('\n') || '_No price data yet._',
        otherHits ? `\n**Other matches:**\n${otherHits}` : '',
      ].filter(Boolean).join('\n'),
      thumbnail: top.image_url ? { url: top.image_url } : undefined,
      color: 0x1AC7A0, // PathBinder teal
      footer: { text: 'PathBinder · open the app for full price history' },
    }],
  });
}

// /bug <text> — write to bug_reports. Captures channel + linked user
// where possible so triage has context.
async function handleBug(interaction) {
  const opts = (interaction.data && interaction.data.options) || [];
  const descOpt = opts.find(o => o.name === 'description');
  if (!descOpt || !descOpt.value) return ephemeral('Usage: `/bug description:<what went wrong>`');

  const u = (interaction.member && interaction.member.user) || interaction.user;
  const discordUserId = u.id;
  const discordUsername = u.username || u.global_name || '';

  // Resolve to a PathBinder user_id if linked.
  let userId = null;
  try {
    const link = await sb.from('discord_links')
      .select('user_id').eq('discord_user_id', discordUserId).maybeSingle();
    userId = (link.data && link.data.user_id) || null;
  } catch (_) {}

  // Channel name needs another REST call — keep it cheap by skipping
  // for now; channel_id from the interaction is sufficient for triage.
  const channelName = interaction.channel && interaction.channel.name
    ? interaction.channel.name : (interaction.channel_id || 'dm');

  await sb.from('bug_reports').insert({
    user_id:          userId,
    discord_user_id:  discordUserId,
    discord_username: discordUsername,
    channel_name:     channelName,
    description:      String(descOpt.value).slice(0, 4000),
  });

  return ephemeral('Bug filed. Thanks — we\'ll take a look.');
}


// ─── Helpers ───────────────────────────────────────────────────────

function ephemeral(content) {
  return {
    type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  };
}
function publicReply(data) {
  return { type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE, data };
}

// Single source of truth for slash-command routing. Used by both the
// synchronous dispatch path and the deferred dispatch path (after the
// type-5 ack is sent). Keep in sync with the command list registered
// in scripts/register_discord_commands.js.
async function runSlashHandler(name, interaction) {
  switch (name) {
    case 'link':          return await handleLink(interaction);
    case 'tier':          return await handleTier(interaction);
    case 'price':         return await handlePrice(interaction);
    case 'bug':           return await handleBug(interaction);
    case 'help':          return await handleHelp(interaction);
    case 'portfolio':     return await handlePortfolio(interaction);
    case 'showcase':      return await handleShowcase(interaction);
    case 'movers':        return await handleMovers(interaction);
    case 'wishlist':      return await handleWishlist(interaction);
    case 'listings':      return await handleListings(interaction);
    case 'marketplace':   return await handleMarketplace(interaction);
    case 'random':        return await handleRandom(interaction);
    case 'badge':         return await handleBadge(interaction);
    case 'trade-open':    return await handleTradeOpen(interaction);
    case 'set':           return await handleSet(interaction);
    case 'usercount':     return await handleUsercount(interaction);
    case 'sales':         return await handleSales(interaction);
    case 'leaderboard':   return await handleLeaderboard(interaction);
    case 'track':         return await handleTrack(interaction);
    case 'untrack':       return await handleUntrack(interaction);
    case 'duel':          return await handleDuel(interaction);
    case 'starter':       return await handleStarter(interaction);
    case 'profile':       return await handleProfile(interaction);
    default:              return ephemeral(`Unknown command: ${name}`);
  }
}

// PATCH the deferred-interaction's original response with the real
// message. Uses Discord's interaction-webhook endpoint, which requires
// only the interaction token (no Bot Authorization header). The reply
// shape we get back from a handler is { type, data } — the webhook
// endpoint only wants the `data` payload, so we unwrap.
//
// For UPDATE_MESSAGE responses (button-click flows), `reply` is also
// { type: 7, data: {...} } and we just take the data, since PATCHing
// the original interaction message is equivalent to type-7 edit.
async function patchOriginalInteractionResponse(interaction, reply) {
  const appId = process.env.DISCORD_APP_ID;
  if (!appId) {
    console.error('[discord-bot] DISCORD_APP_ID missing — cannot PATCH deferred response');
    return;
  }
  const body = (reply && reply.data) || {};
  // PATCH endpoint is forgiving — sends back the message we just set,
  // or { code: 10015 } if the interaction token expired (15-min cap).
  try {
    const r = await fetch(
      `https://discord.com/api/v10/webhooks/${appId}/${interaction.token}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!r.ok) {
      console.error('[discord-bot] PATCH failed:', r.status, await r.text());
    }
  } catch (e) {
    console.error('[discord-bot] PATCH threw:', e.message);
  }
}

// A-Z + 2-9 (no 0/O/1/I/L to dodge font confusion), 6 chars, dash
// in the middle for readability: "ABC-XYZ".
function randomLinkCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)];
  return pick() + pick() + pick() + '-' + pick() + pick() + pick();
}

// Resolve profile row → canonical tier string.
function resolveTier(p) {
  if (!p) return 'free';
  if (p.is_admin) return 'shop';
  if (p.subscription_tier) return String(p.subscription_tier).toLowerCase();
  if (p.is_vendor)  return 'enthusiast';
  if (p.is_premium) return 'collector';
  return 'free';
}

// PUT the user into the right tier role + remove other tier roles. No-op
// if the role IDs aren't configured in env (graceful degradation when
// the server isn't fully wired up yet).
async function syncDiscordRole(discordUserId, tier) {
  const guildId = process.env.DISCORD_GUILD_ID;
  const botTok  = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botTok) return;

  const wantedRoleId = process.env[TIER_ROLE_ENV[tier] || ''] || null;
  const allTierRoleIds = Object.values(TIER_ROLE_ENV)
    .map(envName => process.env[envName])
    .filter(Boolean);

  // Read current member to know their existing roles.
  const memRes = await fetch(
    `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`,
    { headers: { Authorization: `Bot ${botTok}` } }
  );
  if (!memRes.ok) return;
  const member = await memRes.json();
  const currentRoles = new Set(member.roles || []);

  // Remove any existing tier roles, then add the wanted one.
  let changed = false;
  for (const rid of allTierRoleIds) {
    if (currentRoles.has(rid) && rid !== wantedRoleId) {
      currentRoles.delete(rid); changed = true;
    }
  }
  if (wantedRoleId && !currentRoles.has(wantedRoleId)) {
    currentRoles.add(wantedRoleId); changed = true;
  }
  if (!changed) return;

  await fetch(
    `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ roles: Array.from(currentRoles) }),
    }
  );
}

// DM helper — opens (or reuses) a 1:1 channel with the user and posts
// the content. `extra` can carry embeds / components / flags for
// richer DM payloads (portfolio summaries etc.). Best-effort: if the
// user has DMs disabled the open call fails and we silently skip.
async function tryDmUser(discordUserId, content, extra) {
  const tok = process.env.DISCORD_BOT_TOKEN;
  if (!tok) return;
  try {
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${tok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!dmRes.ok) return;
    const dm = await dmRes.json();
    const body = Object.assign({ content }, extra || {});
    await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${tok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (_) { /* DMs disabled or transient failure */ }
}


// ─── Phase 2 handlers ─────────────────────────────────────────────
// Most read-only commands hit existing Supabase tables; structure is
// always: resolve caller → query → format embed.

// /help — paste the full command list. Public (visible to everyone in
// the channel) since it's a discovery aid.
async function handleHelp(_interaction) {
  return publicReply({
    embeds: [{
      title: 'PathBinder bot commands',
      color: 0x1AC7A0,
      description: [
        '**Linking**',
        '`/link` — connect Discord to your PathBinder account',
        '`/tier` — re-sync your Discord role with your subscription',
        '',
        '**Look up**',
        '`/price card:<name>` — card price + comps',
        '`/set name:<set>` — set completion + most valuable card',
        '`/random [game]` — surprise me with a card',
        '`/marketplace card:<name>` — cheapest active listings',
        '',
        '**Your stuff** (DM, requires linked account)',
        '`/portfolio` — collection value + top 5 + 7d gain',
        '`/wishlist` — top wishlist cards + savings progress',
        '`/listings` — your active marketplace listings',
        '`/sales [period]` — sales summary (enthusiast+)',
        '`/badge` — your earned badges',
        '',
        '**Community**',
        '`/showcase card:<name>` — public spotlight on a card',
        '`/movers [period]` — biggest movers in the last 24h or 7d',
        '`/leaderboard` — top portfolios (opt-in only)',
        '`/trade-open` — start a trade-analyzer session you can share',
        '',
        '**Alerts**',
        '`/track card:<name> threshold:<usd> [direction:above|below]`',
        '`/untrack card:<name>` — stop watching',
        '',
        '**Feedback**',
        '`/bug description:<...>` — file an issue',
        '',
        '_Right-click any message → Apps → File as Bug / Track Card Price._',
      ].join('\n'),
      footer: { text: 'pathbinder.gg' },
    }],
  });
}

// /portfolio — DMs the caller their collection summary. Requires
// linking (we need to know which PathBinder account is "them").
async function handlePortfolio(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  const userId = link.profile.id;

  const items = await sb.from('collection_items')
    .select('id,card_name,set_name,current_value,purchase_price,quantity,sold_offline,is_ghost')
    .eq('user_id', userId)
    .eq('sold_offline', false)
    .eq('is_ghost', false);
  if (items.error) throw items.error;

  const rows = items.data || [];
  if (!rows.length) {
    return ephemeral('No cards in your collection yet. Open the app and add one!');
  }
  let total = 0, cost = 0;
  for (const r of rows) {
    const v = Number(r.current_value) || Number(r.purchase_price) || 0;
    total += v * (r.quantity || 1);
    cost  += (Number(r.purchase_price) || 0) * (r.quantity || 1);
  }
  const gain = total - cost;

  // 7-day gain via portfolio_snapshots if present (best-effort).
  let gain7d = null;
  try {
    const wk = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
    const s = await sb.from('portfolio_snapshots')
      .select('total_value,snapshot_date')
      .eq('user_id', userId).gte('snapshot_date', wk)
      .order('snapshot_date', { ascending: true }).limit(1);
    if (!s.error && s.data && s.data[0] && Number(s.data[0].total_value) > 0) {
      gain7d = total - Number(s.data[0].total_value);
    }
  } catch (_) {}

  const top5 = rows
    .slice()
    .sort((a, b) => ((b.current_value || 0) * (b.quantity || 1)) - ((a.current_value || 0) * (a.quantity || 1)))
    .slice(0, 5)
    .map(r => `• ${r.card_name}${r.set_name ? ` _(${r.set_name})_` : ''} — **$${(Number(r.current_value) || 0).toFixed(2)}**`)
    .join('\n');

  await tryDmUser(link.discordUserId, '', {
    embeds: [{
      title: 'Your PathBinder portfolio',
      color: 0x1AC7A0,
      fields: [
        { name: 'Total value',  value: `**$${total.toFixed(2)}**`, inline: true },
        { name: 'Cost basis',   value: `$${cost.toFixed(2)}`, inline: true },
        { name: 'Gain / Loss',  value: `${gain >= 0 ? '+' : ''}$${gain.toFixed(2)}`, inline: true },
        gain7d !== null ? { name: '7d change', value: `${gain7d >= 0 ? '+' : ''}$${gain7d.toFixed(2)}`, inline: true } : null,
        { name: 'Cards',        value: String(rows.length), inline: true },
        { name: 'Top 5',        value: top5 || '_none_', inline: false },
      ].filter(Boolean),
      footer: { text: 'pathbinder.gg/?page=account' },
    }],
  });
  return ephemeral('Sent your portfolio summary to your DMs.');
}

// /showcase — public embed for a card, with "owned by N PathBinder
// users" count. Made for `#pulls` chatter.
async function handleShowcase(interaction) {
  const q = optString(interaction, 'card');
  if (!q) return ephemeral('Usage: `/showcase card:<name>`');
  const cards = await sb.from('catalog')
    .select('id,name,set_name,card_number,image_url,current_value,rarity')
    .ilike('name', `%${q}%`)
    .order('current_value', { ascending: false, nullsFirst: false })
    .limit(1);
  if (cards.error || !cards.data || !cards.data.length) {
    return ephemeral(`No card matching **${q}**.`);
  }
  const c = cards.data[0];
  let owners = null;
  try {
    const r = await sb.from('collection_items')
      .select('user_id', { count: 'exact', head: true })
      .eq('api_card_id', c.id).eq('is_ghost', false).eq('sold_offline', false);
    owners = r.count || 0;
  } catch (_) {}
  return publicReply({
    embeds: [{
      title: c.name,
      description: `${c.set_name || ''}${c.card_number ? ` · #${c.card_number}` : ''}${c.rarity ? ` · ${c.rarity}` : ''}`,
      image: c.image_url ? { url: c.image_url } : undefined,
      color: 0x1AC7A0,
      fields: [
        c.current_value ? { name: 'Value', value: `**$${Number(c.current_value).toFixed(2)}**`, inline: true } : null,
        owners !== null ? { name: 'Owners on PathBinder', value: String(owners), inline: true } : null,
      ].filter(Boolean),
    }],
  });
}

// Canonical game_type strings the catalog uses. Anything else falls
// back to 'pokemon' so a typo doesn't return zero results silently.
// 'all' is a special pseudo-value handled separately — it fans the
// query out across every game and merges the top movers.
const MOVERS_GAMES = ['pokemon', 'magic', 'yugioh', 'onepiece', 'gundam', 'dbz'];
const MOVERS_GAMES_ACCEPTED = [...MOVERS_GAMES, 'all'];
// Display labels (Pokémon's é + pretty TCG names) for embed titles.
const GAME_LABEL = {
  pokemon: 'Pokémon',
  magic:   'Magic: The Gathering',
  yugioh:  'Yu-Gi-Oh!',
  onepiece:'One Piece',
  gundam:  'Gundam',
  dbz:     'Dragon Ball Z Fusion World',
  all:     'All TCGs',
};

// /movers [period] [scope] [game] — global market movers, or YOUR
// collection movers when scope=personal. Default scope is 'personal'
// when the caller is linked (matches the dashboard "Yours" toggle),
// 'global' when they aren't. Default game is 'pokemon'. Public.
async function handleMovers(interaction) {
  // Default to 7-day. 24h is too tight when the snapshot cron only
  // fires once a day — if today's snapshot hasn't run yet, the 24h
  // baseline equals catalog.current_value and every delta is zero.
  // 7d always has enough history depth to surface real movement.
  const period = optString(interaction, 'period') || '7d';
  const days   = period === '24h' ? 1 : 7;
  const scopeOpt = (optString(interaction, 'scope') || '').toLowerCase();
  // game option — accept any catalog game_type, plus 'all' which fans
  // out across every game and merges the results. Default pokemon for
  // backwards compatibility (the original command was pokemon-only).
  const gameIn = (optString(interaction, 'game') || 'pokemon').toLowerCase();
  const game   = MOVERS_GAMES_ACCEPTED.includes(gameIn) ? gameIn : 'pokemon';
  const gameLabel = GAME_LABEL[game] || game;

  // Resolve scope. Default is always 'global' (the market view) — most
  // users running /movers in a public channel want to see market-wide
  // movement, not their own collection. Pass scope:personal explicitly
  // to see your own collection.
  const linkCheck = await getLinkedProfile(interaction, { silent: true });
  let scope = scopeOpt === 'global' || scopeOpt === 'personal'
    ? scopeOpt
    : 'global';
  if (scope === 'personal' && !linkCheck.ok) {
    return ephemeral('Link your account first: run `/link`. Or try `/movers scope:global` for market-wide movers.');
  }

  const fmtPct = (n) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`;
  const fmtRow = (x) =>
    `• ${x.name} — $${Number(x.current_value || 0).toFixed(2)} (${fmtPct(x.delta_pct)})`;

  // ── Personal scope ──────────────────────────────────────────────
  // Walk the user's collection, join against catalog_price_history for
  // the period, compute deltas, and return top 3 up + top 3 down.
  // Mirrors the dashboard "Yours" code path in index.html (around line
  // 13180) so the numbers line up with what they see in the app.
  if (scope === 'personal') {
    const userId = linkCheck.profile.id;
    // Fetch the user's owned + ghost rows that have a catalog id and a
    // current value to compare against. is_ghost rows count too — they
    // contribute to "wishlist movers" the dashboard also surfaces.
    // Collection query — scope by game_type unless caller asked for 'all'.
    let itemsQ = sb.from('collection_items')
      .select('api_card_id, card_name, current_value, is_ghost, game_type')
      .eq('user_id', userId)
      .not('api_card_id', 'is', null)
      .not('current_value', 'is', null);
    if (game !== 'all') itemsQ = itemsQ.eq('game_type', game);
    const items = await itemsQ;
    if (items.error) throw items.error;
    const rows = (items.data || []).filter(r => Number(r.current_value) > 0);
    if (!rows.length) {
      return ephemeral(
        game === 'all'
          ? 'Your collection has no priced cards yet — add some and try again.'
          : `You have no priced **${gameLabel}** cards yet — add some and try again, or run \`/movers game:all\`.`
      );
    }

    // Pull oldest-in-window price per catalog_id, in chunks (PostgREST
    // .in() URL gets huge otherwise).
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const ids = [...new Set(rows.map(r => r.api_card_id))];
    const oldByCat = new Map();
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const hist = await sb.from('catalog_price_history')
        .select('catalog_id, recorded_value, recorded_at')
        .in('catalog_id', slice)
        .gte('recorded_at', cutoff)
        .order('recorded_at', { ascending: true });
      if (hist.error) continue;
      for (const h of (hist.data || [])) {
        if (!oldByCat.has(h.catalog_id)) oldByCat.set(h.catalog_id, Number(h.recorded_value));
      }
    }

    const movers = [];
    for (const r of rows) {
      const oldVal = oldByCat.get(r.api_card_id);
      const cur    = Number(r.current_value);
      if (!oldVal || !cur) continue;
      const delta = cur - oldVal;
      const pct   = (delta / oldVal) * 100;
      if (Math.abs(pct) < 0.1) continue;
      movers.push({ name: r.card_name, current_value: cur, delta, delta_pct: pct });
    }
    const up   = movers.filter(m => m.delta > 0).sort((a, b) => b.delta_pct - a.delta_pct).slice(0, 3);
    const down = movers.filter(m => m.delta < 0).sort((a, b) => a.delta_pct - b.delta_pct).slice(0, 3);

    return publicReply({
      embeds: [{
        title: `Your ${gameLabel} movers (${period})`,
        color: 0x1AC7A0,
        fields: [
          { name: '▲ Up',   value: up.length   ? up.map(fmtRow).join('\n')   : '_no gains_',    inline: true },
          { name: '▼ Down', value: down.length ? down.map(fmtRow).join('\n') : '_no declines_', inline: true },
        ],
        footer: { text: 'pathbinder.gg/?page=dashboard' },
      }],
    });
  }

  // ── Global scope ────────────────────────────────────────────────
  // Use the same RPC the dashboard's "Global" toggle uses. For 'all'
  // we fan out across every game in parallel and merge — the RPC takes
  // exactly one game_type, so we ask each for its top-10 and pick the
  // overall top 3 client-side.
  const gamesToQuery = game === 'all' ? MOVERS_GAMES : [game];
  // Bigger per-game pull when merging so we don't accidentally miss a
  // game's strong mover just because its top-3 ranked below another
  // game's top-3 in the global merge.
  const perGameLimit = game === 'all' ? 10 : 3;

  let up = [], down = [];
  let lastRpcError = null;
  let totalRowsReceived = 0;
  try {
    const results = await Promise.all(gamesToQuery.map(gt => {
      const params = {
        p_game_type:    gt,
        p_days_back:    days,
        p_top_n:        perGameLimit,
        p_min_pct:      0.5,
        p_sort:         'pct',
        p_product_type: 'single',
      };
      console.log(`[discord-bot] /movers RPC call (${gt}):`, JSON.stringify(params));
      return sb.rpc('get_global_price_movers', params).then(r => {
        // Log everything — status, error shape, data length, first row.
        // Vercel function logs surface these so we can see what the
        // RPC actually returned to the bot vs what SQL Editor sees.
        const dataArr = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
        console.log(`[discord-bot] /movers RPC reply (${gt}):`, JSON.stringify({
          status:    r.status,
          statusText:r.statusText,
          errorMsg:  r.error && r.error.message,
          errorCode: r.error && r.error.code,
          errorHint: r.error && r.error.hint,
          rowCount:  dataArr.length,
          firstRow:  dataArr[0] || null,
        }));
        if (r.error) {
          lastRpcError = r.error;
          // Don't return [] — keep any data we got even alongside an error.
        }
        totalRowsReceived += dataArr.length;
        // Tag each row with its game so the merged display can show
        // which TCG each entry came from when scope=all.
        return dataArr.map(x => ({ ...x, _game: gt }));
      });
    }));
    const merged = results.flat();
    up   = merged.filter(x => x.direction === 'up')
                 .sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct))
                 .slice(0, 3);
    down = merged.filter(x => x.direction === 'down')
                 .sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct))
                 .slice(0, 3);
    console.log(`[discord-bot] /movers totals: rows=${totalRowsReceived} up=${up.length} down=${down.length}`);
  } catch (e) {
    console.error('[discord-bot] /movers exception:', e);
    lastRpcError = { message: String((e && e.message) || e) };
  }

  // Surface the actual error in the embed footer when DEBUG_MOVERS=1
  // is set in Vercel env. Lets you see the failure right in Discord
  // without having to tail logs.
  const debugFooter = process.env.DEBUG_MOVERS === '1' && lastRpcError
    ? ` · err: ${(lastRpcError.message || '').slice(0, 80)}`
    : '';

  // When showing across-all-TCGs, prefix each row with the game so the
  // reader knows the context. Single-game mode stays clean (no prefix).
  const fmtRowG = (x) => game === 'all'
    ? `• [${(GAME_LABEL[x._game] || x._game).slice(0, 6)}] ${x.name} — $${Number(x.current_value || 0).toFixed(2)} (${fmtPct(x.delta_pct)})`
    : fmtRow(x);

  return publicReply({
    embeds: [{
      title: `${gameLabel} market movers (${period})`,
      color: 0x1AC7A0,
      fields: [
        { name: '▲ Up',   value: up.length   ? up.map(fmtRowG).join('\n')   : '_no data_', inline: true },
        { name: '▼ Down', value: down.length ? down.map(fmtRowG).join('\n') : '_no data_', inline: true },
      ],
      footer: { text: (linkCheck.ok ? 'Tip: /movers scope:personal for your collection' : 'pathbinder.gg/?page=dashboard') + debugFooter },
    }],
  });
}

// /wishlist — DM your top wishlist cards (ghosts).
async function handleWishlist(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  const wl = await sb.from('collection_items')
    .select('card_name,set_name,savings_goal,amount_saved,current_value,card_image_url')
    .eq('user_id', link.profile.id).eq('is_ghost', true)
    .order('savings_goal', { ascending: false }).limit(5);
  if (wl.error || !wl.data || !wl.data.length) {
    return ephemeral('Your wishlist is empty.');
  }
  const lines = wl.data.map(c => {
    const goal = Number(c.savings_goal) || Number(c.current_value) || 0;
    const saved = Number(c.amount_saved) || 0;
    const pct = goal > 0 ? Math.min(100, (saved / goal * 100)).toFixed(0) : 0;
    return `• ${c.card_name}${c.set_name ? ` _(${c.set_name})_` : ''} — $${saved.toFixed(0)}/$${goal.toFixed(0)} (${pct}%)`;
  }).join('\n');
  await tryDmUser(link.discordUserId, '', {
    embeds: [{ title: 'Your wishlist', color: 0x1AC7A0, description: lines }],
  });
  return ephemeral('Sent your wishlist to your DMs.');
}

// /listings — your active marketplace listings count + total.
async function handleListings(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  const r = await sb.from('listings')
    .select('id,name,value,status')
    .eq('seller_id', link.profile.id).eq('status', 'active');
  if (r.error) throw r.error;
  const total = (r.data || []).reduce((s, l) => s + (Number(l.value) || 0), 0);
  return ephemeral(
    `You have **${(r.data || []).length}** active listings totaling **$${total.toFixed(2)}**.\n` +
    `https://pathbinder.gg/?page=account&tab=myListings`
  );
}

// /marketplace card:<name> — cheapest 3 active listings.
async function handleMarketplace(interaction) {
  const q = optString(interaction, 'card');
  if (!q) return ephemeral('Usage: `/marketplace card:<name>`');
  const r = await sb.from('listings')
    .select('id,name,grade,value,seller_name,variant')
    .ilike('name', `%${q}%`).eq('status', 'active')
    .order('value', { ascending: true }).limit(3);
  if (r.error) throw r.error;
  if (!r.data || !r.data.length) return ephemeral(`No active listings for **${q}**.`);
  const lines = r.data.map(l =>
    `• ${l.name}${l.variant && l.variant !== 'normal' ? ` _(${String(l.variant).replace(/_/g, ' ')})_` : ''}` +
    ` — **$${Number(l.value).toFixed(2)}** · ${l.grade || 'NM'}` +
    (l.seller_name ? ` · _${l.seller_name}_` : '') +
    ` · <https://pathbinder.gg/?page=browse#${l.id}>`
  ).join('\n');
  return publicReply({
    embeds: [{ title: `Cheapest "${q}" listings`, color: 0x1AC7A0, description: lines }],
  });
}

// /random [game] — pull a random catalog card. Cheap surprise generator.
async function handleRandom(interaction) {
  const game = optString(interaction, 'game') || 'pokemon';
  // OFFSET-based random is slow on large tables. Trick: pick a random
  // id-prefix character so the filter is cheap, then take whatever
  // comes back in sorted order.
  const alpha = '0123456789abcdef';
  const ch = alpha[Math.floor(Math.random() * alpha.length)];
  const r = await sb.from('catalog')
    .select('name,set_name,card_number,image_url,current_value,id')
    .eq('game_type', game)
    .not('image_url', 'is', null)
    .like('id', `%${ch}%`)
    .limit(50);
  const list = (r.data || []);
  if (!list.length) return ephemeral(`No cards found for ${game}.`);
  const c = list[Math.floor(Math.random() * list.length)];
  return publicReply({
    embeds: [{
      title: c.name,
      description: [c.set_name, c.card_number ? `#${c.card_number}` : ''].filter(Boolean).join(' · '),
      image: c.image_url ? { url: c.image_url } : undefined,
      color: 0x1AC7A0,
      footer: { text: c.current_value ? `~$${Number(c.current_value).toFixed(2)}` : 'pathbinder.gg' },
    }],
  });
}

// /badge — your earned badges count + names (best-effort; profile field
// names vary across the codebase, so we try a few shapes).
async function handleBadge(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  const p = link.profile;
  // The web app stores badges on profiles as either a JSON array
  // `badges` or scattered boolean flags. Try the array first.
  let names = [];
  if (Array.isArray(p.badges)) names = p.badges;
  else if (typeof p.badges === 'object' && p.badges) names = Object.keys(p.badges).filter(k => p.badges[k]);
  if (!names.length) return ephemeral('You haven\'t earned any badges yet — keep collecting!');
  return ephemeral(`You\'ve earned **${names.length}** badges:\n${names.map(b => `🏅 ${b}`).join('\n')}`);
}

// /trade-open — generate a session code and DM the user a deep link
// to the Trade Analyzer pre-loaded with that session. The web side's
// existing Trade Analyzer session-sharing handles the actual join flow.
async function handleTradeOpen(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  // Reuse the link-code generator format — short, readable, low
  // collision risk for active sessions.
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const url  = `https://pathbinder.gg/?page=fairTrade&session=${code}`;
  await tryDmUser(link.discordUserId, `Trade Analyzer session ready: ${url}\nShare that URL with your trade partner.`);
  return ephemeral(`Session code **${code}** — sent the join link to your DMs.`);
}

// /set name:<set> — set lookup + completion if linked.
async function handleSet(interaction) {
  const q = optString(interaction, 'name');
  if (!q) return ephemeral('Usage: `/set name:<set>`');
  // Match by set_name OR set_code (case-insensitive, contains).
  const sets = await sb.from('catalog')
    .select('set_code,set_name,game_type', { count: 'exact' })
    .or(`set_name.ilike.%${q}%,set_code.ilike.${q}`)
    .limit(200);
  if (sets.error || !sets.data || !sets.data.length) {
    return ephemeral(`No set matching **${q}**.`);
  }
  // Group counts by set_code in JS.
  const counts = {};
  sets.data.forEach(r => {
    const k = r.set_code || r.set_name;
    counts[k] = counts[k] || { code: r.set_code, name: r.set_name, total: 0 };
    counts[k].total++;
  });
  const best = Object.values(counts).sort((a, b) => b.total - a.total)[0];
  if (!best) return ephemeral(`No set matching **${q}**.`);

  // Optional: caller's owned count for this set.
  let ownedLine = '';
  try {
    const link = await getLinkedProfile(interaction, { silent: true });
    if (link.ok) {
      const own = await sb.from('collection_items')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', link.profile.id)
        .like('api_card_id', `%${best.code || ''}%`);
      if (!own.error) {
        const pct = best.total > 0 ? Math.round((own.count || 0) / best.total * 100) : 0;
        ownedLine = `\nYou own **${own.count || 0} / ${best.total}** (${pct}%).`;
      }
    }
  } catch (_) {}

  // Most valuable card in the set.
  const top = await sb.from('catalog')
    .select('name,current_value').eq('set_code', best.code || '')
    .order('current_value', { ascending: false, nullsFirst: false })
    .limit(1);
  const topLine = (top.data && top.data[0])
    ? `\nMost valuable: **${top.data[0].name}** — $${Number(top.data[0].current_value || 0).toFixed(2)}`
    : '';

  return publicReply({
    embeds: [{
      title: best.name,
      description: `${best.code ? `\`${best.code}\` · ` : ''}**${best.total}** cards${topLine}${ownedLine}`,
      color: 0x1AC7A0,
    }],
  });
}

// /usercount — admin only. Total signups + active in last 7 days.
async function handleUsercount(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  if (!link.profile.is_admin) return ephemeral('Admin only.');
  const wk = new Date(Date.now() - 7 * 86400e3).toISOString();
  const [tot, recent] = await Promise.all([
    sb.from('profiles').select('id', { count: 'exact', head: true }),
    sb.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', wk),
  ]);
  return ephemeral(
    `Total users: **${tot.count || 0}**\nSignups (7d): **${recent.count || 0}**`
  );
}

// /sales [period] — enthusiast+ only. Sums recent orders.
async function handleSales(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  const tier = resolveTier(link.profile);
  if (!['enthusiast', 'vendor', 'shop'].includes(tier)) {
    return ephemeral('Sales summary is an Enthusiast+ feature.');
  }
  const period = optString(interaction, 'period') || 'month';
  const days = period === 'week' ? 7 : period === 'year' ? 365 : 30;
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const r = await sb.from('orders')
    .select('seller_payout,platform_fee,created_at,status')
    .eq('seller_id', link.profile.id)
    .eq('status', 'completed')
    .gte('created_at', since);
  if (r.error) throw r.error;
  const sales = r.data || [];
  const gross = sales.reduce((s, o) => s + (Number(o.seller_payout) || 0) + (Number(o.platform_fee) || 0), 0);
  const net   = sales.reduce((s, o) => s + (Number(o.seller_payout) || 0), 0);
  return ephemeral(
    `Sales (${period}): **${sales.length}** orders · gross **$${gross.toFixed(2)}** · net **$${net.toFixed(2)}**`
  );
}

// /leaderboard — top 10 portfolios by current value. Opt-in only.
async function handleLeaderboard(_interaction) {
  // Pull opt-in profiles + their summed collection values. Doing this
  // as two queries since PostgREST joins on aggregates are awkward.
  const ops = await sb.from('profiles')
    .select('id,username,name')
    .eq('leaderboard_optin', true);
  if (ops.error || !ops.data || !ops.data.length) {
    return publicReply({ embeds: [{
      title: 'Leaderboard — top portfolios',
      description: 'No one\'s opted in yet. Run `/leaderboard-optin` (Account page setting) to be eligible.',
      color: 0x1AC7A0,
    }]});
  }
  const ids = ops.data.map(p => p.id);
  const ci  = await sb.from('collection_items')
    .select('user_id,current_value,quantity')
    .in('user_id', ids).eq('sold_offline', false).eq('is_ghost', false);
  const totals = {};
  for (const r of (ci.data || [])) {
    totals[r.user_id] = (totals[r.user_id] || 0) + ((Number(r.current_value) || 0) * (r.quantity || 1));
  }
  const ranked = ops.data
    .map(p => ({ name: p.username || p.name || 'Anon', value: totals[p.id] || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const lines = ranked.map((r, i) => `**${i + 1}.** ${r.name} — $${r.value.toFixed(2)}`).join('\n');
  return publicReply({
    embeds: [{
      title: 'Top portfolios (opt-in)',
      color: 0x1AC7A0,
      description: lines || '_no data_',
      footer: { text: 'Opt out anytime from your Account settings.' },
    }],
  });
}

// /track card:<name> threshold:<usd> [direction] — create price alert.
async function handleTrack(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  const cardQ     = optString(interaction, 'card');
  const threshold = Number(optString(interaction, 'threshold'));
  const direction = (optString(interaction, 'direction') || 'above').toLowerCase();
  if (!cardQ || !threshold || isNaN(threshold)) {
    return ephemeral('Usage: `/track card:<name> threshold:<usd> [direction:above|below]`');
  }
  if (!['above', 'below'].includes(direction)) {
    return ephemeral('direction must be `above` or `below`');
  }
  const cards = await sb.from('catalog')
    .select('id,name').ilike('name', `%${cardQ}%`)
    .order('current_value', { ascending: false, nullsFirst: false })
    .limit(1);
  if (!cards.data || !cards.data.length) return ephemeral(`No card matching **${cardQ}**.`);
  const c = cards.data[0];
  const ins = await sb.from('price_alerts').upsert({
    user_id:   link.profile.id,
    catalog_id: c.id,
    threshold, direction,
  }, { onConflict: 'user_id,catalog_id,direction' });
  if (ins.error) throw ins.error;
  return ephemeral(`Tracking **${c.name}** — I\'ll DM you when the price goes **${direction} $${threshold.toFixed(2)}**.`);
}

// /untrack card:<name> — remove price alerts for a card.
async function handleUntrack(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  const cardQ = optString(interaction, 'card');
  if (!cardQ) return ephemeral('Usage: `/untrack card:<name>`');
  const c = await sb.from('catalog').select('id,name').ilike('name', `%${cardQ}%`).limit(1).maybeSingle();
  if (!c.data) return ephemeral(`No card matching **${cardQ}**.`);
  const del = await sb.from('price_alerts').delete().eq('user_id', link.profile.id).eq('catalog_id', c.data.id);
  if (del.error) throw del.error;
  return ephemeral(`Stopped tracking **${c.data.name}**.`);
}


// /duel opponent:<user> [game] [rounds] — community fun. Each side
// pulls N random catalog cards; higher current_value takes that round.
// Most rounds won wins the match. Pure chat candy, no money /
// inventory effect. Default rounds = 3 (best of three).
// ─── Bot game loop (starter, profile, accept-required duel) ──────
//
// 27 starters across Gens 1-9. Discord caps STATIC `choices` at 25 so
// we expose the full list via autocomplete instead. Artwork comes from
// the PokeAPI sprites repo — stable URLs, MIT-licensed.
const STARTERS = [
  // Gen 1
  { id:   1, name: 'Bulbasaur',  gen: 1 },
  { id:   4, name: 'Charmander', gen: 1 },
  { id:   7, name: 'Squirtle',   gen: 1 },
  // Gen 2
  { id: 152, name: 'Chikorita',  gen: 2 },
  { id: 155, name: 'Cyndaquil',  gen: 2 },
  { id: 158, name: 'Totodile',   gen: 2 },
  // Gen 3
  { id: 252, name: 'Treecko',    gen: 3 },
  { id: 255, name: 'Torchic',    gen: 3 },
  { id: 258, name: 'Mudkip',     gen: 3 },
  // Gen 4
  { id: 387, name: 'Turtwig',    gen: 4 },
  { id: 390, name: 'Chimchar',   gen: 4 },
  { id: 393, name: 'Piplup',     gen: 4 },
  // Gen 5
  { id: 495, name: 'Snivy',      gen: 5 },
  { id: 498, name: 'Tepig',      gen: 5 },
  { id: 501, name: 'Oshawott',   gen: 5 },
  // Gen 6
  { id: 650, name: 'Chespin',    gen: 6 },
  { id: 653, name: 'Fennekin',   gen: 6 },
  { id: 656, name: 'Froakie',    gen: 6 },
  // Gen 7
  { id: 722, name: 'Rowlet',     gen: 7 },
  { id: 725, name: 'Litten',     gen: 7 },
  { id: 728, name: 'Popplio',    gen: 7 },
  // Gen 8
  { id: 810, name: 'Grookey',    gen: 8 },
  { id: 813, name: 'Scorbunny',  gen: 8 },
  { id: 816, name: 'Sobble',     gen: 8 },
  // Gen 9
  { id: 906, name: 'Sprigatito', gen: 9 },
  { id: 909, name: 'Fuecoco',    gen: 9 },
  { id: 912, name: 'Quaxly',     gen: 9 },
];
function starterArt(pokemonId) {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${pokemonId}.png`;
}
function findStarter(query) {
  if (!query) return null;
  const q = String(query).toLowerCase().trim();
  // Exact match first, then prefix match.
  return STARTERS.find(s => s.name.toLowerCase() === q)
      || STARTERS.find(s => s.name.toLowerCase().startsWith(q))
      || STARTERS.find(s => s.name.toLowerCase().includes(q))
      || null;
}

// XP / level curve. Total XP needed to REACH level N is `10 * (N-1)^2`,
// so:
//   Level 1 →  2:    10 XP   (10*1   - 10*0)
//   Level 2 →  3:    30 XP   (10*4   - 10*1)
//   Level 10 → 11:  190 XP   (10*100 - 10*81)
//   Level 50 → 51: 1010 XP
//   Level 98 → 99: 1970 XP
//
// XP per win against a same-level opponent is ~30 — so the curve eases
// you up the first ~20 levels then becomes a real grind, which is what
// people expect from a Pokémon-style progression.
function levelFromXp(xp) {
  if (xp <= 0) return 1;
  return Math.min(99, Math.floor(Math.sqrt(xp / 10)) + 1);
}
function xpForLevel(level) { return 10 * (level - 1) * (level - 1); }

// XP awarded for a single duel outcome. Win is base 30 modulated by
// the level difference (clamped 10..100 so you can't farm vastly
// weaker opponents but can't be totally shut out by a huge mismatch).
function calcXpAwarded(outcome, myLevel, oppLevel) {
  if (outcome === 'win') {
    const diff = (oppLevel || 1) - (myLevel || 1);
    const raw  = Math.round(30 * (1 + diff * 0.1));
    return Math.max(10, Math.min(100, raw));
  }
  if (outcome === 'tie') return 15;
  if (outcome === 'loss') return 8;
  return 0;
}

// Cooldowns (in seconds). 10s per-challenger stops anyone from sending
// challenges to multiple targets in rapid succession. 30s per-pair
// stops back-and-forth spam between two specific users.
const DUEL_CD_CHALLENGER_SEC = 10;
const DUEL_CD_PAIR_SEC       = 30;

// Pull one random priced single from the catalog (shared between the
// /duel invitation flow and the accept-button handler).
async function pullDuelCard(game) {
  const alpha = '0123456789abcdef';
  const ch = alpha[Math.floor(Math.random() * alpha.length)];
  const r = await sb.from('catalog')
    .select('id,name,set_name,card_number,image_url,current_value,product_type')
    .eq('game_type', game)
    .not('image_url', 'is', null)
    .not('current_value', 'is', null)
    .gt('current_value', 0)
    .or('product_type.eq.single,product_type.is.null')
    .like('id', `%${ch}%`)
    .limit(80);
  const list = (r.data || []).filter(x =>
    Number(x.current_value) > 0 &&
    (x.product_type === 'single' || x.product_type == null)
  );
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}


// /starter pokemon:<name>  — pick (or change) your starter.
async function handleStarter(interaction) {
  const u = (interaction.member && interaction.member.user) || interaction.user;
  const q = optString(interaction, 'pokemon');
  const s = findStarter(q);
  if (!s) {
    return ephemeral(
      'Pick a starter from the autocomplete list — type a few letters of your favorite ' +
      'starter (Bulbasaur, Charmander, Squirtle, … Quaxly).'
    );
  }
  // Upsert — first-time picks get level 1 / 0 xp / 0 w-l-t; changing a
  // starter keeps existing progress so people can swap to their fave
  // without losing their grind.
  const existing = await sb.from('bot_pokemon')
    .select('level,xp,wins,losses,ties').eq('discord_user_id', u.id).maybeSingle();
  const isUpdate = !!(existing.data);
  const payload = {
    discord_user_id: u.id,
    pokemon_id:      s.id,
    pokemon_name:    s.name,
    updated_at:      new Date().toISOString(),
  };
  if (!isUpdate) {
    payload.level  = 1;
    payload.xp     = 0;
    payload.wins   = 0;
    payload.losses = 0;
    payload.ties   = 0;
  }
  const up = await sb.from('bot_pokemon').upsert(payload, { onConflict: 'discord_user_id' });
  if (up.error) throw up.error;

  return ephemeral(
    `${isUpdate ? 'Swapped' : 'Picked'} your starter: **${s.name}** (Gen ${s.gen}).\n` +
    `${isUpdate ? 'Your XP and W/L stay the same.' : 'You start at level 1. Win /duels to earn XP.'}\n` +
    `Check your stats with \`/profile\`.`
  );
}

// Autocomplete handler for /starter pokemon:. Returns up to 25
// matching starters; if the user hasn't typed anything we surface the
// first 25 (covers Gens 1-8 — they can keep typing for Gen 9).
function handleStarterAutocomplete(interaction) {
  const focused = (interaction.data.options || []).find(o => o.focused);
  const q = (focused && focused.value || '').toLowerCase();
  const matches = !q
    ? STARTERS
    : STARTERS.filter(s => s.name.toLowerCase().includes(q));
  const choices = matches.slice(0, 25).map(s => ({
    name:  `${s.name} (Gen ${s.gen})`,
    value: s.name,
  }));
  return {
    type: INTERACTION_RESPONSE_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  };
}

// /profile [user]  — show starter + stats. Defaults to caller; takes
// optional user:@someone to peek at another player.
async function handleProfile(interaction) {
  const targetUser = optUser(interaction, 'user')
    || (interaction.member && interaction.member.user)
    || interaction.user;
  const r = await sb.from('bot_pokemon')
    .select('*').eq('discord_user_id', targetUser.id).maybeSingle();
  if (!r.data) {
    const who = targetUser.global_name || targetUser.username || 'They';
    return ephemeral(`${who} hasn\'t picked a starter yet — run \`/starter\` to get going.`);
  }
  const p          = r.data;
  const totalDuels = (p.wins || 0) + (p.losses || 0) + (p.ties || 0);
  const winRate    = totalDuels ? Math.round((p.wins / totalDuels) * 100) : 0;
  const curBase    = xpForLevel(p.level);
  const nextBase   = p.level >= 99 ? curBase : xpForLevel(p.level + 1);
  const intoLevel  = p.xp - curBase;
  const toNext     = Math.max(0, nextBase - p.xp);
  const barFilled  = p.level >= 99 ? 20 : Math.max(0, Math.min(20, Math.round((intoLevel / (nextBase - curBase)) * 20)));
  const bar        = '█'.repeat(barFilled) + '░'.repeat(20 - barFilled);
  const name       = targetUser.global_name || targetUser.username || 'Trainer';
  return publicReply({
    embeds: [{
      title: `${name}\'s ${p.pokemon_name}`,
      color: 0x1AC7A0,
      thumbnail: { url: starterArt(p.pokemon_id) },
      fields: [
        { name: 'Level',  value: `**${p.level}**${p.level >= 99 ? ' (MAX)' : ''}`, inline: true },
        { name: 'XP',     value: `${p.xp} / ${p.level >= 99 ? p.xp : nextBase}`,   inline: true },
        { name: 'Record', value: `${p.wins}W · ${p.losses}L · ${p.ties}T (${winRate}%)`, inline: true },
        { name: 'Progress', value: '`' + bar + '`' + (p.level >= 99 ? '' : `  ${toNext} to next`), inline: false },
      ],
      footer: { text: totalDuels ? `${totalDuels} duels fought` : 'No duels yet — challenge someone with /duel!' },
    }],
  });
}

// /duel opponent:<user> [game] [rounds]  — send a challenge. The
// opponent has to click Accept (or Decline) before any cards get
// pulled, so people can't spam-duel into someone's inbox.
async function handleDuel(interaction) {
  const opp = optUser(interaction, 'opponent');
  if (!opp || !opp.id) return ephemeral('Pick an opponent: `/duel opponent:@someone`');
  const challenger = (interaction.member && interaction.member.user) || interaction.user;
  if (opp.id === challenger.id) {
    return ephemeral('You can\'t duel yourself — that\'s a draw by default.');
  }
  if (opp.bot) {
    return ephemeral('Bots don\'t pull cards. Pick a real opponent.');
  }
  const game     = (optString(interaction, 'game')   || 'pokemon').toLowerCase();
  const roundsIn = Number(optString(interaction, 'rounds'));
  const rounds   = roundsIn === 1 ? 1 : 3;

  // Cooldown checks — per-challenger first, then per-pair. The pair
  // check uses an OR so it catches challenges in either direction (so
  // you can't dodge it by swapping who challenges).
  const cdChallenger = await sb.from('bot_duel_log')
    .select('created_at')
    .eq('challenger_discord_id', challenger.id)
    .order('created_at', { ascending: false }).limit(1);
  if (cdChallenger.data && cdChallenger.data[0]) {
    const ageSec = (Date.now() - new Date(cdChallenger.data[0].created_at).getTime()) / 1000;
    if (ageSec < DUEL_CD_CHALLENGER_SEC) {
      return ephemeral(`Slow down — wait ${Math.ceil(DUEL_CD_CHALLENGER_SEC - ageSec)}s before sending another challenge.`);
    }
  }
  const cdPair = await sb.from('bot_duel_log')
    .select('created_at')
    .or(`and(challenger_discord_id.eq.${challenger.id},opponent_discord_id.eq.${opp.id}),and(challenger_discord_id.eq.${opp.id},opponent_discord_id.eq.${challenger.id})`)
    .order('created_at', { ascending: false }).limit(1);
  if (cdPair.data && cdPair.data[0]) {
    const ageSec = (Date.now() - new Date(cdPair.data[0].created_at).getTime()) / 1000;
    if (ageSec < DUEL_CD_PAIR_SEC) {
      return ephemeral(`That pair was just challenged — wait ${Math.ceil(DUEL_CD_PAIR_SEC - ageSec)}s.`);
    }
  }

  // Log the challenge as pending. The Accept/Decline button handler
  // updates the row to resolved + winner.
  await sb.from('bot_duel_log').insert({
    challenger_discord_id: challenger.id,
    opponent_discord_id:   opp.id,
    game, rounds,
    status: 'pending',
  });

  const aName = challenger.global_name || challenger.username || 'Challenger';
  const bName = opp.global_name        || opp.username        || 'Opponent';
  // custom_id encodes everything the button handler needs to know
  // without a DB round-trip: who can click, what game, how many rounds.
  const acceptId  = `duel_accept:${challenger.id}:${opp.id}:${game}:${rounds}`;
  const declineId = `duel_decline:${challenger.id}:${opp.id}`;

  return publicReply({
    content: `${aName} challenged <@${opp.id}> to a ${rounds === 1 ? 'single-pull' : 'best-of-' + rounds} ${game} duel!`,
    embeds: [{
      title: 'Duel Challenge',
      description:
        `<@${opp.id}>, do you accept?\n\n` +
        `**Game:** ${game}\n**Rounds:** ${rounds === 1 ? '1 (single pull)' : `Best of ${rounds}`}`,
      color: 0x1AC7A0,
      footer: { text: 'Both players need /starter to earn XP from the result.' },
    }],
    components: [{
      type: 1, // ACTION_ROW
      components: [
        { type: 2, style: 3, label: 'Accept',  custom_id: acceptId  },
        { type: 2, style: 4, label: 'Decline', custom_id: declineId },
      ],
    }],
    allowed_mentions: { users: [opp.id] },
  });
}

// Handle the Accept / Decline buttons on a /duel invitation.
async function handleDuelComponent(interaction) {
  const clicker = (interaction.member && interaction.member.user) || interaction.user;
  const cid     = interaction.data.custom_id || '';
  const parts   = cid.split(':');
  const action  = parts[0];           // duel_accept | duel_decline
  const challengerId = parts[1];
  const opponentId   = parts[2];

  // Only the opponent can click these buttons. Anyone else gets an
  // ephemeral nag so it doesn't clutter the channel.
  if (clicker.id !== opponentId) {
    return ephemeral('This duel is between two other people — wait your turn.');
  }

  if (action === 'duel_decline') {
    await sb.from('bot_duel_log')
      .update({ status: 'declined', resolved_at: new Date().toISOString() })
      .eq('challenger_discord_id', challengerId)
      .eq('opponent_discord_id',   opponentId)
      .eq('status', 'pending');
    return {
      type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
      data: {
        content: `<@${opponentId}> declined the duel.`,
        embeds: [],
        components: [],
        allowed_mentions: { users: [] },
      },
    };
  }

  // Accept — actually pull cards and resolve the duel.
  const game     = parts[3] || 'pokemon';
  const rounds   = Number(parts[4]) === 1 ? 1 : 3;

  // Fetch both players' pokemon (if any) for XP scaling.
  const pkRes = await sb.from('bot_pokemon')
    .select('discord_user_id, pokemon_name, pokemon_id, level, xp, wins, losses, ties')
    .in('discord_user_id', [challengerId, opponentId]);
  const pkMap = {};
  (pkRes.data || []).forEach(r => { pkMap[r.discord_user_id] = r; });
  const aPk = pkMap[challengerId] || null;
  const bPk = pkMap[opponentId]   || null;

  // Pull all cards.
  const pulls = await Promise.all(
    Array.from({ length: rounds * 2 }, () => pullDuelCard(game))
  );
  if (pulls.some(p => !p)) {
    return {
      type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
      data: { content: `Couldn\'t pull enough priced cards for ${game}.`, embeds: [], components: [] },
    };
  }
  const aCards = pulls.slice(0, rounds);
  const bCards = pulls.slice(rounds);

  let aWins = 0, bWins = 0;
  const roundLines = [];
  for (let i = 0; i < rounds; i++) {
    const a = aCards[i], b = bCards[i];
    const av = Number(a.current_value) || 0;
    const bv = Number(b.current_value) || 0;
    let mark;
    if (av > bv)      { aWins++; mark = '◀'; }
    else if (bv > av) { bWins++; mark = '▶'; }
    else              { mark = '=';          }
    roundLines.push(`**R${i + 1}** ${mark}  ${a.name} ($${av.toFixed(2)})  vs  ${b.name} ($${bv.toFixed(2)})`);
  }

  // Pull display names from the resolved users payload Discord sends
  // with the original interaction. We saved them in custom_id only
  // partially, but interaction.message has the original content/embeds.
  // Easier: re-fetch via Discord REST — but adding a roundtrip per
  // click is wasteful. We'll just use mention strings; Discord renders
  // them inline in the embed description.
  const aMention = `<@${challengerId}>`;
  const bMention = `<@${opponentId}>`;

  // Result + XP.
  let resultLine;
  let winnerColor;
  let winnerId = null;
  let aOutcome = 'tie', bOutcome = 'tie';
  if (aWins > bWins) {
    resultLine = `${aMention} wins **${aWins}-${bWins}**!`;
    winnerColor = 0x1AC7A0;
    winnerId = challengerId;
    aOutcome = 'win'; bOutcome = 'loss';
  } else if (bWins > aWins) {
    resultLine = `${bMention} wins **${bWins}-${aWins}**!`;
    winnerColor = 0xC97A3E;
    winnerId = opponentId;
    aOutcome = 'loss'; bOutcome = 'win';
  } else {
    resultLine = `It\'s a tie at **${aWins}-${bWins}** — split the pot.`;
    winnerColor = 0xFFC857;
  }

  // Award XP only if both players have a starter. If either is
  // missing, the duel still resolves; we just don't write any XP.
  let aXp = 0, bXp = 0;
  let xpFooter;
  if (aPk && bPk) {
    aXp = calcXpAwarded(aOutcome, aPk.level, bPk.level);
    bXp = calcXpAwarded(bOutcome, bPk.level, aPk.level);
    await applyDuelResult(aPk, aOutcome, aXp);
    await applyDuelResult(bPk, bOutcome, bXp);
    xpFooter = `XP: ${aPk.pokemon_name} +${aXp} · ${bPk.pokemon_name} +${bXp}`;
  } else {
    const missing = [];
    if (!aPk) missing.push(aMention);
    if (!bPk) missing.push(bMention);
    xpFooter = `No XP awarded — ${missing.join(' and ')} need to run /starter first.`;
  }

  await sb.from('bot_duel_log')
    .update({
      status: 'accepted',
      winner_discord_id: winnerId,
      challenger_xp_gained: aXp,
      opponent_xp_gained:   bXp,
      resolved_at: new Date().toISOString(),
      result_summary: { aWins, bWins, rounds, game },
    })
    .eq('challenger_discord_id', challengerId)
    .eq('opponent_discord_id',   opponentId)
    .eq('status', 'pending');

  const aTotal = aCards.reduce((s, c) => s + Number(c.current_value || 0), 0);
  const bTotal = bCards.reduce((s, c) => s + Number(c.current_value || 0), 0);
  const aBest = aCards.slice().sort((x, y) => Number(y.current_value) - Number(x.current_value))[0];
  const bBest = bCards.slice().sort((x, y) => Number(y.current_value) - Number(x.current_value))[0];
  const SHARED_URL = 'https://pathbinder.gg/?page=dashboard';
  const embeds = [{
    url: SHARED_URL,
    title: rounds === 1 ? 'Card Duel' : `Card Duel — Best of ${rounds}`,
    description: roundLines.join('\n') + '\n\n' + resultLine,
    color: winnerColor,
    fields: [
      { name: `${aMention} total`, value: `$${aTotal.toFixed(2)}`, inline: true },
      { name: `${bMention} total`, value: `$${bTotal.toFixed(2)}`, inline: true },
    ],
    image: aBest && aBest.image_url ? { url: aBest.image_url } : undefined,
    footer: { text: xpFooter },
  }];
  if (bBest && bBest.image_url) {
    embeds.push({ url: SHARED_URL, image: { url: bBest.image_url } });
  }

  return {
    type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
    data: {
      content: `${aMention} vs ${bMention} — accepted!`,
      embeds,
      components: [],
      allowed_mentions: { users: [] },
    },
  };
}

// Compute new totals after a duel outcome and write them back. Pure
// JS-side recompute of level (no race conditions vs concurrent writes
// because each user duels one at a time via the button click).
async function applyDuelResult(pk, outcome, xpDelta) {
  const newXp     = (pk.xp || 0) + (xpDelta || 0);
  const newLevel  = levelFromXp(newXp);
  const patch = {
    xp:         newXp,
    level:      newLevel,
    wins:       (pk.wins   || 0) + (outcome === 'win'  ? 1 : 0),
    losses:     (pk.losses || 0) + (outcome === 'loss' ? 1 : 0),
    ties:       (pk.ties   || 0) + (outcome === 'tie'  ? 1 : 0),
    updated_at: new Date().toISOString(),
  };
  await sb.from('bot_pokemon').update(patch).eq('discord_user_id', pk.discord_user_id);
}


// ─── Message context-menu handlers (right-click → Apps menu) ──────

// "File as Bug" — when invoked on a message, the original message text
// becomes the bug description. No more typing /bug into a chat box.
async function handleFileAsBugMessage(interaction) {
  const msgs = interaction.data && interaction.data.resolved && interaction.data.resolved.messages;
  const targetId = interaction.data && interaction.data.target_id;
  const msg = msgs && targetId ? msgs[targetId] : null;
  if (!msg || !msg.content) return ephemeral('That message has no text to file.');
  const u = (interaction.member && interaction.member.user) || interaction.user;

  let userId = null;
  try {
    const lr = await sb.from('discord_links').select('user_id').eq('discord_user_id', u.id).maybeSingle();
    userId = (lr.data && lr.data.user_id) || null;
  } catch (_) {}

  await sb.from('bug_reports').insert({
    user_id:          userId,
    discord_user_id:  u.id,
    discord_username: u.username || u.global_name || '',
    channel_name:     interaction.channel && interaction.channel.name ? interaction.channel.name : 'dm',
    description:      msg.content.slice(0, 4000) + (msg.author ? `\n\n— original author: ${msg.author.username}` : ''),
  });
  return ephemeral('Filed as a bug. Thanks for the heads-up!');
}

// "Track Card Price" — message-context shortcut. Pulls the first card-
// shaped word out of the message and treats it as the card name with a
// default 50% drop threshold (user can /untrack and re-/track to tune).
async function handleTrackFromMessage(interaction) {
  const link = await getLinkedProfile(interaction);
  if (!link.ok) return link.reply;
  const msgs = interaction.data && interaction.data.resolved && interaction.data.resolved.messages;
  const targetId = interaction.data && interaction.data.target_id;
  const msg = msgs && targetId ? msgs[targetId] : null;
  if (!msg || !msg.content) return ephemeral('That message has no card name to track.');
  // Crude: take the first 1-3 capitalized words as the card name guess.
  const m = msg.content.match(/[A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,2}/);
  if (!m) return ephemeral('Couldn\'t spot a card name. Try `/track card:<name>` instead.');
  const cards = await sb.from('catalog')
    .select('id,name,current_value').ilike('name', `%${m[0]}%`)
    .order('current_value', { ascending: false, nullsFirst: false })
    .limit(1);
  if (!cards.data || !cards.data.length) return ephemeral(`No card matching "${m[0]}".`);
  const c = cards.data[0];
  const baseline = Number(c.current_value) || 1;
  // Default: alert when price drops 10% below today's value.
  const threshold = +(baseline * 0.9).toFixed(2);
  await sb.from('price_alerts').upsert({
    user_id:    link.profile.id,
    catalog_id: c.id,
    threshold,
    direction:  'below',
  }, { onConflict: 'user_id,catalog_id,direction' });
  return ephemeral(`Tracking **${c.name}** — I\'ll DM you if price drops below **$${threshold.toFixed(2)}**.`);
}


// ─── Shared helpers ──────────────────────────────────────────────

// Pull the slash-command string option by name.
function optString(interaction, name) {
  const opts = (interaction.data && interaction.data.options) || [];
  const o = opts.find(x => x.name === name);
  return o && o.value != null ? String(o.value) : null;
}

// Pull a USER (type 6) option. Discord sends the user's id as the value;
// the actual user object lives in interaction.data.resolved.users keyed
// by that id. Returns the resolved user object (with id, username, bot,
// etc.) or a minimal { id } stub if resolved didn't include it.
function optUser(interaction, name) {
  const opts = (interaction.data && interaction.data.options) || [];
  const o = opts.find(x => x.name === name);
  if (!o || !o.value) return null;
  const resolved = interaction.data && interaction.data.resolved && interaction.data.resolved.users;
  const u = resolved ? resolved[o.value] : null;
  return u || { id: String(o.value) };
}

// Resolve the Discord user → linked PathBinder profile. Returns
// { ok: true, profile, discordUserId } on success, or { ok: false,
// reply: <ephemeral msg> } if not linked. Pass {silent:true} when the
// caller wants to ignore unlinked state instead of returning an error.
async function getLinkedProfile(interaction, opts) {
  const silent = !!(opts && opts.silent);
  const u = (interaction.member && interaction.member.user) || interaction.user;
  const link = await sb.from('discord_links')
    .select('user_id').eq('discord_user_id', u.id).maybeSingle();
  if (!link.data) {
    return silent
      ? { ok: false }
      : { ok: false, reply: ephemeral('Link your account first: run `/link` in this server.') };
  }
  const prof = await sb.from('profiles').select('*').eq('id', link.data.user_id).maybeSingle();
  if (!prof.data) return { ok: false, reply: ephemeral('PathBinder account not found.') };
  return { ok: true, profile: prof.data, discordUserId: u.id };
}

// (config exported at the top of the module — Vercel reads it at
// build time, so it has to be present before the handler is assigned.)
