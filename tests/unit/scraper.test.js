const fs = require('fs');
const path = require('path');
const { loadContentScript } = require('../setup/dom-helpers');

const searchHTML = fs.readFileSync(
  path.join(__dirname, '../fixtures/amazon-search-results.html'), 'utf8'
);
const lastPageHTML = fs.readFileSync(
  path.join(__dirname, '../fixtures/amazon-search-lastpage.html'), 'utf8'
);

describe('scraper.js', () => {
  let ctx;

  beforeAll(() => {
    ctx = loadContentScript('scripts/content/scraper.js', searchHTML);
  });

  // ── SELECTORS ───────────────────────────────────────────────
  describe('SELECTORS', () => {
    // SELECTORS is a const (block-scoped) so we use the literal selector string
    const PRODUCT_SELECTOR = '.s-result-item[data-asin]:not([data-asin=""])';

    test('productItem selector matches valid products (excludes empty asin)', () => {
      const items = ctx._document.querySelectorAll(PRODUCT_SELECTOR);
      expect(items.length).toBe(4); // B0TEST001, B0TEST002, B0TEST003, B0TEST004
    });

    test('empty ASIN placeholder is excluded', () => {
      const items = ctx._document.querySelectorAll(PRODUCT_SELECTOR);
      const asins = Array.from(items).map(el => el.dataset.asin);
      expect(asins).not.toContain('');
    });
  });

  // ── getText ────────────────────────────────���────────────────
  describe('getText', () => {
    test('returns text from primary selector', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      const text = ctx.getText(item, 'h2 span');
      expect(text).toBe('Test Widget Pro 2000');
    });

    test('returns null when both selectors miss', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      const text = ctx.getText(item, '.nonexistent', '.also-nonexistent');
      expect(text).toBeNull();
    });

    test('trims whitespace from result', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      const text = ctx.getText(item, 'h2 span');
      expect(text).toBe(text.trim());
    });
  });

  // ── extractPrice ─────────���──────────────────────────────────
  describe('extractPrice', () => {
    test('extracts "$29.99" from product with xl price', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      expect(ctx.extractPrice(item)).toBe('$29.99');
    });

    test('extracts "$9.99" from product with fallback price only', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST002"]');
      expect(ctx.extractPrice(item)).toBe('$9.99');
    });

    test('returns "N/A" for product with no price element', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST003"]');
      expect(ctx.extractPrice(item)).toBe('N/A');
    });
  });

  // ── parseRatingText ─────────────────────────────────────────
  describe('parseRatingText', () => {
    test('parses "4.5 out of 5 stars" -> 4.5', () => {
      expect(ctx.parseRatingText('4.5 out of 5 stars')).toBe(4.5);
    });

    test('parses "4.5" -> 4.5', () => {
      expect(ctx.parseRatingText('4.5')).toBe(4.5);
    });

    test('returns 0 for null', () => {
      expect(ctx.parseRatingText(null)).toBe(0);
    });

    test('returns 0 for non-numeric text', () => {
      expect(ctx.parseRatingText('no rating')).toBe(0);
    });
  });

  // ── extractRating ─────────��─────────────────────────────────
  describe('extractRating', () => {
    test('extracts 4.5 from product with data-cy rating', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      expect(ctx.extractRating(item)).toBe(4.5);
    });

    test('extracts 3.8 from product with star-mini fallback', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST002"]');
      expect(ctx.extractRating(item)).toBe(3.8);
    });

    test('extracts 4.2 from product with star-small legacy', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST004"]');
      expect(ctx.extractRating(item)).toBe(4.2);
    });

    test('returns 0 for product with no rating elements', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST003"]');
      expect(ctx.extractRating(item)).toBe(0);
    });
  });

  // ── parseReviewText ──��──────────────────────────────────────
  describe('parseReviewText', () => {
    test('parses "(64)" -> 64', () => {
      expect(ctx.parseReviewText('(64)')).toBe(64);
    });

    test('parses "(108.3K)" -> 108300', () => {
      expect(ctx.parseReviewText('(108.3K)')).toBe(108300);
    });

    test('parses "(77K)" -> 77000', () => {
      expect(ctx.parseReviewText('(77K)')).toBe(77000);
    });

    test('parses "(1.2M)" -> 1200000', () => {
      expect(ctx.parseReviewText('(1.2M)')).toBe(1200000);
    });

    test('returns 0 for null', () => {
      expect(ctx.parseReviewText(null)).toBe(0);
    });

    test('returns 0 for empty string', () => {
      expect(ctx.parseReviewText('')).toBe(0);
    });
  });

  // ── extractReviewCount ──────���───────────────────────────────
  describe('extractReviewCount', () => {
    test('extracts 12847 from aria-label "12,847 ratings"', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      expect(ctx.extractReviewCount(item)).toBe(12847);
    });

    test('extracts 247 from fallback text "(247)"', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST002"]');
      expect(ctx.extractReviewCount(item)).toBe(247);
    });

    test('extracts 1500 from K-suffix "(1.5K)"', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST004"]');
      expect(ctx.extractReviewCount(item)).toBe(1500);
    });

    test('returns 0 for product with no review elements', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST003"]');
      expect(ctx.extractReviewCount(item)).toBe(0);
    });
  });

  // ── hasPrimeBadge ──────��────────────────────────────────────
  describe('hasPrimeBadge', () => {
    test('returns true for product with .a-icon-prime', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      expect(ctx.hasPrimeBadge(item)).toBe(true);
    });

    test('returns true for product with .s-prime', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST004"]');
      expect(ctx.hasPrimeBadge(item)).toBe(true);
    });

    test('returns false for product without Prime badge', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST002"]');
      expect(ctx.hasPrimeBadge(item)).toBe(false);
    });
  });

  // ── scrapeProduct ───────────────────────────────────────────
  describe('scrapeProduct', () => {
    test('returns full product object for complete listing', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      const product = ctx.scrapeProduct(item);
      expect(product).not.toBeNull();
      expect(product.name).toBe('Test Widget Pro 2000');
      expect(product.asin).toBe('B0TEST001');
      expect(product.price).toBe('$29.99');
      expect(product.rating).toBe(4.5);
      expect(product.reviewCount).toBe(12847);
      expect(product.isPrime).toBe(true);
    });

    test('product has all required fields', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      const product = ctx.scrapeProduct(item);
      expect(product).toHaveProperty('name');
      expect(product).toHaveProperty('asin');
      expect(product).toHaveProperty('price');
      expect(product).toHaveProperty('rating');
      expect(product).toHaveProperty('reviewCount');
      expect(product).toHaveProperty('isPrime');
      expect(product).toHaveProperty('url');
      expect(product).toHaveProperty('scrapedAt');
    });

    test('url is constructed with amazon.com prefix', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      const product = ctx.scrapeProduct(item);
      expect(product.url).toContain('https://www.amazon.com');
      expect(product.url).toContain('B0TEST001');
    });

    test('handles missing data gracefully', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST003"]');
      const product = ctx.scrapeProduct(item);
      expect(product).not.toBeNull();
      expect(product.price).toBe('N/A');
      expect(product.rating).toBe(0);
      expect(product.reviewCount).toBe(0);
    });

    test('scrapedAt is a valid ISO string', () => {
      const item = ctx._document.querySelector('[data-asin="B0TEST001"]');
      const product = ctx.scrapeProduct(item);
      expect(new Date(product.scrapedAt).toISOString()).toBe(product.scrapedAt);
    });
  });

  // ── getTotalResults ─────────────────────────────────────────
  describe('getTotalResults', () => {
    test('parses "of 523 results" from results header', () => {
      expect(ctx.getTotalResults()).toBe(523);
    });
  });

  // ── hasNextPage ─────────────────────���───────────────────────
  describe('hasNextPage', () => {
    test('returns true when pagination-disabled is absent', () => {
      expect(ctx.hasNextPage()).toBe(true);
    });

    test('returns false when pagination-disabled is present', () => {
      const lastCtx = loadContentScript('scripts/content/scraper.js', lastPageHTML);
      expect(lastCtx.hasNextPage()).toBe(false);
    });
  });

  // ── getNextPageUrl ───────────��────────────────────────��─────
  describe('getNextPageUrl', () => {
    test('increments page parameter from 1 to 2', () => {
      const url = ctx.getNextPageUrl();
      expect(url).toContain('page=2');
    });

    test('sets ref parameter to sr_pg_N', () => {
      const url = ctx.getNextPageUrl();
      expect(url).toContain('ref=sr_pg_2');
    });
  });
});
