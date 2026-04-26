#!/usr/bin/env node
// upload_price_urls.js
// One-time script: loads card_price_urls.json into Supabase table `card_price_urls`.
//
// Usage:
//   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=your_key node upload_price_urls.js
//
// Or copy your values directly into the two constants below.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'YOUR_SERVICE_ROLE_KEY';
const TABLE        = 'card_price_urls';
const BATCH_SIZE   = 500; // Supabase handles 500 rows/request comfortably

const raw  = JSON.parse(fs.readFileSync(path.join(__dirname, 'card_price_urls.json'), 'utf8'));
// Deduplicate by api_card_id — keep last occurrence so no batch contains two rows with the same key
const seen = new Map();
for (const row of raw) seen.set(row.api_card_id, row);
const rows = [...seen.values()];
console.log(`Loaded ${raw.length} rows → ${rows.length} unique after dedup.`);

function supabasePost(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/v1/${TABLE}`, SUPABASE_URL);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + '?on_conflict=api_card_id',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates'
      }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  if (SUPABASE_URL === 'YOUR_SUPABASE_URL') {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars before running.');
    process.exit(1);
  }

  console.log(`Uploading ${rows.length} cards to Supabase in batches of ${BATCH_SIZE}...`);
  let uploaded = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      await supabasePost(batch);
      uploaded += batch.length;
      process.stdout.write(`\r  ${uploaded}/${rows.length} uploaded`);
    } catch(e) {
      console.error(`\nFailed on batch starting at ${i}:`, e.message);
      process.exit(1);
    }
    // Brief pause between batches
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`\n✓ Done! ${uploaded} cards uploaded to ${TABLE}.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
