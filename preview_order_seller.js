#!/usr/bin/env node
/*
 * PathBinder — "You sold a card!" seller email preview generator.
 *
 * Renders the seller new-sale template (api/_lib/order-emails.js) to a
 * static HTML file you can open in a browser. Local asset URLs are
 * rewritten to relative paths so the logo/background load from disk.
 *
 * USAGE
 *   node preview_order_seller.js
 *
 * Output: ./email_previews/order-seller-sale.html
 */

const fs   = require('fs');
const path = require('path');
const { renderSellerNewOrder } = require('./api/_lib/order-emails');

const SITE_ORIGIN = 'https://pathbinder.gg';
const OUTPUT_DIR  = path.join(__dirname, 'email_previews');

const SAMPLE = {
  siteOrigin: SITE_ORIGIN,
  orderId: '93c6131b-0000-0000-0000-000000000000',
  cardName: 'Charizard VMAX',
  setName: 'Darkness Ablaze',
  imageUrl: 'https://images.pokemontcg.io/swsh3/20_hires.png',
  amount: 5.00,
  payout: 4.60,
  shipTo: {
    name: 'Test Buyer',
    street1: '215 Clayton St',
    city: 'San Francisco',
    state: 'CA',
    zip: '94117',
  },
};

function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const msg = renderSellerNewOrder(SAMPLE);
  let html = msg.html
    .replace(SITE_ORIGIN + '/pb_logo.png', '../pb_logo.png')
    .replace(SITE_ORIGIN + '/dash2.webp',  '../dash2.webp')
    .replace(SITE_ORIGIN + '/noise.png',   '../noise.png');

  const outPath = path.join(OUTPUT_DIR, 'order-seller-sale.html');
  fs.writeFileSync(outPath, html);
  console.log('Subject:', msg.subject);
  console.log('  →', outPath);
  console.log('\nOpen this in your browser:');
  console.log('  file://' + outPath);
}

main();
