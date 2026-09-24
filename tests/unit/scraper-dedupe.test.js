/**
 * ASIN dedupe across the pages of one run (F-27) and null-safe deltas
 * (F-28), through the real scraper with the storage mock.
 */
const { loadContentScript } = require('../setup/dom-helpers');
const Run = require('../../scripts/lib/run');

const URL1 = 'https://www.amazon.com/s?k=w';
const URL2 = 'https://www.amazon.com/s?k=w&page=2';

const card = (asin, price, { ad = false, rating = true } = {}) => `
  <div class="s-result-item${ad ? ' AdHolder' : ''}" data-asin="${asin}" data-component-type="s-search-result">
    <a href="/dp/${asin}"><h2><span>Item ${asin}</span></h2></a>
    <div class="a-price" data-a-size="xl"><span class="a-offscreen">${price}</span></div>
    ${rating ? '<div data-cy="reviews-ratings-slot"><span class="a-icon-alt">4.5 out of 5 stars</span></div><a aria-label="1,000 ratings" href="#r">(1K)</a>' : ''}
  </div>`;
const page = (cards, next) => `<!DOCTYPE html><html><body><div class="s-main-slot">${cards}</div>${
  next ? `<a class="s-pagination-next" href="${next}">Next</a>` : '<span class="s-pagination-next s-pagination-disabled">Next</span>'
}</body></html>`;

const PAGE1 = page(card('B0A', '$5.00', { ad: true }) + card('B0B', '$2.00') + card('B0A', '$5.00'), '/s?k=w&page=2');
const PAGE2 = page(card('B0C', '$3.00') + card('B0A', '$5.00') + card('B0B', '$2.00', { rating: false }), null);

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const orig = {};
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] });
  orig.add = chrome.runtime.onMessage.addListener;
  orig.send = chrome.runtime.sendMessage;
  orig.id = chrome.runtime.id;
  chrome.runtime.id = 'test-extension';
  chrome.runtime.onMessage.addListener = () => {};
  chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'WHO_AM_I' && cb) cb({ tabId: 5 });
  };
  chrome.storage.local._reset();
});

afterEach(() => {
  chrome.runtime.onMessage.addListener = orig.add;
  chrome.runtime.sendMessage = orig.send;
  chrome.runtime.id = orig.id;
  chrome.storage.local._reset();
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function scrapeTwoPages(lastValues) {
  const run = Run.create({ runId: 'r1', tabId: 5 });
  chrome.storage.local.set({ run, scrapeRunId: 'r1', scrapeRunPageIndex: 0, isScrapingActive: true, lastValues });
  loadContentScript('scripts/content/scraper.js', PAGE1, URL1);
  await settle();
  jest.clearAllTimers();
  loadContentScript('scripts/content/scraper.js', PAGE2, URL2);
  await settle();
  return chrome.storage.local._getStore();
}

const prevRun = (priceCents) => ({ priceCents, rating: 4.5, reviewCount: 900, runId: 'r0', scrapedAt: null });

test('each ASIN is stored once per run, with every placement', async () => {
  const store = await scrapeTwoPages({});
  expect(store.results.map((r) => r.asin)).toEqual(['B0A', 'B0B', 'B0C']);
  expect(store.currentItemCount).toBe(3);
  expect(store.syncQueue.map((r) => r.asin)).toEqual(['B0A', 'B0B', 'B0C']);

  const a = store.results[0];
  expect(a.url).toBe('https://www.amazon.com/dp/B0A');
  expect(a.sponsored).toBe(true);
  expect(a.organicRank).toBe(2);
  expect(a.placements).toEqual([
    { page: 1, position: 1, sponsored: true, rank: null },
    { page: 1, position: 3, sponsored: false, rank: 2 },
    { page: 2, position: 2, sponsored: false, rank: 4 },
  ]);
  expect(store.syncQueue[0].placements).toEqual(a.placements);

  expect(store.results[2]).toMatchObject({ asin: 'B0C', organicRank: 3, sponsored: false });
  expect(store.scrapeRunPages.map((p) => [p.count, p.placements])).toEqual([[2, 3], [1, 3]]);
});

test('a repeat in the same run keeps the delta against the last run', async () => {
  const store = await scrapeTwoPages({ B0A: prevRun(600), B0B: prevRun(250) });
  const [a, b] = store.results;
  expect(a.delta).toEqual({ isNew: false, dPriceCents: -100, dRating: 0, dReviews: 100 });
  // B0B lost its rating markup on page 2; the page 1 delta stays
  expect(b.delta).toEqual({ isNew: false, dPriceCents: -50, dRating: 0, dReviews: 100 });
  expect(store.syncQueue[0].delta.dPriceCents).toBe(-100);
  expect(store.lastValues.B0B).toMatchObject({ priceCents: 200, rating: 4.5, reviewCount: 1000, runId: 'r1' });
});

test('a card with no rating gives a null delta, not a fake drop (F-28)', async () => {
  const run = Run.create({ runId: 'r1', tabId: 5 });
  chrome.storage.local.set({ run, scrapeRunId: 'r1', scrapeRunPageIndex: 0, isScrapingActive: true, lastValues: { B0B: prevRun(200) } });
  loadContentScript('scripts/content/scraper.js', page(card('B0B', '$2.00', { rating: false }), null), URL1);
  await settle();
  const store = chrome.storage.local._getStore();
  expect(store.results[0]).toMatchObject({ rating: null, reviewCount: null });
  expect(store.results[0].delta).toEqual({ isNew: false, dPriceCents: 0, dRating: null, dReviews: null });
});
