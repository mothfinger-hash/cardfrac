#!/usr/bin/env node
/*
 * PathBinder — "Your order shipped" email preview generator.
 *
 * Renders the buyer shipped template (api/_lib/order-emails.js) to a
 * static HTML file you can open in a browser. Local asset URLs are
 * rewritten to relative paths so pb_logo.png + dash2.webp + noise.png
 * load from disk without a deployed site.
 *
 * USAGE
 *   node preview_order_shipped.js
 *
 * Output: ./email_previews/order-shipped.html
 */

const fs   = require('fs');
const path = require('path');
const { renderBuyerShipped } = require('./api/_lib/order-emails');

const SITE_ORIGIN = 'https://pathbinder.gg';
const OUTPUT_DIR  = path.join(__dirname, 'email_previews');

// Sample order data — tweak to preview different states (e.g. drop
// tracking.url to see the "View Your Order" fallback CTA).
const SAMPLE = {
  siteOrigin: SITE_ORIGIN,
  orderId: '93c6131b-0000-0000-0000-000000000000',
  cardName: 'Charizard VMAX',
  setName: 'Darkness Ablaze',
  imageUrl: 'https://images.pokemontcg.io/swsh3/20_hires.png',
  shipTo: { name: 'Test Buyer' },
  tracking: {
    carrier: 'USPS',
    number: '9400111899223821234567',
    url: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223821234567',
  },
};

function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const msg = renderBuyerShipped(SAMPLE);
  let html = msg.html;

  // Rewrite asset URLs to relative paths so the preview loads images
  // from local disk. The real send keeps the absolute pathbinder.gg URLs.
  html = html
    .replace(SITE_ORIGIN + '/pb_logo.png', '../pb_logo.png')
    .replace(SITE_ORIGIN + '/dash2.webp',  '../dash2.webp')
    .replace(SITE_ORIGIN + '/noise.png',   '../noise.png');

  const outPath = path.join(OUTPUT_DIR, 'order-shipped.html');
  fs.writeFileSync(outPath, html);
  console.log('Subject:', msg.subject);
  console.log('  →', outPath);
  console.log('\nOpen this in your browser:');
  console.log('  file://' + outPath);
}

main();
