// CardFrac — process-cashout Edge Function
// Validates ownership and processes slot cashouts server-side

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Unauthorized', 401);

    const { data: { user }, error: authError } = await createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!
    ).auth.getUser(authHeader.replace('Bearer ', ''));

    if (authError || !user) return errorResponse('Unauthorized', 401);

    const { listingId, slotIdx } = await req.json();
    if (!listingId || slotIdx === undefined) return errorResponse('Missing listingId or slotIdx');

    // 1. Fetch the listing and slot
    const { data: listing } = await supabase
      .from('listings')
      .select('*')
      .eq('id', listingId)
      .single();

    if (!listing) return errorResponse('Listing not found');

    const { data: slot } = await supabase
      .from('slots')
      .select('*')
      .eq('listing_id', listingId)
      .eq('idx', slotIdx)
      .single();

    if (!slot) return errorResponse('Slot not found');

    // 2. Verify the calling user owns this slot
    if (slot.user_id !== user.id) return errorResponse('You do not own this slot');

    // 3. Calculate cashout amount and fee server-side
    const slotValue = Math.ceil(listing.value / listing.total_slots);

    const { data: profile } = await supabase
      .from('profiles')
      .select('membership_active')
      .eq('id', user.id)
      .single();

    const feeRate = profile?.membership_active ? 0.01 : 0.02;
    const fee = Math.round(slotValue * feeRate);
    const cashoutAmount = slotValue - fee;

    // 4. Release the slot
    await supabase.from('slots')
      .update({ user_id: null, ask_price: 0, trade_open: false })
      .eq('id', slot.id);

    // 5. Log the transaction
    await supabase.from('transactions').insert({
      type: 'cashout',
      listing_id: listingId,
      slot_idx: slotIdx,
      user_id: user.id,
      amount: cashoutAmount,
      fee,
    });

    // 6. Update price history
    const history = listing.price_history || [];
    history.push({ price: slotValue, ts: new Date().toISOString() });
    await supabase.from('listings').update({ price_history: history }).eq('id', listingId);

    return successResponse({ cashoutAmount, fee, message: 'Cashout successful' });

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
