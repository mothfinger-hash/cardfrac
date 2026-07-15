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
        // Any wishlisted (ghost) copy of this card. Compare the listing to the
        // user's Target Price (savings_goal) — the field the wishlist modal now
        // edits — falling back to the card's market value only when no target
        // has been set.
        const { data: wishes } = await sb()
          .from('collection_items')
          .select('user_id, savings_goal, current_value, card_name')
          .eq('is_ghost', true)
          .eq('api_card_id', record.api_card_id);
        const cand = (wishes || []).map(w => {
          const goal     = Number(w.savings_goal) || 0;
          const isTarget = goal > 0;
          const target   = isTarget ? goal : (Number(w.current_value) || 0);
          return { user_id: w.user_id, card_name: w.card_name, target, isTarget };
        }).filter(w =>
          w.user_id && w.user_id !== record.seller_id && w.target > 0 && price <= w.target * 1.10);
        let sent = 0;
        if (cand.length) {
          // Respect the per-user opt-in (notify_wishlist_listings, default ON).
          const ids = [...new Set(cand.map(w => w.user_id))];
          const { data: profs } = await sb()
            .from('profiles').select('id, notify_wishlist_listings').in('id', ids);
          const optedOut = new Set((profs || [])
            .filter(p => p.notify_wishlist_listings === false).map(p => p.id));
          for (const w of cand) {
            if (optedOut.has(w.user_id)) continue;
            const diffPct = ((price - w.target) / w.target) * 100;
            const ref = w.isTarget ? 'your $' + w.target.toFixed(2) + ' target' : 'market ($' + w.target.toFixed(2) + ')';
            let rel;
            if (Math.abs(diffPct) < 0.5) rel = 'right at ' + ref;
            else if (diffPct < 0)        rel = Math.abs(diffPct).toFixed(0) + '% below ' + ref;
            else                         rel = diffPct.toFixed(0) + '% above ' + ref;
            await sendPushToUser(w.user_id, {
              title: 'Wishlist card just listed',
              body: (w.card_name || 'A card on your wishlist') + ' is listed for $' + price.toFixed(2) + ' — ' + rel + '.',
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
