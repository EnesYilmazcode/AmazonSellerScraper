/**
 * @fileoverview Price Spread Analysis Engine
 *
 * Calculates statistical spread metrics for seller price distributions
 * to identify arbitrage opportunities. High price variability across
 * sellers for the same ASIN signals pricing disagreement — which means
 * there's room to capture margin.
 *
 * Core metric: Coefficient of Variation (CV) = stdDev / mean * 100
 * - Normalizes variability relative to price level
 * - A $50 spread on a $20 item (250% CV) vs $500 item (10% CV)
 *
 * @module SpreadAnalyzer
 * @see docs/PRICE_SPREAD_ANALYSIS.md
 */

const SpreadAnalyzer = {
    /**
     * Calculate the standard deviation of a numeric array.
     *
     * @param {number[]} values - Array of numbers
     * @param {number} mean - Pre-calculated mean
     * @returns {number} Population standard deviation
     */
    standardDeviation(values, mean) {
        if (values.length <= 1) return 0;
        const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
        const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
        return Math.sqrt(avgSquaredDiff);
    },

    /**
     * Calculate comprehensive spread metrics for a set of seller prices.
     *
     * @param {number[]} prices - Array of seller prices (already parsed to numbers)
     * @returns {Object|null} Spread metrics object, or null if insufficient data
     * @returns {number} return.sellerCount - Number of seller prices analyzed
     * @returns {number} return.minPrice - Lowest seller price
     * @returns {number} return.maxPrice - Highest seller price
     * @returns {number} return.meanPrice - Average seller price
     * @returns {number} return.medianPrice - Median seller price
     * @returns {number} return.stdDev - Standard deviation of prices
     * @returns {number} return.coefficientOfVariation - CV percentage (stdDev/mean * 100)
     * @returns {number} return.absoluteSpread - Dollar difference between max and min
     * @returns {number} return.interquartileRange - IQR (Q3 - Q1)
     */
    calculateSpread(prices) {
        const valid = prices.filter(p => p > 0);
        if (valid.length < 2) return null;

        const sorted = [...valid].sort((a, b) => a - b);
        const count = sorted.length;
        const sum = sorted.reduce((a, b) => a + b, 0);
        const mean = sum / count;
        const stdDev = this.standardDeviation(sorted, mean);

        // Median
        const midIndex = Math.floor(count / 2);
        const median = count % 2 === 0
            ? (sorted[midIndex - 1] + sorted[midIndex]) / 2
            : sorted[midIndex];

        // Interquartile range
        const q1Index = Math.floor(count * 0.25);
        const q3Index = Math.floor(count * 0.75);
        const q1 = sorted[q1Index];
        const q3 = sorted[q3Index];

        return {
            sellerCount: count,
            minPrice: parseFloat(sorted[0].toFixed(2)),
            maxPrice: parseFloat(sorted[count - 1].toFixed(2)),
            meanPrice: parseFloat(mean.toFixed(2)),
            medianPrice: parseFloat(median.toFixed(2)),
            stdDev: parseFloat(stdDev.toFixed(2)),
            coefficientOfVariation: parseFloat(((stdDev / mean) * 100).toFixed(2)),
            absoluteSpread: parseFloat((sorted[count - 1] - sorted[0]).toFixed(2)),
            interquartileRange: parseFloat((q3 - q1).toFixed(2))
        };
    },

    /**
     * Calculate an arbitrage opportunity score from spread metrics.
     *
     * Formula: rawScore = (CV / 15) * log10(sellerCount + 1) * min(1, spread / 20)
     * Normalized to 1-10 scale.
     *
     * Factors:
     * - CV / 15: Primary signal — higher variability = more opportunity
     * - log10(sellers + 1): Confidence from more data points (log prevents dominance)
     * - min(1, spread / 20): Absolute dollar filter — trivial spreads get penalized
     *
     * @param {Object} spreadData - Output from calculateSpread()
     * @returns {number} Arbitrage score (1-10), or 0 if no data
     */
    calculateArbitrageScore(spreadData) {
        if (!spreadData || spreadData.sellerCount < 2) return 0;

        const cvFactor = spreadData.coefficientOfVariation / 15;
        const sellerFactor = Math.log10(spreadData.sellerCount + 1);
        const spreadFactor = Math.min(1, spreadData.absoluteSpread / 20);

        const rawScore = cvFactor * sellerFactor * spreadFactor;

        // Normalize to 1-10 scale
        return parseFloat(Math.min(10, Math.max(1, rawScore * 2.5)).toFixed(1));
    },

    /**
     * Classify the spread level into a human-readable category.
     *
     * @param {number} cv - Coefficient of Variation percentage
     * @returns {{level: string, label: string, color: string}} Classification
     */
    classifySpread(cv) {
        if (cv >= 50) return { level: 'very-high', label: 'Very High Spread', color: '#f44336' };
        if (cv >= 30) return { level: 'high', label: 'High Spread', color: '#FF9800' };
        if (cv >= 15) return { level: 'moderate', label: 'Moderate Spread', color: '#FFC107' };
        if (cv >= 5)  return { level: 'low', label: 'Low Spread', color: '#8BC34A' };
        return { level: 'very-low', label: 'Tight Pricing', color: '#4CAF50' };
    },

    /**
     * Process a full set of products with their fetched seller prices.
     * Returns analysis results sorted by arbitrage score (highest first).
     *
     * @param {Object} spreadResults - Map of ASIN → { sellerPrices: number[] }
     * @returns {Object[]} Array of analyzed products with spread metrics and scores
     */
    analyzeAll(spreadResults) {
        const analyzed = [];

        for (const [asin, data] of Object.entries(spreadResults)) {
            if (!data || !data.sellerPrices || data.sellerPrices.length < 2) {
                analyzed.push({
                    asin,
                    spreadData: null,
                    arbitrageScore: 0,
                    classification: { level: 'insufficient', label: 'Not Enough Data', color: '#9E9E9E' }
                });
                continue;
            }

            const spreadData = this.calculateSpread(data.sellerPrices);
            const arbitrageScore = this.calculateArbitrageScore(spreadData);
            const classification = this.classifySpread(spreadData.coefficientOfVariation);

            analyzed.push({
                asin,
                spreadData,
                arbitrageScore,
                classification
            });
        }

        // Sort by arbitrage score descending
        return analyzed.sort((a, b) => b.arbitrageScore - a.arbitrageScore);
    },

    /**
     * Generate summary statistics for the entire analyzed set.
     *
     * @param {Object[]} analyzedProducts - Output from analyzeAll()
     * @returns {Object} Summary with counts, averages, and top opportunities
     */
    generateSummary(analyzedProducts) {
        const withData = analyzedProducts.filter(p => p.spreadData !== null);
        if (withData.length === 0) {
            return {
                totalAnalyzed: analyzedProducts.length,
                withSpreadData: 0,
                avgCV: 0,
                highSpreadCount: 0,
                topOpportunities: []
            };
        }

        const cvValues = withData.map(p => p.spreadData.coefficientOfVariation);
        const avgCV = cvValues.reduce((a, b) => a + b, 0) / cvValues.length;
        const highSpreadCount = withData.filter(p => p.spreadData.coefficientOfVariation >= 30).length;

        return {
            totalAnalyzed: analyzedProducts.length,
            withSpreadData: withData.length,
            avgCV: parseFloat(avgCV.toFixed(2)),
            highSpreadCount,
            topOpportunities: withData
                .filter(p => p.arbitrageScore >= 4)
                .slice(0, 10)
        };
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SpreadAnalyzer;
}
