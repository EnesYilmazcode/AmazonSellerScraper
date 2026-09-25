// The on-page dock in real Chromium, against saved pages. The dock sits in
// a closed shadow root; tests/e2e/lib/dock.mjs reaches it through CDP.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test as base, expect } from '@playwright/test';
import { launch, extPage, getState, waitForState, endReason, sleep, ended } from './lib/extension.mjs';
import { serveAmazon, simplePlan, corpusPage, asinFor } from './lib/amazon.mjs';
import { dock } from './lib/dock.mjs';

const require = createRequire(import.meta.url);

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  ext: async ({}, use) => {
    const ext = await launch();
    await use(ext);
    await ext.close();
  },
});

const searchUrl = (k, p) => `https://www.amazon.com/s?k=${encodeURIComponent(k).replace(/%20/g, '+')}${p ? `&page=${p}` : ''}`;
const pagesOf = (served, k) => served.filter((p) => p.keyword === k).map((p) => p.page);

async function open(ext, url) {
  const tab = await ext.context.newPage();
  await tab.goto(url);
  const d = await dock(tab);
  await d.waitFor('.launcher');
  return { tab, d };
}

/** The id Chrome gave `tab`, asked from an extension page. */
async function tabIdOf(store, tab) {
  return store.evaluate((url) => new Promise((r) => chrome.tabs.query({ url }, (t) => r(t[0] && t[0].id))), tab.url());
}

test('the dock suggests Scrape on a saved search page, with its product count', async ({ ext }) => {
  const yoga = corpusPage('2026-09/search-yoga-mat.html');
  await serveAmazon(ext.context, () => ({ body: yoga }));
  const { d } = await open(ext, searchUrl('yoga mat'));
  expect(await d.has('.launcher.suggest')).toBe(true);
  const Parsers = require('../../scripts/lib/parsers.js');
  const { parseDoc } = require('../setup/corpus.js');
  const n = Parsers.parseSearchPage(parseDoc(yoga, searchUrl('yoga mat')), searchUrl('yoga mat')).products.length;
  expect(await d.text('.launcher')).toContain(`"yoga mat"`);
  expect(await d.text('.launcher')).toContain(`${n} products on this page`);
  expect(await d.attr('[data-k="notnow"]', 'aria-label')).toBe('Not now, hide for this tab');
});

test('Scrape in the dock runs in that tab, page by page, and completes', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(3));
  const store = await extPage(ext);
  const other = await ext.context.newPage();
  await other.goto(searchUrl('elsewhere'));
  const { tab, d } = await open(ext, searchUrl('garden hose'));
  await d.click('[data-k="scrape-quick"]');
  const s = await waitForState(store, (x) => x.scrapeRunPages?.length >= 3 && !x.isScrapingActive, { timeout: 40000 });

  expect(s.run.tabId).toBe(await tabIdOf(store, tab));
  expect(pagesOf(served, 'garden hose')).toEqual([1, 2, 3]);
  expect(pagesOf(served, 'elsewhere')).toEqual([1]);
  expect(s.results.map((r) => r.asin)).toEqual([1, 2, 3].flatMap((p) => [0, 1, 2, 3].map((i) => asinFor('garden hose', p, i))));
  expect(endReason(s)).toBe('complete');

  // The last page's dock rebuilt itself from the worker and shows the result.
  const after = await dock(tab);
  await after.waitForText(/12 products saved/, { timeout: 10000 });
  await after.waitForText(/Reached the last page\. Page 3 was the last one/);
  expect(await after.count('.ticks i.skip')).toBe(17);
});

