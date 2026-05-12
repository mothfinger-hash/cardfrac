// api/marketplace-checkout.js
// Creates a Stripe Checkout session for a marketplace card purchase.
//
// PAYMENT MODEL (post-escrow refactor):
//   - Sellers receive funds directly on Stripe's normal payout schedule
//   - PathBinder retains a 5% platform fee via application_fee_amount
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

const PLATFORM_FEE_PCT = 0.05; // 5%

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

  const platformFee = Math.round(amount * PLATFORM_FEE_PCT);

  // Look up the seller's Stripe Connect account id (Phase 2 onboarding column).
  // If present and not empty, route funds directly via destination charge.
  let sellerConnectId = null;
  if (sellerId) {
    try {
      const { data: profile } = await sb
        .from('profiles')
        .select('stripe_connect_account_id')
        .eq('id', sellerId)
        .maybeSingle();
      if (profile && profile.stripe_connect_account_id) {
        sellerConnectId = profile.stripe_connect_account_id;
      }
    } catch (_) {
      // Profile lookup failed — silently fall back to platform-only charging.
      // Worst case the order succeeds but seller payout requires manual action.
    }
  }

  const sessionParams = {
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: cardName || 'Trading Card',
          description: 'PathBinder Marketplace Purchase — 5% platform fee applies',
        },
        unit_amount: amount,
      },
      quantity: 1,
    }],
    metadata: {
      listing_id: listingId,
      buyer_id: user.id,
      seller_id: sellerId || '',
      platform_fee: platformFee,
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
