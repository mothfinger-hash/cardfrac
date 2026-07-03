import Stripe from 'npm:stripe@14'
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Stripe mode + secret selection ─────────────────────────────────────────
// Flip STRIPE_MODE between 'test' and 'live' to switch the WHOLE app without
// re-entering anything. Store both sets of secrets side by side:
//   test → <NAME>_TEST   live → <NAME>_LIVE   (legacy unsuffixed = treated as live)
// With STRIPE_MODE unset, the legacy unsuffixed names are used (back-compat).
//   Keys:    STRIPE_SECRET_KEY[_TEST|_LIVE]
//   Webhook: STRIPE_WEBHOOK_SECRET[_TEST|_LIVE]   (used by stripe-webhook)
//   Prices:  STRIPE_PRICE_<TIER>_<BILLING>[_TEST|_LIVE]
//            tiers: collector|enthusiast|vendor|shop  billing: monthly|annual
//            (collector $5/mo, enthusiast $10/mo, vendor $50/mo, shop $150/mo)
function envForMode(base: string): string | undefined {
  const m = (Deno.env.get('STRIPE_MODE') || '').trim().toLowerCase()
  if (m === 'test') return Deno.env.get(`${base}_TEST`)                        // test: strict — never falls back to live
  if (m === 'live') return Deno.env.get(`${base}_LIVE`) ?? Deno.env.get(base)  // live: _LIVE or legacy unsuffixed
  return Deno.env.get(base)                                                    // no mode set: legacy unsuffixed
}