test('Stop in the dock halts the run before the next page', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(4));
  const store = await extPage(ext);
  const { tab, d } = await open(ext, searchUrl('stop me'));
  await d.click('[data-k="launcher"]');
  await d.waitFor('[data-k="scrape"]');
  await d.click('[data-k="scrape"]');
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 1, { timeout: 15000, interval: 100 });
  const live = await dock(tab);
  await live.waitFor('[data-k="stop"]');
  expect(await live.text('[data-k="stop"]')).toMatch(/Stop and keep 4 products/);
  await live.click('[data-k="stop"]');
  await sleep(4500);
  const s = await getState(store);

  expect(s.isScrapingActive).toBe(false);
  expect(endReason(s)).toBe('stopped');
  expect(pagesOf(served, 'stop me')).toEqual([1]);
  await live.waitForText(/Stopped with 4 products/);
});

test('a product page gets the plain launcher and no Scrape; the cart gets no dock', async ({ ext }) => {
  await serveAmazon(ext.context, simplePlan(1));
  const { tab, d } = await open(ext, 'https://www.amazon.com/dp/B09B8V1LZ3');
  expect(await d.has('.launcher.plain')).toBe(true);
  expect(await d.has('[data-k="scrape-quick"]')).toBe(false);
  await d.click('[data-k="launcher"]');
  await d.waitForText(/Open a search or a storefront/);
  expect(await d.has('[data-k="scrape"]')).toBe(false);

  await ext.context.route('https://www.amazon.com/gp/cart/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><h1>Cart</h1></body></html>' }));
  await tab.goto('https://www.amazon.com/gp/cart/view.html');
  await sleep(1200);
  expect(await (await dock(tab)).present()).toBe(false);
});

test('Not now hides the suggestion for the rest of the tab, not in a new tab', async ({ ext }) => {
  await serveAmazon(ext.context, simplePlan(2));
  const { tab, d } = await open(ext, searchUrl('dismiss'));
  await d.click('[data-k="notnow"]');
  await d.waitFor('.launcher.plain');
  await tab.goto(searchUrl('dismiss', 2));
  const again = await dock(tab);
  await again.waitFor('.launcher');
  expect(await again.has('.launcher.plain')).toBe(true);

  const fresh = await open(ext, searchUrl('dismiss'));
  expect(await fresh.d.has('.launcher.suggest')).toBe(true);
});

test('Download Excel in the dock saves the run through chrome.downloads', async ({ ext }) => {
  await serveAmazon(ext.context, simplePlan(2));
  const store = await extPage(ext);
  const { tab, d } = await open(ext, searchUrl('export me'));
  await d.click('[data-k="scrape-quick"]');
  await waitForState(store, (x) => ended(x) && x.scrapeRunPages?.length >= 2, { timeout: 40000 });
  const done = await dock(tab);
  await done.waitFor('[data-k="xlsx"]', { timeout: 10000 });
  await done.click('[data-k="xlsx"]');
  await done.waitForText(/Excel download started/, { timeout: 15000 });
  await done.click('[data-k="csv"]');
  await done.waitForText(/CSV download started/, { timeout: 15000 });

  const items = await store.evaluate(async () => {
    const shape = (f) => ({ url: f.url.slice(0, 60), mime: f.mime, state: f.state, error: f.error || null, bytes: f.totalBytes, file: f.filename });
    for (let i = 0; i < 40; i++) {
      const found = await chrome.downloads.search({});
      if (found.length >= 2 && found.every((f) => f.state !== 'in_progress')) return found.map(shape);
      await new Promise((r) => setTimeout(r, 250));
    }
    return (await chrome.downloads.search({})).map(shape);
  });
  // Playwright keeps downloads under its own names, so check type and bytes.
  expect(items.map((i) => [i.mime, i.state, i.error]).sort()).toEqual([
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'complete', null],
    ['text/csv', 'complete', null],
  ]);
  const csv = fs.readFileSync(items.find((i) => i.mime === 'text/csv').file, 'utf8');
  expect(csv).toContain(asinFor('export me', 2, 3));
  const xlsx = fs.readFileSync(items.find((i) => i.mime !== 'text/csv').file);
  expect(xlsx.subarray(0, 2).toString()).toBe('PK');
});
