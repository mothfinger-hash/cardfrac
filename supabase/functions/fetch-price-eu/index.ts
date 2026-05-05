/**
 * fetch-price-eu — Cardmarket API pricing (OAuth 1.0a)
 *
 * Supports any language Cardmarket carries: EN, FR, DE, ES, IT, PT, JA, KO, ZH, RU
 *
 * Setup — add these four secrets in Supabase Dashboard → Settings → Edge Functions:
 *   CARDMARKET_APP_TOKEN      (from cardmarket.com → Account → Developer → My Apps)
 *   CARDMARKET_APP_SECRET
 *   CARDMARKET_ACCESS_TOKEN
 *   CARDMARKET_ACCESS_SECRET
 *
 * Register at: https://www.cardmarket.com/en/Pokemon/Seller/MyAccount/APICredentials
 *
 * Deploy:
 *   supabase functions deploy fetch-price-eu
 *
 * Request body:
 *   { cardName: string, setName?: string, cardNumber?: string,
 *     apiCardId?: string, language?: string }
 *     language defaults to 'EN'; use 'JA', 'KO', 'DE', 'FR' etc.
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

// ─── Cardmarket language code map ────────────────────────────────────────────
const CM_LANG: Record<string, number> = {
  EN: 1, FR: 2, DE: 3, ES: 4, IT: 5,
  ZH: 7,  // Simplified Chinese
  JA: 8, PT: 9, RU: 10, KO: 11,
};

const CM_BASE = 'https://api.cardmarket.com/ws/v2.0/output.json';

// ─── OAuth 1.0a signer ───────────────────────────────────────────────────────
async function buildOAuthHeader(method: string, url: string): Promise<string> {
  const appToken     = Deno.env.get('CARDMARKET_APP_TOKEN')!;
  const appSecret    = Deno.env.get('CARDMARKET_APP_SECRET')!;
  const accessToken  = Deno.env.get('CARDMARKET_ACCESS_TOKEN')!;
  const accessSecret = Deno.env.get('CARDMARKET_ACCESS_SECRET')!;

  if (!appToken || !appSecret || !accessToken || !accessSecret) {
    throw new Error('Cardmarket API credentials not configured in Supabase secrets.');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = crypto.randomUUID().replace(/-/g, '');

  const oauthParams: Record<string, string> = {
    oauth_consumer_key:     appToken,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        timestamp,
    oauth_token:            accessToken,
    oauth_version:          '1.0',
  };

  // RFC 5849 §3.4.1 — sorted encoded parameter string
  const paramStr = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join('&');

  // Signature base string
  const sigBase = [method.toUpperCase(), pct(url), pct(paramStr)].join('&');

  // Signing key
  const signingKey = `${pct(appSecret)}&${pct(accessSecret)}`;

  // HMAC-SHA1 via Web Crypto
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sigBuf  = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(sigBase));
  const sigB64  = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  oauthParams['oauth_signature'] = sigB64;

  // Assemble Authorization header
  const authHeader = 'OAuth realm="' + url + '", ' +
    Object.entries(oauthParams)
      .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
      .join(', ');

  return authHeader;
}

// percent-encode per RFC 3986
function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// ─── Cardmarket API call helper ───────────────────────────────────────────────
async function cmGet(path: string): Promise<any> {
  const url = `${CM_BASE}/${path}`;
  const auth = await buildOAuthHeader('GET', url);
  const res = await fetch(url, {
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cardmarket ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Find product by name + language ─────────────────────────────────────────
async function findCMProduct(
  cardName: string, langId: number
): Promise<{ idProduct: number; name: string; priceGuide: any } | null> {
  const encoded = encodeURIComponent(cardName);
  // Game 1 = Pokémon on Cardmarket
  const data = await cmGet(`products/find?search=${encoded}&idGame=1&idLanguage=${langId}&exact=false`);
  const products: any[] = data.product ?? data.products ?? [];
  if (!products.length) return null;

  // Prefer an exact name match, fall back to first result
  const match = products.find((p: any) =>
    p.name?.toLowerCase() === cardName.toLowerCase()
  ) ?? products[0];

  return {
    idProduct:  match.idProduct,
    name:       match.name,
    priceGuide: match.priceGuide ?? null,
  };
}

// ─── Live EUR → USD rate ──────────────────────────────────────────────────────
async function getEURtoUSD(): Promise<number> {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD');
    const data = await res.json();
    return data.rates?.USD ?? 1.08;
  } catch {
    return 1.08; // rough fallback
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
    const {
      cardName, setName, cardNumber, apiCardId,
      language = 'EN',
    } = await req.json();

    if (!cardName) return errorResp('cardName is required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── 1. Check cache ────────────────────────────────────────────────────────
    const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    let cacheQ = supabase
      .from('card_prices')
      .select('*')
      .eq('language',  language)
      .eq('source',    'cardmarket')
      .gte('updated_at', cutoff);

    if (apiCardId) {
      cacheQ = cacheQ.eq('api_card_id', apiCardId);
    } else {
      cacheQ = cacheQ.eq('card_name', cardName);
    }

    const { data: cached } = await cacheQ;
    if (cached && cached.length > 0) {
      return jsonResp({ prices: cached, cached: true });
    }

    // ── 2. Resolve Cardmarket language ID ────────────────────────────────────
    const langId = CM_LANG[language.toUpperCase()] ?? 1;

    // ── 3. Find product + fetch live FX in parallel ───────────────────────────
    const [product, fxRate] = await Promise.all([
      findCMProduct(cardName, langId),
      getEURtoUSD(),
    ]);

    if (!product) {
      return jsonResp({ prices: [], cached: false, message: 'No Cardmarket listing found' });
    }

    // ── 4. Extract price from priceGuide ─────────────────────────────────────
    // Cardmarket priceGuide fields: SELL, LOW, LOWEX, LOWFOIL, AVG1, AVG7, AVG30
    const pg        = product.priceGuide ?? {};
    const price_eur = parseFloat(pg.SELL ?? pg.AVG7 ?? pg.AVG1 ?? '0');
    const price_usd = price_eur > 0
      ? Math.round(price_eur * fxRate * 100) / 100
      : null;

    const row = {
      api_card_id: apiCardId ?? null,
      card_name:   cardName,
      set_name:    setName   ?? null,
      card_number: cardNumber ?? null,
      language,
      source:      'cardmarket',
      price_usd,
      price_local: price_eur,
      currency:    'EUR',
      fx_rate:     fxRate,
      raw_data:    { idProduct: product.idProduct, name: product.name, priceGuide: pg },
    };

    // ── 5. Cache result ───────────────────────────────────────────────────────
    await supabase
      .from('card_prices')
      .upsert(row, { onConflict: 'card_name,set_name,card_number,language,source' });

    return jsonResp({ prices: [row], cached: false, fx_rate: fxRate });

  } catch (err: any) {
    console.error('[fetch-price-eu]', err);
    return errorResp(err?.message ?? 'Internal error', 500);
  }
});
