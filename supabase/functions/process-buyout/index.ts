// CardFrac — process-buyout Edge Function
// Admin-only: accepts a buyout offer, transfers all slots, marks card sold

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

    // Verify the calling user is an admin
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single();

    if (!profile?.is_admin) return errorResponse('Admin access required', 403);

    const { offerId } = await req.json();
    if (!offerId) return errorResponse('Missing offerId');

    // 1. Fetch the buyout offer
    const { data: offer, error: offerError } = await supabase
      .from('buyout_offers')
      .select('*')
      .eq('id', offerId)
      .single();

    if (offerError || !offer) return errorResponse('Buyout offer not found');
    if (offer.status !== 'pending') return errorResponse('Offer is no longer pending');

    // 2. Transfer ALL slots to the buyer
    const { error: slotsError } = await supabase
      .from('slots')
      .update({ user_id: offer.from_user_id, ask_price: 0, trade_open: false })
      .eq('listing_id', offer.listing_id);

    if (slotsError) return errorResponse('Failed to transfer slots');

    // 3. Mark the listing as sold
    await supabase.from('listings')
      .update({ status: 'sold' })
      .eq('id', offer.listing_id);

    // 4. Mark the offer as accepted
    await supabase.from('buyout_offers')
      .update({ status: 'accepted' })
      .eq('id', offerId);

    // 5. Decline any other pending buyout offers for this listing
    await supabase.from('buyout_offers')
      .update({ status: 'declined' })
      .eq('listing_id', offer.listing_id)
      .eq('status', 'pending')
      .neq('id', offerId);

    // 6. Log the transaction
    await supabase.from('transactions').insert({
      type: 'buyout',
      listing_id: offer.listing_id,
      slot_idx: null,
      user_id: offer.from_user_id,
      amount: offer.amount,
      fee: 0,
      note: `Full buyout accepted by admin`,
    });

    return successResponse({ message: 'Buyout accepted — all slots transferred' });

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
