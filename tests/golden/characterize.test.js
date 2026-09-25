/**
 * @jest-environment node
 *
 * Records what today's code does on every corpus page, bugs included, so
 * refactors can prove they changed nothing. The snapshot is the contract:
 * update it only in a commit that means to change behavior.
 */
const { loadContentScript } = require('../setup/dom-helpers');
const { createRig, settle } = require('../setup/engine-rig');
const { corpus } = require('../setup/corpus');
const Analyzer = require('../../scripts/modules/analyzer');
const Price = require('../../scripts/modules/price');
const Run = require('../../scripts/lib/run');

const PAGES = corpus();
const PRICE_STRINGS = [
  '$19.99', '$1,299.00', '$12.99 - $24.99', '$19.99 ($0.33/Ounce)', 'See price in cart',
  '€19,99', 'CDN$ 24.99', '$0.00', 'FREE', '$24.99 + $5.99 shipping', '$1.005',
  'Was: $30.00 Now: $20.00', 'N/A', '', null, 19.99,
];

beforeAll(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterAll(() => jest.useRealTimers());

function attempt(fn) {
  try { return fn(); } catch (e) { return `throws ${e.constructor.name}`; }
}

/**
 * Starts a run on the page through the service worker engine and the real
 * content script (tests/setup/engine-rig.js), then lets the page delay pass
 * once to see where the run goes next. Other pages answer 404.
 */
async function runScrape(page) {
  const rig = createRig({ site: (url) => (url === page.expected.url ? page.html : null), random: () => 0 });
  const tabId = rig.openTab(page.expected.url);
  await settle();
  const started = await rig.popup({ type: 'START_RUN', tabId });
  await settle();
  const st = await rig.popup({ type: 'GET_STATE' });
  const sent = rig.sent.map((m) => m.type);
  const before = st.run || {};
  await settle(4000);
  const nav = rig.served.slice(1).map((s) => `[ProScan] Navigating to next page: ${s.url}`);
  const ctx = rig.tabCtx(tabId);
  const runId = before.runId;
  return {
    started: started.ok ? 'started' : started.error,
    sent,
    nav,
    isScrapingActive: Run.isActive(before),
    runStatus: before.reason || before.state || null,
    runPage: before.page || 0,
    currentItemCount: before.itemCount || 0,
    runPages: (st.pages || []).map(({ pageIndex, count, url }) => ({ pageIndex, count, url })),
    results: (st.results || []).map(({ n, ...r }) => ({
      ...r, runId: r.runId === runId ? 'run-golden' : r.runId, scrapedAt: typeof r.scrapedAt,
    })),
    helpers: ctx ? {
      total: ctx.getTotalResults(),
      hasNext: ctx.hasNextPage(),
      nextUrl: ctx.getNextPageUrl(),
    } : null,
  };
}

describe('current scraper behavior on the corpus', () => {
  test.each(PAGES.map((p) => [p.id, p]))('%s', async (_id, page) => {
    expect(await runScrape(page)).toMatchSnapshot();
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
