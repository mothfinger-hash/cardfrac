#!/usr/bin/env node
// fetch_pokemon_cards.js
// Fetches all Pokémon TCG cards and writes a CSV you can open in Excel / Google Sheets.
// Usage: node fetch_pokemon_cards.js
// Output: pokemon_cards_pricechart.csv (same folder)

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const OUTPUT = path.join(__dirname, 'pokemon_cards_pricechart.csv');
const PAGE_SIZE = 250;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CardFrac/1.0' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('JSON parse error: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function makeSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim().replace(/^-|-$/g, '');
}

function csvCell(val) {
  if (val == null) return '';
  const s = String(val);
  // Escape quotes and wrap if needed
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function main() {
  const allCards = [];
  let page = 1;

  console.log('Fetching all Pokémon TCG cards...');
  while (true) {
    const url = `https://api.pokemontcg.io/v2/cards?pageSize=${PAGE_SIZE}&page=${page}&orderBy=set.id,number`;
    process.stdout.write(`  Page ${page}... `);
    try {
      const data = await get(url);
      const cards = data.data || [];
      if (!cards.length) { console.log('done.'); break; }
      allCards.push(...cards);
      console.log(`${cards.length} cards (total: ${allCards.length})`);
      if (allCards.length >= (data.totalCount || Infinity)) break;
      page++;
      // Small delay to be polite to the API
      await new Promise(r => setTimeout(r, 80));
    } catch(e) {
      console.error('\nError on page', page, ':', e.message);
      break;
    }
  }

  console.log(`\nBuilding CSV with ${allCards.length} cards...`);

  const headers = [
    'Card Name',
    'Set Name',
    'Set Code',
    'Card Number',
    'Rarity',
    'Supertype',
    'PriceCharting URL',
    'PriceCharting Search URL',
    'TCGPlayer URL',
    'Card Image URL',
    'Price Source URL (fill me in)'
  ];

  const rows = [headers.map(csvCell).join(',')];

  for (const card of allCards) {
    const name      = card.name || '';
    const setName   = card.set?.name || '';
    const setCode   = card.set?.id   || '';
    const number    = card.number    || '';
    const rarity    = card.rarity    || '';
    const supertype = card.supertype || '';
    const tcgUrl    = card.tcgplayer?.url || '';
    const imgUrl    = card.images?.small  || '';
    const slug      = makeSlug(name);
    const pcUrl     = `https://www.pricecharting.com/game/pokemon/${slug}`;
    const searchUrl = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(name)}&type=prices`;

    rows.push([name, setName, setCode, number, rarity, supertype, pcUrl, searchUrl, tcgUrl, imgUrl, ''].map(csvCell).join(','));
  }

  fs.writeFileSync(OUTPUT, rows.join('\n'), 'utf8');
  console.log(`\n✓ Saved to: ${OUTPUT}`);
  console.log(`  Total cards: ${allCards.length}`);
  console.log('\nTip: Open in Excel or Google Sheets.');
  console.log('     The "PriceCharting URL" column is a best-guess slug.');
  console.log('     Use "PriceCharting Search URL" to verify/correct each one.');
  console.log('     Fill in "Price Source URL" then bulk-import to Supabase.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
