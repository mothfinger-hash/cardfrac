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
const { renderBuyerShipped, sendOrderEmail } = require('./_lib/order-emails');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Best-effort buyer "your order shipped" email. Looks up the card name from
// the listing (if any) and sends to the order's ship-to email. Never throws —
// a mail failure must not break label purchase or manual tracking.
async function notifyBuyerShipped(order, tracking) {
  try {
    const to = order.ship_to_email;
    if (!to) return;
    let cardName = null, setName = null, imageUrl = null;
    if (order.listing_id) {
      const { data: l } = await sb.from('listings')
        .select('name, set_name, photos, api_card_id').eq('id', order.listing_id).maybeSingle();
      if (l) {
        cardName = l.name || null;
        setName = l.set_name || null;
        // Prefer the listing's own ad photo; fall back to the catalog image.
        if (Array.isArray(l.photos) && l.photos[0]) imageUrl = l.photos[0];
        if (!imageUrl && l.api_card_id) {
          const { data: cat } = await sb.from('catalog')
            .select('image_url').eq('id', l.api_card_id).maybeSingle();
          if (cat) imageUrl = cat.image_url || null;
        }
      }
    }
    const siteOrigin = (process.env.NEXT_PUBLIC_SITE_URL || 'https://pathbinder.gg').replace(/\/+$/, '');
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) imageUrl = siteOrigin + (imageUrl[0] === '/' ? '' : '/') + imageUrl;
    const msg = renderBuyerShipped({
      siteOrigin: siteOrigin,
      orderId: order.id,
      cardName: cardName,
      setName: setName,
      imageUrl: imageUrl,
      shipTo: { name: order.ship_to_name },
      tracking: tracking || {},
    });
    await sendOrderEmail({ to: to, subject: msg.subject, html: msg.html, text: msg.text });
  } catch (e) {
    console.error('[shippo] shipped email failed:', e && e.message);
  }
}

// Mode-aware token selection — mirrors the Stripe STRIPE_MODE switch so the
// test -> live cutover is a single env change.
function platformToken() {
  const m = (process.env.SHIPPO_MODE || '').toLowerCase();
  if (m === 'test') return process.env.SHIPPO_API_TOKEN_TEST;
  if (m === 'live') return process.env.SHIPPO_API_TOKEN_LIVE || process.env.SHIPPO_API_TOKEN;
  return process.env.SHIPPO_API_TOKEN;
}

// Sellers buy labels on their OWN connected Shippo account — we do NOT front
// label costs via the platform token. Returns null when unconnected; the
// handler guards on that (SHIPPO_NOT_CONNECTED) with a "connect" message.
// platformToken() is retained for env documentation / possible admin use.
function resolveToken(sellerProfile) {
  return (sellerProfile && sellerProfile.shippo_oauth_token) || null;
}

async function shippo(path, method, body, token) {
  // OAuth (per-seller) tokens start with "oauth." and authenticate as Bearer,
  // and on-behalf-of calls require a pinned API version. Platform-account
  // tokens (shippo_test_/shippo_live_) use the "ShippoToken" scheme.
  const isOauth = /^oauth\./.test(token || '');
  const headers = {
    'Authorization': (isOauth ? 'Bearer ' : 'ShippoToken ') + token,
    'Content-Type': 'application/json',
  };
  if (isOauth) headers['Shippo-API-Version'] = '2018-02-08';
  const r = await fetch('https://api.goshippo.com' + path, {
    method: method || 'GET',
    headers: headers,
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

// Explicit Shippo address validation. POSTs the address with validate:true and
// returns { is_valid, messages, corrected }. Never throws — a validation hiccup
// must not block the seller from getting rates / buying a label.
async function validateAddress(addr, token) {
  try {
    const r = await shippo('/addresses/', 'POST', Object.assign({}, addr, { validate: true }), token);
    const vr = (r && r.validation_results) || {};
    const messages = Array.isArray(vr.messages) ? vr.messages.map(m => m && m.text).filter(Boolean) : [];
    const corrected = {
      name: r.name || null, street1: r.street1 || null, street2: r.street2 || null,
      city: r.city || null, state: r.state || null, zip: r.zip || null, country: r.country || null,
    };
    // Did Shippo normalize/correct any address line vs what we submitted?
    const norm = s => String(s || '').trim().toLowerCase();
    const changed = ['street1', 'street2', 'city', 'state', 'zip'].some(k => norm(corrected[k]) !== norm(addr[k]));
    return {
      is_valid: (typeof vr.is_valid === 'boolean') ? vr.is_valid : null,
      messages: messages,
      corrected: corrected,
      changed: changed,
    };
  } catch (e) {
    return { is_valid: null, messages: [], corrected: null, changed: false, error: (e && e.message) || 'validation error' };
  }
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

  // ── Manual-tracking path: just email the buyer (no label/address needed) ─
  // Called by the client after a manual "Save Tracking" so the buyer still
  // gets the shipped notification when the seller ships outside Shippo.
  if (action === 'notify_shipped') {
    await notifyBuyerShipped(order, {
      carrier: order.tracking_carrier || null,
      number:  order.tracking_number || null,
      url:     null,
    });
    return res.status(200).json({ ok: true });
  }

  // ── Seller (from) + buyer (to) addresses ────────────────────────────────
  const { data: seller } = await sb
    .from('profiles')
    .select('ship_from_name, ship_from_street1, ship_from_street2, ship_from_city, ship_from_state, ship_from_zip, ship_from_country, ship_from_phone, shop_name, name, email, shippo_oauth_token')
    .eq('id', user.id)
    .single();

  if (!seller || !seller.ship_from_street1 || !seller.ship_from_zip) {
    return res.status(400).json({ error: 'Add your return address in seller settings before buying a label', code: 'NO_FROM_ADDRESS' });
  }
  if (!order.ship_to_street1 || !order.ship_to_zip) {
    return res.status(400).json({ error: 'This order has no shipping address on file', code: 'NO_TO_ADDRESS' });
  }

  // Sellers bill labels to their OWN Shippo account — platform billing is off.
  // Sellers who ship independently use the manual "enter your own tracking"
  // path (returns above at action === 'notify_shipped'), which needs no label.
  const token = resolveToken(seller);
  if (!token) {
    return res.status(400).json({
      error: 'Connect your Shippo account to buy prepaid labels.',
      code: 'SHIPPO_NOT_CONNECTED',
    });
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
    email: seller.email || 'orders@pathbinder.gg',
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
    email: order.ship_to_email || 'buyer@pathbinder.gg',
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
      // Explicit Shippo address validation on BOTH ends before rating/buying —
      // run in parallel with shipment creation so it adds no latency. The
      // validation results (valid flag + messages + Shippo's normalized
      // address) ride back to the client so the seller sees any problems
      // before committing to a label.
      const [validation, shipment] = await Promise.all([
        Promise.all([validateAddress(addressFrom, token), validateAddress(addressTo, token)])
          .then(([from, to]) => ({ from, to })),
        shippo('/shipments/', 'POST', {
          address_from: addressFrom,
          address_to: addressTo,
          parcels: [parcelObj],
          async: false,
        }, token),
      ]);

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
        return res.status(400).json({ error: m, validation });
      }
      return res.status(200).json({ shipment_id: shipment.object_id, rates, validation });
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

      // Notify the buyer their order shipped (best-effort).
      await notifyBuyerShipped(order, {
        carrier: carrier || null,
        number:  tx.tracking_number || null,
        url:     tx.tracking_url_provider || null,
      });

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
