// Pagination in real Chromium (audit report 6.2, layer 3).
//
// Each scenario first checks the setup worked, then calls bug() right before
// the checks today's code fails, so a broken harness still fails loudly while
// a known bug counts as an expected failure. When a fix lands, Playwright
// reports the scenario as "expected to fail, but passed": delete the bug()
// line then. PROSCAN_SHOW_KNOWN=1 shows what the known failures fail on.
import { createRequire } from 'node:module';
import { test as base, expect } from '@playwright/test';
import {
  launch, extPage, getState, clickStart, aimPopupAt, waitForState, endReason,
  runMetaFor, killServiceWorker, sleep,
} from './lib/extension.mjs';
import { serveAmazon, simplePlan, searchPage, card, asinFor, corpusPage, CAPTCHA } from './lib/amazon.mjs';

const require = createRequire(import.meta.url);

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  ext: async ({}, use) => {
    const ext = await launch();
    await use(ext);
    await ext.close();
  },
});

// PROSCAN_SHOW_KNOWN=1 runs known failures as normal tests to see their errors.
function bug(fid, what) {
  test.fail(!process.env.PROSCAN_SHOW_KNOWN, `${fid}: ${what}`);
}

const searchUrl = (keyword, page) =>
  `https://www.amazon.com/s?k=${encodeURIComponent(keyword).replace(/%20/g, '+')}${page ? `&page=${page}` : ''}`;

async function openSearch(ext, keyword) {
  const tab = await ext.context.newPage();
  await tab.goto(searchUrl(keyword));
  await sleep(800);
  return tab;
}

const pagesOf = (served, keyword) => served.filter((p) => p.keyword === keyword).map((p) => p.page);
const allAsins = (keyword, pages, per = 4) =>
  pages.flatMap((p) => Array.from({ length: per }, (_, i) => asinFor(keyword, p, i)));

test('a clean 3 page run scrapes every page once and completes', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(3));
  const tab = await openSearch(ext, 'garden hose');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  const s = await waitForState(store, (x) => x.scrapeRunPages?.length >= 3 && !x.isScrapingActive, { timeout: 30000 });

  expect(pagesOf(served, 'garden hose')).toEqual([1, 2, 3]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('garden hose', [1, 2, 3]));
  expect(s.results[0]).toMatchObject({ priceCents: 1001, rating: 4, reviewCount: 100 });
  expect(s.scrapeRunPages.map((p) => p.pageIndex)).toEqual([1, 2, 3]);
  expect(endReason(s)).toBe('complete');
});

test('real markup: Chromium scrapes the saved yoga mat page like the parser does', async ({ ext }) => {
  const yoga = corpusPage('2026-09/search-yoga-mat.html');
  const last = corpusPage('2026-02/search-lastpage.html');
  const served = await serveAmazon(ext.context, ({ page }) => ({ body: page === 1 ? yoga : last }));
  const tab = await openSearch(ext, 'yoga mat');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  const s = await waitForState(store, (x) => x.scrapeRunPages?.length >= 2 && !x.isScrapingActive, { timeout: 30000 });

  expect(pagesOf(served, 'yoga mat')).toEqual([1, 2]);
  const page1 = s.results.filter((r) => r.pageIndex === 1);

  const Parsers = require('../../scripts/lib/parsers.js');
  const { parseDoc } = require('../setup/corpus.js');
  const golden = Parsers.parseSearchPage(parseDoc(yoga, searchUrl('yoga mat')), searchUrl('yoga mat')).products;
  expect(page1.map((r) => r.asin)).toEqual(golden.map((r) => r.asin));
  expect(page1.map((r) => r.priceCents)).toEqual(golden.map((r) => r.priceCents));
  expect(page1.map((r) => r.url)).toEqual(golden.map((r) => r.url));
  const fill = Parsers.fillRates(page1);
  expect(fill.title).toBeGreaterThanOrEqual(0.9);
  expect(fill.price).toBeGreaterThanOrEqual(0.9);

  bug('F-27', 'repeats and carousel cards are stored as products');
  expect(new Set(page1.map((r) => r.asin)).size).toBe(page1.length);
});

