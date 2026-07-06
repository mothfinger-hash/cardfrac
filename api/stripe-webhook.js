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
const { renderSellerNewOrder, sendOrderEmail } = require('./_lib/order-emails');

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

// Disable body parsing — Stripe needs the raw bytes for signature
// verification. This file is CommonJS (uses module.exports), so we
// must declare config via module.exports.config — `export const`
// would silently no-op and Vercel would pre-parse the body, breaking
// every webhook signature. The property is re-attached after the
// handler assignment at the bottom because `module.exports = handler`
// would otherwise overwrite it.
module.exports.config = { api: { bodyParser: false } };

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

// ── Renewal failure: grace period instead of immediate downgrade ──────────────
// On invoice.payment_failed (recurring renewal), stamp a 3-day grace
// timestamp on the profile. Tier-gated checks should respect both
// subscription_tier AND subscription_grace_until — if grace is in
// effect the user keeps their paid features even though Stripe says
// the sub is past_due. Gives them a window to fix their card or talk
// to us on Discord before listings vanish.
async function handleInvoicePaymentFailed(invoice) {
  const customerId = invoice.customer;
  if (!customerId) return;

  // Only act on recurring-sub invoices, not one-off charges.
  const subscriptionId = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
  if (!subscriptionId) return;

  const { data: profile } = await sb.from('profiles')
    .select('id, subscription_tier').eq('stripe_customer_id', customerId).maybeSingle();
  if (!profile) return;

  // Skip free-tier users (no paid features to preserve).
  if (!profile.subscription_tier || profile.subscription_tier === 'free') return;

  const graceUntil = new Date(Date.now() + 3 * 86400000).toISOString();
  await sb.from('profiles')
    .update({ subscription_grace_until: graceUntil })
    .eq('id', profile.id);
  console.log(`[webhook] grace started: user ${profile.id} until ${graceUntil}`);
}

// On invoice.payment_succeeded (renewal recovered, or first invoice
// after fixing card), clear any grace timestamp so future failures
// start a fresh window.
async function handleInvoicePaymentSucceeded(invoice) {
  const customerId = invoice.customer;
  if (!customerId) return;
  const { data: profile } = await sb.from('profiles')
    .select('id, subscription_grace_until').eq('stripe_customer_id', customerId).maybeSingle();
  if (!profile || !profile.subscription_grace_until) return;
  await sb.from('profiles')
    .update({ subscription_grace_until: null })
    .eq('id', profile.id);
  console.log(`[webhook] grace cleared: user ${profile.id} (renewal recovered)`);
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

  // Buyer shipping address, captured by Checkout's shipping_address_collection.
  // Lives on session.shipping_details (name + address) + customer_details
  // (email/phone). The seller reads these to buy a Shippo label. Wrapped so a
  // pre-migration DB (missing ship_to_* columns) doesn't fail the insert.
  const ship = (session.shipping_details && session.shipping_details.address) || {};
  const cust = session.customer_details || {};
  const shipTo = {
    ship_to_name:    (session.shipping_details && session.shipping_details.name) || cust.name || null,
    ship_to_street1: ship.line1 || null,
    ship_to_street2: ship.line2 || null,
    ship_to_city:    ship.city || null,
    ship_to_state:   ship.state || null,
    ship_to_zip:     ship.postal_code || null,
    ship_to_country: ship.country || 'US',
    ship_to_phone:   cust.phone || null,
    ship_to_email:   cust.email || null,
  };

  const baseOrder = {
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
  };

  let insertRes = await sb.from('orders').insert(Object.assign({}, baseOrder, shipTo)).select('id').single();
  // Graceful fallback if the shipping-address migration hasn't been applied.
  if (insertRes.error && /ship_to_/.test(insertRes.error.message || '')) {
    console.warn('[webhook] ship_to_* columns missing — inserting order without address');
    insertRes = await sb.from('orders').insert(baseOrder).select('id').single();
  }

  if (insertRes.error) {
    console.error('[webhook] order creation error:', insertRes.error.message);
    return;
  }
  const newOrderId = insertRes.data && insertRes.data.id;

  if (meta.listing_id) {
    // Mark the listing sold so it drops out of the live marketplace.
    // Buyer is tracked on the order (orders.buyer_id) — there is no sold_to
    // column on listings, and including one here previously made the whole
    // update fail (PGRST204), leaving sold listings live in the marketplace.
    const _soldRes = await sb.from('listings').update({
      status: 'sold',
    }).eq('id', meta.listing_id);
    if (_soldRes.error) {
      console.error('[webhook] failed to mark listing sold:', meta.listing_id, _soldRes.error.message);
    }
  }

  // Notify the seller they made a sale (best-effort — never block the webhook).
  try {
    await notifySellerOfSale({
      orderId: newOrderId,
      sellerId: meta.seller_id,
      listingId: meta.listing_id,
      amount: amountCents / 100,
      payout: sellerPayout / 100,
      shipTo: shipTo,
    });
  } catch (e) {
    console.error('[webhook] seller email failed:', e && e.message);
  }

  // Native push to the seller too (best-effort — never block the webhook).
  try {
    const { sendPushToUser } = require('./_lib/push');
    if (meta.seller_id) {
      await sendPushToUser(meta.seller_id, {
        title: 'You sold a card!',
        body: 'Your listing sold for $' + (amountCents / 100).toFixed(2) + ' — time to ship it.',
        data: { page: 'account', order: newOrderId || '' },
      });
    }
  } catch (e) {
    console.error('[webhook] seller push failed:', e && e.message);
  }

  console.log(`[webhook] order created for listing ${meta.listing_id} via ${meta.payment_route || 'platform_only'}`);
}

