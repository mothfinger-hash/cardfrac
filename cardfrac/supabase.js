// ============================================================
// CardFrac — Supabase Client
// Replace SUPABASE_URL and SUPABASE_ANON_KEY with your values
// from: Supabase Dashboard → Settings → API
// ============================================================

const SUPABASE_URL  = 'https://xjamytrhxeaynywcwfun.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_HeBrC8k5nKaBmqA9qMn6-Q_YqL8OEBV';

// We load the Supabase JS client from CDN (see index.html)
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


// ============================================================
// AUTH
// ============================================================

async function signUp(email, password, name, username, referralCode) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name, username }
    }
  });
  if (error) throw error;

  // If a referral code was provided, link it after profile is created
  if (referralCode && data.user) {
    const { data: referrer } = await supabase
      .from('profiles')
      .select('id')
      .eq('referral_code', referralCode)
      .single();
    if (referrer) {
      await supabase.from('profiles').update({
        referred_by: referralCode,
        referral_discount_used: false
      }).eq('id', data.user.id);

      await supabase.from('profiles').update({
        referral_count: supabase.rpc('increment', { row_id: referrer.id, field: 'referral_count' })
      }).eq('id', referrer.id);
    }
  }
  return data;
}

async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  return { ...user, ...profile };
}


// ============================================================
// LISTINGS
// ============================================================