test('a captcha at page 2 ends the run as blocked', async ({ ext }) => {
  const served = await serveAmazon(ext.context, ({ keyword, page }) =>
    page === 2 ? { body: CAPTCHA() } : { body: searchPage(keyword, page, { last: page >= 4 }) });
  const tab = await openSearch(ext, 'usb cable');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  const s = await waitForState(store, (x) => !x.isScrapingActive && x.scrapeRunPages?.length >= 1, { timeout: 30000 });
  await sleep(2500);

  expect(pagesOf(served, 'usb cable')).toEqual([1, 2]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('usb cable', [1]));

  bug('F-12', 'a captcha page ends the run as complete');
  expect(endReason(s)).toBe('blocked');
});

test('duplicates across pages are stored once', async ({ ext }) => {
  const sponsored = `
    <div class="s-result-item AdHolder" data-asin="B0SPONSOR1" data-component-type="s-search-result">
      <a class="a-link-normal s-no-outline" href="/sspa/click?ie=UTF8&amp;url=%2Fdp%2FB0SPONSOR1"></a>
      <span class="puis-sponsored-label-text">Sponsored</span>
      <h2><span>Sponsored widget</span></h2>
      <div class="a-price" data-a-size="xl"><span class="a-offscreen">$5.00</span></div>
    </div>`;
  const repeat = (page) => (page > 1 ? card('dupes', 1, 0) : '');
  const served = await serveAmazon(ext.context, ({ keyword, page }) =>
    ({ body: searchPage(keyword, page, { last: page >= 3, extraCards: sponsored + repeat(page) }) }));
  const tab = await openSearch(ext, 'dupes');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  const s = await waitForState(store, (x) => x.scrapeRunPages?.length >= 3 && !x.isScrapingActive, { timeout: 30000 });

  expect(pagesOf(served, 'dupes')).toEqual([1, 2, 3]);
  const asins = s.results.map((r) => r.asin);
  expect(asins).toEqual(expect.arrayContaining([...allAsins('dupes', [1, 2, 3]), 'B0SPONSOR1']));

  bug('F-27', 'no ASIN dedupe within or across pages');
  expect(asins.length).toBe(new Set(asins).size);
});

test('Stop halts the run before the next page loads', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(4));
  const tab = await openSearch(ext, 'stop me');
  const store = await extPage(ext);
  const popup = await clickStart(ext, tab);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 1, { timeout: 15000, interval: 100 });
  await popup.click('#actionButton');
  await sleep(4500);
  const s = await getState(store);

  expect(s.isScrapingActive).toBe(false);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('stop me', [1]));

  bug('F-13', 'the pending navigation still fires and the run is never finalized as stopped');
  expect(pagesOf(served, 'stop me')).toEqual([1]);
  expect(endReason(s)).toBe('stopped');
});

test('a second search tab opened mid-run does not join the run', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(3));
  const tab = await openSearch(ext, 'alpha');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 1, { timeout: 15000, interval: 100 });
  const other = await ext.context.newPage();
  await other.goto(searchUrl('beta'));
  const s = await waitForState(store, (x) => !x.isScrapingActive, { timeout: 30000 });
  await sleep(2500);

  expect(pagesOf(served, 'beta')[0]).toBe(1);

  bug('F-11', 'every Amazon tab reads the one global flag and scrapes into the run');
  expect(s.results.filter((r) => r.name.startsWith('beta'))).toEqual([]);
  expect(pagesOf(served, 'alpha')).toEqual([1, 2, 3]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('alpha', [1, 2, 3]));
});

test('a product page opened mid-run does not end the run', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(3));
  const tab = await openSearch(ext, 'gamma');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 1, { timeout: 15000, interval: 100 });
  const product = await ext.context.newPage();
  await product.goto('https://www.amazon.com/dp/B09B8V1LZ3');
  await sleep(6000);
  const s = await waitForState(store, (x) => !x.isScrapingActive, { timeout: 30000 });

  expect(await product.title()).not.toBe('');

  bug('F-11', 'a tab with zero listings ends the run for everyone');
  expect(pagesOf(served, 'gamma')).toEqual([1, 2, 3]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('gamma', [1, 2, 3]));
});

