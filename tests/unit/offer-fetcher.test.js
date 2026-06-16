const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadContentScript, wrapHTML } = require('../setup/dom-helpers');

const aodHTML = fs.readFileSync(
  path.join(__dirname, '../fixtures/amazon-offer-aod.html'), 'utf8'
);
const classicHTML = fs.readFileSync(
  path.join(__dirname, '../fixtures/amazon-offer-classic.html'), 'utf8'
);

describe('offer-fetcher.js', () => {
  let ctx;

  beforeAll(() => {
    // Load offer-fetcher in a minimal Amazon page context
    ctx = loadContentScript(
      'scripts/content/offer-fetcher.js',
      wrapHTML('<div></div>'),
      'https://www.amazon.com/s?k=test'
    );
  });

  // ── parseOfferPrice ────��────────────────────────────────────
  describe('parseOfferPrice', () => {
    test('parses "$19.99" -> 19.99', () => {
      expect(ctx.parseOfferPrice('$19.99')).toBe(19.99);
    });

    test('parses "$1,299.00" -> 1299.00', () => {
      expect(ctx.parseOfferPrice('$1,299.00')).toBe(1299);
    });

    test('returns 0 for null', () => {
      expect(ctx.parseOfferPrice(null)).toBe(0);
    });

    test('returns 0 for empty string', () => {
      expect(ctx.parseOfferPrice('')).toBe(0);
    });

    test('returns 0 for non-numeric text', () => {
      expect(ctx.parseOfferPrice('not a price')).toBe(0);
    });
  });

  // ── buildOfferUrl ──────────────���────────────────────────────
  describe('buildOfferUrl', () => {
    test('constructs correct URL with ASIN', () => {
      const url = ctx.buildOfferUrl('B0TEST001');
      expect(url).toContain('B0TEST001');
      expect(url).toContain('offer-listing');
    });

    test('includes condition=new parameter', () => {
      const url = ctx.buildOfferUrl('B0TEST001');
      expect(url).toContain('condition=new');
    });
  });

  // ── buildAodUrl ─────────��───────────────────────────────────
  describe('buildAodUrl', () => {
    test('constructs correct AOD AJAX URL with ASIN', () => {
      const url = ctx.buildAodUrl('B0TEST001');
      expect(url).toContain('asin=B0TEST001');
      expect(url).toContain('gp/aod/ajax');
    });

    test('includes condition=new parameter', () => {
      // The AOD endpoint must filter to new offers like buildOfferUrl does,
      // or used/refurbished prices pollute the spread distribution.
      const url = ctx.buildAodUrl('B0TEST001');
      expect(url).toContain('condition=new');
    });
  });

  // ─��� extractPricesFromDocument ───���───────────────────────────
  describe('extractPricesFromDocument', () => {
    test('extracts 5 prices from AOD fixture', () => {
      const dom = new JSDOM(aodHTML);
      const prices = ctx.extractPricesFromDocument(dom.window.document);
      expect(prices.length).toBe(5);
      expect(prices).toContain(24.99);
      expect(prices).toContain(31.50);
      expect(prices).toContain(27.00);
      expect(prices).toContain(22.99);
      expect(prices).toContain(35.00);
    });

    test('extracts prices from classic #olpOfferList fixture', () => {
      const dom = new JSDOM(classicHTML);
      const prices = ctx.extractPricesFromDocument(dom.window.document);
      expect(prices.length).toBeGreaterThanOrEqual(3);
      expect(prices).toContain(22.50);
      expect(prices).toContain(28.00);
      expect(prices).toContain(19.99);
    });

    test('stops at first successful selector strategy (no double-counting)', () => {
      const dom = new JSDOM(classicHTML);
      const prices = ctx.extractPricesFromDocument(dom.window.document);
      // classic HTML has 3 olpOfferList prices — should stop there, not include legacy olpOfferPrice
      expect(prices.length).toBe(3);
    });

    test('preserves duplicate seller prices (each seller is a data point)', () => {
      // Two distinct sellers legitimately listing the same price are two
      // real data points for spread stats — they must NOT be deduped.
      const html = wrapHTML(`
        <div class="aod-information-block">
          <div class="a-price"><span class="a-offscreen">$10.00</span></div>
        </div>
        <div class="aod-information-block">
          <div class="a-price"><span class="a-offscreen">$10.00</span></div>
        </div>
      `);
      const dom = new JSDOM(html);
      const prices = ctx.extractPricesFromDocument(dom.window.document);
      expect(prices.length).toBe(2);
      expect(prices).toEqual([10, 10]);
    });

    test('general fallback does not scoop buy-box / non-offer prices', () => {
      // No scoped offer container matches; only a stray buy-box price exists.
      // The scoped fallback must return nothing rather than treat the
      // buy-box price as a competing seller offer.
      const html = wrapHTML(`
        <div id="buybox">
          <div class="a-price"><span class="a-offscreen">$999.00</span></div>
        </div>
      `);
      const dom = new JSDOM(html);
      const prices = ctx.extractPricesFromDocument(dom.window.document);
      expect(prices).toEqual([]);
    });

    test('returns empty array when no prices found', () => {
      const dom = new JSDOM(wrapHTML('<div>no prices here</div>'));
      const prices = ctx.extractPricesFromDocument(dom.window.document);
      expect(prices).toEqual([]);
    });

    test('filters out zero prices', () => {
      const html = wrapHTML(`
        <div class="aod-information-block">
          <div class="a-price"><span class="a-offscreen">$0.00</span></div>
        </div>
        <div class="aod-information-block">
          <div class="a-price"><span class="a-offscreen">$15.00</span></div>
        </div>
      `);
      const dom = new JSDOM(html);
      const prices = ctx.extractPricesFromDocument(dom.window.document);
      expect(prices).toEqual([15]);
    });
  });

  // ── fetchOfferPrices ──────���─────────────────────────────────
  describe('fetchOfferPrices', () => {
    test('returns sellerPrices and fetchedAt on successful AOD fetch', async () => {
      // Mock fetch to return AOD HTML
      ctx.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(aodHTML)
      });

      const result = await ctx.fetchOfferPrices('B0TEST001');
      expect(result).not.toBeNull();
      expect(result.sellerPrices.length).toBe(5);
      expect(result.fetchedAt).toBeDefined();
    });

    test('falls back to classic page when AOD fails', async () => {
      ctx.fetch = jest.fn()
        .mockRejectedValueOnce(new Error('AOD failed'))
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(classicHTML)
        });

      const result = await ctx.fetchOfferPrices('B0TEST001');
      expect(result).not.toBeNull();
      expect(result.sellerPrices.length).toBeGreaterThanOrEqual(3);
    });

    test('returns null when both endpoints fail', async () => {
      ctx.fetch = jest.fn()
        .mockRejectedValueOnce(new Error('AOD failed'))
        .mockRejectedValueOnce(new Error('Classic failed'));

      const result = await ctx.fetchOfferPrices('B0TEST001');
      expect(result).toBeNull();
    });

    test('returns null when HTML has no parseable prices', async () => {
      ctx.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(wrapHTML('<div>empty</div>'))
      });

      // AOD returns no prices, then classic also returns no prices
      ctx.fetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(wrapHTML('<div>also empty</div>'))
      });

      const result = await ctx.fetchOfferPrices('B0TEST001');
      expect(result).toBeNull();
    });
  });
});
