// api/lookup-price.js
// Lookup market price from PriceCharting by card name OR a direct URL.
//
// POST body: { name: string, condition?: string, url?: string }
//   - If `url` is provided it is fetched directly and parsed (most reliable)
//   - If only `name` is provided we attempt a slug guess + search fallback
// Returns: { price: number | null, source: string | null }
//
// ─────────────────────────────────────────────────────────────────────────────
// PRE-LAUNCH UPGRADE: Switch to the official PriceCharting API
// ─────────────────────────────────────────────────────────────────────────────
// Current approach scrapes HTML which is fragile and can return wrong cards.
// The official API (https://www.pricecharting.com/api/) returns clean JSON
// with exact per-condition prices and eliminates all parsing guesswork.
//
// Migration plan:
//   1. Obtain a PriceCharting API key (free tier available at pricecharting.com)
//   2. Store as PRICECHARTING_API_KEY in Vercel environment variables
//   3. Replace lookupFromName() with:
//        GET /api/products?q={name}  → pick best match by name similarity
//        GET /api/product?id={id}    → returns { "ungraded-price", "grade-10-price", ... }
//   4. Prices come back in cents — divide by 100 (same as current logic)
//   5. Remove all HTML fetch / parse code below
//
// This would also enable caching product IDs in Supabase so repeat lookups
// for the same card skip the search step entirely.
// ─────────────────────────────────────────────────────────────────────────────

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
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
    req.setTimeout(9000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Map grade string → PriceCharting element ID
function gradeToId(grade) {
  if (!grade) return 'used_price';
  const g = grade.toLowerCase();
  if (g.includes('10'))  return 'grade_10_price';
  if (g.includes('9.5')) return 'grade_9_5_price';
  if (g.includes('9'))   return 'grade_9_price';
  if (g.includes('8'))   return 'grade_8_price';
  if (g.includes('7'))   return 'grade_7_price';
  if (g.includes('ungraded') || g.includes('raw') || g.includes('nm') || g.includes('lp')) return 'used_price';
  return 'used_price';
}

// Map grade → ordered list of PriceCharting JSON keys to check (cents-based)
function gradeCandidateKeys(grade) {
  if (!grade) return ['ungraded', 'loose', 'used'];
  const g = grade.toLowerCase();
  if (g.includes('10'))  return ['grade_10',  'ungraded'];
  if (g.includes('9.5')) return ['grade_9_5', 'ungraded'];
  if (g.includes('9'))   return ['grade_9',   'ungraded'];
  if (g.includes('8'))   return ['grade_8',   'ungraded'];
  if (g.includes('7'))   return ['grade_7',   'ungraded'];
  // raw / ungraded / nm / lp — never fall through to a graded price
  return ['ungraded', 'loose', 'used'];
}

// Parse a price from PriceCharting HTML given a grade
function parsePriceChartingHtml(html, grade) {
  // 1. Embedded JS price object (most reliable — pricecharting stores cents)
  const jsonMatch = html.match(/var\s+prices\s*=\s*(\{[\s\S]*?\});/) ||
                    html.match(/"prices"\s*:\s*(\{[\s\S]*?\})/);
  if (jsonMatch) {
    try {
      const prices = JSON.parse(jsonMatch[1]);
      const candidates = gradeCandidateKeys(grade);
      for (const k of candidates) {
        // PriceCharting stores prices as integer cents — divide by 100
        const val = prices[k] ?? prices[k + '_price'];
        if (val != null) {
          const n = parseFloat((Number(val) / 100).toFixed(2));
          if (n > 0) return n;
        }
      }
    } catch (_) {}
  }

  // 2. Element ID patterns (HTML scrape fallback)
  // Build id list that matches the grade — raw cards should NOT fall to grade_10_price
  const isRaw = !grade || /raw|ungraded|nm|lp/i.test(grade);
  const idOrder = isRaw
    ? [gradeToId(grade), 'used_price']          // raw: never try grade_10
    : [gradeToId(grade), 'used_price'];         // graded: already specific
  for (const id of idOrder) {
    const patterns = [
      new RegExp(`id="${id}"[^>]*>[^<$]*\\$?([0-9,]+\\.?[0-9]*)`, 'i'),
      new RegExp(`id="${id.replace('_price', '')}"[^>]*>[^<$]*\\$?([0-9,]+\\.?[0-9]*)`, 'i'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        const price = extractNumber(m[1]);
        if (price && price > 0) return price;  // allow sub-$0.50 cards
      }
    }
  }

  // 3. JSON-LD structured data
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld.offers?.price) return parseFloat(ld.offers.price);
    } catch (_) {}
  }

  // 4. Last resort: dollar figure near ungraded/raw price labels
  const fallback = html.match(/(?:ungraded|near.?mint|used)[^$\d]{0,60}\$([0-9,]+\.?[0-9]*)/i);
  if (fallback) {
    const price = extractNumber(fallback[1]);
    if (price && price > 0) return price;  // allow cheap cards
  }

  return null;
}

