const Analyzer = require('../../scripts/modules/analyzer');
const { sampleProducts } = require('../fixtures/sample-products');

describe('Analyzer', () => {

  // ── parsePrice ──────────────────────────────────────────────
  describe('parsePrice', () => {
    test('parses dollar amount "$19.99" -> 19.99', () => {
      expect(Analyzer.parsePrice('$19.99')).toBe(19.99);
    });

    test('parses with comma "$1,299.99" -> 1299.99', () => {
      expect(Analyzer.parsePrice('$1,299.99')).toBe(1299.99);
    });

    test('returns 0 for "N/A"', () => {
      expect(Analyzer.parsePrice('N/A')).toBe(0);
    });

    test('returns 0 for null', () => {
      expect(Analyzer.parsePrice(null)).toBe(0);
    });

    test('returns 0 for undefined', () => {
      expect(Analyzer.parsePrice(undefined)).toBe(0);
    });

    test('returns 0 for empty string', () => {
      expect(Analyzer.parsePrice('')).toBe(0);
    });

    test('handles numeric input (already a number)', () => {
      expect(Analyzer.parsePrice(24.99)).toBe(24.99);
    });

    test('strips non-numeric characters', () => {
      expect(Analyzer.parsePrice('EUR 24.99')).toBe(24.99);
    });
  });

  // ── parseRating ─────────────────────────────────────────────
  describe('parseRating', () => {
    test('parses string "4.5" -> 4.5', () => {
      expect(Analyzer.parseRating('4.5')).toBe(4.5);
    });

    test('parses number 4.5 -> 4.5', () => {
      expect(Analyzer.parseRating(4.5)).toBe(4.5);
    });

    test('returns 0 for "N/A"', () => {
      expect(Analyzer.parseRating('N/A')).toBe(0);
    });

    test('returns 0 for null', () => {
      expect(Analyzer.parseRating(null)).toBe(0);
    });

    test('returns 0 for undefined', () => {
      expect(Analyzer.parseRating(undefined)).toBe(0);
    });
  });

  // ── parseReviewCount ────────────────────────────────────────
  describe('parseReviewCount', () => {
    test('parses "12,847" -> 12847', () => {
      expect(Analyzer.parseReviewCount('12,847')).toBe(12847);
    });

    test('parses numeric 500 -> 500', () => {
      expect(Analyzer.parseReviewCount(500)).toBe(500);
    });

    test('returns 0 for null', () => {
      expect(Analyzer.parseReviewCount(null)).toBe(0);
    });

    test('returns 0 for undefined', () => {
      expect(Analyzer.parseReviewCount(undefined)).toBe(0);
    });

    test('returns 0 for empty string', () => {
      expect(Analyzer.parseReviewCount('')).toBe(0);
    });

    test('parses "(1,200)" with parens', () => {
      expect(Analyzer.parseReviewCount('(1,200)')).toBe(1200);
    });
  });

  // ── calculateStats ──────────────────────────────────────────
  describe('calculateStats', () => {
    test('returns correct stats for [10, 20, 30, 40, 50]', () => {
      const result = Analyzer.calculateStats([10, 20, 30, 40, 50]);
      expect(result.min).toBe(10);
      expect(result.max).toBe(50);
      expect(result.avg).toBe(30);
      expect(result.median).toBe(30);
      expect(result.count).toBe(5);
    });

    test('handles even-length array median correctly', () => {
      const result = Analyzer.calculateStats([10, 20, 30, 40]);
      expect(result.median).toBe(25); // (20+30)/2
    });

    test('filters out zeros and negatives', () => {
      const result = Analyzer.calculateStats([0, -5, 10, 20]);
      expect(result.count).toBe(2);
      expect(result.min).toBe(10);
    });

    test('returns all zeros for empty array', () => {
      const result = Analyzer.calculateStats([]);
      expect(result).toEqual({ min: 0, max: 0, avg: 0, median: 0, count: 0 });
    });

    test('returns all zeros for array of only zeros', () => {
      const result = Analyzer.calculateStats([0, 0, 0]);
      expect(result).toEqual({ min: 0, max: 0, avg: 0, median: 0, count: 0 });
    });

    test('single element array', () => {
      const result = Analyzer.calculateStats([42]);
      expect(result.min).toBe(42);
      expect(result.max).toBe(42);
      expect(result.avg).toBe(42);
      expect(result.median).toBe(42);
      expect(result.count).toBe(1);
    });
  });

  // ── getPriceDistribution ────────────────────────────────────
  describe('getPriceDistribution', () => {
    test('buckets products correctly across all 5 ranges', () => {
      const result = Analyzer.getPriceDistribution(sampleProducts);
      expect(result['$0-$10']).toBeGreaterThanOrEqual(1); // $5.99
      expect(result['$10-$25']).toBeGreaterThanOrEqual(1); // $12.99, $19.99
      expect(result['$25-$50']).toBeGreaterThanOrEqual(1); // $29.99
      expect(result['$100+']).toBeGreaterThanOrEqual(1);   // $149.99
    });

    test('skips products with price "N/A" (price <= 0)', () => {
      const products = [{ price: 'N/A' }, { price: '$10.00' }];
      const result = Analyzer.getPriceDistribution(products);
      const total = Object.values(result).reduce((a, b) => a + b, 0);
      expect(total).toBe(1);
    });

    test('handles empty product array', () => {
      const result = Analyzer.getPriceDistribution([]);
      const total = Object.values(result).reduce((a, b) => a + b, 0);
      expect(total).toBe(0);
    });

    test('boundary: $9.99 goes in $0-$10, $10 goes in $10-$25', () => {
      const products = [{ price: '$9.99' }, { price: '$10.00' }];
      const result = Analyzer.getPriceDistribution(products);
      expect(result['$0-$10']).toBe(1);
      expect(result['$10-$25']).toBe(1);
    });
  });

  // ── getRatingDistribution ───────────────────────────────────
  describe('getRatingDistribution', () => {
    test('buckets products correctly', () => {
      const result = Analyzer.getRatingDistribution(sampleProducts);
      // 4.8 and 4.9 → '5 Stars'; 4.5, 4.2, 4.0 → '4-4.9 Stars'; 3.2 → '3-3.9 Stars'; 0 → 'No Rating'
      expect(result['5 Stars']).toBeGreaterThanOrEqual(2);
      expect(result['4-4.9 Stars']).toBeGreaterThanOrEqual(2);
      expect(result['3-3.9 Stars']).toBeGreaterThanOrEqual(1);
      expect(result['No Rating']).toBeGreaterThanOrEqual(1);
    });

    test('4.8 rating goes into "5 Stars"', () => {
      const result = Analyzer.getRatingDistribution([{ rating: 4.8 }]);
      expect(result['5 Stars']).toBe(1);
    });

    test('0 rating goes into "No Rating"', () => {
      const result = Analyzer.getRatingDistribution([{ rating: 0 }]);
      expect(result['No Rating']).toBe(1);
    });

    test('handles empty array', () => {
      const result = Analyzer.getRatingDistribution([]);
      const total = Object.values(result).reduce((a, b) => a + b, 0);
      expect(total).toBe(0);
    });
  });

  // ── calculateOpportunityScore ───────────────────────────────
  describe('calculateOpportunityScore', () => {
    test('returns score between 1-10 for valid product', () => {
      const score = Analyzer.calculateOpportunityScore(sampleProducts[0]); // Widget Pro
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(10);
    });

    test('returns 0 when price is "N/A"', () => {
      const score = Analyzer.calculateOpportunityScore(sampleProducts[5]); // No Price Item
      expect(score).toBe(0);
    });

    test('returns 0 when rating is 0', () => {
      const score = Analyzer.calculateOpportunityScore(sampleProducts[6]); // No Rating Item
      expect(score).toBe(0);
    });

    test('higher rating + more reviews + lower price = higher score', () => {
      const cheap = { price: '$5.00', rating: 4.8, reviewCount: 1000 };
      const expensive = { price: '$200.00', rating: 3.5, reviewCount: 50 };
      expect(Analyzer.calculateOpportunityScore(cheap))
        .toBeGreaterThan(Analyzer.calculateOpportunityScore(expensive));
    });

    test('score never exceeds 10', () => {
      const extreme = { price: '$1.00', rating: 5.0, reviewCount: 999999 };
      expect(Analyzer.calculateOpportunityScore(extreme)).toBeLessThanOrEqual(10);
    });
  });

  // ── calculateCombinedScore ──────────────────────────────────
  describe('calculateCombinedScore', () => {
    test('returns base score when spreadData is null', () => {
      const base = Analyzer.calculateOpportunityScore(sampleProducts[0]);
      const combined = Analyzer.calculateCombinedScore(sampleProducts[0], null);
      expect(combined).toBe(base);
    });

    test('returns base score when spreadData.spreadData is null', () => {
      const base = Analyzer.calculateOpportunityScore(sampleProducts[0]);
      const combined = Analyzer.calculateCombinedScore(sampleProducts[0], { spreadData: null });
      expect(combined).toBe(base);
    });

    test('blends 60/40 when SpreadAnalyzer is available', () => {
      // Set up SpreadAnalyzer on global for this test
      const SpreadAnalyzer = require('../../scripts/modules/spread-analyzer');
      global.SpreadAnalyzer = SpreadAnalyzer;

      const spreadData = {
        spreadData: SpreadAnalyzer.calculateSpread([24.99, 29.99, 31.50, 27.00, 35.00])
      };
      const combined = Analyzer.calculateCombinedScore(sampleProducts[0], spreadData);
      expect(combined).toBeGreaterThanOrEqual(1);
      expect(combined).toBeLessThanOrEqual(10);

      delete global.SpreadAnalyzer;
    });
  });

  // ── getTopOpportunities ─────────────────────────────────────
  describe('getTopOpportunities', () => {
    test('returns products sorted by opportunity score descending', () => {
      const top = Analyzer.getTopOpportunities(sampleProducts);
      for (let i = 1; i < top.length; i++) {
        expect(top[i - 1].opportunityScore).toBeGreaterThanOrEqual(top[i].opportunityScore);
      }
    });

    test('respects limit parameter', () => {
      const top = Analyzer.getTopOpportunities(sampleProducts, 3);
      expect(top.length).toBeLessThanOrEqual(3);
    });

    test('filters out products with score 0', () => {
      const top = Analyzer.getTopOpportunities(sampleProducts);
      top.forEach(p => expect(p.opportunityScore).toBeGreaterThan(0));
    });

    test('augments each product with .opportunityScore', () => {
      const top = Analyzer.getTopOpportunities(sampleProducts);
      top.forEach(p => expect(typeof p.opportunityScore).toBe('number'));
    });

    test('default limit is 10', () => {
      const manyProducts = Array.from({ length: 20 }, (_, i) => ({
        name: `Product ${i}`, price: `$${10 + i}`, rating: 4.5, reviewCount: 100 + i * 10
      }));
      const top = Analyzer.getTopOpportunities(manyProducts);
      expect(top.length).toBeLessThanOrEqual(10);
    });
  });

  // ── findUnderpriced ─────────────────────────────────────────
  describe('findUnderpriced', () => {
    test('finds products priced 30%+ below average with 4+ rating', () => {
      const underpriced = Analyzer.findUnderpriced(sampleProducts);
      underpriced.forEach(p => {
        expect(Analyzer.parseRating(p.rating)).toBeGreaterThanOrEqual(4.0);
        expect(Analyzer.parsePrice(p.price)).toBeGreaterThan(0);
      });
    });

    test('returns empty when no products match', () => {
      const expensive = [
        { price: '$100', rating: 4.5, reviewCount: 100 },
        { price: '$100', rating: 4.5, reviewCount: 100 }
      ];
      expect(Analyzer.findUnderpriced(expensive)).toEqual([]);
    });

    test('custom threshold works (0.5 = 50% below)', () => {
      const products = [
        { price: '$100', rating: 4.5 },
        { price: '$100', rating: 4.5 },
        { price: '$10', rating: 4.5 }  // way below avg
      ];
      const result = Analyzer.findUnderpriced(products, 0.5);
      expect(result.length).toBe(1);
    });

    test('excludes products with rating < 4.0', () => {
      const products = [
        { price: '$100', rating: 4.5 },
        { price: '$100', rating: 4.5 },
        { price: '$5', rating: 3.0 }  // cheap but low rated
      ];
      const result = Analyzer.findUnderpriced(products);
      expect(result.length).toBe(0);
    });
  });

  // ── findUnderexposed ────────────────────────────────────────
  describe('findUnderexposed', () => {
    test('finds products with <=50 reviews and >=4.0 rating', () => {
      const result = Analyzer.findUnderexposed(sampleProducts);
      result.forEach(p => {
        const reviews = Analyzer.parseReviewCount(p.reviewCount);
        expect(reviews).toBeGreaterThan(0);
        expect(reviews).toBeLessThanOrEqual(50);
        expect(Analyzer.parseRating(p.rating)).toBeGreaterThanOrEqual(4.0);
      });
    });

    test('excludes products with 0 reviews', () => {
      const products = [{ rating: 4.5, reviewCount: 0 }];
      expect(Analyzer.findUnderexposed(products)).toEqual([]);
    });

    test('custom maxReviews and minRating parameters work', () => {
      const result = Analyzer.findUnderexposed(sampleProducts, 100, 3.0);
      result.forEach(p => {
        expect(Analyzer.parseReviewCount(p.reviewCount)).toBeLessThanOrEqual(100);
        expect(Analyzer.parseRating(p.rating)).toBeGreaterThanOrEqual(3.0);
      });
    });

    test('returns empty for empty array', () => {
      expect(Analyzer.findUnderexposed([])).toEqual([]);
    });
  });

  // ── generateInsights ────────────────────────────────────────
  describe('generateInsights', () => {
    test('always includes price range and quality distribution insights', () => {
      const insights = Analyzer.generateInsights(sampleProducts);
      const titles = insights.map(i => i.title);
      expect(titles).toContain('Price Range Analysis');
      expect(titles).toContain('Quality Distribution');
    });

    test('each insight has required fields', () => {
      const insights = Analyzer.generateInsights(sampleProducts);
      insights.forEach(insight => {
        expect(insight).toHaveProperty('type');
        expect(insight).toHaveProperty('priority');
        expect(insight).toHaveProperty('title');
        expect(insight).toHaveProperty('description');
        expect(insight).toHaveProperty('action');
      });
    });

    test('includes underpriced insight when underpriced products exist', () => {
      // Create products where one is clearly underpriced
      const products = [
        { price: '$100', rating: 4.5, reviewCount: 100 },
        { price: '$100', rating: 4.5, reviewCount: 100 },
        { price: '$100', rating: 4.5, reviewCount: 100 },
        { price: '$5', rating: 4.5, reviewCount: 100 }  // 95% below avg
      ];
      const insights = Analyzer.generateInsights(products);
      const titles = insights.map(i => i.title);
      expect(titles.some(t => t.includes('underpriced'))).toBe(true);
    });

    test('handles spread results when SpreadAnalyzer is available', () => {
      const SpreadAnalyzer = require('../../scripts/modules/spread-analyzer');
      global.SpreadAnalyzer = SpreadAnalyzer;

      const { sampleSpreadResults } = require('../fixtures/sample-products');
      const insights = Analyzer.generateInsights(sampleProducts, sampleSpreadResults);
      expect(Array.isArray(insights)).toBe(true);

      delete global.SpreadAnalyzer;
    });
  });

  // ── generateFullReport ──────────────────────────────────────
  describe('generateFullReport', () => {
    test('returns complete report structure with all expected keys', () => {
      const report = Analyzer.generateFullReport(sampleProducts);
      expect(report).toHaveProperty('summary');
      expect(report).toHaveProperty('distributions');
      expect(report).toHaveProperty('topOpportunities');
      expect(report).toHaveProperty('insights');
      expect(report).toHaveProperty('generatedAt');
    });

    test('summary.totalProducts matches input length', () => {
      const report = Analyzer.generateFullReport(sampleProducts);
      expect(report.summary.totalProducts).toBe(sampleProducts.length);
    });

    test('distributions has price and rating', () => {
      const report = Analyzer.generateFullReport(sampleProducts);
      expect(report.distributions).toHaveProperty('price');
      expect(report.distributions).toHaveProperty('rating');
    });

    test('topOpportunities is an array', () => {
      const report = Analyzer.generateFullReport(sampleProducts);
      expect(Array.isArray(report.topOpportunities)).toBe(true);
    });

    test('generatedAt is a valid ISO string', () => {
      const report = Analyzer.generateFullReport(sampleProducts);
      expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    });

    test('summary contains price, rating, and review stats', () => {
      const report = Analyzer.generateFullReport(sampleProducts);
      expect(report.summary).toHaveProperty('priceStats');
      expect(report.summary).toHaveProperty('ratingStats');
      expect(report.summary).toHaveProperty('reviewStats');
    });
  });
});
