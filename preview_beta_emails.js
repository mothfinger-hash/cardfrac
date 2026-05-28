#!/usr/bin/env node
/*
 * PathBinder — Beta invite email preview generator.
 *
 * Generates one HTML file per tier in ./email_previews/ using the
 * SAME render function the API endpoint uses, so what you see here
 * matches what gets sent. Open the files in a browser to preview.
 *
 * USAGE
 *   node preview_beta_emails.js
 *
 * The HTML references hosted assets (pb_logo.png, dashboard.jpg)
 * at pathbinder.gg — once the site is deployed those resolve.
 * If you want to preview before deploying you can either:
 *   • Push the assets first so the URLs are live
 *   • Edit the SITE_ORIGIN const below to your local dev server
 */

const fs   = require('fs');
const path = require('path');
const { TIER_COPY, renderEmailHtml } = require('./api/_lib/beta-invite-template');

const SITE_ORIGIN  = process.env.PREVIEW_SITE_ORIGIN || 'https://pathbinder.gg';
const OUTPUT_DIR   = path.join(__dirname, 'email_previews');
const SAMPLE_EMAIL = 'preview@example.com';
const SAMPLE_NAME  = 'Alex';
const SAMPLE_CODE  = 'DEMO-CODE-1234';

function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Also write an index.html that links to all the per-tier previews
  // so you can navigate them from one tab instead of opening each file.
  const links = [];

  Object.keys(TIER_COPY).forEach(tier => {
    let html = renderEmailHtml({
      email:       SAMPLE_EMAIL,
      tier,
      code:        SAMPLE_CODE,
      inviteeName: SAMPLE_NAME,
      siteOrigin:  SITE_ORIGIN,
    });
    // Local-preview hack: rewrite the absolute asset URLs to relative
    // paths so the previews load images straight from the local file
    // system instead of pathbinder.gg/<asset>. The relative paths only
    // work because the preview HTML lives one folder below the assets;
    // the actual EMAIL still ships with absolute URLs (it doesn't go
    // through this rewrite).
    html = html
      .replace(SITE_ORIGIN + '/pb_logo.png',   '../pb_logo.png')
      .replace(SITE_ORIGIN + '/dashboard.jpg', '../dashboard.jpg')
      .replace(SITE_ORIGIN + '/noise.png',     '../noise.png');
    const outPath = path.join(OUTPUT_DIR, `beta-invite-${tier}.html`);
    fs.writeFileSync(outPath, html);
    console.log(`  → ${outPath}`);
    links.push({ tier, file: `beta-invite-${tier}.html`, title: TIER_COPY[tier].title });
  });

  const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Beta Invite Email Previews</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0e1a; color: #d8e0e8; padding: 32px; max-width: 720px; margin: 0 auto; }
    h1 { color: #1AC7A0; font-size: 22px; letter-spacing: 0.04em; }
    p { color: #6a7888; font-size: 14px; line-height: 1.6; }
    ul { padding: 0; list-style: none; }
    li { margin: 12px 0; }
    a { display: block; padding: 14px 18px; background: rgba(26,199,160,0.06); border-left: 3px solid #1AC7A0; color: #d8e0e8; text-decoration: none; }
    a:hover { background: rgba(26,199,160,0.12); }
    .tier { color: #B87333; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
    .title { color: #ffffff; font-size: 15px; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>PathBinder beta invite email previews</h1>
  <p>One preview per tier. Open in a browser; the rendered HTML is exactly what Resend ships to the invitee. Site assets (logo, background) resolve from <code>${SITE_ORIGIN}</code> — push those first if you're seeing broken images.</p>
  <ul>
    ${links.map(l => `<li><a href="${l.file}"><span class="tier">${l.tier}</span><br /><span class="title">${l.title}</span></a></li>`).join('\n    ')}
  </ul>
</body>
</html>`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), indexHtml);
  console.log(`  → ${path.join(OUTPUT_DIR, 'index.html')}`);
  console.log('\nOpen email_previews/index.html in your browser to navigate.');
}

main();
