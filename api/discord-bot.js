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

// CRITICAL: tell Vercel NOT to parse the request body. Discord signs
// the exact bytes of the request, and any JSON re-serialization (key
// order, whitespace) would break the signature verification. Must be
// exported at the TOP of the module — Vercel reads this at build time
// before the handler runs.
//
// maxDuration: 60 — Discord's deferred-ack model lets us send the
// "thinking…" ack immediately and PATCH the real response anytime
// within 15 minutes. Vercel's default function maxDuration on the
// Hobby plan is 10s — if the deferred handler takes longer than
// that, Vercel KILLS the function before the PATCH goes out and
// the user is left staring at "PathBot is thinking…" forever. 60s
// is comfortably above what any /movers-style RPC needs even with
// a cold-start cache miss, and well under the 15-min Discord cap.
// On Vercel Pro you can go up to 300s; on Hobby this caps at 60s.
module.exports.config = { api: { bodyParser: false }, maxDuration: 60 };

// Lazy-loaded Supabase client. @supabase/supabase-js is the largest
// dep in this bundle (~300KB) and adds ~300-500ms to cold-start time
// when require()d at module top-level. Moving the require + createClient
// behind a Proxy means PING interactions (which Discord sends
// regularly to verify the endpoint is alive) never touch it; the
// first slash-command request still creates the client on demand
// before the deferred ack returns. Subsequent invocations on the
// same warm instance reuse the cached client.
let _sbCache = null;
function _ensureSb() {
  if (_sbCache) return _sbCache;
  const { createClient } = require('@supabase/supabase-js');
  _sbCache = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  return _sbCache;
}
// Proxy lets existing `sb.from(...)`, `sb.rpc(...)`, `sb.storage`
// callsites keep working unchanged — every property access lazily
// initializes the client and forwards.
const sb = new Proxy({}, {
  get(_t, prop) {
    const client = _ensureSb();
    const v = client[prop];
    return typeof v === 'function' ? v.bind(client) : v;
  },
});

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
  'movers', 'showcase', 'random', 'set',
  'price', 'marketplace', 'usercount', 'leaderboard',
  // /duel intentionally NOT deferred — it was snappy without it, and
  // the "Bot is thinking..." preface was extra noise before the
  // challenge embed showed up.
]);
const DEFER_EPHEMERAL_SLASH = new Set([
  'portfolio', 'wishlist', 'listings', 'sales', 'badge',
  'track', 'untrack', 'trade-open', 'profile',
  // /starter intentionally NOT deferred — one read + one upsert is
  // fast enough that the "Bot is thinking..." flash before the confirm
  // is more annoying than useful.
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
  // Warm-up ping from the Vercel cron (vercel.json crons entry hits
  // ?warm=1 every 4 minutes). The whole point is to keep this Lambda
  // hot so user-triggered slash commands don't pay cold-start cost
  // and trip Discord's 3-second deferred-ack window. Respond instantly
  // without touching Supabase or the signature path.
  if (req.method === 'GET' && req.query && req.query.warm === '1') {
    return res.status(200).json({
      ok: true,
      service: 'pathbinder-discord-bot',
      warmed_at: new Date().toISOString(),
    });
  }
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
      // to settle before terminating the function (capped at the
      // module's maxDuration, set to 60s above).
      const _deferStart = Date.now();
      console.log('[discord-bot] /' + name + ' DEFER ack sent');
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE,
        data: deferEphemeral ? { flags: EPHEMERAL } : {},
      });
      // WATCHDOG: race the handler against a 50s timer (under the
      // 60s maxDuration). Whichever wins, the user sees a real
      // message — not "PathBot is thinking…" forever.
      //
      // Background: without this, if the handler's work exceeds
      // maxDuration, Vercel SIGKILL's the function and the PATCH
      // call inside the catch block never fires — leaving Discord
      // showing "thinking…" until the 15-min interaction token
      // expires. The watchdog guarantees we PATCH SOMETHING within
      // the function's lifetime, even if it's a timeout message.
      const HANDLER_BUDGET_MS = 50000;
      let watchdogFired = false;
      const watchdog = new Promise(function(resolve) {
        setTimeout(function() {
          watchdogFired = true;
          resolve({ __watchdog: true });
        }, HANDLER_BUDGET_MS);
      });
      try {
        const result = await Promise.race([runSlashHandler(name, interaction), watchdog]);
        if (watchdogFired) {
          const _ms = Date.now() - _deferStart;
          console.error('[discord-bot] /' + name + ' watchdog tripped at ' + _ms + 'ms — handler still running');
          await patchOriginalInteractionResponse(interaction,
            ephemeral('That command is taking too long. The catalog might be under heavy load — try again in a moment.'));
        } else {
          const _handlerMs = Date.now() - _deferStart;
          console.log('[discord-bot] /' + name + ' handler done in ' + _handlerMs + 'ms, PATCHing…');
          await patchOriginalInteractionResponse(interaction, result);
          const _totalMs = Date.now() - _deferStart;
          console.log('[discord-bot] /' + name + ' PATCH done, total ' + _totalMs + 'ms');
        }
      } catch (e) {
        const _failMs = Date.now() - _deferStart;
        console.error('[discord-bot] /' + name + ' deferred handler error at ' + _failMs + 'ms:', e && e.stack || e);
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
  // Handled synchronously — was snappy in practice and deferring just
  // added a "thinking..." UX flash before the result.
  if (interaction.type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
    try {
      const cid = (interaction.data && interaction.data.custom_id) || '';
      if (cid.startsWith('duel_accept:') || cid.startsWith('duel_decline:')) {
        const reply = await handleDuelComponent(interaction);
        return res.status(200).json(reply);
      }
      if (cid.startsWith('battle_accept:') || cid.startsWith('battle_decline:')) {
        const reply = await handleBattleComponent(interaction);
        return res.status(200).json(reply);
      }
      if (cid.startsWith('battle2_accept:') || cid.startsWith('battle2_decline:') || cid.startsWith('battle2_move:')) {
        const reply = await handleBattleFullComponent(interaction);
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
// maxDuration MUST match the top-of-file declaration; see that comment.
module.exports.config = { api: { bodyParser: false }, maxDuration: 60 };


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
    case 'battle': {
      // Route to Tier 1 (quick) or Tier 2 (full) based on the
      // `mode` choice. Defaults to 'quick' so old links/tests still
      // work — opting into the multi-turn experience is explicit.
      const mode = (optString(interaction, 'mode') || 'quick').toLowerCase();
      if (mode === 'full') return await handleBattleFull(interaction);
      return await handleBattle(interaction);
    }
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
  // Per-RPC timeout (ms). Beyond this we abandon the query for that
  // game and continue with whatever finished — `_no data_` for that
  // game's column is far better than the entire handler stalling and
  // Vercel killing the function at maxDuration:60 with no PATCH ever
  // going out. Tunable per env: set MOVERS_RPC_TIMEOUT_MS to override.
  const RPC_TIMEOUT_MS = parseInt(process.env.MOVERS_RPC_TIMEOUT_MS, 10) || 8000;
  function _withTimeout(p, ms, label) {
    return new Promise(resolve => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        console.warn(`[discord-bot] /movers RPC ${label} TIMEOUT after ${ms}ms`);
        resolve({ data: [], error: { message: `RPC timeout after ${ms}ms` } });
      }, ms);
      p.then(r => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(r);
      }).catch(e => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve({ data: [], error: e || { message: 'unknown rejection' } });
      });
    });
  }
  try {
    // allSettled instead of all — a slow RPC for one game shouldn't
    // gate the others. With per-call timeouts above, total wall-clock
    // is bounded by the longest survivor (≤ RPC_TIMEOUT_MS).
    const results = await Promise.allSettled(gamesToQuery.map(gt => {
      const params = {
        p_game_type:    gt,
        p_days_back:    days,
        p_top_n:        perGameLimit,
        p_min_pct:      0.5,
        p_sort:         'pct',
        p_product_type: 'single',
        // $1+ floor — cheap commons aren't going to be top-3
        // movers and they make up ~80% of the catalog scan.
        // Drops RPC time from ~1.2s to ~200ms per game.
        p_min_value:    1.0,
      };
      console.log(`[discord-bot] /movers RPC call (${gt}):`, JSON.stringify(params));
      return _withTimeout(sb.rpc('get_global_price_movers', params), RPC_TIMEOUT_MS, gt).then(r => {
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
    // Promise.allSettled gives [{status:'fulfilled', value: [...rows]}, ...]
    // or [{status:'rejected', reason: ...}, ...]. Pull the values out and
    // ignore rejections (they were already logged inside _withTimeout).
    const merged = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value || []);
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

// Evolution chains for each starter. Levels match the canonical
// games (mostly 16/36 for Gens 1-3 with a few outliers — Cyndaquil
// and Chimchar evolve early at 14, Totodile late at 18, Quilladin/
// Bayleef etc. as in cart). Stage IDs are PokeAPI pokedex numbers
// so starterArt(id) works for the evolved form too.
const EVOLUTIONS = {
  // Gen 1
  1:   { stage2: { id: 2,   name: 'Ivysaur',     level: 16 }, stage3: { id: 3,   name: 'Venusaur',    level: 32 } },
  4:   { stage2: { id: 5,   name: 'Charmeleon',  level: 16 }, stage3: { id: 6,   name: 'Charizard',   level: 36 } },
  7:   { stage2: { id: 8,   name: 'Wartortle',   level: 16 }, stage3: { id: 9,   name: 'Blastoise',   level: 36 } },
  // Gen 2
  152: { stage2: { id: 153, name: 'Bayleef',     level: 16 }, stage3: { id: 154, name: 'Meganium',    level: 32 } },
  155: { stage2: { id: 156, name: 'Quilava',     level: 14 }, stage3: { id: 157, name: 'Typhlosion',  level: 36 } },
  158: { stage2: { id: 159, name: 'Croconaw',    level: 18 }, stage3: { id: 160, name: 'Feraligatr',  level: 30 } },
  // Gen 3
  252: { stage2: { id: 253, name: 'Grovyle',     level: 16 }, stage3: { id: 254, name: 'Sceptile',    level: 36 } },
  255: { stage2: { id: 256, name: 'Combusken',   level: 16 }, stage3: { id: 257, name: 'Blaziken',    level: 36 } },
  258: { stage2: { id: 259, name: 'Marshtomp',   level: 16 }, stage3: { id: 260, name: 'Swampert',    level: 36 } },
  // Gen 4
  387: { stage2: { id: 388, name: 'Grotle',      level: 18 }, stage3: { id: 389, name: 'Torterra',    level: 32 } },
  390: { stage2: { id: 391, name: 'Monferno',    level: 14 }, stage3: { id: 392, name: 'Infernape',   level: 36 } },
  393: { stage2: { id: 394, name: 'Prinplup',    level: 16 }, stage3: { id: 395, name: 'Empoleon',    level: 36 } },
  // Gen 5
  495: { stage2: { id: 496, name: 'Servine',     level: 17 }, stage3: { id: 497, name: 'Serperior',   level: 36 } },
  498: { stage2: { id: 499, name: 'Pignite',     level: 17 }, stage3: { id: 500, name: 'Emboar',      level: 36 } },
  501: { stage2: { id: 502, name: 'Dewott',      level: 17 }, stage3: { id: 503, name: 'Samurott',    level: 36 } },
  // Gen 6
  650: { stage2: { id: 651, name: 'Quilladin',   level: 16 }, stage3: { id: 652, name: 'Chesnaught',  level: 36 } },
  653: { stage2: { id: 654, name: 'Braixen',     level: 16 }, stage3: { id: 655, name: 'Delphox',     level: 36 } },
  656: { stage2: { id: 657, name: 'Frogadier',   level: 16 }, stage3: { id: 658, name: 'Greninja',    level: 36 } },
  // Gen 7
  722: { stage2: { id: 723, name: 'Dartrix',     level: 17 }, stage3: { id: 724, name: 'Decidueye',   level: 34 } },
  725: { stage2: { id: 726, name: 'Torracat',    level: 17 }, stage3: { id: 727, name: 'Incineroar',  level: 34 } },
  728: { stage2: { id: 729, name: 'Brionne',     level: 17 }, stage3: { id: 730, name: 'Primarina',   level: 34 } },
  // Gen 8
  810: { stage2: { id: 811, name: 'Thwackey',    level: 16 }, stage3: { id: 812, name: 'Rillaboom',   level: 35 } },
  813: { stage2: { id: 814, name: 'Raboot',      level: 16 }, stage3: { id: 815, name: 'Cinderace',   level: 35 } },
  816: { stage2: { id: 817, name: 'Drizzile',    level: 16 }, stage3: { id: 818, name: 'Inteleon',    level: 35 } },
  // Gen 9
  906: { stage2: { id: 907, name: 'Floragato',   level: 16 }, stage3: { id: 908, name: 'Meowscarada', level: 36 } },
  909: { stage2: { id: 910, name: 'Crocalor',    level: 16 }, stage3: { id: 911, name: 'Skeledirge',  level: 36 } },
  912: { stage2: { id: 913, name: 'Quaxwell',    level: 16 }, stage3: { id: 914, name: 'Quaquaval',   level: 36 } },
};

// Given a starter ID and a level, the highest evolution stage the
// pokemon would be in at that level. Returns null when still in
// stage-1 (the starter itself).
function pokemonAtLevel(starterId, level) {
  const ev = EVOLUTIONS[starterId];
  if (!ev) return null;
  if (level >= ev.stage3.level) return { id: ev.stage3.id, name: ev.stage3.name, stage: 3 };
  if (level >= ev.stage2.level) return { id: ev.stage2.id, name: ev.stage2.name, stage: 2 };
  return null;
}

// Should this pokemon evolve as a result of a level-up? Compares the
// current stage (inferred from currentPokemonId) against the highest
// stage available at the new level. Returns the new form info or null.
// Skips intermediate stages if a big XP burst leapfrogs multiple
// thresholds (you'd evolve directly to stage 3 rather than 2).
function checkEvolution(starterId, currentPokemonId, newLevel) {
  const ev = EVOLUTIONS[starterId];
  if (!ev) return null;
  let currentStage = 1;
  if (currentPokemonId === ev.stage3.id)      currentStage = 3;
  else if (currentPokemonId === ev.stage2.id) currentStage = 2;

  let targetStage = currentStage;
  if (newLevel >= ev.stage3.level)      targetStage = 3;
  else if (newLevel >= ev.stage2.level) targetStage = Math.max(targetStage, 2);

  if (targetStage <= currentStage) return null;
  const stage = targetStage === 3 ? ev.stage3 : ev.stage2;
  return { id: stage.id, name: stage.name, fromStage: currentStage, toStage: targetStage };
}
// ── /battle move data ──────────────────────────────────────────────
// Each starter form gets 4 lore-accurate moves with canonical-ish
// power/accuracy values. Keys are POKEMON NAMES (matching STARTERS +
// EVOLUTIONS) for easy lookup by current form. Moves trend stronger
// per evolution stage so leveling up + evolving makes you stronger
// in /battle, matching real-game progression.
//
// Tier 1 scoring: random move pick from each side; damage = power ×
// (accuracy/100) × random(0.85, 1.0) + (level × 0.5). Higher damage
// wins. No HP, no type chart, no turn loop — those come in Tier 2.
const POKEMON_MOVES = {
  // Gen 1 — Bulbasaur line
  'Bulbasaur':  [{n:'Vine Whip',  p:45,a:100,t:'grass'},  {n:'Tackle',      p:40,a:100,t:'normal'}, {n:'Leech Seed',  p:25,a:90, t:'grass'},  {n:'Growl',         p:15,a:100,t:'normal'}],
  'Ivysaur':    [{n:'Razor Leaf', p:55,a:95, t:'grass'},  {n:'Take Down',   p:90,a:85, t:'normal'}, {n:'Sleep Powder',p:35,a:75, t:'grass'},  {n:'Vine Whip',     p:45,a:100,t:'grass'}],
  'Venusaur':   [{n:'Solar Beam', p:120,a:100,t:'grass'}, {n:'Sludge Bomb', p:90,a:100,t:'poison'},{n:'Petal Blizzard',p:90,a:100,t:'grass'}, {n:'Earthquake',    p:100,a:100,t:'ground'}],
  // Gen 1 — Charmander line
  'Charmander': [{n:'Ember',      p:40,a:100,t:'fire'},   {n:'Scratch',     p:40,a:100,t:'normal'}, {n:'Smokescreen', p:20,a:100,t:'normal'}, {n:'Dragon Rage',   p:40,a:100,t:'dragon'}],
  'Charmeleon': [{n:'Flamethrower',p:90,a:100,t:'fire'},  {n:'Slash',       p:70,a:100,t:'normal'}, {n:'Dragon Breath',p:60,a:100,t:'dragon'},{n:'Ember',         p:40,a:100,t:'fire'}],
  'Charizard':  [{n:'Fire Blast', p:110,a:85, t:'fire'},  {n:'Air Slash',   p:75,a:95, t:'flying'}, {n:'Dragon Claw', p:80,a:100,t:'dragon'}, {n:'Heat Wave',     p:95,a:90, t:'fire'}],
  // Gen 1 — Squirtle line
  'Squirtle':   [{n:'Water Gun',  p:40,a:100,t:'water'},  {n:'Tackle',      p:40,a:100,t:'normal'}, {n:'Withdraw',    p:20,a:100,t:'water'},  {n:'Bubble',        p:40,a:100,t:'water'}],
  'Wartortle':  [{n:'Bite',       p:60,a:100,t:'dark'},   {n:'Water Pulse', p:60,a:100,t:'water'},  {n:'Aqua Jet',    p:40,a:100,t:'water'},  {n:'Rapid Spin',    p:50,a:100,t:'normal'}],
  'Blastoise':  [{n:'Hydro Pump', p:110,a:80, t:'water'}, {n:'Skull Bash',  p:130,a:100,t:'normal'},{n:'Ice Beam',    p:90,a:100,t:'ice'},    {n:'Flash Cannon',  p:80,a:100,t:'steel'}],
  // Gen 2 — Chikorita line
  'Chikorita':  [{n:'Vine Whip',  p:45,a:100,t:'grass'},  {n:'Tackle',      p:40,a:100,t:'normal'}, {n:'Razor Leaf',  p:55,a:95, t:'grass'},  {n:'Reflect',       p:25,a:100,t:'psychic'}],
  'Bayleef':    [{n:'Magical Leaf',p:60,a:100,t:'grass'}, {n:'Body Slam',   p:85,a:100,t:'normal'}, {n:'Synthesis',   p:30,a:100,t:'grass'},  {n:'Razor Leaf',    p:55,a:95, t:'grass'}],
  'Meganium':   [{n:'Petal Dance',p:120,a:100,t:'grass'}, {n:'Earthquake',  p:100,a:100,t:'ground'},{n:'Body Slam',   p:85,a:100,t:'normal'}, {n:'Solar Beam',    p:120,a:100,t:'grass'}],
  // Gen 2 — Cyndaquil line
  'Cyndaquil':  [{n:'Ember',      p:40,a:100,t:'fire'},   {n:'Tackle',      p:40,a:100,t:'normal'}, {n:'Smokescreen', p:20,a:100,t:'normal'}, {n:'Quick Attack',  p:40,a:100,t:'normal'}],
  'Quilava':    [{n:'Flame Wheel',p:60,a:100,t:'fire'},   {n:'Quick Attack',p:40,a:100,t:'normal'}, {n:'Lava Plume',  p:80,a:100,t:'fire'},   {n:'Swift',         p:60,a:100,t:'normal'}],
  'Typhlosion': [{n:'Eruption',   p:120,a:100,t:'fire'},  {n:'Flamethrower',p:90,a:100,t:'fire'},   {n:'Thunder Punch',p:75,a:100,t:'electric'},{n:'Wild Charge', p:90,a:100,t:'electric'}],
  // Gen 2 — Totodile line
  'Totodile':   [{n:'Water Gun',  p:40,a:100,t:'water'},  {n:'Scratch',     p:40,a:100,t:'normal'}, {n:'Bite',        p:60,a:100,t:'dark'},   {n:'Rage',          p:20,a:100,t:'normal'}],
  'Croconaw':   [{n:'Crunch',     p:80,a:100,t:'dark'},   {n:'Water Pulse', p:60,a:100,t:'water'},  {n:'Slash',       p:70,a:100,t:'normal'}, {n:'Aqua Tail',     p:90,a:90, t:'water'}],
  'Feraligatr': [{n:'Hydro Pump', p:110,a:80, t:'water'}, {n:'Crunch',      p:80,a:100,t:'dark'},   {n:'Ice Fang',    p:65,a:95, t:'ice'},    {n:'Aqua Tail',     p:90,a:90, t:'water'}],
  // Gen 3 — Treecko line
  'Treecko':    [{n:'Pound',      p:40,a:100,t:'normal'}, {n:'Absorb',      p:20,a:100,t:'grass'},  {n:'Quick Attack',p:40,a:100,t:'normal'}, {n:'Mega Drain',    p:40,a:100,t:'grass'}],
  'Grovyle':    [{n:'Leaf Blade', p:90,a:100,t:'grass'},  {n:'Slash',       p:70,a:100,t:'normal'}, {n:'Quick Attack',p:40,a:100,t:'normal'}, {n:'Pursuit',       p:40,a:100,t:'dark'}],
  'Sceptile':   [{n:'Leaf Storm', p:130,a:90, t:'grass'}, {n:'Dragon Claw', p:80,a:100,t:'dragon'}, {n:'Leaf Blade',  p:90,a:100,t:'grass'},  {n:'Earthquake',    p:100,a:100,t:'ground'}],
  // Gen 3 — Torchic line
  'Torchic':    [{n:'Ember',      p:40,a:100,t:'fire'},   {n:'Peck',        p:35,a:100,t:'flying'}, {n:'Scratch',     p:40,a:100,t:'normal'}, {n:'Sand Attack',   p:15,a:100,t:'ground'}],
  'Combusken':  [{n:'Double Kick',p:30,a:100,t:'fighting'},{n:'Flame Charge',p:50,a:100,t:'fire'},  {n:'Peck',        p:35,a:100,t:'flying'}, {n:'Bulk Up',       p:25,a:100,t:'fighting'}],
  'Blaziken':   [{n:'Blaze Kick', p:85,a:90, t:'fire'},   {n:'Sky Uppercut',p:85,a:90, t:'fighting'},{n:'Brave Bird', p:120,a:100,t:'flying'},{n:'Flare Blitz',   p:120,a:100,t:'fire'}],
  // Gen 3 — Mudkip line
  'Mudkip':     [{n:'Water Gun',  p:40,a:100,t:'water'},  {n:'Tackle',      p:40,a:100,t:'normal'}, {n:'Mud-Slap',    p:20,a:100,t:'ground'}, {n:'Foresight',     p:15,a:100,t:'normal'}],
  'Marshtomp':  [{n:'Mud Shot',   p:55,a:95, t:'ground'}, {n:'Water Pulse', p:60,a:100,t:'water'},  {n:'Mud Bomb',    p:65,a:85, t:'ground'}, {n:'Rock Slide',    p:75,a:90, t:'rock'}],
  'Swampert':   [{n:'Hydro Pump', p:110,a:80, t:'water'}, {n:'Earthquake',  p:100,a:100,t:'ground'},{n:'Hammer Arm',  p:100,a:90, t:'fighting'},{n:'Muddy Water', p:90,a:85, t:'water'}],
  // Gen 4 — Turtwig line
  'Turtwig':    [{n:'Tackle',     p:40,a:100,t:'normal'}, {n:'Absorb',      p:20,a:100,t:'grass'},  {n:'Withdraw',    p:20,a:100,t:'water'},  {n:'Razor Leaf',    p:55,a:95, t:'grass'}],
  'Grotle':     [{n:'Bite',       p:60,a:100,t:'dark'},   {n:'Razor Leaf',  p:55,a:95, t:'grass'},  {n:'Body Slam',   p:85,a:100,t:'normal'}, {n:'Mega Drain',    p:40,a:100,t:'grass'}],
  'Torterra':   [{n:'Wood Hammer',p:120,a:100,t:'grass'}, {n:'Earthquake',  p:100,a:100,t:'ground'},{n:'Crunch',      p:80,a:100,t:'dark'},   {n:'Stone Edge',    p:100,a:80, t:'rock'}],
  // Gen 4 — Chimchar line
  'Chimchar':   [{n:'Scratch',    p:40,a:100,t:'normal'}, {n:'Ember',       p:40,a:100,t:'fire'},   {n:'Leer',        p:15,a:100,t:'normal'}, {n:'Taunt',         p:20,a:100,t:'dark'}],
  'Monferno':   [{n:'Mach Punch', p:40,a:100,t:'fighting'},{n:'Flame Wheel',p:60,a:100,t:'fire'},   {n:'Feint',       p:30,a:100,t:'normal'}, {n:'Fury Swipes',   p:50,a:80, t:'normal'}],
  'Infernape':  [{n:'Close Combat',p:120,a:100,t:'fighting'},{n:'Flare Blitz',p:120,a:100,t:'fire'},{n:'U-Turn',      p:70,a:100,t:'bug'},    {n:'Stone Edge',    p:100,a:80, t:'rock'}],
  // Gen 4 — Piplup line
  'Piplup':     [{n:'Pound',      p:40,a:100,t:'normal'}, {n:'Bubble',      p:40,a:100,t:'water'},  {n:'Peck',        p:35,a:100,t:'flying'}, {n:'Growl',         p:15,a:100,t:'normal'}],
  'Prinplup':   [{n:'Metal Claw', p:50,a:95, t:'steel'},  {n:'Bubble Beam', p:65,a:100,t:'water'},  {n:'Peck',        p:35,a:100,t:'flying'}, {n:'Pluck',         p:60,a:100,t:'flying'}],
  'Empoleon':   [{n:'Hydro Pump', p:110,a:80, t:'water'}, {n:'Drill Peck',  p:80,a:100,t:'flying'}, {n:'Flash Cannon',p:80,a:100,t:'steel'},  {n:'Aqua Jet',      p:40,a:100,t:'water'}],
  // Gen 5 — Snivy line
  'Snivy':      [{n:'Tackle',     p:40,a:100,t:'normal'}, {n:'Vine Whip',   p:45,a:100,t:'grass'},  {n:'Leer',        p:15,a:100,t:'normal'}, {n:'Wrap',          p:15,a:90, t:'normal'}],
  'Servine':    [{n:'Leaf Tornado',p:65,a:90, t:'grass'}, {n:'Slam',        p:80,a:75, t:'normal'}, {n:'Leech Seed',  p:25,a:90, t:'grass'},  {n:'Vine Whip',     p:45,a:100,t:'grass'}],
  'Serperior':  [{n:'Leaf Storm', p:130,a:90, t:'grass'}, {n:'Coil',        p:30,a:100,t:'poison'}, {n:'Aqua Tail',   p:90,a:90, t:'water'},  {n:'Dragon Pulse',  p:85,a:100,t:'dragon'}],
  // Gen 5 — Tepig line
  'Tepig':      [{n:'Tackle',     p:40,a:100,t:'normal'}, {n:'Ember',       p:40,a:100,t:'fire'},   {n:'Tail Whip',   p:15,a:100,t:'normal'}, {n:'Defense Curl',  p:20,a:100,t:'normal'}],
  'Pignite':    [{n:'Flame Charge',p:50,a:100,t:'fire'},  {n:'Arm Thrust',  p:40,a:100,t:'fighting'},{n:'Heat Crash', p:80,a:100,t:'fire'},   {n:'Rollout',       p:30,a:90, t:'rock'}],
  'Emboar':     [{n:'Heat Crash', p:120,a:100,t:'fire'},  {n:'Hammer Arm',  p:100,a:90, t:'fighting'},{n:'Wild Charge',p:90,a:100,t:'electric'},{n:'Head Smash', p:150,a:80, t:'rock'}],
  // Gen 5 — Oshawott line
  'Oshawott':   [{n:'Tackle',     p:40,a:100,t:'normal'}, {n:'Water Gun',   p:40,a:100,t:'water'},  {n:'Tail Whip',   p:15,a:100,t:'normal'}, {n:'Focus Energy', p:20,a:100,t:'normal'}],
  'Dewott':     [{n:'Razor Shell',p:75,a:95, t:'water'},  {n:'Fury Cutter', p:40,a:95, t:'bug'},    {n:'Aqua Jet',    p:40,a:100,t:'water'},  {n:'Water Pulse',  p:60,a:100,t:'water'}],
  'Samurott':   [{n:'Hydro Pump', p:110,a:80, t:'water'}, {n:'Megahorn',    p:120,a:85, t:'bug'},   {n:'Slash',       p:70,a:100,t:'normal'}, {n:'Aqua Jet',     p:40,a:100,t:'water'}],
  // Gen 6 — Chespin line
  'Chespin':    [{n:'Tackle',     p:40,a:100,t:'normal'}, {n:'Vine Whip',   p:45,a:100,t:'grass'},  {n:'Rollout',     p:30,a:90, t:'rock'},   {n:'Bite',          p:60,a:100,t:'dark'}],
  'Quilladin':  [{n:'Pin Missile',p:25,a:95, t:'bug'},    {n:'Needle Arm',  p:60,a:100,t:'grass'},  {n:'Take Down',   p:90,a:85, t:'normal'}, {n:'Bite',          p:60,a:100,t:'dark'}],
  'Chesnaught': [{n:'Wood Hammer',p:120,a:100,t:'grass'}, {n:'Hammer Arm',  p:100,a:90, t:'fighting'},{n:'Spiky Shield',p:30,a:100,t:'grass'},{n:'Body Slam',     p:85,a:100,t:'normal'}],
  // Gen 6 — Fennekin line
  'Fennekin':   [{n:'Scratch',    p:40,a:100,t:'normal'}, {n:'Ember',       p:40,a:100,t:'fire'},   {n:'Tail Whip',   p:15,a:100,t:'normal'}, {n:'Howl',          p:20,a:100,t:'normal'}],
  'Braixen':    [{n:'Psybeam',    p:65,a:100,t:'psychic'},{n:'Flame Charge',p:50,a:100,t:'fire'},   {n:'Magical Leaf',p:60,a:100,t:'grass'},  {n:'Lucky Chant',   p:25,a:100,t:'normal'}],
  'Delphox':    [{n:'Mystical Fire',p:75,a:100,t:'fire'}, {n:'Psyshock',    p:80,a:100,t:'psychic'},{n:'Future Sight',p:120,a:100,t:'psychic'},{n:'Flamethrower',p:90,a:100,t:'fire'}],
  // Gen 6 — Froakie line
  'Froakie':    [{n:'Pound',      p:40,a:100,t:'normal'}, {n:'Bubble',      p:40,a:100,t:'water'},  {n:'Quick Attack',p:40,a:100,t:'normal'}, {n:'Lick',          p:30,a:100,t:'ghost'}],
  'Frogadier':  [{n:'Water Pulse',p:60,a:100,t:'water'},  {n:'Smokescreen', p:20,a:100,t:'normal'}, {n:'Round',       p:60,a:100,t:'normal'}, {n:'Bounce',        p:85,a:85, t:'flying'}],
  'Greninja':   [{n:'Water Shuriken',p:15,a:100,t:'water'},{n:'Night Slash',p:70,a:100,t:'dark'},   {n:'Hydro Pump',  p:110,a:80, t:'water'}, {n:'Ice Beam',      p:90,a:100,t:'ice'}],
  // Gen 7 — Rowlet line
  'Rowlet':     [{n:'Tackle',     p:40,a:100,t:'normal'}, {n:'Leafage',     p:40,a:100,t:'grass'},  {n:'Peck',        p:35,a:100,t:'flying'}, {n:'Astonish',      p:30,a:100,t:'ghost'}],
  'Dartrix':    [{n:'Razor Leaf', p:55,a:95, t:'grass'},  {n:'Pluck',       p:60,a:100,t:'flying'}, {n:'Synthesis',   p:30,a:100,t:'grass'},  {n:'Ominous Wind',  p:60,a:100,t:'ghost'}],
  'Decidueye':  [{n:'Spirit Shackle',p:80,a:100,t:'ghost'},{n:'Leaf Blade', p:90,a:100,t:'grass'},  {n:'Brave Bird',  p:120,a:100,t:'flying'},{n:'Phantom Force',p:90,a:100,t:'ghost'}],
  // Gen 7 — Litten line
  'Litten':     [{n:'Scratch',    p:40,a:100,t:'normal'}, {n:'Ember',       p:40,a:100,t:'fire'},   {n:'Lick',        p:30,a:100,t:'ghost'},  {n:'Leer',          p:15,a:100,t:'normal'}],
  'Torracat':   [{n:'Fire Fang',  p:65,a:95, t:'fire'},   {n:'Bite',        p:60,a:100,t:'dark'},   {n:'Lick',        p:30,a:100,t:'ghost'},  {n:'Double Kick',   p:30,a:100,t:'fighting'}],
  'Incineroar': [{n:'Darkest Lariat',p:85,a:100,t:'dark'},{n:'Flare Blitz', p:120,a:100,t:'fire'},  {n:'Cross Chop',  p:100,a:80, t:'fighting'},{n:'Throat Chop',p:80,a:100,t:'dark'}],
  // Gen 7 — Popplio line
  'Popplio':    [{n:'Pound',      p:40,a:100,t:'normal'}, {n:'Water Gun',   p:40,a:100,t:'water'},  {n:'Disarming Voice',p:40,a:100,t:'fairy'},{n:'Growl',        p:15,a:100,t:'normal'}],
  'Brionne':    [{n:'Bubble Beam',p:65,a:100,t:'water'},  {n:'Disarming Voice',p:40,a:100,t:'fairy'},{n:'Aqua Jet',  p:40,a:100,t:'water'},  {n:'Encore',        p:20,a:100,t:'normal'}],
  'Primarina':  [{n:'Sparkling Aria',p:90,a:100,t:'water'},{n:'Moonblast',  p:95,a:100,t:'fairy'},  {n:'Hydro Pump',  p:110,a:80, t:'water'}, {n:'Psychic',       p:90,a:100,t:'psychic'}],
  // Gen 8 — Grookey line
  'Grookey':    [{n:'Scratch',    p:40,a:100,t:'normal'}, {n:'Branch Poke', p:40,a:100,t:'grass'},  {n:'Growl',       p:15,a:100,t:'normal'}, {n:'Taunt',         p:20,a:100,t:'dark'}],
  'Thwackey':   [{n:'Razor Leaf', p:55,a:95, t:'grass'},  {n:'Knock Off',   p:65,a:100,t:'dark'},   {n:'Double Hit',  p:35,a:90, t:'normal'}, {n:'Screech',       p:20,a:85, t:'normal'}],
  'Rillaboom':  [{n:'Drum Beating',p:80,a:100,t:'grass'}, {n:'Wood Hammer', p:120,a:100,t:'grass'}, {n:'Earthquake',  p:100,a:100,t:'ground'},{n:'High Horsepower',p:95,a:95,t:'ground'}],
  // Gen 8 — Scorbunny line
  'Scorbunny':  [{n:'Tackle',     p:40,a:100,t:'normal'}, {n:'Ember',       p:40,a:100,t:'fire'},   {n:'Quick Attack',p:40,a:100,t:'normal'}, {n:'Double Kick',   p:30,a:100,t:'fighting'}],
  'Raboot':     [{n:'Flame Charge',p:50,a:100,t:'fire'},  {n:'Double Kick', p:30,a:100,t:'fighting'},{n:'Headbutt',   p:70,a:100,t:'normal'}, {n:'Quick Attack',  p:40,a:100,t:'normal'}],
  'Cinderace':  [{n:'Pyro Ball',  p:120,a:90, t:'fire'},  {n:'High Jump Kick',p:130,a:90,t:'fighting'},{n:'Iron Head',p:80,a:100,t:'steel'},  {n:'Bounce',        p:85,a:85, t:'flying'}],
  // Gen 8 — Sobble line
  'Sobble':     [{n:'Pound',      p:40,a:100,t:'normal'}, {n:'Water Gun',   p:40,a:100,t:'water'},  {n:'Growl',       p:15,a:100,t:'normal'}, {n:'Bind',          p:15,a:85, t:'normal'}],
  'Drizzile':   [{n:'Water Pulse',p:60,a:100,t:'water'},  {n:'U-Turn',      p:70,a:100,t:'bug'},    {n:'Sucker Punch',p:70,a:100,t:'dark'},   {n:'Liquidation',   p:85,a:100,t:'water'}],
  'Inteleon':   [{n:'Snipe Shot', p:80,a:100,t:'water'},  {n:'Hydro Pump',  p:110,a:80, t:'water'}, {n:'Ice Beam',    p:90,a:100,t:'ice'},    {n:'Air Slash',     p:75,a:95, t:'flying'}],
  // Gen 9 — Sprigatito line
  'Sprigatito': [{n:'Scratch',    p:40,a:100,t:'normal'}, {n:'Leafage',     p:40,a:100,t:'grass'},  {n:'Tail Whip',   p:15,a:100,t:'normal'}, {n:'Bite',          p:60,a:100,t:'dark'}],
  'Floragato':  [{n:'Magical Leaf',p:60,a:100,t:'grass'}, {n:'Bite',        p:60,a:100,t:'dark'},   {n:'U-Turn',      p:70,a:100,t:'bug'},    {n:'Slash',         p:70,a:100,t:'normal'}],
  'Meowscarada':[{n:'Flower Trick',p:70,a:100,t:'grass'}, {n:'Night Slash', p:70,a:100,t:'dark'},   {n:'U-Turn',      p:70,a:100,t:'bug'},    {n:'Play Rough',    p:90,a:90, t:'fairy'}],
  // Gen 9 — Fuecoco line
  'Fuecoco':    [{n:'Tackle',     p:40,a:100,t:'normal'}, {n:'Ember',       p:40,a:100,t:'fire'},   {n:'Leer',        p:15,a:100,t:'normal'}, {n:'Astonish',      p:30,a:100,t:'ghost'}],
  'Crocalor':   [{n:'Bite',       p:60,a:100,t:'dark'},   {n:'Incinerate',  p:60,a:100,t:'fire'},   {n:'Flame Charge',p:50,a:100,t:'fire'},   {n:'Yawn',          p:25,a:100,t:'normal'}],
  'Skeledirge': [{n:'Torch Song', p:80,a:100,t:'fire'},   {n:'Shadow Ball', p:80,a:100,t:'ghost'},  {n:'Earth Power', p:90,a:100,t:'ground'}, {n:'Hyper Voice',   p:90,a:100,t:'normal'}],
  // Gen 9 — Quaxly line
  'Quaxly':     [{n:'Pound',      p:40,a:100,t:'normal'}, {n:'Water Gun',   p:40,a:100,t:'water'},  {n:'Sing',        p:25,a:55, t:'normal'}, {n:'Wing Attack',   p:60,a:100,t:'flying'}],
  'Quaxwell':   [{n:'Aqua Step',  p:80,a:100,t:'water'},  {n:'Wing Attack', p:60,a:100,t:'flying'}, {n:'Double Hit',  p:35,a:90, t:'normal'}, {n:'Work Up',       p:20,a:100,t:'normal'}],
  'Quaquaval':  [{n:'Aqua Step',  p:80,a:100,t:'water'},  {n:'Brick Break', p:75,a:100,t:'fighting'},{n:'Close Combat',p:120,a:100,t:'fighting'},{n:'Liquidation',p:85,a:100,t:'water'}],
};

// Primary + optional secondary type for each starter form. Used by
// Tier 2 /battle for type-effectiveness math. Format: [primary] or
// [primary, secondary]. Tier 1 doesn't read this, only Tier 2.
const POKEMON_TYPES = {
  // Gen 1
  'Bulbasaur':['grass','poison'], 'Ivysaur':['grass','poison'], 'Venusaur':['grass','poison'],
  'Charmander':['fire'], 'Charmeleon':['fire'], 'Charizard':['fire','flying'],
  'Squirtle':['water'], 'Wartortle':['water'], 'Blastoise':['water'],
  // Gen 2
  'Chikorita':['grass'], 'Bayleef':['grass'], 'Meganium':['grass'],
  'Cyndaquil':['fire'], 'Quilava':['fire'], 'Typhlosion':['fire'],
  'Totodile':['water'], 'Croconaw':['water'], 'Feraligatr':['water'],
  // Gen 3
  'Treecko':['grass'], 'Grovyle':['grass'], 'Sceptile':['grass'],
  'Torchic':['fire'], 'Combusken':['fire','fighting'], 'Blaziken':['fire','fighting'],
  'Mudkip':['water'], 'Marshtomp':['water','ground'], 'Swampert':['water','ground'],
  // Gen 4
  'Turtwig':['grass'], 'Grotle':['grass'], 'Torterra':['grass','ground'],
  'Chimchar':['fire'], 'Monferno':['fire','fighting'], 'Infernape':['fire','fighting'],
  'Piplup':['water'], 'Prinplup':['water'], 'Empoleon':['water','steel'],
  // Gen 5
  'Snivy':['grass'], 'Servine':['grass'], 'Serperior':['grass'],
  'Tepig':['fire'], 'Pignite':['fire','fighting'], 'Emboar':['fire','fighting'],
  'Oshawott':['water'], 'Dewott':['water'], 'Samurott':['water'],
  // Gen 6
  'Chespin':['grass'], 'Quilladin':['grass'], 'Chesnaught':['grass','fighting'],
  'Fennekin':['fire'], 'Braixen':['fire'], 'Delphox':['fire','psychic'],
  'Froakie':['water'], 'Frogadier':['water'], 'Greninja':['water','dark'],
  // Gen 7
  'Rowlet':['grass','flying'], 'Dartrix':['grass','flying'], 'Decidueye':['grass','ghost'],
  'Litten':['fire'], 'Torracat':['fire'], 'Incineroar':['fire','dark'],
  'Popplio':['water'], 'Brionne':['water'], 'Primarina':['water','fairy'],
  // Gen 8
  'Grookey':['grass'], 'Thwackey':['grass'], 'Rillaboom':['grass'],
  'Scorbunny':['fire'], 'Raboot':['fire'], 'Cinderace':['fire'],
  'Sobble':['water'], 'Drizzile':['water'], 'Inteleon':['water'],
  // Gen 9
  'Sprigatito':['grass'], 'Floragato':['grass'], 'Meowscarada':['grass','dark'],
  'Fuecoco':['fire'], 'Crocalor':['fire'], 'Skeledirge':['fire','ghost'],
  'Quaxly':['water'], 'Quaxwell':['water'], 'Quaquaval':['water','fighting'],
};

// Canonical Pokemon type-effectiveness chart, sparse-encoded — only
// non-1× entries appear. Read as TYPE_CHART[attackingType][defendingType]
// = multiplier. Missing pair → 1× (neutral).
// 2 = super effective, 0.5 = not very effective, 0 = no effect.
const TYPE_CHART = {
  normal:   { rock:0.5, ghost:0,   steel:0.5 },
  fire:     { fire:0.5, water:0.5, grass:2,   ice:2, bug:2, rock:0.5, dragon:0.5, steel:2 },
  water:    { fire:2,   water:0.5, grass:0.5, ground:2, rock:2, dragon:0.5 },
  electric: { water:2,  electric:0.5, grass:0.5, ground:0, flying:2, dragon:0.5 },
  grass:    { fire:0.5, water:2,   grass:0.5, poison:0.5, ground:2, flying:0.5, bug:0.5, rock:2, dragon:0.5, steel:0.5 },
  ice:      { fire:0.5, water:0.5, grass:2,   ice:0.5, ground:2, flying:2, dragon:2, steel:0.5 },
  fighting: { normal:2, ice:2, poison:0.5, flying:0.5, psychic:0.5, bug:0.5, rock:2, ghost:0, dark:2, steel:2, fairy:0.5 },
  poison:   { grass:2, poison:0.5, ground:0.5, rock:0.5, ghost:0.5, steel:0, fairy:2 },
  ground:   { fire:2, electric:2, grass:0.5, poison:2, flying:0, bug:0.5, rock:2, steel:2 },
  flying:   { electric:0.5, grass:2, fighting:2, bug:2, rock:0.5, steel:0.5 },
  psychic:  { fighting:2, poison:2, psychic:0.5, dark:0, steel:0.5 },
  bug:      { fire:0.5, grass:2, fighting:0.5, poison:0.5, flying:0.5, psychic:2, ghost:0.5, dark:2, steel:0.5, fairy:0.5 },
  rock:     { fire:2, ice:2, fighting:0.5, ground:0.5, flying:2, bug:2, steel:0.5 },
  ghost:    { normal:0, psychic:2, ghost:2, dark:0.5 },
  dragon:   { dragon:2, steel:0.5, fairy:0 },
  dark:     { fighting:0.5, psychic:2, ghost:2, dark:0.5, fairy:0.5 },
  steel:    { fire:0.5, water:0.5, electric:0.5, ice:2, rock:2, steel:0.5, fairy:2 },
  fairy:    { fire:0.5, fighting:2, poison:0.5, dragon:2, dark:2, steel:0.5 },
};

// Look up a Pokémon's types by name. Returns at least one type
// (defaults to 'normal' if a form is somehow missing from
// POKEMON_TYPES — the Tier 2 battle still runs, just without a
// type bonus for that side).
function getPokemonTypes(name) {
  return POKEMON_TYPES[name] || ['normal'];
}

// Multiplier when a move of `attackType` hits a defender with up
// to two types. Multipliers stack (2× × 2× = 4×, 0.5× × 0.5× = 0.25×).
function typeEffectiveness(attackType, defenderTypes) {
  const chart = TYPE_CHART[attackType] || {};
  let mult = 1;
  for (const t of defenderTypes) {
    if (t in chart) mult *= chart[t];
  }
  return mult;
}

// HP scales with level so leveling up makes you genuinely sturdier.
// Lv 1 = 45 HP, Lv 10 = 135, Lv 36 (final evo) = 395. Tuned so a
// neutral 60-power move does ~50-80 damage = 2-3 hits per battle.
function pokemonHp(level) {
  return (Math.max(1, level | 0) * 10) + 35;
}

// Tier 2 damage formula. Considers level, move power, accuracy
// (miss roll), type effectiveness, and a small variance.
// Returns { dmg, missed, effectiveness } — missed=true means the
// accuracy roll failed and dmg = 0.
function calcBattleDamageFull(move, attackerLevel, defenderTypes) {
  const acc = Math.min(100, Math.max(1, move.a || 100));
  if (Math.random() * 100 > acc) {
    return { dmg: 0, missed: true, effectiveness: 1 };
  }
  const effectiveness = typeEffectiveness(move.t, defenderTypes);
  const variance = 0.85 + Math.random() * 0.15;
  // Scaled-down Gen 1 formula. The /5 normalizes power so a Lv 10
  // Flamethrower does ~70 dmg before effectiveness vs the ~135 HP of
  // a Lv 10 defender. Tunable.
  const base = ((attackerLevel || 1) / 5 + 2) * (move.p || 1) * 0.4;
  const dmg = Math.max(1, Math.round(base * variance * effectiveness));
  return { dmg, missed: false, effectiveness };
}

// ASCII-ish HP bar for the embed. Pokemon-style coloring isn't
// possible in Discord embeds without using ANSI code blocks, so we
// use Unicode block characters and let the embed color carry the
// "warning" signal (green → yellow → red as HP drops).
function hpBar(current, max, width = 10) {
  const pct = Math.max(0, Math.min(1, current / max));
  const filled = Math.round(pct * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

// Color for the battle embed based on the lower of the two HP
// percentages — drops from teal → gold → red as either side gets
// close to KO. Just visual flavor.
function hpEmbedColor(aHp, aMax, bHp, bMax) {
  const minPct = Math.min(aHp / aMax, bHp / bMax);
  if (minPct < 0.25) return 0xE74C3C; // red
  if (minPct < 0.50) return 0xFFC857; // gold
  return 0x1AC7A0;                     // teal
}

// Element-style icons for the embed flavor — one glyph per move type.
const TYPE_ICONS = {
  fire:'🔥', water:'💧', grass:'🌿', electric:'⚡', ice:'❄️',
  fighting:'👊', poison:'☠️', ground:'🌎', flying:'🪶', psychic:'🔮',
  bug:'🐛', rock:'🪨', ghost:'👻', dragon:'🐉', dark:'🌑',
  steel:'⚙️', fairy:'✨', normal:'⭐',
};

// Lookup helper — returns the moveset for the pokemon's CURRENT form
// (resolves starter_id + level → current form name, falls back to a
// generic moveset if data is somehow missing).
function getMovesForPokemon(pk) {
  const name = (pk && pk.pokemon_name) || '';
  return POKEMON_MOVES[name] || [
    {n:'Tackle', p:40, a:100, t:'normal'},
    {n:'Growl',  p:15, a:100, t:'normal'},
  ];
}

// Single damage calculation. Used by /battle (Tier 1 — no HP, no
// type chart). Damage = power × (accuracy/100) × random(0.85, 1.0)
// + level × 0.5. The level term gives high-level pokemon a meaningful
// edge without making low-level battles deterministic.
function calcBattleDamage(move, level) {
  const accFactor = Math.min(1, (move.a || 100) / 100);
  const variance  = 0.85 + Math.random() * 0.15;
  const base      = (move.p || 0) * accFactor * variance;
  const levelBonus = (level || 1) * 0.5;
  // Accuracy roll — if it misses entirely, damage is zero (suspense).
  if (Math.random() * 100 > (move.a || 100)) return 0;
  return Math.round(base + levelBonus);
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
const DUEL_CD_PAIR_SEC       = 15;

// Pull one random priced single from the catalog (shared between the
// /duel invitation flow and the accept-button handler).
async function pullDuelCard(game) {
  // Previous implementation used `id LIKE '%<random hex char>%'` as a
  // randomizer, which for small TCG pools (Gundam ~50 eligible singles)
  // could return zero rows just because the chosen char didn't appear
  // in any id. That's why /duel game:gundam reported "couldn't pull
  // enough priced cards" even though Gundam had 83% history coverage.
  // Also, the old filter `product_type IN (single, null)` excluded
  // every sealed-* row — for Gundam ~80% of today's priced rows are
  // sealed products, leaving a tiny single pool. Now we:
  //   1. COUNT eligible rows for the game (no hex filter)
  //   2. Pick a random offset
  //   3. Fetch the row at that offset
  // Singles and sealed both count — sealed boosters/decks have
  // current_value just like singles, and they make for fun "you drew
  // a $200 booster box" duel reveals.
  const baseFilter = {
    game_type: game,
  };

  // Count first so we know the pool size and can fail fast with a
  // useful error if it's truly empty (e.g. dbz/topps before their
  // weekly scrape runs).
  const countRes = await sb.from('catalog')
    .select('id', { count: 'exact', head: true })
    .eq('game_type', game)
    .not('image_url', 'is', null)
    .not('current_value', 'is', null)
    .gt('current_value', 0);
  const total = countRes.count || 0;
  if (total === 0) return null;

  // Random offset into the eligible pool. Postgres + PostgREST handle
  // .range() as inclusive on both ends; range(N, N) → 1 row at offset N.
  const offset = Math.floor(Math.random() * total);
  const r = await sb.from('catalog')
    .select('id,name,set_name,card_number,image_url,current_value,product_type')
    .eq('game_type', game)
    .not('image_url', 'is', null)
    .not('current_value', 'is', null)
    .gt('current_value', 0)
    .order('id', { ascending: true })
    .range(offset, offset);
  return (r.data && r.data[0]) || null;
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
  // auto_evolve option — defaults true (Pokémon games default).
  // Explicit false makes the pokemon stay in its current form across
  // level-ups, same as holding B to cancel evolution in the games.
  const autoEvolveOpt = optBool(interaction, 'auto_evolve');
  const allowEvolution = autoEvolveOpt === null ? true : autoEvolveOpt;

  // Upsert — first-time picks get level 1 / 0 xp / 0 w-l-t; changing a
  // starter keeps existing progress so people can swap to their fave
  // without losing their grind.
  const existing = await sb.from('bot_pokemon')
    .select('level,xp,wins,losses,ties').eq('discord_user_id', u.id).maybeSingle();
  const isUpdate = !!(existing.data);

  // Catch-up evolution: if the trainer is already a higher level than
  // the starter's first/second evolution thresholds and auto_evolve is
  // on, evolve straight to the appropriate form. Without this, picking
  // Charmander at lvl 50 would leave you stuck as a Charmander until
  // you gained more XP — surprising and bad UX.
  let displayPokemonId   = s.id;
  let displayPokemonName = s.name;
  let evolvedTo = null;
  if (isUpdate && allowEvolution) {
    const lvl = existing.data.level || 1;
    const catchUp = pokemonAtLevel(s.id, lvl);
    if (catchUp) {
      displayPokemonId   = catchUp.id;
      displayPokemonName = catchUp.name;
      evolvedTo = catchUp;
    }
  }

  const payload = {
    discord_user_id:     u.id,
    pokemon_id:          displayPokemonId,
    pokemon_name:        displayPokemonName,
    original_pokemon_id: s.id,
    allow_evolution:     allowEvolution,
    updated_at:          new Date().toISOString(),
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

  // Build the confirmation message.
  const verb = isUpdate ? 'Swapped' : 'Picked';
  let line = `${verb} your starter: **${s.name}** (Gen ${s.gen}).`;
  if (evolvedTo) {
    line += `\nYour level ${existing.data.level} progress evolved it straight into **${evolvedTo.name}**.`;
  } else if (isUpdate) {
    line += '\nYour XP and W/L stay the same.';
  } else {
    line += '\nYou start at level 1. Win /duels to earn XP.';
  }
  line += allowEvolution
    ? '\nAuto-evolution: **on**. Pass `auto_evolve: false` next time to keep your starter form.'
    : '\nAuto-evolution: **off**. Your pokemon will stay in this form across level-ups.';
  line += '\nCheck your stats with `/profile`.';
  return ephemeral(line);
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

  // Evolution status — find the starter name (might differ from current
  // pokemon name if they've evolved), and note whether evolution is on.
  const starterId = p.original_pokemon_id || p.pokemon_id;
  const starterEntry = STARTERS.find(s => s.id === starterId);
  const starterName  = starterEntry ? starterEntry.name : null;
  const evolved      = starterName && p.pokemon_name !== starterName;
  const evoOn        = p.allow_evolution !== false;
  // Footer breakdown:
  //   "5 duels fought · originally Charmander · evolution: on"
  const footerParts = [];
  footerParts.push(totalDuels ? `${totalDuels} duels fought` : 'No duels yet — challenge someone with /duel!');
  if (evolved && starterName) footerParts.push(`originally ${starterName}`);
  footerParts.push(`evolution: ${evoOn ? 'on' : 'paused'}`);

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
      footer: { text: footerParts.join(' · ') },
    }],
  });
}

// /duel opponent:<user> [game] [rounds]  — runs immediately, no
// accept prompt. Cooldowns (10s per challenger, 30s per pair) are
// the only spam guard. XP is still only awarded when both players
// have starters; otherwise the duel runs purely for fun.
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
  // Allowed rounds: 1 (quick), 3 (best-of-three, default), 5 (extended).
  // Previous version clamped to `roundsIn === 1 ? 1 : 3` which silently
  // demoted 5 → 3. Now we accept any of the three registered choices
  // and default to 3 for unknowns/missing.
  const roundsIn = optInt(interaction, 'rounds');
  const rounds   = (roundsIn === 1 || roundsIn === 5) ? roundsIn : 3;

  // Cooldown checks — per-challenger first, then per-pair. The pair
  // check uses an OR so it catches challenges in either direction (so
  // you can't dodge it by swapping who challenges).
  //
  // We deliberately ignore 'pending' rows: those are either duels that
  // errored out before firing (resolveDuelMatch returned no cards) or
  // /battle invites the opponent never accepted. In neither case did
  // the previous challenge actually run, so it would feel awful to
  // make the user wait 15s before retrying.
  const cdChallenger = await sb.from('bot_duel_log')
    .select('created_at')
    .eq('challenger_discord_id', challenger.id)
    .neq('status', 'pending')
    .order('created_at', { ascending: false }).limit(1);
  if (cdChallenger.data && cdChallenger.data[0]) {
    const ageSec = (Date.now() - new Date(cdChallenger.data[0].created_at).getTime()) / 1000;
    if (ageSec < DUEL_CD_CHALLENGER_SEC) {
      return ephemeral(`Slow down — wait ${Math.ceil(DUEL_CD_CHALLENGER_SEC - ageSec)}s before sending another challenge.`);
    }
  }
  const cdPair = await sb.from('bot_duel_log')
    .select('created_at')
    .neq('status', 'pending')
    .or(`and(challenger_discord_id.eq.${challenger.id},opponent_discord_id.eq.${opp.id}),and(challenger_discord_id.eq.${opp.id},opponent_discord_id.eq.${challenger.id})`)
    .order('created_at', { ascending: false }).limit(1);
  if (cdPair.data && cdPair.data[0]) {
    const ageSec = (Date.now() - new Date(cdPair.data[0].created_at).getTime()) / 1000;
    if (ageSec < DUEL_CD_PAIR_SEC) {
      return ephemeral(`That pair was just challenged — wait ${Math.ceil(DUEL_CD_PAIR_SEC - ageSec)}s.`);
    }
  }

  // Fetch both players' pokemon records (if any) for XP scaling. The
  // duel runs regardless — XP is only awarded when both have starters,
  // but no consent prompt either way.
  const pkRes = await sb.from('bot_pokemon')
    .select('discord_user_id, pokemon_name, pokemon_id, level, xp, wins, losses, ties, allow_evolution, original_pokemon_id')
    .in('discord_user_id', [challenger.id, opp.id]);
  const pkMap = {};
  (pkRes.data || []).forEach(r => { pkMap[r.discord_user_id] = r; });
  const aPk = pkMap[challenger.id] || null;
  const bPk = pkMap[opp.id]        || null;

  const aName = challenger.global_name || challenger.username || 'Challenger';
  const bName = opp.global_name        || opp.username        || 'Opponent';

  // Log the duel — single insert, marked pending and immediately
  // resolved by resolveDuelMatch below.
  const logRow = await sb.from('bot_duel_log').insert({
    challenger_discord_id: challenger.id,
    opponent_discord_id:   opp.id,
    game, rounds,
    status: 'pending',
  }).select('id').maybeSingle();
  const duelLogId = (logRow.data && logRow.data.id) || null;

  const resolved = await resolveDuelMatch({
    challengerId: challenger.id,
    opponentId:   opp.id,
    game, rounds,
    aPk, bPk,
    duelLogId,
    aName, bName,
  });
  if (resolved.error) {
    // The duel never actually fired (e.g. game catalog had no priced
    // cards). Delete the pending log row so it doesn't sit around;
    // the cooldown query already ignores pending rows but the cleanup
    // keeps the table tidy.
    if (duelLogId) {
      try { await sb.from('bot_duel_log').delete().eq('id', duelLogId); } catch(_) {}
    }
    return publicReply({ content: resolved.error });
  }
  return publicReply({
    content: `${aName} challenged <@${opp.id}> to a ${rounds === 1 ? 'single-pull' : 'best-of-' + rounds} ${game} duel!`,
    embeds: resolved.embeds,
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
  // Custom_id encodes rounds as parts[4]. Allowed values: 1, 3, 5
  // (matches the slash command's choices). Default to 3 for any
  // unknown value — older custom_ids that predate the 5-round option
  // gracefully fall back instead of crashing.
  const game     = parts[3] || 'pokemon';
  const roundsIn = Number(parts[4]);
  const rounds   = (roundsIn === 1 || roundsIn === 5) ? roundsIn : 3;

  // Fetch both players' pokemon — by the time we reach here both should
  // exist (handleDuel only uses buttons when both have starters), but
  // we handle the missing case defensively.
  const pkRes = await sb.from('bot_pokemon')
    .select('discord_user_id, pokemon_name, pokemon_id, level, xp, wins, losses, ties')
    .in('discord_user_id', [challengerId, opponentId]);
  const pkMap = {};
  (pkRes.data || []).forEach(r => { pkMap[r.discord_user_id] = r; });

  const resolved = await resolveDuelMatch({
    challengerId,
    opponentId,
    game, rounds,
    aPk: pkMap[challengerId] || null,
    bPk: pkMap[opponentId]   || null,
    duelLogId: null, // looked up by challenger+opponent+pending below
  });
  if (resolved.error) {
    // Clean up the pending row that handleDuel inserted — the cooldown
    // query already ignores pending rows, but this stops dead rows
    // from piling up in bot_duel_log when the catalog has no pulls.
    try {
      await sb.from('bot_duel_log')
        .delete()
        .eq('challenger_discord_id', challengerId)
        .eq('opponent_discord_id',   opponentId)
        .eq('status', 'pending');
    } catch(_) {}
    return {
      type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
      data: { content: resolved.error, embeds: [], components: [] },
    };
  }

  return {
    type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
    data: {
      content: `<@${challengerId}> vs <@${opponentId}> — accepted!`,
      embeds: resolved.embeds,
      components: [],
      allowed_mentions: { users: [] },
    },
  };
}

// Shared duel runner: pulls cards, scores rounds, awards XP if both
// ─── /battle — Pokémon-style move battle (Tier 1) ──────────────────
// Both players must have a starter at level 5+. Each side gets a
// random move from their current form's moveset, damage is computed,
// higher damage wins. Same Accept-button flow as /duel and writes to
// the same bot_duel_log table (so /profile and history queries pick
// up battles too). Battles award 2x the XP of a duel — they're
// intended as the "main event" once you've grown your starter.
const BATTLE_LEVEL_MIN = 5;
const BATTLE_XP_MULTIPLIER = 2;

async function handleBattle(interaction) {
  const u = (interaction.member && interaction.member.user) || interaction.user;
  const opp = optUser(interaction, 'opponent');
  if (!opp || !opp.id) return ephemeral('Pick an opponent.');
  if (opp.id === u.id) return ephemeral('Battling yourself is not allowed.');
  if (opp.bot)         return ephemeral('Bots don\'t train pokemon. Pick a real opponent.');

  // Both must have starters at level 5+.
  const pkRes = await sb.from('bot_pokemon')
    .select('*').in('discord_user_id', [u.id, opp.id]);
  const pks = (pkRes.data || []);
  const aPk = pks.find(p => p.discord_user_id === u.id);
  const bPk = pks.find(p => p.discord_user_id === opp.id);
  if (!aPk) return ephemeral('Pick your starter first — run /starter.');
  if (!bPk) return ephemeral(`<@${opp.id}> hasn't picked a starter yet — they need to run /starter first.`);
  if ((aPk.level || 1) < BATTLE_LEVEL_MIN) {
    return ephemeral(`Your **${aPk.pokemon_name}** is only level ${aPk.level || 1} — needs to be level ${BATTLE_LEVEL_MIN} to battle. Try /duel to grind XP first.`);
  }
  if ((bPk.level || 1) < BATTLE_LEVEL_MIN) {
    return ephemeral(`<@${opp.id}>'s **${bPk.pokemon_name}** is only level ${bPk.level || 1} — needs to be level ${BATTLE_LEVEL_MIN} to battle.`);
  }

  // Same cooldowns as /duel (per-challenger + per-pair). Pending rows
  // are excluded — see /duel for the rationale (abandoned invites and
  // failed-to-fire duels shouldn't penalize the challenger).
  const cdChallenger = await sb.from('bot_duel_log')
    .select('created_at').eq('challenger_discord_id', u.id)
    .neq('status', 'pending')
    .order('created_at', { ascending: false }).limit(1);
  if (cdChallenger.data && cdChallenger.data[0]) {
    const ageSec = (Date.now() - new Date(cdChallenger.data[0].created_at).getTime()) / 1000;
    if (ageSec < DUEL_CD_CHALLENGER_SEC) {
      return ephemeral(`Slow down — wait ${Math.ceil(DUEL_CD_CHALLENGER_SEC - ageSec)}s before sending another challenge.`);
    }
  }
  const cdPair = await sb.from('bot_duel_log')
    .select('created_at')
    .neq('status', 'pending')
    .or(`and(challenger_discord_id.eq.${u.id},opponent_discord_id.eq.${opp.id}),and(challenger_discord_id.eq.${opp.id},opponent_discord_id.eq.${u.id})`)
    .order('created_at', { ascending: false }).limit(1);
  if (cdPair.data && cdPair.data[0]) {
    const ageSec = (Date.now() - new Date(cdPair.data[0].created_at).getTime()) / 1000;
    if (ageSec < DUEL_CD_PAIR_SEC) {
      return ephemeral(`That pair was just challenged — wait ${Math.ceil(DUEL_CD_PAIR_SEC - ageSec)}s.`);
    }
  }

  // Log a pending battle so the Accept button knows which row to resolve.
  await sb.from('bot_duel_log').insert({
    challenger_discord_id: u.id,
    opponent_discord_id:   opp.id,
    game: 'pokemon_battle',
    rounds: 1,
    status: 'pending',
  });

  const aName = (interaction.member && interaction.member.user && interaction.member.user.username) || u.username || 'Trainer';
  const bName = opp.username || 'Trainer';
  return {
    type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `<@${opp.id}>  ⚔️  **${aName}** challenges you to a Pokémon battle!\n` +
               `**${aPk.pokemon_name}** (Lv ${aPk.level}) vs **${bPk.pokemon_name}** (Lv ${bPk.level})`,
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Accept Battle',  custom_id: `battle_accept:${u.id}:${opp.id}` },
          { type: 2, style: 4, label: 'Decline',        custom_id: `battle_decline:${u.id}:${opp.id}` },
        ],
      }],
      allowed_mentions: { users: [opp.id] },
    },
  };
}

async function handleBattleComponent(interaction) {
  const cid = (interaction.data && interaction.data.custom_id) || '';
  const parts = cid.split(':');                  // [action, challengerId, opponentId]
  const action       = parts[0];
  const challengerId = parts[1];
  const opponentId   = parts[2];
  const clickerId    = (interaction.member && interaction.member.user && interaction.member.user.id) ||
                       (interaction.user && interaction.user.id);

  // Only the opponent can accept/decline.
  if (clickerId !== opponentId) {
    return ephemeral('Only the challenged trainer can accept or decline this battle.');
  }

  if (action === 'battle_decline') {
    await sb.from('bot_duel_log')
      .update({ status: 'declined', resolved_at: new Date().toISOString() })
      .eq('challenger_discord_id', challengerId).eq('opponent_discord_id', opponentId)
      .eq('status', 'pending');
    return {
      type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
      data: { content: `<@${opponentId}> declined the battle.`, components: [] },
    };
  }

  // Accept — pull both pokemon, resolve, build the result embed.
  const pkRes = await sb.from('bot_pokemon').select('*').in('discord_user_id', [challengerId, opponentId]);
  const pks   = pkRes.data || [];
  const aPk   = pks.find(p => p.discord_user_id === challengerId);
  const bPk   = pks.find(p => p.discord_user_id === opponentId);
  if (!aPk || !bPk) {
    return {
      type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
      data: { content: 'Both trainers need an active starter — battle aborted.', embeds: [], components: [] },
    };
  }

  const result = await resolveBattleMatch({ challengerId, opponentId, aPk, bPk });
  if (result.error) {
    return {
      type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
      data: { content: result.error, embeds: [], components: [] },
    };
  }
  return {
    type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
    data: {
      content: `<@${challengerId}> vs <@${opponentId}> — battle complete!`,
      embeds: result.embeds,
      components: [],
      allowed_mentions: { users: [] },
    },
  };
}

async function resolveBattleMatch({ challengerId, opponentId, aPk, bPk }) {
  const aMoves = getMovesForPokemon(aPk);
  const bMoves = getMovesForPokemon(bPk);
  const aMove  = aMoves[Math.floor(Math.random() * aMoves.length)];
  const bMove  = bMoves[Math.floor(Math.random() * bMoves.length)];
  const aDmg   = calcBattleDamage(aMove, aPk.level || 1);
  const bDmg   = calcBattleDamage(bMove, bPk.level || 1);

  let resultLine, winnerColor, winnerId = null, aOutcome = 'tie', bOutcome = 'tie';
  if (aDmg > bDmg) {
    resultLine = `**${aPk.pokemon_name}** wins! **${aDmg}** damage vs ${bDmg}`;
    winnerColor = 0x1AC7A0;
    winnerId = challengerId; aOutcome = 'win'; bOutcome = 'loss';
  } else if (bDmg > aDmg) {
    resultLine = `**${bPk.pokemon_name}** wins! **${bDmg}** damage vs ${aDmg}`;
    winnerColor = 0xC97A3E;
    winnerId = opponentId; aOutcome = 'loss'; bOutcome = 'win';
  } else {
    resultLine = `Both trainers dealt **${aDmg}** damage — it's a draw!`;
    winnerColor = 0xFFC857;
  }

  // XP — battles award 2x duel XP. Evolutions still trigger normally
  // through applyDuelResult.
  const aXp = calcXpAwarded(aOutcome, aPk.level, bPk.level) * BATTLE_XP_MULTIPLIER;
  const bXp = calcXpAwarded(bOutcome, bPk.level, aPk.level) * BATTLE_XP_MULTIPLIER;
  const aRes = await applyDuelResult(aPk, aOutcome, aXp);
  const bRes = await applyDuelResult(bPk, bOutcome, bXp);
  const evolutionLines = [];
  if (aRes && aRes.evolution) evolutionLines.push(`✦ ${aPk.pokemon_name} evolved into **${aRes.evolution.name}**!`);
  if (bRes && bRes.evolution) evolutionLines.push(`✦ ${bPk.pokemon_name} evolved into **${bRes.evolution.name}**!`);

  // Write back to bot_duel_log so /profile shows the battle.
  await sb.from('bot_duel_log').update({
    status: 'accepted',
    winner_discord_id: winnerId,
    challenger_xp_gained: aXp,
    opponent_xp_gained:   bXp,
    resolved_at: new Date().toISOString(),
    result_summary: {
      aMove: aMove.n, aDmg, aType: aMove.t,
      bMove: bMove.n, bDmg, bType: bMove.t,
      battleMode: 'tier1_random_move',
    },
  })
  .eq('challenger_discord_id', challengerId)
  .eq('opponent_discord_id',   opponentId)
  .eq('status', 'pending')
  .eq('game', 'pokemon_battle');

  const aIcon = TYPE_ICONS[aMove.t] || '⭐';
  const bIcon = TYPE_ICONS[bMove.t] || '⭐';
  const SHARED_URL = 'https://pathbinder.gg/?page=dashboard';
  const desc = [
    `**${aPk.pokemon_name}** (Lv ${aPk.level}) used **${aMove.n}** ${aIcon}`,
    `**${bPk.pokemon_name}** (Lv ${bPk.level}) used **${bMove.n}** ${bIcon}`,
    '',
    resultLine,
  ];
  if (evolutionLines.length) desc.push('', evolutionLines.join('\n'));
  return {
    embeds: [{
      url: SHARED_URL,
      title: '⚔️ Pokémon Battle',
      description: desc.join('\n'),
      color: winnerColor,
      fields: [
        { name: `${aPk.pokemon_name} dmg`, value: `**${aDmg}**`, inline: true },
        { name: `${bPk.pokemon_name} dmg`, value: `**${bDmg}**`, inline: true },
      ],
      footer: { text: `XP: ${aPk.pokemon_name} +${aXp} · ${bPk.pokemon_name} +${bXp}` },
    }],
  };
}


// ─── /battle mode:full — Tier 2 multi-turn battles ────────────────
// HP bars, type effectiveness, pick-a-move buttons each turn.
// Persists battle state in `bot_battle_state` so each button click
// can read/update across the multi-turn flow. Lifecycle:
//   1. /battle mode:full opponent:@user
//      → INSERT row { status:'pending', current_turn:'challenger' }
//      → message with Accept / Decline buttons
//   2. Opponent clicks Accept
//      → UPDATE status='in_progress', show challenger's move buttons
//   3. Active player clicks a move
//      → calc damage, update opponent HP, log turn
//      → if HP<=0: status='finished', award XP, show winner embed
//      → else: swap current_turn, show next player's move buttons
//   4. Either player clicks "Forfeit"
//      → status='finished', other side wins
//
// Battle ends silently after 20 turns to prevent unlimited HP-pong;
// at 20-turn limit, whichever side has more HP% wins.
const BATTLE_FULL_XP_MULTIPLIER = 3;     // 3× duel XP (more engagement)
const BATTLE_FULL_MAX_TURNS    = 20;

// Helper — encode a Discord button row with up to 5 buttons.
function _btnRow(buttons) {
  return { type: 1, components: buttons };
}

// Helper — build the 4 move buttons for whichever player's turn it is.
// custom_id schema: battle2_move:<battle_id>:<role>:<moveIndex>
//   role: 'a' (challenger) | 'b' (opponent)
// Only the player whose role === current_turn can usefully click;
// the click handler validates by interaction.user.id.
function _battleMoveButtons(battleId, role, moves) {
  return _btnRow(moves.map((m, i) => ({
    type: 2,
    style: 1,   // primary blue
    label: `${m.n} (${m.p})`,
    custom_id: `battle2_move:${battleId}:${role}:${i}`,
  })));
}

// Helper — render the standing battle embed (HP bars, current turn,
// last-action recap). Called after every state change.
function _renderBattleEmbed(state) {
  const aP = state.challenger_pokemon;
  const bP = state.opponent_pokemon;
  const aHp = state.challenger_hp, aMax = state.challenger_max_hp;
  const bHp = state.opponent_hp,   bMax = state.opponent_max_hp;
  const finished = state.status === 'finished';
  const desc = [
    `**${aP.name}** (Lv ${aP.level})`,
    `${hpBar(aHp, aMax)}  \`${aHp}/${aMax} HP\``,
    '',
    `**${bP.name}** (Lv ${bP.level})`,
    `${hpBar(bHp, bMax)}  \`${bHp}/${bMax} HP\``,
  ];
  // Last 3 log entries surfaced inline for in-progress recap.
  const log = Array.isArray(state.log) ? state.log : [];
  if (log.length) {
    desc.push('', '__Last actions:__');
    const tail = log.slice(-3);
    for (const e of tail) {
      const icon = TYPE_ICONS[e.moveType] || '⭐';
      let line = `> ${e.actorName} used **${e.moveName}** ${icon}`;
      if (e.missed) {
        line += ' — but it missed!';
      } else {
        const eff = e.effectiveness;
        const effTag = eff === 0          ? ' (no effect)'
                     : eff >= 2           ? ' — super effective!'
                     : eff <= 0.5 && eff > 0 ? ' — not very effective…'
                     : '';
        line += ` (${e.damage} dmg${effTag})`;
      }
      desc.push(line);
    }
  }
  if (finished) {
    desc.push('');
    if (state.winner_discord_id === state.challenger_id) {
      desc.push(`🏆  **${aP.name}** wins the battle!`);
    } else if (state.winner_discord_id === state.opponent_id) {
      desc.push(`🏆  **${bP.name}** wins the battle!`);
    } else {
      desc.push(`🤝  Draw — neither side could finish the other.`);
    }
  } else {
    const turnName = state.current_turn === 'challenger' ? aP.name : bP.name;
    desc.push('', `▶ **${turnName}**'s turn — pick a move:`);
  }
  return {
    title: '⚔️ Pokémon Battle' + (finished ? ' — Complete' : ` — Turn ${(state.turn_count || 0) + 1}`),
    description: desc.join('\n'),
    color: hpEmbedColor(aHp, aMax, bHp, bMax),
    footer: finished
      ? { text: `XP: ${aP.name} +${state.challenger_xp_gained} · ${bP.name} +${state.opponent_xp_gained}` }
      : { text: 'Battles end at 0 HP or after 20 turns.' },
  };
}

async function handleBattleFull(interaction) {
  const u = (interaction.member && interaction.member.user) || interaction.user;
  const opp = optUser(interaction, 'opponent');
  if (!opp || !opp.id) return ephemeral('Pick an opponent.');
  if (opp.id === u.id) return ephemeral('Battling yourself is not allowed.');
  if (opp.bot)         return ephemeral('Bots don\'t train pokemon. Pick a real opponent.');

  // Both must have starters at level 5+.
  const pkRes = await sb.from('bot_pokemon').select('*').in('discord_user_id', [u.id, opp.id]);
  const pks = pkRes.data || [];
  const aPk = pks.find(p => p.discord_user_id === u.id);
  const bPk = pks.find(p => p.discord_user_id === opp.id);
  if (!aPk) return ephemeral('Pick your starter first — run /starter.');
  if (!bPk) return ephemeral(`<@${opp.id}> hasn't picked a starter yet — they need to run /starter first.`);
  if ((aPk.level || 1) < BATTLE_LEVEL_MIN) {
    return ephemeral(`Your **${aPk.pokemon_name}** is only level ${aPk.level || 1} — needs to be level ${BATTLE_LEVEL_MIN} to battle.`);
  }
  if ((bPk.level || 1) < BATTLE_LEVEL_MIN) {
    return ephemeral(`<@${opp.id}>'s **${bPk.pokemon_name}** is only level ${bPk.level || 1} — needs to be level ${BATTLE_LEVEL_MIN} to battle.`);
  }

  // Cooldown reuse from /duel — same per-challenger gate. Pending
  // rows are excluded so abandoned invites or failed-to-fire duels
  // don't penalize the challenger.
  const cdChallenger = await sb.from('bot_duel_log')
    .select('created_at').eq('challenger_discord_id', u.id)
    .neq('status', 'pending')
    .order('created_at', { ascending: false }).limit(1);
  if (cdChallenger.data && cdChallenger.data[0]) {
    const ageSec = (Date.now() - new Date(cdChallenger.data[0].created_at).getTime()) / 1000;
    if (ageSec < DUEL_CD_CHALLENGER_SEC) {
      return ephemeral(`Slow down — wait ${Math.ceil(DUEL_CD_CHALLENGER_SEC - ageSec)}s.`);
    }
  }

  // Build snapshot payloads for both pokemon. Saves us joining
  // bot_pokemon on every move click.
  const snapshot = (pk) => ({
    starter_id:    pk.starter_id,
    name:          pk.pokemon_name,
    level:         pk.level || 1,
    types:         getPokemonTypes(pk.pokemon_name),
    current_form_id: pk.original_pokemon_id || pk.starter_id,
  });
  const aSnap = snapshot(aPk);
  const bSnap = snapshot(bPk);
  const aHp = pokemonHp(aSnap.level);
  const bHp = pokemonHp(bSnap.level);

  // Persist pending battle. Accept handler will flip status to in_progress.
  const ins = await sb.from('bot_battle_state').insert({
    challenger_id:      u.id,
    opponent_id:        opp.id,
    challenger_pokemon: aSnap,
    opponent_pokemon:   bSnap,
    challenger_hp:      aHp,
    opponent_hp:        bHp,
    challenger_max_hp:  aHp,
    opponent_max_hp:    bHp,
    current_turn:       'challenger',
    status:             'pending',
    channel_id:         interaction.channel_id || null,
    guild_id:           interaction.guild_id || null,
  }).select('id').single();
  if (ins.error) {
    return ephemeral(`Failed to start battle: ${ins.error.message}`);
  }
  const battleId = ins.data.id;

  return {
    type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `<@${opp.id}>  ⚔️  **${aSnap.name}** (Lv ${aSnap.level}) challenges **${bSnap.name}** (Lv ${bSnap.level}) to a full Pokémon battle!`,
      components: [_btnRow([
        { type: 2, style: 3, label: 'Accept Battle', custom_id: `battle2_accept:${battleId}` },
        { type: 2, style: 4, label: 'Decline',       custom_id: `battle2_decline:${battleId}` },
      ])],
      allowed_mentions: { users: [opp.id] },
    },
  };
}

async function handleBattleFullComponent(interaction) {
  const cid    = (interaction.data && interaction.data.custom_id) || '';
  const parts  = cid.split(':');
  const action = parts[0];
  const clickerId = (interaction.member && interaction.member.user && interaction.member.user.id) ||
                    (interaction.user && interaction.user.id);

  // ── Accept / Decline ──
  if (action === 'battle2_accept' || action === 'battle2_decline') {
    const battleId = parts[1];
    const stRes = await sb.from('bot_battle_state').select('*').eq('id', battleId).single();
    if (stRes.error || !stRes.data) {
      return { type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
        data: { content: 'Battle no longer exists.', components: [], embeds: [] } };
    }
    const state = stRes.data;
    if (clickerId !== state.opponent_id) {
      return ephemeral('Only the challenged trainer can accept or decline.');
    }
    if (state.status !== 'pending') {
      return ephemeral('That battle was already resolved.');
    }
    if (action === 'battle2_decline') {
      await sb.from('bot_battle_state').update({ status: 'declined', updated_at: new Date().toISOString() }).eq('id', battleId);
      return { type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
        data: { content: `<@${state.opponent_id}> declined the battle.`, components: [], embeds: [] } };
    }
    // Accept — flip to in_progress and show challenger's move picker.
    await sb.from('bot_battle_state').update({
      status: 'in_progress', updated_at: new Date().toISOString(),
    }).eq('id', battleId);
    state.status = 'in_progress';
    const aMoves = getMovesForPokemon({ pokemon_name: state.challenger_pokemon.name });
    return {
      type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
      data: {
        content: `<@${state.challenger_id}> vs <@${state.opponent_id}>`,
        embeds: [_renderBattleEmbed(state)],
        components: [_battleMoveButtons(battleId, 'a', aMoves)],
        allowed_mentions: { users: [] },
      },
    };
  }

  // ── Move click ──
  if (action === 'battle2_move') {
    const battleId  = parts[1];
    const role      = parts[2];                   // 'a' (challenger) | 'b' (opponent)
    const moveIdx   = parseInt(parts[3], 10) | 0;

    const stRes = await sb.from('bot_battle_state').select('*').eq('id', battleId).single();
    if (stRes.error || !stRes.data) {
      return { type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
        data: { content: 'Battle state lost.', components: [], embeds: [] } };
    }
    const state = stRes.data;
    if (state.status !== 'in_progress') return ephemeral('This battle is over.');

    // Validate clicker matches current_turn player.
    const expectedRole = state.current_turn === 'challenger' ? 'a' : 'b';
    const expectedId   = state.current_turn === 'challenger' ? state.challenger_id : state.opponent_id;
    if (role !== expectedRole || clickerId !== expectedId) {
      return ephemeral(`Not your turn — it's ${state.current_turn === 'challenger' ? `<@${state.challenger_id}>` : `<@${state.opponent_id}>`}'s move.`);
    }

    // Apply the move. Attacker = current_turn side, defender = the other.
    const attackerPk = role === 'a' ? state.challenger_pokemon : state.opponent_pokemon;
    const defenderPk = role === 'a' ? state.opponent_pokemon   : state.challenger_pokemon;
    const attackerMoves = getMovesForPokemon({ pokemon_name: attackerPk.name });
    const move = attackerMoves[moveIdx] || attackerMoves[0];

    const result = calcBattleDamageFull(move, attackerPk.level, defenderPk.types);
    const logEntry = {
      actorName:     attackerPk.name,
      moveName:      move.n,
      moveType:      move.t,
      damage:        result.dmg,
      effectiveness: result.effectiveness,
      missed:        result.missed,
      turn:          (state.turn_count || 0) + 1,
    };

    // Apply damage to defender.
    let newAHp = state.challenger_hp, newBHp = state.opponent_hp;
    if (role === 'a') newBHp = Math.max(0, newBHp - result.dmg);
    else              newAHp = Math.max(0, newAHp - result.dmg);

    const newTurnCount = (state.turn_count || 0) + 1;
    const nextTurn = state.current_turn === 'challenger' ? 'opponent' : 'challenger';
    const newLog = [...(state.log || []), logEntry];

    // Check end conditions.
    let finished = false, winnerId = null;
    if (newAHp <= 0 && newBHp <= 0) {
      // Mutual KO — defender just dropped to 0 too. Attacker wins
      // (they got the last hit in). Real Pokémon doesn't allow simul
      // KO since moves are sequential; this matches our turn model.
      finished = true;
      winnerId = role === 'a' ? state.challenger_id : state.opponent_id;
    } else if (newAHp <= 0) {
      finished = true; winnerId = state.opponent_id;
    } else if (newBHp <= 0) {
      finished = true; winnerId = state.challenger_id;
    } else if (newTurnCount >= BATTLE_FULL_MAX_TURNS) {
      finished = true;
      // Higher HP% wins; tie if exactly equal.
      const aPct = newAHp / state.challenger_max_hp;
      const bPct = newBHp / state.opponent_max_hp;
      if (aPct > bPct)      winnerId = state.challenger_id;
      else if (bPct > aPct) winnerId = state.opponent_id;
      else                  winnerId = null;
    }

    // Build the update payload. Compute XP only if finished.
    const patch = {
      challenger_hp: newAHp,
      opponent_hp:   newBHp,
      current_turn:  nextTurn,
      turn_count:    newTurnCount,
      log:           newLog,
      updated_at:    new Date().toISOString(),
    };
    if (finished) {
      patch.status = 'finished';
      patch.winner_discord_id = winnerId;
      // Award XP — winner gets 3× duel XP, loser gets 0.5× (still
      // grinding-friendly so people don't lose battles for net-negative XP).
      // Need to look up bot_pokemon rows to update XP/level.
      const pkRes = await sb.from('bot_pokemon').select('*')
        .in('discord_user_id', [state.challenger_id, state.opponent_id]);
      const pks = pkRes.data || [];
      const aPkRow = pks.find(p => p.discord_user_id === state.challenger_id);
      const bPkRow = pks.find(p => p.discord_user_id === state.opponent_id);
      let aOutcome = 'tie', bOutcome = 'tie';
      if (winnerId === state.challenger_id) { aOutcome = 'win';  bOutcome = 'loss'; }
      else if (winnerId === state.opponent_id) { aOutcome = 'loss'; bOutcome = 'win'; }
      const aXp = calcXpAwarded(aOutcome, aPkRow?.level || 1, bPkRow?.level || 1) * BATTLE_FULL_XP_MULTIPLIER;
      const bXp = calcXpAwarded(bOutcome, bPkRow?.level || 1, aPkRow?.level || 1) * BATTLE_FULL_XP_MULTIPLIER;
      patch.challenger_xp_gained = aXp;
      patch.opponent_xp_gained   = bXp;
      if (aPkRow) await applyDuelResult(aPkRow, aOutcome, aXp);
      if (bPkRow) await applyDuelResult(bPkRow, bOutcome, bXp);
    }

    await sb.from('bot_battle_state').update(patch).eq('id', battleId);
    Object.assign(state, patch);

    if (finished) {
      return {
        type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
        data: {
          content: `<@${state.challenger_id}> vs <@${state.opponent_id}> — battle complete!`,
          embeds: [_renderBattleEmbed(state)],
          components: [],
          allowed_mentions: { users: [] },
        },
      };
    }

    // Continue — show next player's move buttons.
    const nextRole = nextTurn === 'challenger' ? 'a' : 'b';
    const nextPk   = nextTurn === 'challenger' ? state.challenger_pokemon : state.opponent_pokemon;
    const nextMoves = getMovesForPokemon({ pokemon_name: nextPk.name });
    return {
      type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
      data: {
        content: `<@${state.challenger_id}> vs <@${state.opponent_id}>`,
        embeds: [_renderBattleEmbed(state)],
        components: [_battleMoveButtons(battleId, nextRole, nextMoves)],
        allowed_mentions: { users: [] },
      },
    };
  }

  return ephemeral('Unknown battle action.');
}


// ─── (existing duel resolver below) ────────────────────────────────
// players have starters, updates the duel log row, returns embed
// data. Called from BOTH the immediate-run path in /duel (no
// invitation) and the Accept-button path in handleDuelComponent.
//
// duelLogId: if known (from immediate-run insert), updates that row
//   directly. Otherwise (accept path), updates the most recent pending
//   row for the (challenger, opponent) pair.
// aName / bName: display names. Optional — falls back to <@id> mention
//   form if absent (the legacy accept-button path doesn't have them).
async function resolveDuelMatch({ challengerId, opponentId, game, rounds, aPk, bPk, duelLogId, aName, bName }) {
  const pulls = await Promise.all(
    Array.from({ length: rounds * 2 }, () => pullDuelCard(game))
  );
  if (pulls.some(p => !p)) {
    return { error: `Couldn\'t pull enough priced cards for ${game}.` };
  }
  const aCards = pulls.slice(0, rounds);
  const bCards = pulls.slice(rounds);

  // Scoring model: TOTAL VALUE of pulled cards across all rounds.
  // The per-round arrow markers (◀ ▶ =) are kept as entertainment so
  // readers can see which side pulled the bigger card each round, but
  // they don't determine the winner — only the sum at the end does.
  // (Previously we awarded based on round wins, which produced
  // counter-intuitive outcomes like "Mothfinger pulled $7.34 of cards
  // but lost because Duffalo edged out 2-of-3 rounds with cheap pulls".)
  let aRoundsWon = 0, bRoundsWon = 0;   // kept for the per-round arrows + log payload
  let aTotal = 0, bTotal = 0;
  const roundLines = [];
  for (let i = 0; i < rounds; i++) {
    const a = aCards[i], b = bCards[i];
    const av = Number(a.current_value) || 0;
    const bv = Number(b.current_value) || 0;
    aTotal += av;
    bTotal += bv;
    let mark;
    if (av > bv)      { aRoundsWon++; mark = '◀'; }
    else if (bv > av) { bRoundsWon++; mark = '▶'; }
    else              { mark = '=';                }
    roundLines.push(`**R${i + 1}** ${mark}  ${a.name} ($${av.toFixed(2)})  vs  ${b.name} ($${bv.toFixed(2)})`);
  }

  // Plain display names for the embed (Discord doesn't always render
  // <@id> mentions inside embed titles / field names, which is why
  // they were showing up as raw <@id> strings earlier).
  const aLabel = aName || `<@${challengerId}>`;
  const bLabel = bName || `<@${opponentId}>`;

  let resultLine;
  let winnerColor;
  let winnerId = null;
  let aOutcome = 'tie', bOutcome = 'tie';
  if (aTotal > bTotal) {
    resultLine = `**${aLabel}** wins! **$${aTotal.toFixed(2)}** vs $${bTotal.toFixed(2)}`;
    winnerColor = 0x1AC7A0;
    winnerId = challengerId;
    aOutcome = 'win'; bOutcome = 'loss';
  } else if (bTotal > aTotal) {
    resultLine = `**${bLabel}** wins! **$${bTotal.toFixed(2)}** vs $${aTotal.toFixed(2)}`;
    winnerColor = 0xC97A3E;
    winnerId = opponentId;
    aOutcome = 'loss'; bOutcome = 'win';
  } else {
    resultLine = `It\'s a tie at **$${aTotal.toFixed(2)}** each — split the pot.`;
    winnerColor = 0xFFC857;
  }

  // XP only if BOTH players have starters. Mismatched / missing setups
  // run the duel for entertainment but skip the level grind.
  let aXp = 0, bXp = 0;
  let xpFooter;
  const evolutionLines = [];
  if (aPk && bPk) {
    aXp = calcXpAwarded(aOutcome, aPk.level, bPk.level);
    bXp = calcXpAwarded(bOutcome, bPk.level, aPk.level);
    const aRes = await applyDuelResult(aPk, aOutcome, aXp);
    const bRes = await applyDuelResult(bPk, bOutcome, bXp);
    if (aRes && aRes.evolution) {
      evolutionLines.push(`✦ ${aLabel}'s **${aPk.pokemon_name}** evolved into **${aRes.evolution.name}**!`);
    }
    if (bRes && bRes.evolution) {
      evolutionLines.push(`✦ ${bLabel}'s **${bPk.pokemon_name}** evolved into **${bRes.evolution.name}**!`);
    }
    xpFooter = `XP: ${aPk.pokemon_name} +${aXp} · ${bPk.pokemon_name} +${bXp}`;
  } else {
    const missing = [];
    if (!aPk) missing.push(aLabel);
    if (!bPk) missing.push(bLabel);
    xpFooter = `Run /starter to start earning XP. (${missing.join(' and ')} not registered.)`;
  }

  // Log update. Prefer the direct id path; fall back to (challenger,
  // opponent, pending) for the accept-button flow which doesn't have
  // an id passed through the custom_id.
  const update = sb.from('bot_duel_log').update({
    status: 'accepted',
    winner_discord_id: winnerId,
    challenger_xp_gained: aXp,
    opponent_xp_gained:   bXp,
    resolved_at: new Date().toISOString(),
    // Persist both the round wins (entertainment) and the totals
    // (the actual scoring) so historical duels remain analyzable even
    // if the scoring model changes again in the future. aWins/bWins
    // are kept as keys for backward compatibility with any consumers
    // (leaderboards, /profile) that still read those.
    result_summary: {
      aWins:   aRoundsWon,
      bWins:   bRoundsWon,
      aTotal:  Number(aTotal.toFixed(2)),
      bTotal:  Number(bTotal.toFixed(2)),
      rounds,
      game,
      scoringModel: 'total_value',
    },
  });
  if (duelLogId) {
    await update.eq('id', duelLogId);
  } else {
    await update
      .eq('challenger_discord_id', challengerId)
      .eq('opponent_discord_id',   opponentId)
      .eq('status', 'pending');
  }

  // Head-to-head record. Pulls every resolved duel between this pair
  // (including the one we just updated) and counts wins per side.
  // Shows nothing on the very first match — only meaningful from #2
  // onward.
  let h2hLine = '';
  try {
    const h2h = await sb.from('bot_duel_log')
      .select('winner_discord_id')
      .eq('status', 'accepted')
      .or(`and(challenger_discord_id.eq.${challengerId},opponent_discord_id.eq.${opponentId}),and(challenger_discord_id.eq.${opponentId},opponent_discord_id.eq.${challengerId})`);
    if (!h2h.error && Array.isArray(h2h.data) && h2h.data.length > 1) {
      let aH2h = 0, bH2h = 0, tH2h = 0;
      h2h.data.forEach(r => {
        if (r.winner_discord_id === challengerId)      aH2h++;
        else if (r.winner_discord_id === opponentId)   bH2h++;
        else                                            tH2h++;
      });
      h2hLine = `Head-to-head: **${aLabel}** ${aH2h}W · **${bLabel}** ${bH2h}W` + (tH2h ? ` · ${tH2h}T` : '');
    }
  } catch (_) { /* never let h2h failure block the embed */ }

  // aTotal/bTotal already computed in the per-round loop above (they
  // determine the winner). Just compute the best-card per side for
  // the embed images.
  const aBest = aCards.slice().sort((x, y) => Number(y.current_value) - Number(x.current_value))[0];
  const bBest = bCards.slice().sort((x, y) => Number(y.current_value) - Number(x.current_value))[0];
  const SHARED_URL = 'https://pathbinder.gg/?page=dashboard';
  // Pokémon roster line — shows BOTH duelists' pokemon + level so
  // readers know what's on the field. When only one (or neither) has
  // a starter, render whatever side IS registered and tag the other
  // as "no starter" so it's obvious why XP isn't moving.
  let rosterLine = '';
  const aRoster = aPk ? `**${aPk.pokemon_name}** (Lv. ${aPk.level})` : '*no starter*';
  const bRoster = bPk ? `**${bPk.pokemon_name}** (Lv. ${bPk.level})` : '*no starter*';
  rosterLine = `${aLabel}: ${aRoster}  vs  ${bLabel}: ${bRoster}`;

  // Build description: roster, rounds, result, evolutions, h2h.
  const descParts = [rosterLine, roundLines.join('\n'), resultLine];
  if (evolutionLines.length) descParts.push(evolutionLines.join('\n'));
  if (h2hLine)                descParts.push(h2hLine);
  const embeds = [{
    url: SHARED_URL,
    title: rounds === 1 ? 'Card Duel' : `Card Duel — Best of ${rounds}`,
    description: descParts.join('\n\n'),
    color: winnerColor,
    fields: [
      // Totals are the win condition under the current scoring model
      // (sum of pulled card values). "X total" reads as the verdict;
      // whoever's number is higher won the duel. The per-round arrow
      // markers in the description above are kept as flavor so you
      // can see which side drew the bigger card each round.
      { name: `${aLabel} total`, value: `$${aTotal.toFixed(2)}`, inline: true },
      { name: `${bLabel} total`, value: `$${bTotal.toFixed(2)}`, inline: true },
    ],
    image: aBest && aBest.image_url ? { url: aBest.image_url } : undefined,
    footer: { text: xpFooter },
  }];
  if (bBest && bBest.image_url) {
    embeds.push({ url: SHARED_URL, image: { url: bBest.image_url } });
  }
  return { embeds };
}

// Compute new totals after a duel outcome and write them back. Pure
// JS-side recompute of level (no race conditions vs concurrent writes
// because each user duels one at a time via the button click).
// Returns { evolution } so resolveDuelMatch can celebrate any
// evolution that fired during this update.
async function applyDuelResult(pk, outcome, xpDelta) {
  const oldLevel = pk.level || 1;
  const newXp    = (pk.xp   || 0) + (xpDelta || 0);
  const newLevel = levelFromXp(newXp);
  const patch = {
    xp:         newXp,
    level:      newLevel,
    wins:       (pk.wins   || 0) + (outcome === 'win'  ? 1 : 0),
    losses:     (pk.losses || 0) + (outcome === 'loss' ? 1 : 0),
    ties:       (pk.ties   || 0) + (outcome === 'tie'  ? 1 : 0),
    updated_at: new Date().toISOString(),
  };

  // Evolution check — only if the trainer's allowed it, only when we
  // actually crossed at least one level boundary. The starter id used
  // for the lookup is original_pokemon_id (so once-evolved Charmeleon
  // still resolves to the Charmander chain).
  let evolution = null;
  if (pk.allow_evolution !== false && newLevel > oldLevel) {
    const starterId = pk.original_pokemon_id || pk.pokemon_id;
    evolution = checkEvolution(starterId, pk.pokemon_id, newLevel);
    if (evolution) {
      patch.pokemon_id   = evolution.id;
      patch.pokemon_name = evolution.name;
    }
  }

  await sb.from('bot_pokemon').update(patch).eq('discord_user_id', pk.discord_user_id);
  return { evolution };
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

// Pull a BOOLEAN (type 5) slash-command option. Returns true/false
// when set, null when omitted, so callers can distinguish "user said
// false" from "user didn't pass it" and apply their own default.
function optBool(interaction, name) {
  const opts = (interaction.data && interaction.data.options) || [];
  const o = opts.find(x => x.name === name);
  if (!o || o.value === undefined || o.value === null) return null;
  return Boolean(o.value);
}

// Pull an INTEGER (type 4) slash-command option. Returns the integer
// value when set, null when omitted. Use for numeric params like
// /duel rounds — optString + Number() works but loses type info and
// is easy to misuse (e.g. `Number(optString())` then a strict ===
// comparison against literal numbers).
function optInt(interaction, name) {
  const opts = (interaction.data && interaction.data.options) || [];
  const o = opts.find(x => x.name === name);
  if (!o || o.value === undefined || o.value === null) return null;
  const n = Number(o.value);
  return Number.isFinite(n) ? n : null;
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
