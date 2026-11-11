// tools/refresh-fixtures.mjs - captures fresh Amazon pages for the corpus.
// Manual only. Never run it in CI or from a test.
//
//   node tools/refresh-fixtures.mjs <name> <url> [<name> <url> ...]
//
// At most 5 fetches per run, 3 seconds apart, amazon.com only. Each page is
// sanitized (tools/lib/sanitize-page.mjs), compared with the newest earlier
// capture of the same name, and written to tests/pages/<yyyy-mm>/<name>.html
// only after you type "y". Write or update <name>.expected.json by hand from
// the page itself, not from what the parser returns.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { sanitizeHtml, leftoverTokens } from './lib/sanitize-page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = path.join(ROOT, 'tests', 'pages');
const MAX_FETCHES = 5;
const GAP_MS = 3000;

// Rough markers so a layout change is visible before accepting a page.
const MARKERS = {
  'result cards': /data-component-type="s-search-result"/g,
  'sponsored labels': /puis-sponsored-label-text/g,
  'sspa links': /\/sspa\/click/g,
  'next link': /s-pagination-next/g,
  'a-offscreen': /a-offscreen/g,
  'aod offers': /id="aod-offer"/g,
  'pricetopay labels': /apex-pricetopay-accessibility-label/g,
  'captcha form': /validateCaptcha/g,
  'bm-verify': /bm-verify/g,
};

function markerCounts(html) {
  return Object.fromEntries(Object.entries(MARKERS).map(([k, re]) => [k, (html.match(re) || []).length]));
}

function previousCapture(name, month) {
  if (!fs.existsSync(PAGES)) return null;
  const months = fs.readdirSync(PAGES).filter((m) => /^\d{4}-\d{2}$/.test(m) && m <= month).sort().reverse();
  for (const m of months) {
    const f = path.join(PAGES, m, `${name}.html`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

async function main(argv) {
  if (process.env.CI) {
    console.error('[refresh-fixtures] refusing to run in CI');
    process.exit(1);
  }
  if (argv.length === 0 || argv.length % 2 !== 0) {
    console.error('usage: node tools/refresh-fixtures.mjs <name> <url> [<name> <url> ...]');
    process.exit(1);
  }
  const jobs = [];
  for (let i = 0; i < argv.length; i += 2) jobs.push({ name: argv[i], url: argv[i + 1] });
  if (jobs.length > MAX_FETCHES) {
    console.error(`[refresh-fixtures] at most ${MAX_FETCHES} pages per run`);
    process.exit(1);
  }
  for (const { name, url } of jobs) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad name: ${name}`);
    const host = new URL(url).hostname;
    if (host !== 'www.amazon.com' && host !== 'amazon.com') throw new Error(`not amazon.com: ${url}`);
  }

  const month = new Date().toISOString().slice(0, 7);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let fetches = 0;
  try {
    for (const { name, url } of jobs) {
      if (fetches > 0) await new Promise((r) => setTimeout(r, GAP_MS));
      if (++fetches > MAX_FETCHES) break;

      const res = await fetch(url, { headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US' }, redirect: 'follow' });
      const clean = sanitizeHtml(await res.text());
      const left = leftoverTokens(clean);
      const now = markerCounts(clean);

      console.log(`\n${name}: HTTP ${res.status}, ${clean.length} bytes after sanitizing, final URL ${res.url}`);
      if (left.length) console.log(`  still looks like it has: ${left.join(', ')}`);
      const prevFile = previousCapture(name, month);
      const prev = prevFile ? markerCounts(fs.readFileSync(prevFile, 'utf8')) : null;
      console.log(`  ${'marker'.padEnd(20)} ${'new'.padStart(6)} ${prev ? 'previous'.padStart(9) : ''}`);
      for (const k of Object.keys(now)) {
        const changed = prev && prev[k] !== now[k] ? '  <- changed' : '';
        console.log(`  ${k.padEnd(20)} ${String(now[k]).padStart(6)} ${prev ? String(prev[k]).padStart(9) : ''}${changed}`);
      }
      if (prevFile) console.log(`  previous: ${path.relative(ROOT, prevFile)}`);

      const out = path.join(PAGES, month, `${name}.html`);
      const answer = (await rl.question(`  write ${path.relative(ROOT, out)}? [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' || left.length) {
        console.log(left.length ? '  skipped: sanitize it by hand first' : '  skipped');
        continue;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, clean);
      console.log(`  wrote it. Now write ${name}.expected.json next to it from the page.`);
    }
  } finally {
    rl.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`[refresh-fixtures] ${err.message ?? err}`);
  process.exit(1);
});
