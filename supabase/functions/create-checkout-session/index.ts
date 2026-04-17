import Stripe from 'npm:stripe@14'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    const buyerId = user.id

    const body = await req.json()
    const { type, items, plan, successUrl, cancelUrl } = body
    // type: 'slot_purchase' | 'secondary_purchase' | 'membership'
    // items: [{ listingId, listingName, slotIdx, priceCents }]
    // plan (membership only): 'monthly' | 'yearly'

    if (type === 'slot_purchase' || type === 'secondary_purchase') {
      if (!items || !items.length) throw new Error('No items in order')

      // Store the pending order so the webhook can process it atomically
      const { data: order, error: orderErr } = await supabase
        .from('pending_checkouts')
        .insert({
          buyer_id: buyerId,
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
            product_data: {
              name: `Slot #${item.slotIdx} — ${item.listingName}`,
            },
            unit_amount: Number(item.priceCents),
          },
          quantity: 1,
        })),
        metadata: {
          type,
          order_id: order.id,
          buyer_id: buyerId,
        },
        success_url: `${successUrl}?payment=success&order_id=${order.id}`,
        cancel_url: `${cancelUrl}?payment=cancelled`,
      })

      // Attach Stripe session ID to the order for idempotency checks
      await supabase
        .from('pending_checkouts')
        .update({ stripe_session_id: session.id })
        .eq('id', order.id)

      return new Response(JSON.stringify({ url: session.url }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })

    } else if (type === 'membership') {
      if (!plan) throw new Error('Missing membership plan')

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'CardFrac Premium',
              description: plan === 'yearly' ? 'Annual plan — best value' : 'Monthly plan',
            },
            unit_amount: plan === 'yearly' ? 9900 : 900,
            recurring: { interval: plan === 'yearly' ? 'year' : 'month' },
          },
          quantity: 1,
        }],
        metadata: { type: 'membership', buyer_id: buyerId, plan },
        // Store buyer_id on subscription so cancellation webhook can find the user
        subscription_data: {
          metadata: { buyer_id: buyerId, plan },
        },
        success_url: `${successUrl}?payment=success&type=membership`,
        cancel_url: `${cancelUrl}?payment=cancelled`,
      })

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