// Fetch a known URL directly and parse price
async function lookupFromUrl(url, grade) {
  try {
    const html = await fetchUrl(url);
    if (!html || html.length < 500) return null;
    if (url.includes('pricecharting.com')) return parsePriceChartingHtml(html, grade);

    // TCGPlayer — __NEXT_DATA__ JSON
    if (url.includes('tcgplayer.com')) {
      const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (nextMatch) {
        try {
          const data = JSON.parse(nextMatch[1]);
          const pp = data?.props?.pageProps;
          const price = pp?.product?.marketPrice ?? pp?.listing?.results?.[0]?.marketPrice;
          if (price != null) return Math.round(Number(price));
        } catch (_) {}
      }
      const m = html.match(/"marketPrice"\s*:\s*([\d.]+)/);
      if (m) return extractNumber(m[1]);
    }

    // Generic JSON-LD
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1]);
        const price = ld.offers?.price ?? ld.offers?.[0]?.price;
        if (price != null) return parseFloat(price);
      } catch (_) {}
    }

    return null;
  } catch (e) {
    console.error('[lookup-price] URL fetch error:', e.message);
    return null;
  }
}

// Name-based search: slug guess → search page fallback
async function lookupFromName(name, grade) {
  try {
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const directUrl = `https://www.pricecharting.com/game/pokemon/${slug}`;

    let html = await fetchUrl(directUrl).catch(() => null);

    // If direct URL returned a real page, parse it
    if (html && html.length > 2000 && !html.includes('page-not-found') && !html.includes('404')) {
      const price = parsePriceChartingHtml(html, grade);
      if (price) return price;
    }

    // Search fallback
    const searchUrl = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(name)}&type=prices`;
    const searchHtml = await fetchUrl(searchUrl).catch(() => null);
    if (!searchHtml) return null;

    // Collect all /game/ links from the search page and pick the best match
    // Prefer a link whose path contains the card name words (avoids grabbing
    // a graded-slab page or a completely unrelated card at the top of results)
    const linkRe = /href="(\/game\/[^"]+)"/g;
    const links = [];
    let lm;
    while ((lm = linkRe.exec(searchHtml)) !== null) {
      // Skip links that are clearly graded/slab pages
      if (/graded|psa|bgs|cgc|sgc/i.test(lm[1])) continue;
      links.push(lm[1]);
    }

    if (!links.length) return null;

    // Score each link by how many name words appear in the URL slug
    const nameWords = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    let bestLink = links[0];
    let bestScore = -1;
    for (const link of links.slice(0, 6)) {  // only check top 6 to stay fast
      const score = nameWords.filter(w => link.toLowerCase().includes(w)).length;
      if (score > bestScore) { bestScore = score; bestLink = link; }
    }

    const resultHtml = await fetchUrl('https://www.pricecharting.com' + bestLink).catch(() => null);
    if (resultHtml) return parsePriceChartingHtml(resultHtml, grade);

    return null;
  } catch (e) {
    console.error('[lookup-price] name lookup error:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, condition, url } = req.body || {};
  if (!name && !url) return res.status(400).json({ error: 'name or url required' });

  try {
    let price = null;

    if (url) {
      // URL-based lookup is more reliable — use it first
      price = await lookupFromUrl(url, condition);
      // Fall back to name search if URL parse failed
      if (!price && name) price = await lookupFromName(name, condition);
    } else {
      price = await lookupFromName(name, condition);
    }

    return res.status(200).json({
      price: price || null,
      source: price ? (url ? 'url' : 'pricecharting') : null
    });
  } catch (e) {
    return res.status(200).json({ price: null, error: e.message });
  }
};