test('a slow page is scraped once and the run still completes', async ({ ext }) => {
  const served = await serveAmazon(ext.context, ({ keyword, page }) =>
    ({ body: searchPage(keyword, page, { last: page >= 3 }), delayMs: page === 2 ? 4000 : 0 }));
  const tab = await openSearch(ext, 'slow');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  const s = await waitForState(store, (x) => x.scrapeRunPages?.length >= 3 && !x.isScrapingActive, { timeout: 40000 });
  await sleep(1000);

  expect(pagesOf(served, 'slow')).toEqual([1, 2, 3]);
  expect(s.scrapeRunPages.map((p) => p.pageIndex)).toEqual([1, 2, 3]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('slow', [1, 2, 3]));
  expect(endReason(s)).toBe('complete');
});

test('a full storage quota fails the run loudly', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(2));
  const store = await extPage(ext);
  // Fill storage with queued products until about 2 KB is left.
  const left = await store.evaluate(async () => {
    const one = { name: 'x'.repeat(100), asin: 'B0FILL0000', price: '$1.00', priceCents: 100, url: 'https://www.amazon.com/dp/B0FILL0000', scrapedAt: new Date().toISOString(), runId: 'old' };
    const quota = chrome.storage.local.QUOTA_BYTES;
    const per = JSON.stringify(one).length + 1;
    let n = Math.floor((quota - 4096) / per);
    for (;;) {
      try { await chrome.storage.local.set({ syncQueue: Array.from({ length: n }, () => one) }); break; } catch { n -= 50; }
    }
    return quota - await chrome.storage.local.getBytesInUse(null);
  });
  expect(left).toBeLessThan(4096);

  const tab = await openSearch(ext, 'full disk');
  await clickStart(ext, tab);
  const s = await waitForState(store, (x) => !x.isScrapingActive, { timeout: 30000 });
  await sleep(2500);

  expect(pagesOf(served, 'full disk').length).toBeGreaterThanOrEqual(1);

  bug('F-26', 'storage writes ignore lastError, so the run reports complete with nothing saved');
  expect(endReason(s)).toBe('storage_full');
});

test('two runs without an export keep their own attribution', async ({ ext }) => {
  await serveAmazon(ext.context, simplePlan(2));
  const store = await extPage(ext);

  const tab1 = await openSearch(ext, 'garden hose');
  await clickStart(ext, tab1);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 2 && !x.isScrapingActive, { timeout: 30000 });

  const tab2 = await openSearch(ext, 'yoga mat');
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extId}/popup/popup.html`);
  await aimPopupAt(popup, tab2);
  await popup.click('#actionButton');
  await sleep(300);
  const s = await waitForState(store, (x) => x.scrapeRunPages?.length >= 2 && !x.isScrapingActive &&
    (x.syncQueue || []).length >= 16, { timeout: 30000 });

  const runIds = [...new Set(s.syncQueue.map((p) => p.runId))];
  expect(runIds).toHaveLength(2);

  bug('F-20', 'only the newest run keeps its source; older queued items lose theirs');
  for (const item of s.syncQueue) {
    const meta = runMetaFor(s, item.runId);
    expect(meta && meta.keyword).toBe(item.name.startsWith('garden hose') ? 'garden hose' : 'yoga mat');
  }
});

test('a service worker stopped between pages does not break the run', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(3));
  const tab = await openSearch(ext, 'sleepy');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 1, { timeout: 15000, interval: 100 });
  expect(await killServiceWorker(ext, tab)).toBe(true);

  const s = await waitForState(store, (x) => x.scrapeRunPages?.length >= 3 && !x.isScrapingActive, { timeout: 30000 });
  expect(pagesOf(served, 'sleepy')).toEqual([1, 2, 3]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('sleepy', [1, 2, 3]));
  expect(endReason(s)).toBe('complete');
});
