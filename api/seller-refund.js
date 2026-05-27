// api/seller-refund.js
//
// Seller-initiated refund for a marketplace order. Mirrors /api/refund-order
// (admin-initiated) but auth-checks that the caller IS the seller on the
// order, and only accepts orders that are in a refund-eligible state.
//
// Why this exists: pre-this-endpoint the only refund path was admin-only,
// which meant every return request bottlenecked on us. For the soft launch
// that's untenable — sellers handle their own returns the same way they do
// on eBay and TCGplayer.
//
// REFUND MECHANICS (Stripe Connect):
//   When the original charge used transfer_data.destination (destination
//   charge), the funds live on the connected account. A plain refund
//   would try to pull from THERE, which fails if the seller has already
//   spent the balance. We pass:
//     reverse_transfer:        true   — pull funds back from the seller's
//                                       Connect account
//     refund_application_fee:  true   — also return our platform fee to
//                                       the buyer (this is the correct
//                                       behavior on a buyer-favoring refund;
//                                       the seller shouldn't pay a fee on a
//                                       sale they didn't keep)
//   For legacy platform_only orders these params are no-ops on Stripe's
//   side but it's safer to send them than to special-case.
//
// REQUEST:
//   POST /api/seller-refund
//   headers: Authorization: Bearer <supabase-jwt>
//   body:    { orderId, reason?: 'requested_by_customer'|'fraudulent'|'duplicate' }
//
// RESPONSE:
//   200 { success: true, refundId, amount, status }
//   400 / 401 / 403 / 404 / 500 with { error }

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Statuses from which a seller can issue a refund. completed (buyer
// confirmed receipt) is included because a buyer can still report an
// issue within the 7-day window; the seller may choose to refund as a
// goodwill gesture.
const REFUND_ELIGIBLE_STATUSES = new Set([
  'paid',
  'shipped',
  'delivered',
  'completed',
  'return_requested',
  'disputed',
]);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }

  // ── Auth ────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  // ── Parse body ──────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const orderId = body && body.orderId;
  const reason  = body && body.reason;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  // ── Order lookup + ownership check ──────────────────────────────────
  const { data: order, error: orderErr } = await sb
    .from('orders')
    .select('id, status, stripe_payment_intent, amount, buyer_id, seller_id, listing_id, payment_route')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr || !order) return res.status(404).json({ error: 'Order not found' });

  // Only the seller (or an admin) can refund — admins go through the
  // admin endpoint normally, but allow them here as a fallback.
  if (order.seller_id !== user.id) {
    const { data: prof } = await sb
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle();
    if (!prof || !prof.is_admin) {
      return res.status(403).json({ error: 'Only the seller can refund this order' });
    }
  }

  if (!order.stripe_payment_intent) {
    return res.status(400).json({ error: 'Order has no Stripe payment intent — admin needs to handle manually' });
  }
  if (order.status === 'refunded' || order.status === 'cancelled') {
    return res.status(400).json({ error: 'Order already ' + order.status });
  }
  if (!REFUND_ELIGIBLE_STATUSES.has(order.status)) {
    return res.status(400).json({ error: 'Cannot refund order in status: ' + order.status });
  }

  // ── Refund via Stripe ───────────────────────────────────────────────
  // reverse_transfer + refund_application_fee are no-ops for charges that
  // didn't use destination charge, so it's safe to send unconditionally.
  let refund;
  try {
    refund = await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent,
      reason: (reason && ['requested_by_customer','fraudulent','duplicate'].includes(reason))
                ? reason
                : 'requested_by_customer',
      reverse_transfer:       true,
      refund_application_fee: true,
      metadata: {
        order_id:        order.id,
        refunded_by:     user.id,
        seller_initiated: 'true',
        payment_route:   order.payment_route || 'platform_only',
      },
    });
  } catch (e) {
    console.error('[seller-refund] Stripe error:', e);
    return res.status(500).json({ error: e.message || 'Refund failed' });
  }

  // ── Persist order + listing state ───────────────────────────────────
  const { error: updErr } = await sb.from('orders').update({
    status:                   'refunded',
    refunded_at:              new Date().toISOString(),
    refund_id:                refund.id,
    refunded_application_fee: true,
    return_decided_at:        new Date().toISOString(),
    return_decision:          'approved',
  }).eq('id', order.id);
  if (updErr) {
    // Stripe already succeeded — log loudly but don't fail the response.
    console.error('[seller-refund] order status update failed:', updErr.message);
  }

  // Put the listing back on the market unless the seller manually
  // deactivated it in the meantime.
  if (order.listing_id) {
    await sb.from('listings')
      .update({ status: 'available', sold_to: null })
      .eq('id', order.listing_id);
  }

  return res.status(200).json({
    success:  true,
    refundId: refund.id,
    amount:   refund.amount / 100,
    status:   refund.status,
  });
};
