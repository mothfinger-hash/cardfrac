// CardFrac — process-buy Edge Function
// Handles slot purchases server-side so fees can't be manipulated in the browser

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // Create a Supabase client with the service role key (bypasses RLS for trusted server ops)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get the calling user from their JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Unauthorized', 401);

    const { data: { user }, error: authError } = await createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!
    ).auth.getUser(authHeader.replace('Bearer ', ''));

    if (authError || !user) return errorResponse('Unauthorized', 401);

    const { listingId, slotIdx } = await req.json();
    if (!listingId || slotIdx === undefined) return errorResponse('Missing listingId or slotIdx');

    // 1. Fetch the listing
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('*')
      .eq('id', listingId)
      .single();

    if (listingError || !listing) return errorResponse('Listing not found');

    // 2. Fetch the slot and verify it's available
    const { data: slot, error: slotError } = await supabase
      .from('slots')
      .select('*')
      .eq('listing_id', listingId)
      .eq('idx', slotIdx)
      .single();

    if (slotError || !slot) return errorResponse('Slot not found');
    if (slot.user_id !== null) return errorResponse('Slot already owned');

    // 3. Calculate price and fee server-side (can't be spoofed)
    const slotPrice = Math.ceil(listing.value / listing.total_slots);

    const { data: profile } = await supabase
      .from('profiles')
      .select('membership_active, referral_discount_used, referred_by')
      .eq('id', user.id)
      .single();

    let feeRate = profile?.membership_active ? 0.01 : 0.02;

    // Apply one-time referral discount
    if (profile?.referred_by && !profile?.referral_discount_used) {
      feeRate = Math.max(0, feeRate - 0.005);
    }

    const fee = Math.round(slotPrice * feeRate);

    // 4. Transfer slot ownership
    const { error: updateError } = await supabase
      .from('slots')
      .update({ user_id: user.id, ask_price: 0, trade_open: false })
      .eq('id', slot.id)
      .is('user_id', null); // extra safety check

    if (updateError) return errorResponse('Failed to claim slot — may have been purchased simultaneously');

    // 5. Log the transaction
    await supabase.from('transactions').insert({
      type: 'buy',
      listing_id: listingId,
      slot_idx: slotIdx,
      user_id: user.id,
      amount: slotPrice,
      fee,
    });

    // 6. Update price history
    const history = listing.price_history || [];
    history.push({ price: slotPrice, ts: new Date().toISOString() });
    await supabase.from('listings').update({ price_history: history }).eq('id', listingId);

    // 7. Burn referral discount after first use
    if (profile?.referred_by && !profile?.referral_discount_used) {
      await supabase.from('profiles').update({ referral_discount_used: true }).eq('id', user.id);
    }

    return successResponse({ slotPrice, fee, message: 'Slot purchased successfully' });

  } catch (err) {
    console.error(err);
    return errorResponse('Internal server error', 500);
  }
});

function successResponse(data: object) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 200,
  });
}

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}
