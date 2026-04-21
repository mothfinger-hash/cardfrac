// api/update-prices.js
// Fetches market prices from TCGPlayer, eBay, and PSA pages and updates
// listing values in Supabase.
//
// Triggered by:
//   1. Vercel cron job (daily at 3 AM — see vercel.json)
//   2. Admin panel "Refresh Prices" button (sends Supabase JWT)
//
// Required environment variables (set in Vercel dashboard):
//   SUPABASE_URL          — your project URL
//   SUPABASE_SERVICE_KEY  — service role key (Settings → API → service_role)
//   CRON_SECRET           — any random string, set in Vercel + paste in your env

import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service key bypasses RLS for writes
);

// ── Price parsers ────────────────────────────────────────────────────────────

function extractNumber(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : Math.round(n);
}

async function fetchPriceFromUrl(url) {
  if (!url) return null;

  let html;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`[update-prices] fetch error for ${url}:`, err.message);
    return null;
  }

  // ── TCGPlayer ──────────────────────────────────────────────────────────────
  if (url.includes('tcgplayer.com')) {
    // Next.js embeds full page state as __NEXT_DATA__ JSON
    const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextMatch) {
      try {
        const data = JSON.parse(nextMatch[1]);
        // Navigate the tree — structure varies by page type
        const pp = data?.props?.pageProps;
        const price =
          pp?.product?.marketPrice ??
          pp?.listing?.results?.[0]?.marketPrice ??
          pp?.listingResults?.results?.[0]?.marketPrice ??
          pp?.productListing?.marketPrice;
        if (price != null) return Math.round(Number(price));
      } catch (_) {}
    }
    // Fallback regex patterns
    const patterns = [
      /"marketPrice"\s*:\s*([\d.]+)/,
      /Market Price[^$\d]*\$([\d,]+\.?\d{0,2})/i,
      /"price"\s*:\s*"([\d.]+)"/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return extractNumber(m[1]);
    }
  }

  // ── eBay ───────────────────────────────────────────────────────────────────
  if (url.includes('ebay.com')) {
    // Sold/completed listing search page — grab first result price
    const soldPrices = [...html.matchAll(/class="s-item__price"[^>]*>([\s\S]*?)<\/span>/g)];
    for (const m of soldPrices) {
      const raw = m[1].replace(/<[^>]+>/g, '').trim();
      // Skip ranges like "$10.00 to $20.00"
      if (raw.includes(' to ')) continue;
      const price = extractNumber(raw);
      if (price && price > 0) return price;
    }
    // Single completed listing page
    const patterns = [
      /"price"\s*:\s*\{"value"\s*:\s*"([\d.]+)"/,
      /class="x-price-primary"[^>]*>[\s\S]*?\$([\d,]+\.?\d{0,2})/,
      /"amount"\s*:\s*"([\d.]+)"/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return extractNumber(m[1]);
    }
  }

  // ── PSA Price Guide ────────────────────────────────────────────────────────
  if (url.includes('psacard.com')) {
    const patterns = [
      /"avg_price"\s*:\s*([\d.]+)/i,
      /Average Sale Price[^$\d]*\$([\d,]+\.?\d{0,2})/i,
      /class="price-guide-price"[^>]*>\s*\$([\d,]+\.?\d{0,2})/i,
      /\$([\d,]+\.?\d{0,2})/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        const price = extractNumber(m[1]);
        if (price && price > 0) return price;
      }
    }
  }

  // ── Generic fallback: JSON-LD structured data ──────────────────────────────
  const jsonLdBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const price =
        data?.offers?.price ??
        data?.offers?.[0]?.price ??
        data?.price;
      if (price != null) return Math.round(Number(price));
    } catch (_) {}
  }

  return null;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // ── Auth: accept Vercel cron secret OR a valid Supabase admin JWT ──────────
  const cronSecret = process.env.CRON_SECRET;
  const vercelCronHeader = req.headers['x-vercel-cron-secret'];   // set by Vercel
  const authHeader = req.headers['authorization'];

  let authed = false;

  if (cronSecret && vercelCronHeader === cronSecret) {
    authed = true; // Called by Vercel cron
  } else if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const { data: { user }, error } = await sb.auth.getUser(token);
      if (!error && user) {
        const { data: profile } = await sb
          .from('profiles')
          .select('is_admin')
          .eq('id', user.id)
          .maybeSingle();
        if (profile?.is_admin) authed = true;
      }
    } catch (_) {}
  }

  if (!authed) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Fetch all listings that have a price_source_url set ───────────────────
  const { data: listings, error: fetchErr } = await sb
    .from('listings')
    .select('id, name, value, price_source_url')
    .not('price_source_url', 'is', null)
    .neq('price_source_url', '');

  if (fetchErr) {
    console.error('[update-prices] Supabase fetch error:', fetchErr);
    return res.status(500).json({ error: fetchErr.message });
  }

  if (!listings?.length) {
    return res.status(200).json({ message: 'No listings with a price source URL.', updated: 0 });
  }

  // ── Process each listing ─────────────────────────────────────────────────
  const results = [];
  const errors = [];

  for (const listing of listings) {
    const newPrice = await fetchPriceFromUrl(listing.price_source_url);

    if (newPrice == null) {
      errors.push({ name: listing.name, url: listing.price_source_url, reason: 'Could not parse price' });
      continue;
    }

    if (newPrice === listing.value) {
      results.push({ name: listing.name, status: 'unchanged', price: newPrice });
      continue;
    }

    const { error: updateErr } = await sb
      .from('listings')
      .update({ value: newPrice })
      .eq('id', listing.id);

    if (updateErr) {
      errors.push({ name: listing.name, reason: updateErr.message });
    } else {
      console.log(`[update-prices] ${listing.name}: $${listing.value} → $${newPrice}`);
      results.push({ name: listing.name, status: 'updated', old: listing.value, new: newPrice });
    }
  }

  return res.status(200).json({
    updated: results.filter(r => r.status === 'updated').length,
    unchanged: results.filter(r => r.status === 'unchanged').length,
    errors: errors.length,
    results,
    errors,
  });
}
