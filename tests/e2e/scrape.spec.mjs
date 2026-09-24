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
  runMetaFor, killServiceWorker, enableDeveloperMode, sleep, ended, seedRun, workerTargets,
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

  expect(new Set(page1.map((r) => r.asin)).size).toBe(page1.length);
  expect(page1.filter((r) => r.sponsored).length).toBe(12);
  expect(page1.filter((r) => /\/sspa\//.test(r.url))).toEqual([]);
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

  expect(asins.length).toBe(new Set(asins).size);
  const ad = s.results.find((r) => r.asin === 'B0SPONSOR1');
  expect(ad).toMatchObject({ sponsored: true, organicRank: null, url: 'https://www.amazon.com/dp/B0SPONSOR1' });
  expect(ad.placements.map((pl) => pl.page)).toEqual([1, 2, 3]);
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

// Run data lives in IndexedDB now. Chrome gives an extension origin most of
// the disk and ignores a CDP quota override for it (checked: the override
// reports active, and a 200 KB write under a 1 KB quota still commits), so
// a real quota error cannot be forced here. engine.test.js covers the
// storage_full path; this breaks the database for real instead.
test('a page that cannot be saved fails the run loudly (F-26)', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(4));
  const tab = await openSearch(ext, 'full disk');
  const store = await extPage(ext);
  const popup = await clickStart(ext, tab);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 1, { timeout: 15000, interval: 100 });
  // A newer schema from elsewhere: the worker's connection closes and it can no longer open version 1.
  await store.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('proscan', 99);
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  }));
  await sleep(6000);
  const run = await popup.evaluate(async () => (await chrome.storage.session.get('run')).run);

  expect(pagesOf(served, 'full disk')).toEqual([1, 2]);
  expect(run).toMatchObject({ state: 'failed', reason: 'storage_error', page: 1 });
  await expect(popup.locator('#status')).toContainText(/could not save a page/);
});

const Flags = require('../../scripts/lib/flags.js');

