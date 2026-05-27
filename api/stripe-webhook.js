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
//     account.updated                  ← Connect Express status sync
//     capability.updated               ← (optional) finer-grained capability flips

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service key bypasses RLS — never expose client-side
);

// All recognised subscription tiers. Order matters elsewhere (see TIER_ORDER
// in index.html) but here it's just membership. 'enthusiast' was missing
// pre-Connect-onboarding-PR — its absence meant subscription.updated events
// for enthusiast Prices silently no-op'd and the user stayed on whatever
// tier they had previously. Added now along with the rest.
const VALID_TIERS = ['free', 'collector', 'enthusiast', 'vendor', 'shop'];

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
// Post-escrow model: order is created with status='paid'. There is NO
// custodial holding period — sellers receive funds via Stripe's normal
// payout schedule (handled by Stripe automatically when the checkout used
// a destination charge with transfer_data, or manually via the admin if
// the seller hasn't completed Connect onboarding yet).
//
// Buyers have a 7-day buyer-protection window during which they can file
// a dispute with Stripe in the usual way. That flow runs through the
// standard Stripe chargeback machinery — we don't gate the seller's
// payout on a "delivery confirmed" event.
async function handleMarketplacePurchase(session) {
  const meta = session.metadata || {};
  const amountCents = session.amount_total || 0;
  const platformFee = parseInt(meta.platform_fee || 0);
  const sellerPayout = amountCents - platformFee;

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
    payment_route:          meta.payment_route || 'platform_only',
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

  console.log(`[webhook] order created for listing ${meta.listing_id} via ${meta.payment_route || 'platform_only'}`);
}

// ── Connect Express: account state changed ───────────────────────────────────
// Stripe fires account.updated whenever the connected account's status
// changes — charges_enabled, payouts_enabled, requirements list, capability
// flips, etc. We mirror those flags onto profiles so the Account page and
// marketplace-checkout can read them without round-tripping Stripe on every
// page load.
//
// The account id arrives on the event object (account.id, e.g. acct_xxx).
// We find the matching profile by stripe_connect_account_id — that column
// was set when the user first kicked off onboarding via /api/connect-onboard.
async function handleAccountUpdated(account) {
  if (!account || !account.id) return;

  const { data: profile, error: lookupErr } = await sb
    .from('profiles')
    .select('id, stripe_connect_onboarded_at')
    .eq('stripe_connect_account_id', account.id)
    .maybeSingle();

  if (lookupErr || !profile) {
    // Either the column doesn't exist yet (migration not run) or the
    // account doesn't belong to a PathBinder profile (someone else's
    // Stripe sending us webhooks shouldn't happen, but no-op cleanly).
    console.log('[webhook] account.updated for unknown account:', account.id);
    return;
  }

  const req = account.requirements || {};
  const patch = {
    stripe_connect_charges_enabled:   !!account.charges_enabled,
    stripe_connect_payouts_enabled:   !!account.payouts_enabled,
    stripe_connect_details_submitted: !!account.details_submitted,
    stripe_connect_requirements: {
      currently_due:        req.currently_due        || [],
      past_due:             req.past_due             || [],
      pending_verification: req.pending_verification || [],
      disabled_reason:      req.disabled_reason      || null,
    },
    stripe_connect_synced_at: new Date().toISOString(),
  };
  // Only stamp onboarded_at the first time. Don't overwrite on every
  // subsequent account.updated event — that timestamp is a one-shot
  // analytics signal, not a "last touched" timestamp.
  if (account.details_submitted && !profile.stripe_connect_onboarded_at) {
    patch.stripe_connect_onboarded_at = new Date().toISOString();
  }

  const { error: updErr } = await sb
    .from('profiles')
    .update(patch)
    .eq('id', profile.id);
  if (updErr) {
    console.error('[webhook] account.updated persist failed:', updErr.message);
  } else {
    console.log(`[webhook] account.updated synced for profile ${profile.id} (charges=${patch.stripe_connect_charges_enabled} payouts=${patch.stripe_connect_payouts_enabled})`);
  }
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

    case 'account.updated':
      // Connect Express seller account status changed — sync to profiles.
      // `obj` here is the Account object itself.
      await handleAccountUpdated(obj);
      break;

    case 'capability.updated':
      // Capability changes (e.g. transfers active → restricted) also surface
      // through account.updated, but Stripe sends capability.updated first.
      // We re-fetch the full account so we're not relying on the partial
      // shape Stripe gives us on this event.
      if (obj && obj.account) {
        try {
          const acct = await stripe.accounts.retrieve(obj.account);
          await handleAccountUpdated(acct);
        } catch (e) {
          console.error('[webhook] capability.updated re-fetch failed:', e.message);
        }
      }
      break;

    default:
      // Unhandled event — always return 200 so Stripe doesn't retry
      break;
  }

  return res.status(200).json({ received: true });
};
