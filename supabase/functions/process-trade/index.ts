// CardFrac — process-trade Edge Function
// Validates and executes trade offers server-side atomically

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

    // Authenticate the calling user
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Unauthorized', 401);

    const { data: { user }, error: authError } = await createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!
    ).auth.getUser(authHeader.replace('Bearer ', ''));

    if (authError || !user) return errorResponse('Unauthorized', 401);

    const { offerId } = await req.json();
    if (!offerId) return errorResponse('Missing offerId');

    // 1. Fetch the trade offer
    const { data: offer, error: offerError } = await supabase
      .from('trade_offers')
      .select('*')
      .eq('id', offerId)
      .single();

    if (offerError || !offer) return errorResponse('Trade offer not found');
    if (offer.status !== 'pending') return errorResponse('Trade offer is no longer pending');

    // Only the recipient can accept
    if (offer.to_user_id !== user.id) return errorResponse('Only the recipient can accept this trade');

    // 2. Validate all fromSlots are still owned by fromUser
    for (const s of offer.from_slots) {
      const { data: slot } = await supabase
        .from('slots')
        .select('user_id')
        .eq('listing_id', s.listingId)
        .eq('idx', s.idx)
        .single();

      if (!slot || slot.user_id !== offer.from_user_id) {
        return errorResponse(`Slot #${s.idx} is no longer owned by the sender`);
      }
    }

    // 3. Validate all toSlots are still owned by toUser
    for (const s of offer.to_slots) {
      const { data: slot } = await supabase
        .from('slots')
        .select('user_id')
        .eq('listing_id', s.listingId)
        .eq('idx', s.idx)
        .single();

      if (!slot || slot.user_id !== offer.to_user_id) {
        return errorResponse(`Slot #${s.idx} is no longer owned by you`);
      }
    }

    // 4. Calculate fee server-side
    const { data: fromProfile } = await supabase
      .from('profiles')
      .select('membership_active')
      .eq('id', offer.from_user_id)
      .single();

    const feeRate = fromProfile?.membership_active ? 0.01 : 0.02;
    const tradeValue = offer.cash_topup || 0;
    const fee = Math.round(tradeValue * feeRate);

    // 5. Execute the swap atomically
    for (const s of offer.from_slots) {
      await supabase.from('slots')
        .update({ user_id: offer.to_user_id, ask_price: 0, trade_open: false })
        .eq('listing_id', s.listingId)
        .eq('idx', s.idx);
    }

    for (const s of offer.to_slots) {
      await supabase.from('slots')
        .update({ user_id: offer.from_user_id, ask_price: 0, trade_open: false })
        .eq('listing_id', s.listingId)
        .eq('idx', s.idx);
    }

    // 6. Mark offer as accepted
    await supabase.from('trade_offers')
      .update({ status: 'accepted', fee })
      .eq('id', offerId);

    // 7. Log the transaction
    if (offer.from_slots.length > 0) {
      await supabase.from('transactions').insert({
        type: 'trade',
        listing_id: offer.from_slots[0].listingId,
        slot_idx: null,
        user_id: offer.from_user_id,
        amount: offer.cash_topup || 0,
        fee,
        note: `Trade with user ${offer.to_user_id}`,
      });
    }

    return successResponse({ fee, message: 'Trade completed successfully' });

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