/** Scrapes 2 pages of "garden hose" in one tab, then 2 of "yoga mat" in another. */
async function twoRuns(ext, store, done = () => true) {
  const tab1 = await openSearch(ext, 'garden hose');
  await clickStart(ext, tab1);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 2 && !x.isScrapingActive, { timeout: 30000 });

  const tab2 = await openSearch(ext, 'yoga mat');
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extId}/popup/popup.html`);
  await aimPopupAt(popup, tab2);
  await popup.click('#actionButton');
  await sleep(300);
  return waitForState(store, (x) => x.scrapeRunPages?.length >= 2 && !x.isScrapingActive &&
    (x.results || []).some((r) => r.name.startsWith('yoga mat')) && done(x), { timeout: 30000 });
}

test('with cloud sync off, two runs queue nothing and keep their deltas (F-26)', async ({ ext }) => {
  test.skip(Flags.CLOUD_SYNC, 'cloud sync is on in this build');
  await serveAmazon(ext.context, simplePlan(2));
  const store = await extPage(ext);
  const s = await twoRuns(ext, store);

  expect(s.results.map((r) => r.asin)).toEqual(allAsins('yoga mat', [1, 2]));
  expect(s).not.toHaveProperty('syncQueue');
  expect(s.outbox).toEqual([]);
  expect(Object.keys(s.lastValues).sort()).toEqual([...allAsins('garden hose', [1, 2]), ...allAsins('yoga mat', [1, 2])].sort());
});

test('with cloud sync off, the popup shows no sign-in and no Export to ProScan', async ({ ext }) => {
  test.skip(Flags.CLOUD_SYNC, 'cloud sync is on in this build');
  const popup = await extPage(ext);
  await sleep(500);
  await expect(popup.locator('#actionButton')).toBeVisible();
  await expect(popup.locator('#authPanel')).toBeHidden();
  await expect(popup.locator('#exportToProScanBtn')).toBeHidden();
  const resp = await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'PROSCAN_EXPORT' }, r)));
  expect(resp.error).toMatch(/not available/);
});

test('two runs without an export keep their own attribution', async ({ ext }) => {
  test.skip(!Flags.CLOUD_SYNC, 'F-20: cloud sync is off until 2.3, so nothing is queued to attribute');
  await serveAmazon(ext.context, simplePlan(2));
  const store = await extPage(ext);
  const s = await twoRuns(ext, store, (x) => (x.outbox || []).length >= 4);

  const runIds = [...new Set(s.outbox.map((p) => p.runId))];
  expect(runIds).toHaveLength(2);
  for (const runId of runIds) {
    expect(runMetaFor(s, runId)).toBeTruthy();
  }
});

test('a service worker stopped between pages does not break the run', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(3));
  const tab = await openSearch(ext, 'sleepy');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 1, { timeout: 15000, interval: 100 });
  expect(await killServiceWorker(ext, tab)).toBe(true);
  // The pending page lived in the dead worker's timer. Nothing here wakes
  // it: the state reads go straight to storage, so the tab's heartbeat must.
  const s = await waitForState(store, (x) => x.scrapeRunPages?.length >= 3 && !x.isScrapingActive, { timeout: 30000 });
  expect(pagesOf(served, 'sleepy')).toEqual([1, 2, 3]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('sleepy', [1, 2, 3]));
  expect(endReason(s)).toBe('complete');
});

test('the page cap in settings ends the run as complete', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(5));
  const store = await extPage(ext);
  await store.evaluate(() => chrome.storage.local.set({ settings: { pageDelay: 2000, maxPages: 2 } }));
  const tab = await openSearch(ext, 'capped');
  await clickStart(ext, tab);
  const s = await waitForState(store, ended, { timeout: 30000 });
  await sleep(4500);

  expect(pagesOf(served, 'capped')).toEqual([1, 2]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('capped', [1, 2]));
  expect(endReason(s)).toBe('complete');
});

test('Start on a captcha page changes nothing and says why', async ({ ext }) => {
  await serveAmazon(ext.context, () => ({ body: CAPTCHA() }));
  const store = await extPage(ext);
  await seedRun(store, [{ asin: 'B0KEEP0001', name: 'kept' }]);
  const tab = await openSearch(ext, 'robot');
  const popup = await clickStart(ext, tab);
  await sleep(1000);
  const s = await getState(store);

  expect(s.results.map((r) => r.asin)).toEqual(['B0KEEP0001']);
  expect(s.run.runId).toBe('seeded');
  expect(s.isScrapingActive).toBeFalsy();
  expect(await popup.textContent('#status')).toMatch(/captcha/);
});

test('Start on a tab left over from an update offers a reload, then runs', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(2));
  const tab = await openSearch(ext, 'orphan');
  const before = await extPage(ext);
  await seedRun(before, [{ asin: 'B0KEEP0001', name: 'kept' }]);

  // Reloading the extension orphans the content script already in the tab,
  // as a Chrome Web Store update does.
  await enableDeveloperMode(ext);
  await ext.sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await sleep(3000);
  const store = await extPage(ext);
  const popup = await clickStart(ext, tab);
  await sleep(1000);
  let s = await getState(store);

  expect(s.results.map((r) => r.asin)).toEqual(['B0KEEP0001']);
  expect(s.isScrapingActive).toBeFalsy();
  expect(await popup.isVisible('#reloadTabButton')).toBe(true);

  await popup.click('#reloadTabButton');
  s = await waitForState(store, (x) => ended(x) && x.run.runId !== 'seeded', { timeout: 30000 });

  expect(pagesOf(served, 'orphan')).toEqual([1, 1, 2]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('orphan', [1, 2]));
  expect(endReason(s)).toBe('complete');
});

test('a new search typed in the run tab ends the run and is not scraped into it', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(3));
  const tab = await openSearch(ext, 'first');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 1, { timeout: 15000, interval: 100 });
  await tab.goto(searchUrl('second'));
  const s = await waitForState(store, (x) => x.run && x.run.status !== 'running', { timeout: 15000 });
  await sleep(5000);

  expect(pagesOf(served, 'second')).toEqual([1]);
  expect(pagesOf(served, 'first')).toEqual([1]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('first', [1]));
  expect(endReason(s)).toBe('interrupted');
});

test('a run tab that left Amazon and comes back after a minute does not resume', async ({ ext }) => {
  const served = await serveAmazon(ext.context, simplePlan(3));
  const tab = await openSearch(ext, 'wander');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  await waitForState(store, (x) => x.scrapeRunPages?.length >= 1, { timeout: 15000, interval: 100 });
  // Answered locally like every other request.
  await tab.route('https://example.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>elsewhere</p>' }));
  await tab.goto('https://example.com/');
  // Age the heartbeat instead of waiting out the 60 s.
  await store.evaluate(async () => {
    const { run } = await chrome.storage.local.get('run');
    await chrome.storage.local.set({ run: { ...run, heartbeat: Date.now() - 120000 } });
  });
  await tab.goto(searchUrl('wander', 2));
  const s = await waitForState(store, (x) => x.run && x.run.status !== 'running', { timeout: 15000 });
  await sleep(5000);

  expect(pagesOf(served, 'wander')).toEqual([1, 2]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('wander', [1]));
  expect(endReason(s)).toBe('interrupted');
});

test('a 503 error page at page 2 ends the run as a warning, not complete', async ({ ext }) => {
  const dog = '<!DOCTYPE html><html><head><title>Sorry! Something went wrong!</title></head>'
    + '<body><b>Sorry! Something went wrong on our end.</b><img alt="Dogs of Amazon"></body></html>';
  const served = await serveAmazon(ext.context, ({ keyword, page }) =>
    page === 2 ? { body: dog } : { body: searchPage(keyword, page, { last: page >= 4 }) });
  const tab = await openSearch(ext, 'throttled');
  const store = await extPage(ext);
  await clickStart(ext, tab);
  const s = await waitForState(store, (x) => x.run && x.run.status !== 'running', { timeout: 30000 });
  await sleep(2500);

  expect(pagesOf(served, 'throttled')).toEqual([1, 2]);
  expect(s.results.map((r) => r.asin)).toEqual(allAsins('throttled', [1]));
  expect(endReason(s)).toBe('selectors_broken');
});
