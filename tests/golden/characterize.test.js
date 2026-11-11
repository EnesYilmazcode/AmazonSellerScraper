/**
 * Records what today's code does on every corpus page, bugs included, so
 * refactors can prove they changed nothing. The snapshot is the contract:
 * update it only in a commit that means to change behavior.
 */
const { loadContentScript } = require('../setup/dom-helpers');
const { corpus } = require('../setup/corpus');
const Analyzer = require('../../scripts/modules/analyzer');
const Price = require('../../scripts/modules/price');

const PAGES = corpus();
const PRICE_STRINGS = [
  '$19.99', '$1,299.00', '$12.99 - $24.99', '$19.99 ($0.33/Ounce)', 'See price in cart',
  '€19,99', 'CDN$ 24.99', '$0.00', 'FREE', '$24.99 + $5.99 shipping', '$1.005',
  'Was: $30.00 Now: $20.00', 'N/A', '', null, 19.99,
];

// Fake timers keep the 2 second page navigation from firing.
beforeAll(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] }));
afterAll(() => jest.useRealTimers());

function attempt(fn) {
  try { return fn(); } catch (e) { return `throws ${e.constructor.name}`; }
}

function runScrape(page) {
  let listener = null;
  const sent = [];
  const origAdd = chrome.runtime.onMessage.addListener;
  const origSend = chrome.runtime.sendMessage;
  chrome.runtime.onMessage.addListener = (fn) => { listener = fn; };
  chrome.runtime.sendMessage = (msg) => { sent.push(msg.type); };
  chrome.storage.local._reset();
  try {
    const ctx = loadContentScript('scripts/content/scraper.js', page.html, page.expected.url);
    chrome.storage.local.set({ scrapeRunId: 'run-golden', scrapeRunPageIndex: 0 });
    listener({ type: 'START_SCRAPING' }, {}, () => {});
    const store = chrome.storage.local._getStore();
    const nav = ctx.console.log.mock.calls.map((c) => c[0]).filter((l) => /Navigating/.test(l));
    return {
      sent,
      nav,
      isScrapingActive: store.isScrapingActive,
      currentItemCount: store.currentItemCount,
      runPages: (store.scrapeRunPages || []).map(({ pageIndex, count, url }) => ({ pageIndex, count, url })),
      results: (store.results || []).map((r) => ({ ...r, scrapedAt: typeof r.scrapedAt })),
      helpers: {
        total: ctx.getTotalResults(),
        hasNext: ctx.hasNextPage(),
        nextUrl: ctx.getNextPageUrl(),
      },
    };
  } finally {
    chrome.storage.local._reset();
    chrome.runtime.onMessage.addListener = origAdd;
    chrome.runtime.sendMessage = origSend;
    jest.clearAllTimers();
  }
}

describe('current scraper behavior on the corpus', () => {
  test.each(PAGES.map((p) => [p.id, p]))('%s', (_id, page) => {
    expect(runScrape(page)).toMatchSnapshot();
  });
});

describe('current offer parsing on the corpus', () => {
  let ctx;
  beforeAll(() => {
    ctx = loadContentScript('scripts/content/offer-fetcher.js', '<!DOCTYPE html><html><body></body></html>', 'https://www.amazon.com/s?k=x');
  });

  test.each(PAGES.map((p) => [p.id, p]))('%s', (_id, page) => {
    const doc = new ctx.DOMParser().parseFromString(page.html, 'text/html');
    expect(ctx.extractPricesFromDocument(doc)).toMatchSnapshot();
  });

  test('urls', () => {
    expect([ctx.buildAodUrl('B0TEST0001'), ctx.buildOfferUrl('B0TEST0001')]).toMatchSnapshot();
  });
});

describe('current price, rating and review parsers', () => {
  let scraper;
  let offers;
  beforeAll(() => {
    const blank = '<!DOCTYPE html><html><body></body></html>';
    scraper = loadContentScript('scripts/content/scraper.js', blank);
    offers = loadContentScript('scripts/content/offer-fetcher.js', blank);
  });

  test('price strings', () => {
    const rows = PRICE_STRINGS.map((s) => ({
      input: s,
      offer: attempt(() => offers.parseOfferPrice(s)),
      analyzer: attempt(() => Analyzer.parsePrice(s)),
      cents: Price.priceToCents(s),
    }));
    expect(rows).toMatchSnapshot();
  });

  test('rating and review strings', () => {
    const inputs = ['4.5 out of 5 stars', '4.7', '', null, '(108.3K)', '(1.2M)', '(64)', '12,847', 'N/A', 'calificaciones'];
    const rows = inputs.map((s) => ({
      input: s,
      ratingText: scraper.parseRatingText(s),
      reviewText: scraper.parseReviewText(s),
      analyzerRating: Analyzer.parseRating(s),
      analyzerReviews: Analyzer.parseReviewCount(s),
    }));
    expect(rows).toMatchSnapshot();
  });
});
