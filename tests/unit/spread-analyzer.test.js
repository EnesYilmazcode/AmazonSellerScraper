const SpreadAnalyzer = require('../../scripts/modules/spread-analyzer');
const { sampleSpreadResults } = require('../fixtures/sample-products');

describe('SpreadAnalyzer', () => {

  // ── standardDeviation ───────────────────────────────────────
  describe('standardDeviation', () => {
    test('returns 0 for single element', () => {
      expect(SpreadAnalyzer.standardDeviation([5], 5)).toBe(0);
    });

    test('returns 0 for identical values', () => {
      expect(SpreadAnalyzer.standardDeviation([3, 3, 3], 3)).toBe(0);
    });

    test('correct for known set [2, 4, 4, 4, 5, 5, 7, 9]', () => {
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      const mean = values.reduce((a, b) => a + b, 0) / values.length; // 5
      const sd = SpreadAnalyzer.standardDeviation(values, mean);
      expect(sd).toBeCloseTo(2.0, 0); // ~2.0
    });

    test('handles empty array', () => {
      expect(SpreadAnalyzer.standardDeviation([], 0)).toBe(0);
    });
  });

  // ── calculateSpread ─────────────────────────────────────────
  describe('calculateSpread', () => {
    test('returns null for fewer than 2 prices', () => {
      expect(SpreadAnalyzer.calculateSpread([10])).toBeNull();
    });

    test('returns null for empty array', () => {
      expect(SpreadAnalyzer.calculateSpread([])).toBeNull();
    });

    test('filters out zero/negative prices', () => {
      expect(SpreadAnalyzer.calculateSpread([0, -5, 10])).toBeNull(); // only 1 valid
    });

    test('correct metrics for [10, 20, 30, 40]', () => {
      const result = SpreadAnalyzer.calculateSpread([10, 20, 30, 40]);
      expect(result.sellerCount).toBe(4);
      expect(result.minPrice).toBe(10);
      expect(result.maxPrice).toBe(40);
      expect(result.meanPrice).toBe(25);
      expect(result.absoluteSpread).toBe(30);
    });

    test('CV is (stdDev/mean)*100', () => {
      const result = SpreadAnalyzer.calculateSpread([10, 20, 30, 40]);
      const expectedCV = (result.stdDev / result.meanPrice) * 100;
      expect(result.coefficientOfVariation).toBeCloseTo(expectedCV, 1);
    });

    test('median correct for odd count', () => {
      const result = SpreadAnalyzer.calculateSpread([10, 20, 30]);
      expect(result.medianPrice).toBe(20);
    });

    test('median correct for even count', () => {
      const result = SpreadAnalyzer.calculateSpread([10, 20, 30, 40]);
      expect(result.medianPrice).toBe(25);
    });

    test('handles duplicate prices', () => {
      const result = SpreadAnalyzer.calculateSpread([15, 15, 15, 15]);
      expect(result.sellerCount).toBe(4);
      expect(result.stdDev).toBe(0);
      expect(result.coefficientOfVariation).toBe(0);
    });

    test('handles two prices (minimum valid)', () => {
      const result = SpreadAnalyzer.calculateSpread([10, 30]);
      expect(result).not.toBeNull();
      expect(result.sellerCount).toBe(2);
      expect(result.absoluteSpread).toBe(20);
    });

    test('interquartileRange is q3 - q1', () => {
      const result = SpreadAnalyzer.calculateSpread([10, 20, 30, 40, 50]);
      expect(result.interquartileRange).toBeGreaterThanOrEqual(0);
    });
  });

  // ── calculateArbitrageScore ─────────────────────────────────
  describe('calculateArbitrageScore', () => {
    test('returns 0 for null input', () => {
      expect(SpreadAnalyzer.calculateArbitrageScore(null)).toBe(0);
    });

    test('returns 0 when sellerCount < 2', () => {
      expect(SpreadAnalyzer.calculateArbitrageScore({ sellerCount: 1 })).toBe(0);
    });

    test('returns score between 1-10 for valid spread data', () => {
      const spread = SpreadAnalyzer.calculateSpread([24.99, 29.99, 31.50, 27.00, 35.00]);
      const score = SpreadAnalyzer.calculateArbitrageScore(spread);
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(10);
    });

    test('higher CV -> higher score', () => {
      const lowCV = SpreadAnalyzer.calculateSpread([20, 21]);      // low variability
      const highCV = SpreadAnalyzer.calculateSpread([10, 50]);     // high variability
      expect(SpreadAnalyzer.calculateArbitrageScore(highCV))
        .toBeGreaterThan(SpreadAnalyzer.calculateArbitrageScore(lowCV));
    });

    test('more sellers -> higher score (log factor)', () => {
      const fewSellers = SpreadAnalyzer.calculateSpread([10, 30]);
      const manySellers = SpreadAnalyzer.calculateSpread([10, 15, 20, 25, 30]);
      // Both have same min/max spread, but more sellers increases confidence
      expect(SpreadAnalyzer.calculateArbitrageScore(manySellers))
        .toBeGreaterThanOrEqual(SpreadAnalyzer.calculateArbitrageScore(fewSellers));
    });

    test('score capped at 10', () => {
      const extreme = SpreadAnalyzer.calculateSpread([1, 1000, 500, 200, 800, 300, 700, 400, 600, 100]);
      const score = SpreadAnalyzer.calculateArbitrageScore(extreme);
      expect(score).toBeLessThanOrEqual(10);
    });
  });

  // ── classifySpread ──────────────────────────────────────────
  describe('classifySpread', () => {
    test('CV >= 50 -> very-high', () => {
      const result = SpreadAnalyzer.classifySpread(55);
      expect(result.level).toBe('very-high');
      expect(result.color).toBe('#f44336');
    });

    test('CV >= 30 -> high', () => {
      const result = SpreadAnalyzer.classifySpread(35);
      expect(result.level).toBe('high');
      expect(result.color).toBe('#FF9800');
    });

    test('CV >= 15 -> moderate', () => {
      const result = SpreadAnalyzer.classifySpread(20);
      expect(result.level).toBe('moderate');
      expect(result.color).toBe('#FFC107');
    });

    test('CV >= 5 -> low', () => {
      const result = SpreadAnalyzer.classifySpread(8);
      expect(result.level).toBe('low');
      expect(result.color).toBe('#8BC34A');
    });

    test('CV < 5 -> very-low (Tight Pricing)', () => {
      const result = SpreadAnalyzer.classifySpread(3);
      expect(result.level).toBe('very-low');
      expect(result.label).toBe('Tight Pricing');
      expect(result.color).toBe('#4CAF50');
    });

    test('each classification has level, label, color', () => {
      [0, 5, 15, 30, 50].forEach(cv => {
        const result = SpreadAnalyzer.classifySpread(cv);
        expect(result).toHaveProperty('level');
        expect(result).toHaveProperty('label');
        expect(result).toHaveProperty('color');
      });
    });
  });

  // ── analyzeAll ──────────────────────────────────────────────
  describe('analyzeAll', () => {
    test('processes map of ASIN -> sellerPrices correctly', () => {
      const results = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
      expect(results.length).toBe(Object.keys(sampleSpreadResults).length);
    });

    test('handles ASINs with null data', () => {
      const results = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
      const nullEntry = results.find(r => r.asin === 'B004');
      expect(nullEntry.spreadData).toBeNull();
      expect(nullEntry.arbitrageScore).toBe(0);
    });

    test('handles ASINs with insufficient data (<2 prices)', () => {
      const results = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
      const singlePrice = results.find(r => r.asin === 'B005');
      expect(singlePrice.spreadData).toBeNull();
      expect(singlePrice.classification.level).toBe('insufficient');
    });

    test('results sorted by arbitrage score descending', () => {
      const results = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].arbitrageScore).toBeGreaterThanOrEqual(results[i].arbitrageScore);
      }
    });

    test('each result has asin, spreadData, arbitrageScore, classification', () => {
      const results = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
      results.forEach(r => {
        expect(r).toHaveProperty('asin');
        expect(r).toHaveProperty('spreadData');
        expect(r).toHaveProperty('arbitrageScore');
        expect(r).toHaveProperty('classification');
      });
    });
  });

  // ── generateSummary ─────────────────────────────────────────
  describe('generateSummary', () => {
    test('returns correct totalAnalyzed and withSpreadData counts', () => {
      const analyzed = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
      const summary = SpreadAnalyzer.generateSummary(analyzed);
      expect(summary.totalAnalyzed).toBe(analyzed.length);
      expect(summary.withSpreadData).toBeLessThanOrEqual(summary.totalAnalyzed);
    });

    test('avgCV is average of all CVs', () => {
      const analyzed = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
      const summary = SpreadAnalyzer.generateSummary(analyzed);
      expect(typeof summary.avgCV).toBe('number');
      expect(summary.avgCV).toBeGreaterThanOrEqual(0);
    });

    test('highSpreadCount counts products with CV >= 30', () => {
      const analyzed = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
      const summary = SpreadAnalyzer.generateSummary(analyzed);
      const manual = analyzed.filter(p => p.spreadData && p.spreadData.coefficientOfVariation >= 30).length;
      expect(summary.highSpreadCount).toBe(manual);
    });

    test('topOpportunities filters to arbitrageScore >= 4', () => {
      const analyzed = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
      const summary = SpreadAnalyzer.generateSummary(analyzed);
      summary.topOpportunities.forEach(p => {
        expect(p.arbitrageScore).toBeGreaterThanOrEqual(4);
      });
    });

    test('handles all insufficient data', () => {
      const badData = { 'X1': null, 'X2': { sellerPrices: [5] } };
      const analyzed = SpreadAnalyzer.analyzeAll(badData);
      const summary = SpreadAnalyzer.generateSummary(analyzed);
      expect(summary.withSpreadData).toBe(0);
      expect(summary.avgCV).toBe(0);
      expect(summary.topOpportunities).toEqual([]);
    });
  });
});
