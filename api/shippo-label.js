// api/shippo-label.js
// Shippo shipping-label endpoint for marketplace orders. Test-mode first.
//
// POST body:
//   { action: 'rates', orderId, parcel? }              -> live rate options
//   { action: 'buy',   orderId, rateId, carrier? }     -> buys label, returns PDF
//
// Auth: caller must be the SELLER on the order (Supabase JWT in Authorization).
//
// Required env vars (Vercel):
//   SHIPPO_MODE            'test' | 'live'  (unset = legacy unsuffixed token)
//   SHIPPO_API_TOKEN_TEST  shippo_test_...   (used when SHIPPO_MODE=test)
//   SHIPPO_API_TOKEN_LIVE  shippo_live_...   (used when SHIPPO_MODE=live)
//   SHIPPO_API_TOKEN       legacy unsuffixed fallback
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Phase 2 (per-seller billing): resolveToken() already prefers a seller's
// connected-account token if one is stored on their profile, falling back to
// the platform token — so wiring Shippo OAuth later is a small change here.

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Mode-aware token selection — mirrors the Stripe STRIPE_MODE switch so the
// test -> live cutover is a single env change.
function platformToken() {
  const m = (process.env.SHIPPO_MODE || '').toLowerCase();
  if (m === 'test') return process.env.SHIPPO_API_TOKEN_TEST;
  if (m === 'live') return process.env.SHIPPO_API_TOKEN_LIVE || process.env.SHIPPO_API_TOKEN;
  return process.env.SHIPPO_API_TOKEN;
}

// Phase 2 hook: if the seller has connected their own Shippo account, bill them.
function resolveToken(sellerProfile) {
  if (sellerProfile && sellerProfile.shippo_oauth_token) return sellerProfile.shippo_oauth_token;
  return platformToken();
}

async function shippo(path, method, body, token) {
  const r = await fetch('https://api.goshippo.com' + path, {
    method: method || 'GET',
    headers: {
      'Authorization': 'ShippoToken ' + token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { _raw: text }; }
  if (!r.ok) {
    const msg = (json && (json.detail || json.message)) || ('Shippo HTTP ' + r.status);
    const err = new Error(msg);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth: must be a logged-in user ──────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace('Bearer ', '');
  if (!jwt) return res.status(401).json({ error: 'Authentication required' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const { action, orderId, parcel, rateId, carrier } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  // ── Load order + verify the caller is the seller ────────────────────────
  const { data: order, error: ordErr } = await sb
    .from('orders').select('*').eq('id', orderId).single();
  if (ordErr || !order) return res.status(404).json({ error: 'Order not found' });
  if (order.seller_id !== user.id) {
    return res.status(403).json({ error: 'You can only ship your own orders' });
  }

  // ── Seller (from) + buyer (to) addresses ────────────────────────────────
  const { data: seller } = await sb
    .from('profiles')
    // NOTE: Phase 2 adds shippo_oauth_token here once the column + OAuth exist.
    .select('ship_from_name, ship_from_street1, ship_from_street2, ship_from_city, ship_from_state, ship_from_zip, ship_from_country, ship_from_phone, shop_name, name')
    .eq('id', user.id)
    .single();

  if (!seller || !seller.ship_from_street1 || !seller.ship_from_zip) {
    return res.status(400).json({ error: 'Add your return address in seller settings before buying a label', code: 'NO_FROM_ADDRESS' });
  }
  if (!order.ship_to_street1 || !order.ship_to_zip) {
    return res.status(400).json({ error: 'This order has no shipping address on file', code: 'NO_TO_ADDRESS' });
  }

  const token = resolveToken(seller);
  if (!token) {
    return res.status(500).json({ error: 'Shippo not configured (set SHIPPO_API_TOKEN_TEST + SHIPPO_MODE=test)' });
  }

  const addressFrom = {
    name: seller.ship_from_name || seller.shop_name || seller.name || 'Seller',
    street1: seller.ship_from_street1,
    street2: seller.ship_from_street2 || '',
    city: seller.ship_from_city,
    state: seller.ship_from_state,
    zip: seller.ship_from_zip,
    country: seller.ship_from_country || 'US',
    phone: seller.ship_from_phone || '',
  };
  const addressTo = {
    name: order.ship_to_name || 'Buyer',
    street1: order.ship_to_street1,
    street2: order.ship_to_street2 || '',
    city: order.ship_to_city,
    state: order.ship_to_state,
    zip: order.ship_to_zip,
    country: order.ship_to_country || 'US',
    phone: order.ship_to_phone || '',
    email: order.ship_to_email || '',
  };

  // Parcel — defaults to a padded card mailer (6x4x1 in, 3 oz). The UI can
  // override per shipment for bulk/sealed.
  const p = parcel || {};
  const parcelObj = {
    length: String(p.length || 6),
    width:  String(p.width  || 4),
    height: String(p.height || 1),
    distance_unit: p.distance_unit || 'in',
    weight: String(p.weight || 3),
    mass_unit: p.mass_unit || 'oz',
  };

  try {
    // ── Rates ─────────────────────────────────────────────────────────────
    if (action === 'rates') {
      const shipment = await shippo('/shipments/', 'POST', {
        address_from: addressFrom,
        address_to: addressTo,
        parcels: [parcelObj],
        async: false,
      }, token);

      const rates = (shipment.rates || []).map(r => ({
        rate_id: r.object_id,
        provider: r.provider,
        servicelevel: (r.servicelevel && r.servicelevel.name) || '',
        amount: r.amount,
        currency: r.currency,
        days: r.estimated_days,
      })).sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));

      if (!rates.length) {
        const m = (shipment.messages && shipment.messages.map(x => x.text).filter(Boolean).join('; ')) ||
          'No rates returned — check the from/to addresses.';
        return res.status(400).json({ error: m });
      }
      return res.status(200).json({ shipment_id: shipment.object_id, rates });
    }

    // ── Buy label ─────────────────────────────────────────────────────────
    if (action === 'buy') {
      if (!rateId) return res.status(400).json({ error: 'rateId required' });

      const tx = await shippo('/transactions/', 'POST', {
        rate: rateId,
        label_file_type: 'PDF_4x6',
        async: false,
      }, token);

      if (tx.status !== 'SUCCESS') {
        const m = (tx.messages && tx.messages.map(x => x.text).filter(Boolean).join('; ')) ||
          'Label purchase failed';
        return res.status(400).json({ error: m, status: tx.status });
      }

      // Persist to the order (service role). Mirrors saveTracking's fields so
      // the rest of the app treats this exactly like a manually-tracked ship.
      const patch = {
        tracking_number:       tx.tracking_number || null,
        tracking_carrier:      carrier || null,
        shippo_transaction_id: tx.object_id || null,
        shippo_label_url:      tx.label_url || null,
        shippo_rate_id:        rateId,
        status:                'shipped',
        shipped_at:            new Date().toISOString(),
      };
      const { error: upErr } = await sb.from('orders').update(patch).eq('id', orderId);
      if (upErr) console.error('[shippo] order update failed:', upErr.message);

      return res.status(200).json({
        tracking_number: tx.tracking_number || null,
        tracking_url:    tx.tracking_url_provider || null,
        label_url:       tx.label_url || null,
        carrier:         carrier || null,
        transaction_id:  tx.object_id || null,
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[shippo]', action, e.message, e.body || '');
    return res.status(e.status && e.status < 500 ? 400 : 500).json({ error: e.message });
  }
};

// Shippo synchronous rate/label calls can take a few seconds.
module.exports.config = { maxDuration: 30 };
