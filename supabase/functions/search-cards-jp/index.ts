/**
 * search-cards-jp
 *
 * Searches the official Japanese Pokémon card database (pokemon-card.com)
 * and returns results in the same shape as the English TCG API so the
 * existing phondex "Add to Binder" flow works unchanged.
 *
 * Deploy:
 *   supabase functions deploy search-cards-jp
 *
 * Request body:
 *   { query: string, page?: number }
 *
 * Response:
 *   { cards: Card[], total: number }
 *
 * Card shape (matches api.pokemontcg.io):
 *   {
 *     id:      string,          // e.g. "jp-sv3a-123"
 *     name:    string,          // Japanese card name
 *     images:  { small: string, large: string },
 *     set:     { name: string, id: string },
 *     number:  string,
 *     rarity:  string | null,
 *     language: "JA"
 *   }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PC_BASE  = 'https://www.pokemon-card.com';
const SEARCH   = `${PC_BASE}/card-search/index.php`;
const HEADERS  = {
  'User-Agent':      'Mozilla/5.0 (compatible; PathBinder/1.0)',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'ja,en;q=0.5',
  'Referer':         PC_BASE,
};

// ─── Regex helpers ────────────────────────────────────────────────────────────

/** Pull all regex match groups from an HTML string */
function allMatches(html: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(html)) !== null) out.push(m);
  return out;
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}=["']([^"']+)["']`, 'i');
  return tag.match(re)?.[1] ?? null;
}

function innerText(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Card extraction ──────────────────────────────────────────────────────────
interface JpCard {
  id: string;
  name: string;
  images: { small: string; large: string };
  set: { name: string; id: string };
  number: string;
  rarity: string | null;
  language: 'JA';
}

function parseCards(html: string): JpCard[] {
  const cards: JpCard[] = [];

  // pokemon-card.com card list items: <li class="col ..." data-card-id="...">
  // Multiple layout variants — try broadest match first
  const liPattern = /<li[^>]+class="[^"]*col[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  const liMatches = allMatches(html, liPattern);

  // Fallback: look for card link blocks if li approach fails
  const blocks = liMatches.length > 0
    ? liMatches.map(m => m[0])
    : allMatches(html, /<a[^>]+href="[^"]*\/card\-[^"]+\.html[^"]*"[^>]*>([\s\S]*?)<\/a>/gi).map(m => m[0]);

  for (const block of blocks) {
    try {
      // Card page URL — extract set/number identifiers from it
      const linkMatch = block.match(/href="([^"]*\/card\-[^"]+\.html[^"]*)"/i)
                     ?? block.match(/href="([^"]*card[^"]+)"/i);
      const cardUrl   = linkMatch?.[1] ?? '';
      const fullUrl   = cardUrl.startsWith('http') ? cardUrl : `${PC_BASE}${cardUrl}`;

      // Image — try src and data-src
      const imgMatch  = block.match(/<img[^>]+>/i);
      let   imgSrc    = imgMatch ? (attr(imgMatch[0], 'data-src') ?? attr(imgMatch[0], 'src') ?? '') : '';
      if (imgSrc && !imgSrc.startsWith('http')) imgSrc = `${PC_BASE}${imgSrc}`;

      // Skip placeholder / UI images
      if (!imgSrc || imgSrc.includes('no_image') || imgSrc.includes('blank')) continue;

      // Card name — look for the name element
      const nameEl   = block.match(/<p[^>]+class="[^"]*card-name[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
                    ?? block.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i)
                    ?? block.match(/<span[^>]+class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const name     = nameEl ? innerText(nameEl[1] ?? nameEl[0]) : 'Unknown';
      if (!name || name === 'Unknown') continue;

      // Expansion/set name
      const setEl    = block.match(/<p[^>]+class="[^"]*expansion[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
                    ?? block.match(/<span[^>]+class="[^"]*expansion[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const setName  = setEl ? innerText(setEl[1] ?? setEl[0]) : '';

      // Card number — often in its own element or in the URL
      const numEl    = block.match(/<p[^>]+class="[^"]*num[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
                    ?? block.match(/No\.\s*(\w+\d+[-\/]?\d*)/i);
      const number   = numEl ? innerText(numEl[1] ?? numEl[0]).replace(/[^\w\-\/]/g, '') : '';

      // Derive a stable id from URL or image path
      const idRaw    = cardUrl.match(/card[_\-]([a-zA-Z0-9_\-]+)\.html/i)?.[1]
                    ?? imgSrc.match(/\/([a-zA-Z0-9_\-]+)\.\w+$/)?.[1]
                    ?? Math.random().toString(36).slice(2);
      const id       = `jp-${idRaw}`;

      // Rarity
      const rarityEl = block.match(/class="[^"]*rarity[^"]*"[^>]*>([\s\S]*?)<\//i);
      const rarity   = rarityEl ? innerText(rarityEl[1] ?? '') || null : null;

      // Derive set id slug from set name
      const setId = setName
        ? 'jp-' + setName.toLowerCase().replace(/[^\w]/g, '-').replace(/-+/g, '-').slice(0, 20)
        : 'jp-unknown';

      // Large image: try to construct the large variant URL
      const largeUrl = imgSrc.replace(/(_s|_small)(\.\w+)$/, '$2').replace(/\/card\//, '/card/');

      cards.push({
        id,
        name,
        images: { small: imgSrc, large: largeUrl || imgSrc },
        set:    { name: setName, id: setId },
        number,
        rarity,
        language: 'JA',
      });
    } catch {
      // Skip malformed blocks
    }
  }

  return cards;
}

// ─── Fetch total card count ───────────────────────────────────────────────────
function parseTotalCount(html: string): number {
  // e.g. "123件" or "検索結果: 123件" or "<span class="total">123</span>"
  const m = html.match(/(\d[\d,]*)\s*件/)
         ?? html.match(/total[^>]*>\s*(\d[\d,]*)/i)
         ?? html.match(/(\d+)\s*cards?/i);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const { query, page = 1 } = await req.json();
    if (!query?.trim()) return json({ error: 'query is required' }, 400);

    // Build search URL
    const params = new URLSearchParams({
      keyword:                 query,
      regulation_sidebar_form: 'all',
      pg:                      String(page),
    });
    const url = `${SEARCH}?${params}`;

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return json({ error: `pokemon-card.com returned ${res.status}` }, 502);

    const html  = await res.text();
    const cards = parseCards(html);
    const total = parseTotalCount(html);

    // Deduplicate by id (some blocks appear twice in different layouts)
    const seen = new Set<string>();
    const unique = cards.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });

    return json({ cards: unique, total, page, query });

  } catch (err: any) {
    console.error('[search-cards-jp]', err);
    return json({ error: err?.message ?? 'Internal error' }, 500);
  }
});
