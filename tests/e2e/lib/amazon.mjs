// Fake amazon.com for the e2e harness. Every request the browser makes is
// answered here: search pages are generated or read from the corpus, product
// pages come from the corpus, and anything else gets an empty 404. Nothing
// leaves the machine.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS = path.resolve(HERE, '../../pages');

export function corpusPage(rel) {
  return fs.readFileSync(path.join(CORPUS, rel), 'utf8');
}

export function asinFor(keyword, page, i) {
  const k = keyword.replace(/[^a-z]/gi, '').toUpperCase().padEnd(3, 'X').slice(0, 3);
  return `B0${k}${String(page).padStart(2, '0')}${String(i).padStart(3, '0')}`;
}

/** One organic result card for item `i` of `page`. */
export function card(keyword, page, i) {
  const asin = asinFor(keyword, page, i);
  return `
    <div class="s-result-item" data-asin="${asin}" data-component-type="s-search-result">
      <a class="a-link-normal s-no-outline" href="/Item/dp/${asin}/ref=sr_1_${i + 1}"></a>
      <h2><span>${keyword} item ${page}-${i}</span></h2>
      <div class="a-price" data-a-size="xl"><span class="a-offscreen">$${10 + i}.${String(page).padStart(2, '0')}</span></div>
      <div data-cy="reviews-ratings-slot"><span class="a-icon-alt">4.${i} out of 5 stars</span></div>
      <a aria-label="${100 * (i + 1)} ratings" href="#customerReviews">(${100 * (i + 1)})</a>
    </div>`;
}

/**
 * A search results page in current card markup.
 * opts: per (cards per page), last (disable Next), extraCards (raw HTML).
 */
export function searchPage(keyword, page, { per = 4, last = false, extraCards = '' } = {}) {
  let cards = '';
  for (let i = 0; i < per; i++) cards += card(keyword, page, i);
  const q = encodeURIComponent(keyword).replace(/%20/g, '+');
  const next = last
    ? '<span class="s-pagination-item s-pagination-next s-pagination-disabled" aria-disabled="true">Next</span>'
    : `<a class="s-pagination-item s-pagination-next s-pagination-button" href="/s?k=${q}&amp;page=${page + 1}&amp;ref=sr_pg_${page}">Next</a>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Amazon.com : ${keyword}</title></head>
<body style="min-height:900px"><div class="s-main-slot">${cards}${extraCards}</div>
<div class="s-pagination-strip">${next}</div></body></html>`;
}

export const CAPTCHA = () => corpusPage('2026-09/captcha-synthetic.html');
export const PRODUCT = () => corpusPage('2026-09/product-dp.html');

/**
 * Routes every request of `context` to `plan`, which is called with
 * {url, keyword, page} for /s search requests and returns
 * {body, delayMs?} or null for a 404. /dp/ requests get the corpus product
 * page. Returns the log of served search pages as [{keyword, page, tab}].
 */
export async function serveAmazon(context, plan) {
  const served = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    let u;
    try { u = new URL(req.url()); } catch { return route.abort(); }
    if (u.protocol === 'chrome-extension:' || u.protocol === 'data:') return route.continue();
    if (!/(^|\.)amazon\.com$/.test(u.hostname) || req.resourceType() !== 'document') {
      return route.fulfill({ status: 404, body: '' });
    }
    if (u.pathname === '/s') {
      const keyword = u.searchParams.get('k') || '';
      const page = Number(u.searchParams.get('page') || 1);
      const out = plan({ url: u, keyword, page });
      served.push({ keyword, page });
      if (!out) return route.fulfill({ status: 404, body: '' });
      if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: out.body }).catch(() => {});
    }
    if (u.pathname.includes('/dp/')) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PRODUCT() });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  return served;
}

/** A plan serving `pages` generated pages per keyword, the last one disabled. */
export function simplePlan(pages, opts = {}) {
  return ({ keyword, page }) => (page > pages ? null : { body: searchPage(keyword, page, { ...opts, last: page >= pages }) });
}
