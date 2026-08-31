// api/ebay-on-sale.js
// Phase 3 (forward sync) — when a seller records an in-store/POS sale in
// PathBinder, decrement the matching eBay listing so they can't oversell it.
//
// Wired as a Supabase Database Webhook:
//   Supabase → Database → Webhooks → HTTP POST to this URL
//     table  public.shop_sales   events: INSERT
//     header x-push-secret: <PUSH_SEND_SECRET>   (reuses the db-hook secret)
//   Supabase sends { type, table, record, old_record }.
//
// Flow: shop_sales INSERT carries user_id + collection_item_id + qty. We find
// the ebay_listing_links row linked to that collection_item, get a valid eBay
// token, and ReviseInventoryStatus to newQty = max(0, lastKnownQty - soldQty)
// (eBay ends the listing at 0). Best-effort + idempotent-ish: always 200 so
// Supabase doesn't spam retries; the worst case on a hiccup is a stale eBay qty
// the next "Sync listings" reconciles.
//
// Env: PUSH_SEND_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY, EBAY_* .

const { createClient } = require('@supabase/supabase-js');
const ebay = require('./_lib/ebay');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.PUSH_SEND_SECRET || req.headers['x-push-secret'] !== process.env.PUSH_SEND_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!ebay.isConfigured()) return res.status(200).json({ ok: true, skipped: 'ebay_not_configured' });

  const evt = (typeof req.body === 'string' ? _safeParse(req.body) : req.body) || {};
  const { table, type, record } = evt;
  if (table !== 'shop_sales' || type !== 'INSERT' || !record) {
    return res.status(200).json({ ok: true, skipped: 'not a shop_sales insert' });
  }

  const userId = record.user_id;
  const itemId = record.collection_item_id;
  const soldQty = parseInt(record.qty, 10) || 0;
  if (!userId || !itemId || soldQty <= 0) return res.status(200).json({ ok: true, skipped: 'incomplete record' });

  try {
    // Only act if this card is linked to an eBay listing.
    const { data: link } = await sb.from('ebay_listing_links')
      .select('ebay_item_id, quantity')
      .eq('user_id', userId).eq('collection_item_id', itemId)
      .not('ebay_item_id', 'is', null).maybeSingle();
    if (!link || !link.ebay_item_id) return res.status(200).json({ ok: true, skipped: 'no linked ebay listing' });

    const tok = await ebay.getValidAccessToken(sb, userId);
    if (tok.error) { console.warn('[ebay-on-sale] token', tok.error); return res.status(200).json({ ok: true, skipped: 'token_' + tok.error }); }

    const newQty = Math.max(0, (Number(link.quantity) || 0) - soldQty);
    const call = await ebay.reviseListingQuantity(tok.token, link.ebay_item_id, newQty);
    const ack = (call.text.match(/<Ack>([^<]*)<\/Ack>/) || [])[1] || 'Unknown';
    if (ack === 'Failure') {
      const msg = (call.text.match(/<ShortMessage>([^<]*)<\/ShortMessage>/) || [])[1] || 'unknown';
      console.error('[ebay-on-sale] revise failed:', link.ebay_item_id, msg);
      return res.status(200).json({ ok: false, ack, error: msg });   // 200 → no retry storm; next Sync reconciles
    }

    // Reflect the new quantity locally so subsequent decrements are correct.
    await sb.from('ebay_listing_links')
      .update({ quantity: newQty, last_synced_at: new Date().toISOString() })
      .eq('user_id', userId).eq('ebay_item_id', link.ebay_item_id);

    return res.status(200).json({ ok: true, itemId: link.ebay_item_id, newQty });
  } catch (e) {
    console.error('[ebay-on-sale] exception:', e && e.message);
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};

function _safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
