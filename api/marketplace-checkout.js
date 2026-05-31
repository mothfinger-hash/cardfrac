// api/marketplace-checkout.js
// Creates a Stripe Checkout session for a marketplace card purchase.
//
// PAYMENT MODEL (post-escrow refactor):
//   - Sellers receive funds directly on Stripe's normal payout schedule
//   - PathBinder retains a tiered platform fee via application_fee_amount:
//       Enthusiast tier  -> 7%
//       Vendor tier      -> 6%
//       Shop tier        -> 5%
//       (Free/Collector cannot sell, so they never hit this path.)
//     Lower-tier sellers pay a higher commission because their subscription
//     contribution is smaller; higher-tier sellers pay less per sale because
//     they're already paying more in subscription up front.
//   - Implemented as a Connect "destination charge" when the seller has a
//     stripe_connect_account_id on their profile
//   - If the seller has not yet completed Connect onboarding (no account id),
//     the charge falls back to platform-only mode (funds held on platform
//     account, manual payout by admin). Existing TOS-compliant — funds are
//     not held conditionally pending delivery confirmation.
//
// Required env vars (Vercel dashboard):
//   STRIPE_SECRET_KEY     — from Stripe Dashboard → Developers → API keys
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   NEXT_PUBLIC_SITE_URL  — your Vercel domain, e.g. https://pathbinder.vercel.app

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Server-side mirror of TIER_COMMISSION_RATES in index.html — keep these
// in sync. The client uses it for display ("you'll keep $X of this sale");
// the server uses it as the source of truth for the actual charge.
const TIER_COMMISSION_RATES = {
  free:       0.00,
  collector:  0.00,
  enthusiast: 0.07,
  vendor:     0.06,
  shop:       0.05,
};
// Default rate when the seller's tier is unknown or unset. Matches the
// old flat-rate behavior so legacy/edge cases don't accidentally pay 0%.
const DEFAULT_COMMISSION_RATE = 0.07;

// Stripe's per-transaction fixed fee (in cents). We fold this into the
// platform commission so PathBinder isn't out-of-pocket on cheap sales.
// Without this, a $1 sale at 5% would leave us with $0.05 commission
// against $0.30 + 2.9% in Stripe processing — a loss of ~$0.28 per sale.
// Folding it in means the platform fee always at least covers the
// processing floor; cheap-item sellers absorb it (their incentive to
// price reasonably).
const STRIPE_FIXED_FEE_CENTS = 30;

function commissionRateFor(tier) {
  if (!tier) return DEFAULT_COMMISSION_RATE;
  const r = TIER_COMMISSION_RATES[String(tier).toLowerCase()];
  return (typeof r === 'number') ? r : DEFAULT_COMMISSION_RATE;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured. Add it in Vercel → Settings → Environment Variables.' });
  }

  const { listingId, sellerId, amount, cardName, successUrl, cancelUrl } = req.body || {};

  if (!listingId || !amount || amount < 100) {
    return res.status(400).json({ error: 'listingId and amount (cents) required' });
  }

  // Verify buyer is authenticated
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  // Look up the seller's Stripe Connect account id (Phase 2 onboarding column)
  // AND their subscription tier (drives the commission rate). One round trip.
  let sellerConnectId = null;
  let sellerTier      = null;
  if (sellerId) {
    try {
      const { data: profile } = await sb
        .from('profiles')
        .select('stripe_connect_account_id, subscription_tier, is_vendor, is_premium')
        .eq('id', sellerId)
        .maybeSingle();
      if (profile) {
        if (profile.stripe_connect_account_id) {
          sellerConnectId = profile.stripe_connect_account_id;
        }
        // Prefer the new subscription_tier column; fall back to legacy
        // booleans so sellers who haven't been migrated still get charged
        // a reasonable rate. is_vendor + is_premium were the old
        // "enthusiast equivalent" flags before the tier rename.
        if (profile.subscription_tier) {
          sellerTier = String(profile.subscription_tier).toLowerCase();
        } else if (profile.is_vendor || profile.is_premium) {
          sellerTier = 'enthusiast';
        }
      }
    } catch (_) {
      // Profile lookup failed — silently fall back to platform-only charging
      // and the default commission rate. Worst case the order succeeds but
      // seller payout requires manual action.
    }
  }

  const feeRate     = commissionRateFor(sellerTier);
  const platformFee = Math.round(amount * feeRate) + STRIPE_FIXED_FEE_CENTS;
  const feePctLabel = (feeRate * 100).toFixed(0) + '% + $0.30/tx';

  const sessionParams = {
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: cardName || 'Trading Card',
          description: 'PathBinder Marketplace Purchase — ' + feePctLabel + ' platform fee applies',
        },
        unit_amount: amount,
      },
      quantity: 1,
    }],
    metadata: {
      listing_id: listingId,
      buyer_id: user.id,
      seller_id: sellerId || '',
      // Stripe metadata values are stringified — keep the numbers as strings
      // so downstream webhook consumers can parse them unambiguously.
      platform_fee:        String(platformFee),
      platform_fee_pct:    String(feeRate),
      seller_tier:         sellerTier || 'unknown',
      type: 'marketplace_purchase',
      // Track which payment route was used so the webhook can act accordingly.
      payment_route: sellerConnectId ? 'destination_charge' : 'platform_only',
    },
    success_url: successUrl || process.env.NEXT_PUBLIC_SITE_URL + '?payment=success&type=purchase',
    cancel_url: cancelUrl || process.env.NEXT_PUBLIC_SITE_URL + '?payment=cancelled',
  };

  // Destination-charge wiring — only enabled when the seller has finished
  // Connect onboarding. Until Phase 2 ships, this branch never executes and
  // checkout works exactly as before.
  if (sellerConnectId) {
    sessionParams.payment_intent_data = {
      application_fee_amount: platformFee,
      transfer_data: { destination: sellerConnectId },
    };
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch(e) {
    console.error('Stripe error:', e);
    return res.status(500).json({ error: e.message });
  }
};
