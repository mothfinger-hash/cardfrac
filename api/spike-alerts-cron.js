// api/spike-alerts-cron.js
// Daily "your owned card spiked" push notification.
//
// Runs AFTER the nightly catalog price refresh (GitHub Action at 07:00 UTC,
// which updates catalog.current_value + writes a daily catalog_price_history
// snapshot). Detects owned cards that jumped via the get_owned_card_spikes RPC,
// dedups against price_spike_notifications, and sends ONE push per opted-in
// user via sendPushToUser (APNs on iOS, FCM on Android — same path as DMs).
//
// Requires migration_price_spike_alerts.sql.
//
// Env (Vercel):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   — DB access
//   (APNS_* / FCM creds are read by api/_lib/push.js)
//   SPIKE_CRON_SECRET (optional)         — if set, require ?secret=<value>
//
// Schedule: vercel.json cron at ~15:00 UTC (fresh data + reasonable US morning).

const { createClient } = require('@supabase/supabase-js');
const { sendPushToUser } = require('./_lib/push');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Push is more intrusive than the in-app alert, so the bar is higher.
const MIN_PCT        = 20;   // owned card must be up >= 20%
const MIN_VALUE      = 10;   // ...and worth >= $10 (skip penny-common noise)
const DAYS_BACK      = 1;    // 24h move ("just spiked")
const DEDUP_DAYS     = 7;    // don't re-notify the same card within 7 days...
const DEDUP_GROW_PTS = 10;   // ...unless it climbed another 10 points

module.exports = async function handler(req, res) {
  const secret = process.env.SPIKE_CRON_SECRET;
  if (secret && String((req.query && req.query.secret) || '') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const { data: spikes, error } = await sb.rpc('get_owned_card_spikes', {
      p_min_pct: MIN_PCT, p_min_value: MIN_VALUE, p_days_back: DAYS_BACK,
    });
    if (error) {
      console.error('[spike-cron] RPC error', error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!spikes || !spikes.length) {
      return res.status(200).json({ ok: true, users: 0, note: 'no spikes today' });
    }

    // Group spikes by user.
    const byUser = new Map();
    for (const s of spikes) {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
      byUser.get(s.user_id).push(s);
    }

    // Pull recent notifications for dedup (one query for everyone).
    const since = new Date(Date.now() - DEDUP_DAYS * 86400000).toISOString();
    const { data: recent } = await sb
      .from('price_spike_notifications')
      .select('user_id, api_card_id, notified_pct')
      .gte('notified_at', since);
    const lastPct = new Map(); // "user|card" -> last notified pct
    for (const r of (recent || [])) {
      lastPct.set(r.user_id + '|' + r.api_card_id, Number(r.notified_pct) || 0);
    }

    let sent = 0, cardsRecorded = 0;
    for (const [userId, list] of byUser) {
      // Keep only cards not notified recently (or that grew enough since).
      const fresh = list
        .filter(s => {
          const prev = lastPct.get(userId + '|' + s.api_card_id);
          if (prev === undefined) return true;
          return (Number(s.delta_pct) - prev) >= DEDUP_GROW_PTS;
        })
        .sort((a, b) => Number(b.delta_pct) - Number(a.delta_pct));
      if (!fresh.length) continue;

      const top = fresh[0];
      const body = fresh.length === 1
        ? `${top.card_name} is up ${Math.round(top.delta_pct)}% — now worth $${Math.round(top.current_value)}. Tap to view.`
        : `${top.card_name} is up ${Math.round(top.delta_pct)}% and ${fresh.length - 1} more of your cards spiked today. Tap to view.`;

      try {
        await sendPushToUser(userId, {
          title: 'PathBinder',
          body,
          data: { type: 'price_spike', card_id: String(top.api_card_id), route: 'dashboard' },
        });
        sent++;
        // Record every fresh card so we don't re-notify it within DEDUP_DAYS.
        const rows = fresh.map(s => ({
          user_id: userId, api_card_id: s.api_card_id, notified_pct: s.delta_pct,
        }));
        await sb.from('price_spike_notifications').insert(rows);
        cardsRecorded += rows.length;
      } catch (e) {
        // One user's failure shouldn't stop the run; don't record so it can retry.
        console.error('[spike-cron] send failed', userId, e && e.message);
      }
    }

    return res.status(200).json({ ok: true, users: sent, cards: cardsRecorded });
  } catch (e) {
    console.error('[spike-cron]', e && e.message);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// RPC + fan-out of push sends can take a few seconds.
module.exports.config = { maxDuration: 60 };
