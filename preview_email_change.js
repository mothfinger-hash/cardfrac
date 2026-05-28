#!/usr/bin/env node
/*
 * PathBinder — Email change email preview generator.
 *
 * Renders the email-change template (api/_lib/email-change-template.js)
 * to a static HTML file you can open in a browser. Local asset URLs
 * are rewritten to relative paths so pb_logo.png + dash2.webp +
 * noise.png load from disk without needing a deployed site.
 *
 * USAGE
 *   node preview_email_change.js
 *
 * Output: ./email_previews/email-change.html
 */

const fs   = require('fs');
const path = require('path');
const { renderHtml } = require('./api/_lib/email-change-template');

const SITE_ORIGIN = 'https://pathbinder.gg';
const OUTPUT_DIR  = path.join(__dirname, 'email_previews');

function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let html = renderHtml({ siteOrigin: SITE_ORIGIN, forPreview: true });
  html = html
    .replace(SITE_ORIGIN + '/pb_logo.png',  '../pb_logo.png')
    .replace(SITE_ORIGIN + '/dash2.webp',   '../dash2.webp')
    .replace(SITE_ORIGIN + '/noise.png',    '../noise.png');

  const outPath = path.join(OUTPUT_DIR, 'email-change.html');
  fs.writeFileSync(outPath, html);
  console.log('  →', outPath);
  console.log('\nOpen this in your browser:');
  console.log('  file://' + outPath);
}

main();
