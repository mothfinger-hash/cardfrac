// api/stripe-webhook.js
// Handles Stripe webhooks for marketplace purchases.
// When a checkout.session.completed event fires, creates an order in Supabase.
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard → Webhooks → your endpoint → Signing secret
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Register this endpoint in Stripe Dashboard → Developers → Webhooks:
//   Endpoint URL: https://your-domain.vercel.app/api/stripe-webhook
//   Events: checkout.session.completed

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Disable body parsing — Stripe needs the raw body for signature verification
export const config = { api: { bodyParser: false } };

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await buffer(req);
    event = webhookSecret
      ? stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
      : JSON.parse(rawBody.toString());
  } catch(e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).json({ error: 'Webhook signature failed' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};

    if (meta.type !== 'marketplace_purchase') {
      return res.status(200).json({ received: true });
    }

    const amountCents = session.amount_total || 0;
    const platformFee = parseInt(meta.platform_fee || 0);
    const sellerPayout = amountCents - platformFee;

    // Calculate auto-release date: 7 days from now
    const autoReleaseAt = new Date();
    autoReleaseAt.setDate(autoReleaseAt.getDate() + 7);

    // Create the order
    const { error: orderErr } = await sb.from('orders').insert({
      listing_id: meta.listing_id || null,
      buyer_id: meta.buyer_id || null,
      seller_id: meta.seller_id || null,
      amount: amountCents / 100,
      platform_fee: platformFee / 100,
      seller_payout: sellerPayout / 100,
      status: 'paid',
      stripe_session_id: session.id,
      stripe_payment_intent: session.payment_intent,
      auto_release_at: autoReleaseAt.toISOString(),
    });

    if (orderErr) {
      console.error('Order creation error:', orderErr);
      return res.status(500).json({ error: orderErr.message });
    }

    // Mark listing as sold
    if (meta.listing_id) {
      await sb.from('listings').update({
        status: 'sold',
        sold_to: meta.buyer_id || null,
      }).eq('id', meta.listing_id);
    }

    console.log(`Order created for listing ${meta.listing_id}`);
  }

  return res.status(200).json({ received: true });
};