function getPriceId(tier: string, billing: string): string {
  const base = `STRIPE_PRICE_${tier.toUpperCase()}_${billing.toUpperCase()}`
  const priceId = envForMode(base)
  if (!priceId) throw new Error(`No Stripe Price ID for ${tier}_${billing} (set ${base}[_TEST|_LIVE], STRIPE_MODE=${Deno.env.get('STRIPE_MODE') || 'unset'})`)
  return priceId
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Build the Stripe client per-request (NOT at module load) so a missing
    // STRIPE_SECRET_KEY surfaces as a clean JSON error instead of crashing the
    // function on boot — which would make even the OPTIONS preflight fail and
    // show up in the browser as a confusing CORS error.
    const stripeKey = envForMode('STRIPE_SECRET_KEY')
    if (!stripeKey) throw new Error(`STRIPE_SECRET_KEY not set for STRIPE_MODE=${Deno.env.get('STRIPE_MODE') || 'unset'} (set STRIPE_SECRET_KEY[_TEST|_LIVE])`)
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' })

    // Authenticate via JWT
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing auth token')

    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authErr || !user) throw new Error('Unauthorized')
    const userId = user.id

    const body = await req.json()
    const { type, items, tier, billing, successUrl, cancelUrl, promo } = body
    // type: 'slot_purchase' | 'secondary_purchase' | 'subscription'
    // tier (subscription only): 'collector' | 'vendor' | 'shop'
    // billing (subscription only): 'monthly' | 'annual'

    // ── Marketplace slot / secondary purchase ─────────────────────────────────
    if (type === 'slot_purchase' || type === 'secondary_purchase') {
      if (!items || !items.length) throw new Error('No items in order')

      const { data: order, error: orderErr } = await supabase
        .from('pending_checkouts')
        .insert({
          buyer_id: userId,
          type,
          items,
          total_cents: items.reduce((sum: number, i: any) => sum + Number(i.priceCents), 0),
          status: 'pending',
        })
        .select('id')
        .single()

      if (orderErr) throw new Error('Failed to create order: ' + orderErr.message)

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: items.map((item: any) => ({
          price_data: {
            currency: 'usd',
            product_data: { name: `Slot #${item.slotIdx} — ${item.listingName}` },
            unit_amount: Number(item.priceCents),
          },
          quantity: 1,
        })),
        metadata: { type, order_id: order.id, buyer_id: userId },
        success_url: `${successUrl}?payment=success&order_id=${order.id}`,
        cancel_url:  `${cancelUrl}?payment=cancelled`,
      })

      await supabase
        .from('pending_checkouts')
        .update({ stripe_session_id: session.id })
        .eq('id', order.id)

      return new Response(JSON.stringify({ url: session.url }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })

    // ── Subscription tier upgrade ─────────────────────────────────────────────
    } else if (type === 'subscription') {
      if (!tier || !billing) throw new Error('Missing tier or billing interval')

      const priceId = getPriceId(tier, billing)

      // Check if the user already has a Stripe customer ID so we can attach
      // the new subscription to their existing customer record
      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id, email, subscription_tier')
        .eq('id', userId)
        .single()

      // Validate the stored Stripe customer against the CURRENT mode. A
      // customer created in test mode doesn't exist in live (and vice versa),
      // and a customer can be deleted — either case makes reusing the id throw
      // "No such customer". If it's not retrievable here, forget it and create
      // a fresh customer so checkout self-heals instead of hard-failing.
      let customerId = profile?.stripe_customer_id || null
      if (customerId) {
        try {
          const cust = await stripe.customers.retrieve(customerId)
          if ((cust as any)?.deleted) customerId = null
        } catch (_) {
          customerId = null
        }
        if (!customerId) {
          await supabase.from('profiles')
            .update({ stripe_customer_id: null, stripe_subscription_id: null })
            .eq('id', userId)
        }
      }

      // ── Tier change with proration ─────────────────────────────────────
      // If the user already has an active subscription, we should UPDATE it
      // (with proration_behavior='create_prorations') rather than create a
      // new one. Stripe automatically credits the unused portion of the
      // current period and invoices the difference for the new price.
      //
      // Example: User paid $239.99 for an annual Enthusiast plan on day 1
      // and upgrades to Vendor ($719.99/yr) on day 90. Stripe credits
      // (275/365) × $239.99 = $180.81 of unused enthusiast time, then
      // invoices (275/365) × $719.99 − $180.81 = $361.66 for the rest of
      // the year on Vendor. The user lands exactly at the new tier with
      // no double-billing or lost time.
      //
      // For downgrades we use proration_behavior='none' instead so the
      // user keeps their current tier through the end of the paid period,
      // then drops to the new tier at the next renewal — matches what the
      // user asked for ("membership stays true for as long as the
      // original tier sub is active").
      if (customerId) {
        const existingSubs = await stripe.subscriptions.list({
          customer: customerId,
          status: 'active',
          limit: 5,
        })
        const liveSub = existingSubs.data.find(s => s.status === 'active' || s.status === 'trialing')
        if (liveSub) {
          // Map tier ordering to detect upgrade vs downgrade.
          const TIER_RANK: Record<string, number> = {
            free: 0, collector: 1, enthusiast: 2, vendor: 3, shop: 4,
          }
          // Use the PROFILE tier (the app's source of truth) to decide
          // upgrade vs downgrade — not the Stripe sub's metadata, which can be
          // stale or belong to a leftover/duplicate subscription. Fall back to
          // the sub metadata only if the profile tier is missing.
          const currentTier = ((profile?.subscription_tier || liveSub.metadata?.tier || '') as string).toLowerCase()
          const isUpgrade = (TIER_RANK[tier] || 0) > (TIER_RANK[currentTier] || 0)

          const updated = await stripe.subscriptions.update(liveSub.id, {
            items: [{ id: liveSub.items.data[0].id, price: priceId }],
            // Upgrades prorate immediately (credit + invoice the diff).
            // Downgrades hold the current tier until period end.
            proration_behavior: isUpgrade ? 'create_prorations' : 'none',
            metadata: { type: 'subscription', tier, user_id: userId },
          })

          // Upgrades take effect immediately, so write the new tier NOW
          // rather than waiting on the async customer.subscription.updated
          // webhook — otherwise the client's refreshProfile() can read the
          // old tier and the listing cap won't lift right after upgrading.
          // Downgrades keep the current tier until period end, so we leave
          // those for the webhook to apply at renewal.
          if (isUpgrade) {
            await supabase.from('profiles').update({
              subscription_tier: tier,
              stripe_subscription_id: updated.id,
              subscription_updated_at: new Date().toISOString(),
            }).eq('id', userId)
          }

          // Webhook also picks up subscription.updated and re-syncs (backup).
          return new Response(JSON.stringify({
            url: null,
            updated: true,
            mode: isUpgrade ? 'upgrade_prorated' : 'downgrade_at_period_end',
            subscription_id: updated.id,
            current_period_end: updated.current_period_end,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        }
      }

      // ── No existing subscription → standard Checkout flow ──────────────
      const sessionParams: any = {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        // Pass tier + user_id in metadata so the webhook can update profiles
        metadata: {
          type:    'subscription',
          tier,
          user_id: userId,
        },
        // Also attach to the subscription object itself (needed for
        // subscription.updated / subscription.deleted events which don't
        // carry session metadata)
        subscription_data: {
          metadata: { type: 'subscription', tier, user_id: userId },
        },
        success_url: `${successUrl}?payment=success&type=subscription&tier=${tier}`,
        cancel_url:  `${cancelUrl}?payment=cancelled`,
      }

      // Welcome promo: apply the server-owned first-month coupon (Stripe coupon
      // with duration=once) when the client flags it. NEW subscriptions only —
      // the existing-subscription proration path above returns before here.
      // Override the coupon id via the STRIPE_WELCOME_COUPON env var if needed.
      if (promo) {
        sessionParams.discounts = [{ coupon: Deno.env.get('STRIPE_WELCOME_COUPON') || 'ukgWK5jy' }]
      }

      // Re-use existing Stripe customer if we have a valid one (validated
      // against the current mode above); otherwise let Checkout create one.
      if (customerId) {
        sessionParams.customer = customerId
      } else if (profile?.email) {
        sessionParams.customer_email = profile.email
      }

      const session = await stripe.checkout.sessions.create(sessionParams)

      return new Response(JSON.stringify({ url: session.url }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })

    // ── Stripe billing portal (manage payment method / invoices / cancel) ─────
    // Requires the Customer Portal to be enabled in the Stripe Dashboard
    // (Settings → Billing → Customer portal). Cancel behavior (at period end)
    // is configured there, matching the "cancel anytime" account-settings copy.
    } else if (type === 'portal') {
      const { data: portalProfile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', userId)
        .single()
      const portalCustomer = portalProfile?.stripe_customer_id
      if (!portalCustomer) throw new Error('No billing account for this user')
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: portalCustomer,
        return_url: body.returnUrl || successUrl || 'https://pathbinder.gg/',
      })
      return new Response(JSON.stringify({ url: portalSession.url }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    throw new Error('Unknown payment type: ' + type)

  } catch (err: any) {
    console.error('create-checkout-session error:', err.message)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
