// api/lookup-price.js
// Auto-lookup market price from PriceCharting when a seller creates a listing.
// Called from the "List Card" modal on price blur.
//
// POST body: { name: string, condition: string }
// Returns:   { price: number | null }

const https = require('https');

function extractNumber(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/[^0-9.]/g, ''));
  return isNaN(n) || n <= 0 ? null : n;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CardFrac/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Map condition to PriceCharting grade key
function conditionToKey(condition) {
  const c = (condition || 'NM').toLowerCase();
  if (c === 'nm' || c === 'near mint') return 'id="used_price"';  // ungraded NM
  if (c === 'lp') return 'id="used_price"';
  if (c === 'hp') return 'id="used_price"';
  return 'id="used_price"'; // fallback — ungraded
}

// Build a PriceCharting search URL from card name
function buildSearchUrl(name) {
  const query = encodeURIComponent(name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));
  return `https://www.pricecharting.com/search-products?q=${encodeURIComponent(name)}&type=prices`;
}

async function lookupFromPriceCharting(name, condition) {
  try {
    // Strategy 1: direct URL guess
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const gameGuess = name.toLowerCase().includes('pikachu') || name.toLowerCase().includes('charizard') || name.toLowerCase().includes('mewtwo') ? 'pokemon' : 'pokemon';
    const directUrl = `https://www.pricecharting.com/game/${gameGuess}/${slug}`;

    let html = await fetchUrl(directUrl).catch(() => null);

    // Strategy 2: search page
    if (!html || html.length < 1000) {
      const searchUrl = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(name)}&type=prices`;
      html = await fetchUrl(searchUrl).catch(() => null);
      if (!html) return null;

      // Extract first result URL
      const match = html.match(/href="(\/game\/[^"]+)"/);
      if (match) {
        html = await fetchUrl('https://www.pricecharting.com' + match[1]).catch(() => null);
      }
    }

    if (!html) return null;

    // Parse price: try JSON-LD first, then element IDs
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1]);
        if (ld.offers?.price) return parseFloat(ld.offers.price);
      } catch(e) {}
    }

    // Try #used_price element
    const usedMatch = html.match(/id="used_price"[^>]*>[\s$]*([0-9,]+\.?[0-9]*)/);
    if (usedMatch) {
      const price = extractNumber(usedMatch[1]);
      if (price && price > 0.5) return price;
    }

    // Try completed_auction_price
    const auctionMatch = html.match(/completed[_-]auction[_-]price[^>]*>[\s$]*([0-9,]+\.?[0-9]*)/i);
    if (auctionMatch) {
      const price = extractNumber(auctionMatch[1]);
      if (price && price > 0.5) return price;
    }

    return null;
  } catch(e) {
    console.error('PriceCharting lookup error:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, condition } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const price = await lookupFromPriceCharting(name, condition || 'NM');
    return res.status(200).json({ price: price || null, source: price ? 'pricecharting' : null });
  } catch(e) {
    return res.status(200).json({ price: null, error: e.message });
  }
};
