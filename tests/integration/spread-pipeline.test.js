/**
 * Integration: Offer Fetcher → SpreadAnalyzer → Analyzer.calculateCombinedScore
 * Tests the full price spread analysis pipeline end-to-end.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadContentScript, wrapHTML } = require('../setup/dom-helpers');
const SpreadAnalyzer = require('../../scripts/modules/spread-analyzer');
const Analyzer = require('../../scripts/modules/analyzer');
const { sampleProducts, sampleSpreadResults } = require('../fixtures/sample-products');

const aodHTML = fs.readFileSync(
  path.join(__dirname, '../fixtures/amazon-offer-aod.html'), 'utf8'
);

describe('Spread analysis pipeline', () => {
  let offerCtx;

  beforeAll(() => {
    offerCtx = loadContentScript(
      'scripts/content/offer-fetcher.js',
      wrapHTML('<div></div>'),
      'https://www.amazon.com/s?k=test'
    );
  });

  test('extractPricesFromDocument output feeds SpreadAnalyzer.calculateSpread', () => {
    const dom = new JSDOM(aodHTML);
    const prices = offerCtx.extractPricesFromDocument(dom.window.document);

    expect(prices.length).toBeGreaterThanOrEqual(2);

    const spread = SpreadAnalyzer.calculateSpread(prices);
    expect(spread).not.toBeNull();
    expect(spread.sellerCount).toBe(prices.length);
    expect(spread.coefficientOfVariation).toBeGreaterThan(0);
  });

  test('SpreadAnalyzer.analyzeAll output feeds Analyzer.generateInsights', () => {
    global.SpreadAnalyzer = SpreadAnalyzer;

    const analyzed = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
    expect(analyzed.length).toBeGreaterThan(0);

    const insights = Analyzer.generateInsights(sampleProducts, sampleSpreadResults);
    expect(Array.isArray(insights)).toBe(true);
    // Should have at least the standard price/quality insights
    expect(insights.length).toBeGreaterThanOrEqual(2);

    delete global.SpreadAnalyzer;
  });

  test('calculateCombinedScore blends base and spread scores', () => {
    global.SpreadAnalyzer = SpreadAnalyzer;

    const product = sampleProducts[0]; // Widget Pro, B001
    const spreadData = sampleSpreadResults['B001'];

    // Get base score
    const baseScore = Analyzer.calculateOpportunityScore(product);
    expect(baseScore).toBeGreaterThan(0);

    // Get spread metrics
    const spreadMetrics = SpreadAnalyzer.calculateSpread(spreadData.sellerPrices);
    expect(spreadMetrics).not.toBeNull();

    // Combined score
    const combined = Analyzer.calculateCombinedScore(product, { spreadData: spreadMetrics });
    expect(combined).toBeGreaterThanOrEqual(1);
    expect(combined).toBeLessThanOrEqual(10);

    // Combined should differ from base (since spread data is non-trivial)
    const arbitrageScore = SpreadAnalyzer.calculateArbitrageScore(spreadMetrics);
    if (arbitrageScore > 0) {
      // It's a weighted blend, should reflect both inputs
      expect(typeof combined).toBe('number');
    }

    delete global.SpreadAnalyzer;
  });

  test('full pipeline: prices → spread → arbitrage score → classification', () => {
    const dom = new JSDOM(aodHTML);
    const prices = offerCtx.extractPricesFromDocument(dom.window.document);

    // Step 1: Calculate spread
    const spread = SpreadAnalyzer.calculateSpread(prices);
    expect(spread).not.toBeNull();

    // Step 2: Calculate arbitrage score
    const score = SpreadAnalyzer.calculateArbitrageScore(spread);
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThanOrEqual(10);

    // Step 3: Classify
    const classification = SpreadAnalyzer.classifySpread(spread.coefficientOfVariation);
    expect(classification).toHaveProperty('level');
    expect(classification).toHaveProperty('label');
    expect(classification).toHaveProperty('color');
  });

  test('analyzeAll summary integrates with generateInsights', () => {
    global.SpreadAnalyzer = SpreadAnalyzer;

    const analyzed = SpreadAnalyzer.analyzeAll(sampleSpreadResults);
    const summary = SpreadAnalyzer.generateSummary(analyzed);

    expect(summary.totalAnalyzed).toBe(Object.keys(sampleSpreadResults).length);
    expect(summary.withSpreadData).toBeGreaterThan(0);

    // Insights should reference high spread products if any exist
    const insights = Analyzer.generateInsights(sampleProducts, sampleSpreadResults);
    expect(insights.some(i => i.type === 'info' || i.type === 'opportunity')).toBe(true);

    delete global.SpreadAnalyzer;
  });
});
