// api/stripe-webhook.js
// Handles Stripe webhooks for marketplace purchases AND subscription tier changes.
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard → Webhooks → your endpoint → Signing secret
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Register this endpoint in Stripe Dashboard → Developers → Webhooks:
//   Endpoint URL: https://your-domain.vercel.app/api/stripe-webhook
//   Events to enable:
//     checkout.session.completed
//     customer.subscription.updated
//     customer.subscription.deleted

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service key bypasses RLS — never expose client-side
);

const VALID_TIERS = ['free', 'collector', 'vendor', 'shop'];

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

// ── Tier upgrade: called when a subscription checkout completes ───────────────
async function handleSubscriptionCheckout(session) {
  const meta = session.metadata || {};
  const userId = meta.user_id;
  const tier   = meta.tier;

  if (!userId || !VALID_TIERS.includes(tier)) {
    console.error('[webhook] subscription checkout missing user_id or invalid tier:', meta);
    return;
  }

  // Store the Stripe customer ID alongside the tier so we can look up
  // the user later when a subscription.deleted event arrives (which only
  // carries customer ID, not our user_id).
  const { error } = await sb.from('profiles').update({
    subscription_tier:      tier,
    stripe_customer_id:     session.customer || null,
    stripe_subscription_id: session.subscription || null,
    subscription_updated_at: new Date().toISOString(),
  }).eq('id', userId);

  if (error) {
    console.error('[webhook] tier upgrade failed:', error.message);
  } else {
    console.log(`[webhook] upgraded user ${userId} → ${tier}`);
  }
}

// ── Plan change: Stripe fires this when the customer switches plans ───────────
// The new price/product tells us which tier they moved to.
// You must set metadata on your Stripe Price objects: { tier: 'collector' } etc.
async function handleSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  if (!customerId) return;

  // Read tier from the price metadata (set this in your Stripe dashboard
  // under Products → your plan → Price → Metadata → tier: collector)
  const priceId   = subscription.items?.data?.[0]?.price?.id;
  const priceMeta = subscription.items?.data?.[0]?.price?.metadata || {};
  const tier      = priceMeta.tier;

  if (!VALID_TIERS.includes(tier)) {
    console.log('[webhook] subscription.updated — no tier in price metadata, skipping. price:', priceId);
    return;
  }

  // Look up the user by Stripe customer ID
  const { data: profile, error: lookupErr } = await sb
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (lookupErr || !profile) {
    console.error('[webhook] could not find profile for customer:', customerId);
    return;
  }

  const { error } = await sb.from('profiles').update({
    subscription_tier:       tier,
    stripe_subscription_id:  subscription.id,
    subscription_updated_at: new Date().toISOString(),
  }).eq('id', profile.id);

  if (error) console.error('[webhook] tier update failed:', error.message);
  else console.log(`[webhook] plan changed: user ${profile.id} → ${tier}`);
}

// ── Cancellation: downgrade to free when sub is cancelled / expires ───────────
async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  if (!customerId) return;

  const { data: profile, error: lookupErr } = await sb
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (lookupErr || !profile) {
    console.error('[webhook] could not find profile for customer:', customerId);
    return;
  }

  const { error } = await sb.from('profiles').update({
    subscription_tier:       'free',
    stripe_subscription_id:  null,
    subscription_updated_at: new Date().toISOString(),
  }).eq('id', profile.id);

  if (error) console.error('[webhook] tier downgrade failed:', error.message);
  else console.log(`[webhook] subscription cancelled: user ${profile.id} → free`);
}

// ── Marketplace purchase ──────────────────────────────────────────────────────
async function handleMarketplacePurchase(session) {
  const meta = session.metadata || {};
  const amountCents = session.amount_total || 0;
  const platformFee = parseInt(meta.platform_fee || 0);
  const sellerPayout = amountCents - platformFee;

  const autoReleaseAt = new Date();
  autoReleaseAt.setDate(autoReleaseAt.getDate() + 7);

  const { error: orderErr } = await sb.from('orders').insert({
    listing_id:             meta.listing_id || null,
    buyer_id:               meta.buyer_id   || null,
    seller_id:              meta.seller_id  || null,
    amount:                 amountCents / 100,
    platform_fee:           platformFee / 100,
    seller_payout:          sellerPayout / 100,
    status:                 'paid',
    stripe_session_id:      session.id,
    stripe_payment_intent:  session.payment_intent,
    auto_release_at:        autoReleaseAt.toISOString(),
  });

  if (orderErr) {
    console.error('[webhook] order creation error:', orderErr.message);
    return;
  }

  if (meta.listing_id) {
    await sb.from('listings').update({
      status:  'sold',
      sold_to: meta.buyer_id || null,
    }).eq('id', meta.listing_id);
  }

  console.log(`[webhook] order created for listing ${meta.listing_id}`);
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await buffer(req);
    event = webhookSecret
      ? stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
      : JSON.parse(rawBody.toString());
  } catch (e) {
    console.error('[webhook] signature error:', e.message);
    return res.status(400).json({ error: 'Webhook signature failed' });
  }

  const obj  = event.data.object;
  const meta = obj.metadata || {};

  switch (event.type) {
    case 'checkout.session.completed':
      if (meta.type === 'subscription')          await handleSubscriptionCheckout(obj);
      else if (meta.type === 'marketplace_purchase') await handleMarketplacePurchase(obj);
      break;

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(obj);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(obj);
      break;

    default:
      // Unhandled event — always return 200 so Stripe doesn't retry
      break;
  }

  return res.status(200).json({ received: true });
};
