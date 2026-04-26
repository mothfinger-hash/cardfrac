import Stripe from 'npm:stripe@14'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Stripe Price ID map ───────────────────────────────────────────────────────
// Store these in Supabase Edge Function secrets (Dashboard → Edge Functions → Secrets):
//   STRIPE_PRICE_COLLECTOR_MONTHLY
//   STRIPE_PRICE_VENDOR_MONTHLY
//   STRIPE_PRICE_VENDOR_ANNUAL
//   STRIPE_PRICE_SHOP_MONTHLY
//   STRIPE_PRICE_SHOP_ANNUAL
function getPriceId(tier: string, billing: string): string {
  const map: Record<string, string> = {
    'collector_monthly': Deno.env.get('STRIPE_PRICE_COLLECTOR_MONTHLY') || '',
    'vendor_monthly':    Deno.env.get('STRIPE_PRICE_VENDOR_MONTHLY')    || '',
    'vendor_annual':     Deno.env.get('STRIPE_PRICE_VENDOR_ANNUAL')     || '',
    'shop_monthly':      Deno.env.get('STRIPE_PRICE_SHOP_MONTHLY')      || '',
    'shop_annual':       Deno.env.get('STRIPE_PRICE_SHOP_ANNUAL')       || '',
  }
  const key = `${tier}_${billing}`
  const priceId = map[key]
  if (!priceId) throw new Error(`No Stripe Price ID configured for ${key}`)
  return priceId
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
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
    const { type, items, tier, billing, successUrl, cancelUrl } = body
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
        .select('stripe_customer_id, email')
        .eq('id', userId)
        .single()

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

      // Re-use existing Stripe customer if we have one
      if (profile?.stripe_customer_id) {
        sessionParams.customer = profile.stripe_customer_id
      } else if (profile?.email) {
        sessionParams.customer_email = profile.email
      }

      const session = await stripe.checkout.sessions.create(sessionParams)

      return new Response(JSON.stringify({ url: session.url }), {
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
