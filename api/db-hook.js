// api/db-hook.js
// ──────────────────────────────────────────────────────────────────────
// Supabase Database Webhook receiver → sends native push for CLIENT-side
// events that never pass through our own server (new direct message, order
// marked shipped). Keeping this server-side (behind a secret) means the FCM
// send secret / service account never touches the client.
//
// Configure in Supabase → Database → Webhooks (HTTP Request, POST to this URL,
// add header  x-push-secret: <PUSH_SEND_SECRET> ):
//   • table public.direct_messages   events: INSERT
//   • table public.orders            events: UPDATE
//   • table public.listings          events: INSERT
//
// Supabase sends: { type, table, schema, record, old_record }
//
// Env: PUSH_SEND_SECRET, FIREBASE_SERVICE_ACCOUNT, SUPABASE_URL, SUPABASE_SERVICE_KEY

const { sendPushToUser } = require('./_lib/push');

let _sb = null;
function sb() {
  if (_sb) return _sb;
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return _sb;
}

async function nameFor(userId) {
  if (!userId) return 'Someone';
  try {
    const { data } = await sb().from('profiles').select('username, name').eq('id', userId).maybeSingle();
    return (data && (data.username || data.name)) || 'Someone';
  } catch (_) { return 'Someone'; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.PUSH_SEND_SECRET || req.headers['x-push-secret'] !== process.env.PUSH_SEND_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const evt = (typeof req.body === 'string' ? safeParse(req.body) : req.body) || {};
  const { table, type, record, old_record } = evt;
  if (!record) return res.status(200).json({ ok: true, skipped: 'no record' });

  try {
    // New direct message → notify the recipient.
    if (table === 'direct_messages' && type === 'INSERT' && record.recipient_id) {
      const who = await nameFor(record.sender_id);
      const push = await sendPushToUser(record.recipient_id, {
        title: 'New message from ' + who,
        body: String(record.body || '').slice(0, 90),
        data: { open: 'inbox', from: record.sender_id || '' },
      });
      console.log('[push] dm ->', record.recipient_id, JSON.stringify(push));
      return res.status(200).json({ ok: true, rule: 'dm', push });
    }

    // Order marked shipped → notify the buyer (only on the transition INTO
    // 'shipped', so re-saving a shipped order doesn't re-notify).
    if (table === 'orders' && type === 'UPDATE' && record.status === 'shipped'
        && (!old_record || old_record.status !== 'shipped') && record.buyer_id) {
      await sendPushToUser(record.buyer_id, {
        title: 'Your order shipped',
        body: 'Your PathBinder order is on its way.',
        data: { page: 'account', order: record.id || '' },
      });
      return res.status(200).json({ ok: true, rule: 'shipped' });
    }

    // New marketplace listing → notify anyone whose wishlist (a ghost
    // collection_item) wants this exact card AND whose desired buy price
    // (savings_goal) is within 10% of the listing price — i.e. the listing is
    // at most 10% over their target (cheaper is even better). Skip the seller.
    if (table === 'listings' && type === 'INSERT' && record.api_card_id) {
      const price = Number(record.value || 0);
      if (price > 0) {
        const { data: wishes } = await sb()
          .from('collection_items')
          .select('user_id, savings_goal, card_name')
          .eq('is_ghost', true)
          .eq('api_card_id', record.api_card_id)
          .gt('savings_goal', 0);
        let sent = 0;
        for (const w of (wishes || [])) {
          if (!w.user_id || w.user_id === record.seller_id) continue;
          if (price <= Number(w.savings_goal) * 1.10) {
            await sendPushToUser(w.user_id, {
              title: 'Wishlist card just listed',
              body: (w.card_name || 'A card on your wishlist') + ' is up for $' + price.toFixed(2)
                + ' — within 10% of your $' + Number(w.savings_goal).toFixed(2) + ' target.',
              data: { page: 'browse', listing: record.id || '' },
            });
            sent++;
          }
        }
        return res.status(200).json({ ok: true, rule: 'wishlist', sent });
      }
    }

    return res.status(200).json({ ok: true, skipped: 'no matching rule' });
  } catch (e) {
    // Always 200 so Supabase doesn't retry-loop on a transient push failure.
    console.error('[db-hook] error:', e && e.message);
    return res.status(200).json({ ok: false, error: (e && e.message) || 'error' });
  }
};

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return {}; } }
