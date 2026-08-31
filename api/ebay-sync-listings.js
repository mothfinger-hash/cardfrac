// api/ebay-sync-listings.js
// Phase 2a — pull the connected seller's ACTIVE eBay listings (Trading API
// GetMyeBaySelling) and store them in ebay_listing_links (raw inventory:
// ItemID, title, SKU, quantity). Catalog MATCHING (linking each listing to a
// PathBinder card) is Phase 2b — best built/validated against real listings,
// so this step just proves the pull + store and gives us the real response shape.
//
// POST, Supabase JWT auth. Returns { pulled, stored, ack, sample }.

const { createClient } = require('@supabase/supabase-js');
const ebay = require('./_lib/ebay');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function _tag(block, name) {
  const m = block.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : null;
}

// Lightweight extraction of the ActiveList items. Scoped to <ActiveList> so we
// don't pick up items from other response sections. Good enough for the few
// fields we need; can move to a real XML parser if the shape gets hairy.
function _parseActiveItems(xml) {
  const active = xml.match(/<ActiveList>[\s\S]*?<\/ActiveList>/);
  const scope = active ? active[0] : xml;
  const items = [];
  const re = /<Item>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = re.exec(scope)) !== null) {
    const b = m[1];
    const itemId = _tag(b, 'ItemID');
    if (!itemId) continue;
    const qtyAvail = _tag(b, 'QuantityAvailable');
    const qty      = _tag(b, 'Quantity');
    const parsedQty = qtyAvail != null ? parseInt(qtyAvail, 10)
                    : qty != null      ? parseInt(qty, 10)
                    : null;
    items.push({
      itemId,
      title: _tag(b, 'Title'),
      sku:   _tag(b, 'SKU'),
      quantity: Number.isFinite(parsedQty) ? parsedQty : null,
    });
  }
  return items;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ebay.isConfigured()) return res.status(503).json({ error: 'eBay not configured', code: 'NOT_CONFIGURED' });

  const jwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!jwt) return res.status(401).json({ error: 'Authentication required' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const tok = await ebay.getValidAccessToken(sb, user.id);
  if (tok.error) return res.status(400).json({ error: 'eBay not connected or token refresh failed', code: tok.error });

  const inner = '<ActiveList><Include>true</Include>'
    + '<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination>'
    + '</ActiveList>';
  const call = await ebay.tradingCall(tok.token, 'GetMyeBaySelling', inner);
  if (!call.ok) {
    console.error('[ebay-sync] http error', call.status, (call.text || '').slice(0, 500));
    return res.status(502).json({ error: 'eBay API error', status: call.status });
  }

  const ack = (call.text.match(/<Ack>([^<]*)<\/Ack>/) || [])[1] || 'Unknown';
  if (ack === 'Failure') {
    const msg = (call.text.match(/<ShortMessage>([^<]*)<\/ShortMessage>/) || [])[1] || 'unknown error';
    console.error('[ebay-sync] Trading Failure:', msg, (call.text || '').slice(0, 800));
    return res.status(502).json({ error: 'eBay: ' + msg });
  }

  const items = _parseActiveItems(call.text);

  // Load the seller's inventory SKUs once, for auto-matching by SKU.
  const { data: invRows } = await sb.from('collection_items')
    .select('id, api_card_id, variant, condition, shop_sku')
    .eq('user_id', user.id).not('shop_sku', 'is', null);
  const bySku = {};
  (invRows || []).forEach(function (r) {
    if (r.shop_sku) bySku[String(r.shop_sku).trim().toLowerCase()] = r;
  });

  let stored = 0, skuMatched = 0;
  for (const it of items) {
    // 1) Upsert the raw listing fields ONLY (no match columns), so a re-sync
    //    never clobbers an existing (manual or prior) link.
    const up = await sb.from('ebay_listing_links').upsert({
      user_id:        user.id,
      ebay_item_id:   it.itemId,
      ebay_sku:       it.sku,
      ebay_title:     it.title,
      quantity:       it.quantity,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'user_id,ebay_item_id' }).select('id');
    if (up.error) { console.warn('[ebay-sync] upsert error:', up.error.message); continue; }
    stored++;

    // 2) Auto-match by SKU — but only fill links that aren't already linked
    //    (the `.is('collection_item_id', null)` guard preserves manual links).
    const skuKey = it.sku ? String(it.sku).trim().toLowerCase() : null;
    const m = skuKey ? bySku[skuKey] : null;
    if (m) {
      const upd = await sb.from('ebay_listing_links')
        .update({ collection_item_id: m.id, api_card_id: m.api_card_id || null,
                  variant: m.variant || 'normal', condition: m.condition || null })
        .eq('user_id', user.id).eq('ebay_item_id', it.itemId)
        .is('collection_item_id', null)
        .select('id');
      if (!upd.error && upd.data && upd.data.length) skuMatched++;
    }
  }

  // Linked / unlinked totals across ALL of the seller's eBay listings.
  const { count: linked } = await sb.from('ebay_listing_links')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id).not('collection_item_id', 'is', null);
  const { count: total } = await sb.from('ebay_listing_links')
    .select('id', { count: 'exact', head: true }).eq('user_id', user.id);

  return res.status(200).json({
    ok: true, pulled: items.length, stored, skuMatched,
    linked: linked || 0, unlinked: Math.max(0, (total || 0) - (linked || 0)), ack,
  });
};
