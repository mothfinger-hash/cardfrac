#!/usr/bin/env node
/*
 * PathBinder — build standalone legal HTML pages from legal/*.md.
 *
 * Produces lightweight, self-contained pages at the repo root (own styling,
 * NO app JS / no SPA shell) so /privacy etc. load instantly for users and
 * app-store reviewers. The internal "_Template prepared… attorney review_"
 * note is stripped from the public output.
 *
 * USAGE: node build_legal_pages.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'legal');

// Source md -> output html (at repo root) + nav label.
const DOCS = [
  { md: 'privacy-policy.md',                  out: 'privacy-policy.html',                  label: 'Privacy Policy' },
  { md: 'terms-of-service.md',                out: 'terms-of-service.html',                label: 'Terms of Service' },
  { md: 'marketplace-seller-terms.md',        out: 'marketplace-seller-terms.html',        label: 'Marketplace & Seller Terms' },
  { md: 'refund-buyer-protection.md',         out: 'refund-buyer-protection.html',         label: 'Refund & Buyer Protection' },
  { md: 'prohibited-items-acceptable-use.md', out: 'prohibited-items-acceptable-use.html', label: 'Prohibited Items & Acceptable Use' },
];

function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Inline markdown: code, links (.md -> .html), bold, italic.
function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, url) => {
    url = url.replace(/\.md(#|$)/, '.html$1');
    const ext = /^https?:/i.test(url) ? ' target="_blank" rel="noopener"' : '';
    return '<a href="' + url + '"' + ext + '>' + t + '</a>';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => '<strong>' + t + '</strong>');
  s = s.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, (_, p, t) => p + '<em>' + t + '</em>');
  return s;
}

// Block-level markdown -> HTML. Returns { title, body }.
function mdToHtml(md) {
  const lines = md.split('\n');
  let html = '';
  let title = 'PathBinder';
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>\n'; para = []; }
  };

  while (i < lines.length) {
    let line = lines[i];

    // Blockquote block — skip the internal reviewer note, render others.
    if (/^>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      const text = buf.join(' ');
      if (!/Template prepared/i.test(text)) html += '<blockquote>' + inline(text) + '</blockquote>\n';
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) { flushPara(); html += '<hr>\n'; i++; continue; }

    // Headings
    let h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1) title = text.replace(/\s*PathBinder\s*/i, '').trim() || text;
      html += '<h' + level + '>' + inline(text) + '</h' + level + '>\n';
      i++; continue;
    }

    // Unordered list
    if (/^\s*-\s+/.test(line)) {
      flushPara();
      html += '<ul>\n';
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        html += '<li>' + inline(lines[i].replace(/^\s*-\s+/, '')) + '</li>\n';
        i++;
      }
      html += '</ul>\n';
      continue;
    }

    // Blank line -> paragraph break
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return { title, body: html };
}

function shell({ title, body, currentOut }) {
  const nav = DOCS.map(d =>
    d.out === currentOut
      ? '<span class="cur">' + d.label + '</span>'
      : '<a href="/' + d.out + '">' + d.label + '</a>'
  ).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} · PathBinder</title>
<meta name="robots" content="index,follow">
<style>
  :root{--bg:#0a0e1a;--surface:#0f1626;--border:#1f2939;--text:#d8e0e8;--muted:#8a98a8;--accent:#1AC7A0;--copper:#B87333}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.65;font-size:16px}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  header{border-bottom:1px solid var(--border);padding:18px 20px;display:flex;align-items:center;gap:12px;max-width:860px;margin:0 auto}
  header .wordmark{font-weight:800;letter-spacing:.04em;color:#fff;font-size:18px}
  header .eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--copper);margin-left:auto}
  main{max-width:760px;margin:0 auto;padding:28px 20px 10px}
  h1{font-size:28px;color:#fff;margin:6px 0 18px;letter-spacing:.01em}
  h2{font-size:20px;color:#fff;margin:30px 0 10px;padding-top:6px;border-top:1px solid var(--border)}
  h3{font-size:16px;color:var(--accent);margin:20px 0 8px;text-transform:none}
  p{margin:0 0 14px}
  ul{margin:0 0 16px;padding-left:22px}
  li{margin:0 0 8px}
  strong{color:#fff}
  hr{border:0;border-top:1px solid var(--border);margin:22px 0}
  blockquote{margin:0 0 16px;padding:10px 16px;border-left:3px solid var(--accent);background:rgba(26,199,160,.06);border-radius:6px;color:var(--muted)}
  code{font-family:'SF Mono',Menlo,Consolas,monospace;background:var(--surface);padding:1px 6px;border-radius:5px;font-size:.9em;color:var(--copper)}
  footer{max-width:760px;margin:30px auto 0;padding:22px 20px 50px;border-top:1px solid var(--border);color:var(--muted);font-size:13px}
  footer nav{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:16px}
  footer nav a,footer nav .cur{font-size:13px}
  footer nav .cur{color:var(--muted)}
  footer .addr{line-height:1.6}
</style>
</head>
<body>
  <header>
    <a href="/" class="wordmark">PathBinder</a>
    <span class="eyebrow">Legal</span>
  </header>
  <main>
${body}  </main>
  <footer>
    <nav>${nav}</nav>
    <div class="addr">PathBinder LLC · 471 Cleveland Crossing Dr Unit 101, Garner, NC 27529, USA · <a href="mailto:support@pathbinder.gg">support@pathbinder.gg</a></div>
  </footer>
</body>
</html>`;
}

function main() {
  let count = 0;
  for (const d of DOCS) {
    const srcPath = path.join(SRC, d.md);
    if (!fs.existsSync(srcPath)) { console.warn('  (missing) ' + d.md); continue; }
    const md = fs.readFileSync(srcPath, 'utf8');
    const { title, body } = mdToHtml(md);
    const out = shell({ title, body, currentOut: d.out });
    fs.writeFileSync(path.join(ROOT, d.out), out);
    console.log('  → /' + d.out + '   (' + title + ')');
    count++;
  }
  console.log('\nBuilt ' + count + ' legal page(s).');
}

main();