async function fetchListings() {
  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function fetchListing(id) {
  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function createListing(listing) {
  const { data, error } = await supabase.from('listings').insert(listing).select().single();
  if (error) throw error;

  // Auto-create all slots for the new listing
  const slotRows = Array.from({ length: listing.total_slots }, (_, i) => ({
    listing_id: data.id,
    idx: i + 1,
    user_id: null,
    ask_price: 0,
    trade_open: false
  }));
  await supabase.from('slots').insert(slotRows);
  return data;
}

async function updateListing(id, updates) {
  const { data, error } = await supabase.from('listings').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}


// ============================================================
// SLOTS
// ============================================================

async function fetchSlots(listingId) {
  const { data, error } = await supabase
    .from('slots')
    .select('*, profiles(name, username, rating_count, rating_total)')
    .eq('listing_id', listingId)
    .order('idx');
  if (error) throw error;
  return data;
}

async function fetchMySlots(userId) {
  const { data, error } = await supabase
    .from('slots')
    .select('*, listings(id, name, grade, game_type, value, total_slots, status)')
    .eq('user_id', userId);
  if (error) throw error;
  return data;
}

async function buySlot(slotId, userId, amount, fee) {
  // Transfer slot ownership
  const { error: slotError } = await supabase
    .from('slots')
    .update({ user_id: userId, ask_price: 0, trade_open: false })
    .eq('id', slotId)
    .is('user_id', null); // Only buy unowned slots

  if (slotError) throw slotError;

  // Log transaction
  const { data: slot } = await supabase.from('slots').select('listing_id, idx').eq('id', slotId).single();
  await logTransaction('buy', slot.listing_id, slot.idx, userId, amount, fee);
}

async function updateSlot(slotId, updates) {
  const { error } = await supabase.from('slots').update(updates).eq('id', slotId);
  if (error) throw error;
}

async function cashoutSlot(slotId, userId, amount, fee) {
  const { data: slot } = await supabase.from('slots').select('listing_id, idx').eq('id', slotId).single();
  await supabase.from('slots').update({ user_id: null, ask_price: 0, trade_open: false }).eq('id', slotId);
  await logTransaction('cashout', slot.listing_id, slot.idx, userId, amount, fee);
}


// ============================================================
// TRANSACTIONS
// ============================================================

async function logTransaction(type, listingId, slotIdx, userId, amount, fee, note = '') {
  const { error } = await supabase.from('transactions').insert({
    type, listing_id: listingId, slot_idx: slotIdx,
    user_id: userId, amount, fee, note
  });
  if (error) console.error('Transaction log error:', error);

  // Update price history on the listing
  const { data: listing } = await supabase.from('listings').select('price_history').eq('id', listingId).single();
  const history = listing?.price_history || [];
  history.push({ price: amount, ts: new Date().toISOString() });
  await supabase.from('listings').update({ price_history: history }).eq('id', listingId);
}

async function fetchTransactions(userId) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*, listings(name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function fetchListingTransactions(listingId) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*, profiles(username)')
    .eq('listing_id', listingId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}


// ============================================================
// TRADE OFFERS
// ============================================================

async function createTradeOffer(fromUserId, toUserId, fromSlots, toSlots, cashTopup, fee) {
  const { data, error } = await supabase.from('trade_offers').insert({
    from_user_id: fromUserId,
    to_user_id: toUserId,
    from_slots: fromSlots,
    to_slots: toSlots,
    cash_topup: cashTopup,
    fee
  }).select().single();
  if (error) throw error;
  return data;
}

async function fetchTradeOffers(userId) {
  const { data, error } = await supabase
    .from('trade_offers')
    .select('*, from_profile:profiles!from_user_id(username, rating_count, rating_total), to_profile:profiles!to_user_id(username, rating_count, rating_total)')
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function acceptTradeOffer(offerId) {
  const { data: offer } = await supabase.from('trade_offers').select('*').eq('id', offerId).single();

  // Swap fromSlots to toUser and toSlots to fromUser
  for (const s of offer.from_slots) {
    await supabase.from('slots')
      .update({ user_id: offer.to_user_id })
      .eq('listing_id', s.listingId).eq('idx', s.idx);
  }
  for (const s of offer.to_slots) {
    await supabase.from('slots')
      .update({ user_id: offer.from_user_id })
      .eq('listing_id', s.listingId).eq('idx', s.idx);
  }

  await supabase.from('trade_offers').update({ status: 'accepted' }).eq('id', offerId);
  await logTransaction('trade', offer.from_slots[0]?.listingId, null, offer.from_user_id, offer.cash_topup || 0, offer.fee);
}

async function declineTradeOffer(offerId) {
  await supabase.from('trade_offers').update({ status: 'declined' }).eq('id', offerId);
}


// ============================================================
// BUYOUT OFFERS
// ============================================================

async function createBuyoutOffer(listingId, fromUserId, amount) {
  const { data, error } = await supabase.from('buyout_offers').insert({
    listing_id: listingId, from_user_id: fromUserId, amount
  }).select().single();
  if (error) throw error;
  return data;
}

async function fetchBuyoutOffers(listingId) {
  const { data, error } = await supabase
    .from('buyout_offers')
    .select('*, profiles(username)')
    .eq('listing_id', listingId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function acceptBuyoutOffer(offerId) {
  const { data: offer } = await supabase.from('buyout_offers').select('*').eq('id', offerId).single();
  // Transfer all slots to buyer
  await supabase.from('slots')
    .update({ user_id: offer.from_user_id, ask_price: 0 })
    .eq('listing_id', offer.listing_id);
  await supabase.from('buyout_offers').update({ status: 'accepted' }).eq('id', offerId);
  await supabase.from('listings').update({ status: 'sold' }).eq('id', offer.listing_id);
  await logTransaction('buyout', offer.listing_id, null, offer.from_user_id, offer.amount, 0);
}


// ============================================================
// IMAGE UPLOAD (Supabase Storage)
// ============================================================

async function uploadCardPhoto(listingId, file) {
  const ext = file.name.split('.').pop();
  const path = `${listingId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('card-photos').upload(path, file);
  if (error) throw error;
  const { data } = supabase.storage.from('card-photos').getPublicUrl(path);
  return data.publicUrl;
}


// ============================================================
// RATINGS
// ============================================================

async function submitRating(targetUserId, stars) {
  const { data: profile } = await supabase.from('profiles').select('rating_count, rating_total').eq('id', targetUserId).single();
  await supabase.from('profiles').update({
    rating_count: (profile.rating_count || 0) + 1,
    rating_total: (profile.rating_total || 0) + stars
  }).eq('id', targetUserId);
}


// ============================================================
// PRICE ALERTS
// ============================================================

async function setPriceAlert(userId, listingId, targetPrice) {
  const { data, error } = await supabase.from('price_alerts').upsert({
    user_id: userId, listing_id: listingId, target_price: targetPrice, triggered: false
  }).select().single();
  if (error) throw error;
  return data;
}

async function fetchMyPriceAlerts(userId) {
  const { data, error } = await supabase
    .from('price_alerts')
    .select('*, listings(name, value, total_slots)')
    .eq('user_id', userId)
    .eq('triggered', false);
  if (error) throw error;
  return data;
}


// ============================================================
// WATCHLIST
// ============================================================

async function toggleWatchlist(userId, listingId) {
  const { data: profile } = await supabase.from('profiles').select('watchlist').eq('id', userId).single();
  let watchlist = profile.watchlist || [];
  if (watchlist.includes(listingId)) {
    watchlist = watchlist.filter(id => id !== listingId);
  } else {
    watchlist.push(listingId);
  }
  await supabase.from('profiles').update({ watchlist }).eq('id', userId);
  return watchlist;
}


// ============================================================
// VOTE TO SELL
// ============================================================

async function voteToSell(listingId, userId) {
  const { data: listing } = await supabase.from('listings').select('sell_votes').eq('id', listingId).single();
  const votes = listing.sell_votes || [];
  if (!votes.includes(userId)) {
    votes.push(userId);
    await supabase.from('listings').update({ sell_votes: votes }).eq('id', listingId);
  }
  return votes;
}
