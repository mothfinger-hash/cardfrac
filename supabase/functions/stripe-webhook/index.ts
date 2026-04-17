import Stripe from 'npm:stripe@14'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
})

// Service role client — bypasses RLS so webhook can update any row
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return new Response('Missing stripe-signature', { status: 400 })

  // Read raw body for signature verification — must NOT parse as JSON first
  const body = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!
    )
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }

  console.log('Processing Stripe event:', event.type)

  // ── Payment completed ────────────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.CheckoutSession
    const { type, order_id, buyer_id, plan } = session.metadata ?? {}

    // ── Slot purchase (primary or secondary market) ──
    if ((type === 'slot_purchase' || type === 'secondary_purchase') && order_id) {
      const { data: order, error: fetchErr } = await supabase
        .from('pending_checkouts')
        .select('*')
        .eq('id', order_id)
        .single()

      if (fetchErr || !order) {
        console.error('Order not found:', order_id, fetchErr?.message)
        return new Response('Order not found', { status: 400 })
      }

      // Idempotency guard — Stripe can send the same event more than once
      if (order.status === 'completed') {
        console.log('Order already processed, skipping:', order_id)
        return new Response(JSON.stringify({ received: true }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Transfer slot ownership for every item in the order
      for (const item of order.items) {
        const { error: slotErr } = await supabase
          .from('slots')
          .update({ user_id: buyer_id, ask_price: null, trade_open: false })
          .eq('listing_id', item.listingId)
          .eq('idx', Number(item.slotIdx))

        if (slotErr) {
          console.error('Slot update failed:', item.listingId, item.slotIdx, slotErr.message)
          // Continue — don't abort the whole order for one slot error
        }

        await supabase.from('transactions').insert({
          type: 'buy',
          listing_id: item.listingId,
          slot_idx: Number(item.slotIdx),
          user_id: buyer_id,
          amount: Number(item.priceCents) / 100,
          // 2% platform fee on secondary market sales
          fee: type === 'secondary_purchase' ? (Number(item.priceCents) / 100) * 0.02 : 0,
        })
      }

      // Mark order complete
      await supabase
        .from('pending_checkouts')
        .update({ status: 'completed', stripe_session_id: session.id })
        .eq('id', order_id)

      console.log('Order completed successfully:', order_id, 'slots:', order.items.length)
    }

    // ── Membership purchase ──
    if (type === 'membership' && buyer_id) {
      const { error: profileErr } = await supabase
        .from('profiles')
        .update({
          is_premium: true,
          membership_plan: plan ?? 'monthly',
          membership_started_at: new Date().toISOString(),
        })
        .eq('id', buyer_id)

      if (profileErr) {
        console.error('Profile update failed:', buyer_id, profileErr.message)
      } else {
        console.log('Membership activated for user:', buyer_id, 'plan:', plan)
      }
    }
  }

  // ── Subscription cancelled (membership lapsed) ───────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription
    const buyerId = sub.metadata?.buyer_id
    if (buyerId) {
      await supabase
        .from('profiles')
        .update({ is_premium: false, membership_plan: null })
        .eq('id', buyerId)
      console.log('Membership cancelled for user:', buyerId)
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
