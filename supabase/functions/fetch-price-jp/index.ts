/**
 * fetch-price-jp — Japanese card pricing
 *
 * Sources (in priority order):
 *   1. Cache  — card_prices table (24-hour TTL)
 *   2. PriceCharting — USD prices for JP sets (requires PRICECHARTING_API_KEY secret)
 *   3. Yuyutei — scraped JPY → USD via Frankfurter live FX
 *
 * Deploy:
 *   supabase functions deploy fetch-price-jp
 *
 * Request body:
 *   { cardName: string, setName?: string, cardNumber?: string, apiCardId?: string }
 *
 * Response:
 *   { prices: PriceRow[], cached: boolean, fx_rate?: number }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Yuyutei candidate URLs to try ───────────────────────────────────────────
// Their search endpoint may vary; we try multiple patterns.
function yuyuteiSearchUrls(cardName: string, cardNumber?: string): string[] {
  const name = encodeURIComponent(cardName);
  const num  = cardNumber ? encodeURIComponent(cardNumber) : null;
  return [
    num  ? `https://yuyu-tei.jp/sell/pokemon?search_word=${num}` : null,
    `https://yuyu-tei.jp/sell/pokemon?search_word=${name}`,
    `https://yuyu-tei.jp/game_title/pokemon/sell/search?keyword=${name}`,
    `https://yuyu-tei.jp/sell/pokemon?keyword=${name}`,
  ].filter(Boolean) as string[];
}

// ─── Price regex patterns for JPY extraction ────────────────────────────────
const JPY_PATTERNS = [
  /class="[^"]*(?:price|nedan)[^"]*"[^>]*>\s*¥?\s*([\d,]+)/gi,
  /¥\s*([\d,]+)/g,
  /([\d,]+)\s*円/g,
  /data-price="([\d]+)"/g,
  /"price"\s*:\s*"?([\d,]+)"?/gi,
  /sell[_-]price[^>]*>\s*[\¥]?\s*([\d,]+)/gi,
];

function extractJpyPrice(html: string): number | null {
  for (const pattern of JPY_PATTERNS) {
    const matches = [...html.matchAll(pattern)];
    for (const m of matches) {
      const val = parseInt(m[1].replace(/,/g, ''), 10);
      // Sanity range: ¥50 – ¥500,000
      if (val >= 50 && val <= 500_000) return val;
    }
  }
  return null;
}

// ─── Yuyutei scraper ─────────────────────────────────────────────────────────
async function scrapeYuyutei(
  cardName: string, setName?: string, cardNumber?: string
): Promise<{ price_jpy: number; url: string } | null> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; PathBinder-PriceBot/1.0)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  };

  for (const url of yuyuteiSearchUrls(cardName, cardNumber)) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const html = await res.text();
      const price_jpy = extractJpyPrice(html);
      if (price_jpy) return { price_jpy, url };
    } catch {
      // Try next URL pattern
    }
  }
  return null;
}

// ─── PriceCharting lookup ────────────────────────────────────────────────────
async function fetchPriceCharting(
  cardName: string, setName?: string
): Promise<{ price_usd: number; raw: unknown } | null> {
  const apiKey = Deno.env.get('PRICECHARTING_API_KEY');
  if (!apiKey) return null;

  try {
    // PriceCharting Japanese Pokemon sets are typically prefixed "Japanese …"
    const query = encodeURIComponent(
      `Japanese ${setName ? setName + ' ' : ''}${cardName}`.trim()
    );
    const url = `https://www.pricecharting.com/api/products?q=${query}&status=completed&api_key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    const products: any[] = data.products ?? [];
    // Prefer an explicitly Japanese-console entry
    const match =
      products.find((p: any) =>
        p['console-name']?.toLowerCase().includes('japanese') ||
        p['console-name']?.toLowerCase().includes('japan')
      ) ?? products[0];

    if (!match) return null;

    // PriceCharting prices are in cents
    const price_usd = ((match['loose-price'] ?? match['cib-price'] ?? 0) / 100);
    return price_usd > 0 ? { price_usd, raw: match } : null;
  } catch {
    return null;
  }
}

// ─── Live JPY → USD rate via Frankfurter (no key needed) ────────────────────
async function getJPYtoUSD(): Promise<number> {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=JPY&to=USD');
    const data = await res.json();
    return data.rates?.USD ?? 0.0067;
  } catch {
    return 0.0067; // ~149 JPY / USD fallback
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const jsonResp  = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const errorResp = (msg: string, status = 400) =>
  jsonResp({ error: msg }, status);

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { cardName, setName, cardNumber, apiCardId } = await req.json();
    if (!cardName) return errorResp('cardName is required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── 1. Check price cache ──────────────────────────────────────────────────
    const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    let cacheQ = supabase
      .from('card_prices')
      .select('*')
      .eq('language', 'JA')
      .gte('updated_at', cutoff);

    if (apiCardId) {
      cacheQ = cacheQ.eq('api_card_id', apiCardId);
    } else {
      cacheQ = cacheQ.eq('card_name', cardName);
      if (setName) cacheQ = cacheQ.eq('set_name', setName);
    }

    const { data: cached } = await cacheQ;
    if (cached && cached.length > 0) {
      return jsonResp({ prices: cached, cached: true });
    }

    // ── 2. Fetch fresh data ───────────────────────────────────────────────────
    const [fxRate, pcResult, yyResult] = await Promise.all([
      getJPYtoUSD(),
      fetchPriceCharting(cardName, setName),
      scrapeYuyutei(cardName, setName, cardNumber),
    ]);

    const baseRow = {
      api_card_id: apiCardId ?? null,
      card_name:   cardName,
      set_name:    setName   ?? null,
      card_number: cardNumber ?? null,
      language:    'JA',
    };

    const rows: any[] = [];

    if (pcResult) {
      rows.push({
        ...baseRow,
        source:      'pricecharting',
        price_usd:   pcResult.price_usd,
        price_local: pcResult.price_usd,
        currency:    'USD',
        fx_rate:     1,
        raw_data:    pcResult.raw,
      });
    }

    if (yyResult) {
      rows.push({
        ...baseRow,
        source:      'yuyutei',
        price_usd:   Math.round(yyResult.price_jpy * fxRate * 100) / 100,
        price_local: yyResult.price_jpy,
        currency:    'JPY',
        fx_rate:     fxRate,
        raw_data:    { url: yyResult.url, price_jpy: yyResult.price_jpy },
      });
    }

    // ── 3. Upsert into cache ──────────────────────────────────────────────────
    for (const row of rows) {
      await supabase
        .from('card_prices')
        .upsert(row, { onConflict: 'card_name,set_name,card_number,language,source' });
    }

    return jsonResp({ prices: rows, cached: false, fx_rate: fxRate });

  } catch (err: any) {
    console.error('[fetch-price-jp]', err);
    return errorResp(err?.message ?? 'Internal error', 500);
  }
});
