// api/refund-order.js
// Admin-only endpoint to refund a marketplace order via Stripe's refund API.
// This is the legitimate path post-escrow refactor: refunds happen through
// Stripe rather than by "releasing" or "withholding" funds.
//
// POST body: { orderId: "<uuid>", reason?: "requested_by_customer" | "fraudulent" | "duplicate" }
// Returns:   { success: true, refundId: "re_..." } | { error: "..." }
//
// Auth: caller must be authenticated AND have is_admin=true on their profile.
//
// Required env vars (Vercel):
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }

  // 1. Auth — require a logged-in admin
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const { data: profile, error: profErr } = await sb
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .maybeSingle();
  if (profErr || !profile || !profile.is_admin) {
    return res.status(403).json({ error: 'Admin only' });
  }

  // 2. Look up the order
  const { orderId, reason } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const { data: order, error: orderErr } = await sb
    .from('orders')
    .select('id, status, stripe_payment_intent, amount, buyer_id, seller_id')
    .eq('id', orderId)
    .maybeSingle();

  if (orderErr || !order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (!order.stripe_payment_intent) {
    return res.status(400).json({ error: 'Order has no Stripe payment intent — manual handling required' });
  }
  if (order.status === 'refunded' || order.status === 'cancelled') {
    return res.status(400).json({ error: `Order already ${order.status}` });
  }

  // 3. Refund via Stripe
  try {
    const refund = await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent,
      reason: (reason && ['requested_by_customer','fraudulent','duplicate'].includes(reason)) ? reason : 'requested_by_customer',
      metadata: {
        order_id:       order.id,
        refunded_by:    user.id,
        admin_initiated: 'true',
      },
    });

    // 4. Update order status + restore listing
    const { error: updErr } = await sb
      .from('orders')
      .update({
        status:        'refunded',
        refunded_at:   new Date().toISOString(),
        refund_id:     refund.id,
      })
      .eq('id', order.id);
    if (updErr) {
      console.error('[refund] order status update failed:', updErr.message);
    }

    // Restore the listing to available so it can be re-sold
    const { data: listing } = await sb
      .from('orders')
      .select('listing_id')
      .eq('id', order.id)
      .maybeSingle();
    if (listing && listing.listing_id) {
      await sb.from('listings').update({ status: 'available', sold_to: null })
        .eq('id', listing.listing_id);
    }

    return res.status(200).json({
      success:  true,
      refundId: refund.id,
      amount:   refund.amount / 100,
      status:   refund.status,
    });
  } catch (e) {
    console.error('[refund] Stripe error:', e);
    return res.status(500).json({ error: e.message || 'Refund failed' });
  }
};
