/**
 * Integration: Scraper output → Analyzer pipeline
 * Validates that the data shapes produced by scraper.js are correctly
 * consumed by analyzer.js for scoring, statistics, and insights.
 */

const fs = require('fs');
const path = require('path');
const { loadContentScript } = require('../setup/dom-helpers');
const Analyzer = require('../../scripts/modules/analyzer');

const searchHTML = fs.readFileSync(
  path.join(__dirname, '../fixtures/amazon-search-results.html'), 'utf8'
);

describe('Scraper → Analyzer pipeline', () => {
  let scrapedProducts;

  beforeAll(() => {
    const ctx = loadContentScript('scripts/content/scraper.js', searchHTML);
    const PRODUCT_SELECTOR = '.s-result-item[data-asin]:not([data-asin=""])';
    const listings = ctx._document.querySelectorAll(PRODUCT_SELECTOR);

    scrapedProducts = Array.from(listings)
      .map(listing => ctx.scrapeProduct(listing))
      .filter(p => p !== null);
  });

  test('scraper produces products with fields Analyzer expects', () => {
    expect(scrapedProducts.length).toBeGreaterThan(0);
    scrapedProducts.forEach(p => {
      expect(p).toHaveProperty('price');
      expect(p).toHaveProperty('rating');
      expect(p).toHaveProperty('reviewCount');
    });
  });

  test('Analyzer.parsePrice handles scraper price strings', () => {
    scrapedProducts.forEach(p => {
      const price = Analyzer.parsePrice(p.price);
      expect(typeof price).toBe('number');
      expect(price).toBeGreaterThanOrEqual(0);
    });
  });

  test('Analyzer.calculateStats works on scraped prices', () => {
    const prices = scrapedProducts.map(p => Analyzer.parsePrice(p.price));
    const stats = Analyzer.calculateStats(prices);
    expect(stats).toHaveProperty('min');
    expect(stats).toHaveProperty('max');
    expect(stats).toHaveProperty('avg');
    expect(stats.count).toBeGreaterThan(0);
  });

  test('Analyzer.getTopOpportunities processes scraper output', () => {
    const top = Analyzer.getTopOpportunities(scrapedProducts);
    expect(Array.isArray(top)).toBe(true);
    top.forEach(p => {
      expect(p).toHaveProperty('opportunityScore');
      expect(p.opportunityScore).toBeGreaterThan(0);
    });
  });

  test('Analyzer.generateFullReport works end-to-end with scraped data', () => {
    const report = Analyzer.generateFullReport(scrapedProducts);
    expect(report.summary.totalProducts).toBe(scrapedProducts.length);
    expect(report.distributions.price).toBeDefined();
    expect(report.distributions.rating).toBeDefined();
    expect(Array.isArray(report.insights)).toBe(true);
  });

  test('Analyzer.getPriceDistribution buckets scraped products', () => {
    const dist = Analyzer.getPriceDistribution(scrapedProducts);
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    // Should bucket at least the products that have valid prices
    const validPriceCount = scrapedProducts.filter(p => Analyzer.parsePrice(p.price) > 0).length;
    expect(total).toBe(validPriceCount);
  });
});
