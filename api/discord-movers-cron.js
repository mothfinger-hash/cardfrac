// api/discord-movers-cron.js
// Daily "market movers" auto-post to a Discord channel via webhook.
//
// Triggered by a Vercel cron (see vercel.json). Fetches the biggest 24h price
// movers across every game using the SAME get_global_price_movers RPC that the
// /movers slash command uses (see api/discord-bot.js), formats one embed, and
// POSTs it to the channel webhook in DISCORD_MOVERS_WEBHOOK_URL.
//
// This is a growth / daily-habit hook: it gives the Discord a reason to open
// the app every day even when nobody is actively buying.
//
// Env vars (Vercel):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   — DB access
//   DISCORD_MOVERS_WEBHOOK_URL           — the channel webhook to post to
//                                          (Discord: Channel → Integrations →
//                                           Webhooks → New Webhook → Copy URL)
//   MOVERS_CRON_SECRET (optional)        — if set, require ?secret=<value> so
//                                          only the cron (or you) can trigger it
//
// Manual test:  GET /api/discord-movers-cron            (if no secret set)
//               GET /api/discord-movers-cron?secret=... (if secret set)

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Same game set the /movers command fans out across.
const MOVERS_GAMES = ['pokemon', 'magic', 'yugioh', 'onepiece', 'gundam', 'dbz'];
const GAME_LABEL = {
  pokemon: 'Pokemon', magic: 'Magic', yugioh: 'Yu-Gi-Oh', onepiece: 'One Piece',
  gundam: 'Gundam', dbz: 'Dragon Ball',
};

const fmtPct = (p) => (p >= 0 ? '+' : '') + Number(p).toFixed(1) + '%';
const fmtRow = (x) =>
  `• [${(GAME_LABEL[x._game] || x._game).slice(0, 8)}] ${x.name} — ` +
  `$${Number(x.current_value || 0).toFixed(2)} (${fmtPct(x.delta_pct)})`;

async function getMovers(days) {
  const results = await Promise.allSettled(MOVERS_GAMES.map((gt) =>
    sb.rpc('get_global_price_movers', {
      p_game_type:    gt,
      p_days_back:    days,
      p_top_n:        10,
      p_min_pct:      0.5,
      p_sort:         'pct',
      p_product_type: 'single',
      p_min_value:    1.0,
    }).then((r) => (Array.isArray(r.data) ? r.data : []).map((x) => ({ ...x, _game: gt })))
  ));
  const merged = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value || []);
  const up   = merged.filter((x) => x.direction === 'up')
    .sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct)).slice(0, 5);
  const down = merged.filter((x) => x.direction === 'down')
    .sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct)).slice(0, 5);
  return { up, down };
}

module.exports = async function handler(req, res) {
  // Optional shared-secret gate. Vercel cron GETs are unauthenticated, so set
  // MOVERS_CRON_SECRET and append ?secret=<value> to the cron path to lock it.
  const secret = process.env.MOVERS_CRON_SECRET;
  if (secret && String((req.query && req.query.secret) || '') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const webhook = process.env.DISCORD_MOVERS_WEBHOOK_URL;
  if (!webhook) {
    return res.status(500).json({ error: 'DISCORD_MOVERS_WEBHOOK_URL not set' });
  }

  try {
    const { up, down } = await getMovers(1); // last 24h
    // Nothing moved enough — skip rather than post an empty/boring embed.
    if (!up.length && !down.length) {
      return res.status(200).json({ ok: true, skipped: 'no movers' });
    }

    const embed = {
      title: 'Daily Market Movers — last 24h',
      color: 0x1AC7A0, // PathBinder cyan
      fields: [
        { name: '▲ Biggest Gainers', value: up.length ? up.map(fmtRow).join('\n') : '_no gains_',    inline: false },
        { name: '▼ Biggest Drops',   value: down.length ? down.map(fmtRow).join('\n') : '_no declines_', inline: false },
      ],
      footer: { text: 'Track your collection at pathbinder.gg' },
    };

    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'PathBinder Markets', embeds: [embed] }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[movers-cron] webhook post failed', r.status, t.slice(0, 200));
      return res.status(502).json({ error: 'webhook post failed', status: r.status });
    }
    return res.status(200).json({ ok: true, up: up.length, down: down.length });
  } catch (e) {
    console.error('[movers-cron] error', e && e.message);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// Movers RPC fan-out can take a few seconds; match the discord-bot ceiling.
module.exports.config = { maxDuration: 60 };
