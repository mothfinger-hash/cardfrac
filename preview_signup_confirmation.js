#!/usr/bin/env node
/*
 * PathBinder — Signup confirmation email preview generator.
 *
 * Renders the signup-confirmation template
 * (api/_lib/signup-confirmation-template.js) to a static HTML file
 * you can open in a browser. Local asset URLs are rewritten to
 * relative paths so pb_logo.png + dash2.webp + noise.png load from
 * disk without needing a deployed site.
 *
 * USAGE
 *   node preview_signup_confirmation.js
 *
 * Output: ./email_previews/signup-confirmation.html
 */

const fs   = require('fs');
const path = require('path');
const { renderHtml } = require('./api/_lib/signup-confirmation-template');

const SITE_ORIGIN = 'https://pathbinder.gg';
const OUTPUT_DIR  = path.join(__dirname, 'email_previews');

function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let html = renderHtml({ siteOrigin: SITE_ORIGIN, forPreview: true });

  // Rewrite asset URLs to relative paths so the preview loads images
  // from the local file system. The Supabase-bound version
  // (forPreview:false) keeps the absolute URLs that point at
  // pathbinder.gg.
  html = html
    .replace(SITE_ORIGIN + '/pb_logo.png',  '../pb_logo.png')
    .replace(SITE_ORIGIN + '/dash2.webp',   '../dash2.webp')
    .replace(SITE_ORIGIN + '/noise.png',    '../noise.png');

  const outPath = path.join(OUTPUT_DIR, 'signup-confirmation.html');
  fs.writeFileSync(outPath, html);
  console.log('  →', outPath);
  console.log('\nOpen this in your browser:');
  console.log('  file://' + outPath);
}

main();
