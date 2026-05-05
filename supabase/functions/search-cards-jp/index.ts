/**
 * search-cards-jp
 *
 * Searches the Pokémon TCG API (api.pokemontcg.io) and returns results
 * tagged as language: "JA" so the PathBinder "Add to Binder" flow
 * automatically pre-selects Japanese for the language dropdown.
 *
 * Deploy:
 *   supabase functions deploy search-cards-jp --no-verify-jwt
 *
 * Request body:
 *   { query: string, page?: number }
 *
 * Response:
 *   { cards: Card[], total: number, page: number, query: string }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TCG_BASE = 'https://api.pokemontcg.io/v2';
const PAGE_SIZE = 20;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  try {
    const { query, page = 1 } = await req.json();
    if (!query?.trim()) return json({ error: 'query is required' }, 400);

    const q      = encodeURIComponent(`name:"${query.trim()}"`);
    const offset = (page - 1) * PAGE_SIZE;
    const url    = `${TCG_BASE}/cards?q=${q}&pageSize=${PAGE_SIZE}&page=${page}`;

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      const body = await res.text();
      return json({ error: `TCG API error ${res.status}: ${body.slice(0, 200)}` }, 502);
    }

    const data  = await res.json();
    const items: any[] = data.data ?? [];
    const total: number = data.totalCount ?? items.length;

    // Re-tag every card as JA so the binder modal pre-selects Japanese
    const cards = items.map((c: any) => ({
      id:       `jp-${c.id}`,
      name:     c.name,
      images:   c.images ?? { small: '', large: '' },
      set:      { name: c.set?.name ?? '', id: c.set?.id ?? '' },
      number:   c.number ?? '',
      rarity:   c.rarity ?? null,
      language: 'JA',
    }));

    return json({ cards, total, page, query });

  } catch (err: any) {
    console.error('[search-cards-jp]', err);
    return json({ error: err?.message ?? 'Internal error' }, 500);
  }
});