// Best-effort "you made a sale" email to the seller.
async function notifySellerOfSale(o) {
  if (!o.sellerId) return;
  const { data: seller } = await sb.from('profiles')
    .select('email, name, shop_name').eq('id', o.sellerId).maybeSingle();
  const to = seller && seller.email;
  if (!to) return;

  let cardName = null, setName = null, imageUrl = null;
  if (o.listingId) {
    const { data: l } = await sb.from('listings')
      .select('name, set_name, photos, api_card_id').eq('id', o.listingId).maybeSingle();
    if (l) {
      cardName = l.name || null;
      setName = l.set_name || null;
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

  const msg = renderSellerNewOrder({
    siteOrigin: siteOrigin,
    orderId: o.orderId,
    cardName: cardName,
    setName: setName,
    imageUrl: imageUrl,
    amount: o.amount,
    payout: o.payout,
    shipTo: {
      name: o.shipTo.ship_to_name,
      street1: o.shipTo.ship_to_street1,
      street2: o.shipTo.ship_to_street2,
      city: o.shipTo.ship_to_city,
      state: o.shipTo.ship_to_state,
      zip: o.shipTo.ship_to_zip,
    },
  });
  await sendOrderEmail({ to: to, subject: msg.subject, html: msg.html, text: msg.text });
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

// ── Buyer risk event logging ─────────────────────────────────────────────────
// Records a row in buyer_risk_events keyed on the card fingerprint
// (durable across charges and accounts) so the next checkout from
// the same card / buyer can be friction-scored. Tolerant: any error
// is logged and swallowed — we never want to 500 the webhook over a
// missing optional risk-table row.
async function logRiskEvent(eventType, stripeObj) {
  try {
    // stripeObj is either a Dispute (has .charge) or a Charge (has .id).
    const isCharge = stripeObj && stripeObj.object === 'charge';
    const chargeId = isCharge
      ? stripeObj.id
      : (stripeObj && stripeObj.charge) || null;

    let card = null;
    let amountCents = 0;
    let reason = null;
    let meta = {};
    let zip = null;

    if (chargeId) {
      try {
        const charge = await stripe.charges.retrieve(chargeId, {
          expand: ['payment_method_details'],
        });
        card = charge.payment_method_details && charge.payment_method_details.card;
        meta = charge.metadata || {};
        amountCents = isCharge ? (stripeObj.amount_refunded || stripeObj.amount || 0)
                               : (stripeObj.amount || 0);
        reason = isCharge ? null : (stripeObj.reason || null);
        const billing = charge.billing_details && charge.billing_details.address;
        if (billing && billing.postal_code) zip = String(billing.postal_code).slice(0, 10);
      } catch (e) {
        console.warn('[webhook] risk-log charge fetch failed:', e.message);
      }
    }

    const buyerId = meta.buyer_id || null;
    await sb.from('buyer_risk_events').insert({
      card_fingerprint: card && card.fingerprint ? card.fingerprint : null,
      buyer_id:         buyerId,
      order_id:         meta.listing_id || null,
      stripe_charge_id: chargeId,
      shipping_zip:     zip,
      event_type:       eventType,
      amount_cents:     amountCents,
      reason:           reason,
    });
  } catch (e) {
    console.error('[webhook] logRiskEvent failed:', eventType, e.message);
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

    case 'charge.dispute.created':
      await logRiskEvent('chargeback_opened', obj);
      break;
    case 'charge.dispute.closed':
      // Stripe sets `status` to 'won' | 'lost' | 'warning_closed' on close.
      // We log lost disputes heavily (friendly fraud), won ones neutrally.
      if (obj.status === 'lost') {
        await logRiskEvent('chargeback_lost', obj);
      } else if (obj.status === 'won') {
        await logRiskEvent('chargeback_won', obj);
      }
      break;
    case 'charge.refunded':
      // Full vs partial refund — drives whether this looks like a normal
      // buyer-satisfaction issue or a money-back-grab pattern.
      await logRiskEvent(
        obj.amount_refunded >= obj.amount ? 'refund_full' : 'refund_partial',
        obj
      );
      break;

    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(obj);
      break;
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(obj);
      break;

    default:
      // Unhandled event — always return 200 so Stripe doesn't retry
      break;
  }

  return res.status(200).json({ received: true });
};
// Re-attach config — `module.exports = handler` above overwrote the
// property we set at the top. Vercel reads it off module.exports at
// build time, so both have to live on the same object.
module.exports.config = { api: { bodyParser: false } };
