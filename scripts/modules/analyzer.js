/**
 * @fileoverview Product Analytics Engine
 *
 * Provides statistical analysis, opportunity scoring, and actionable
 * insight generation for scraped Amazon product data. The core of
 * ProScan's value proposition for resellers and arbitrage traders.
 *
 * Key capabilities:
 * - Descriptive statistics (min, max, avg, median) for price/rating/reviews
 * - Price and rating distribution bucketing for visualization
 * - Proprietary opportunity scoring algorithm for arbitrage identification
 * - Automated insight detection (underpriced, underexposed products)
 * - Full report generation combining all analytics
 *
 * @module Analyzer
 */

const Analyzer = {
    /**
     * Parse a price string into a numeric value.
     * Handles currency symbols, commas, and 'N/A' gracefully.
     *
     * @param {string|number} priceStr - Price string (e.g., "$19.99", "N/A", 19.99)
     * @returns {number} Numeric price, or 0 if unparseable
     *
     * @example
     * Analyzer.parsePrice("$1,299.99") // => 1299.99
     * Analyzer.parsePrice("N/A")       // => 0
     */
    parsePrice(priceStr) {
        if (!priceStr || priceStr === 'N/A') return 0;
        return parseFloat(String(priceStr).replace(/[^0-9.]/g, '')) || 0;
    },

    /**
     * Parse a rating value to a float.
     *
     * @param {string|number} rating - Rating value (e.g., "4.5", 4.5, "N/A")
     * @returns {number} Numeric rating, or 0 if unparseable
     */
    parseRating(rating) {
        if (!rating || rating === 'N/A') return 0;
        return parseFloat(rating) || 0;
    },

    /**
     * Parse a review count string to an integer.
     * Strips non-numeric characters (commas, parentheses, etc.).
     *
     * @param {string|number} count - Review count (e.g., "12,847", 12847)
     * @returns {number} Integer review count, or 0 if unparseable
     */
    parseReviewCount(count) {
        if (!count) return 0;
        return parseInt(String(count).replace(/[^0-9]/g, '')) || 0;
    },

    /**
     * Calculate descriptive statistics for a numeric array.
     * Filters out zero/negative values before computation.
     *
     * @param {number[]} values - Array of numeric values
     * @returns {{min: number, max: number, avg: number, median: number, count: number}}
     *   Statistical summary. All zeros if no valid values exist.
     */
    calculateStats(values) {
        const filtered = values.filter(v => v > 0);
        if (filtered.length === 0) {
            return { min: 0, max: 0, avg: 0, median: 0, count: 0 };
        }

        const sorted = [...filtered].sort((a, b) => a - b);
        const sum = filtered.reduce((a, b) => a + b, 0);
        const midIndex = Math.floor(sorted.length / 2);

        return {
            min: sorted[0],
            max: sorted[sorted.length - 1],
            avg: parseFloat((sum / filtered.length).toFixed(2)),
            median: sorted.length % 2 === 0
                ? (sorted[midIndex - 1] + sorted[midIndex]) / 2
                : sorted[midIndex],
            count: filtered.length
        };
    },

    /**
     * Bucket products into price ranges for distribution analysis.
     *
     * @param {Object[]} products - Array of product objects with .price field
     * @returns {Object<string, number>} Map of price range labels to product counts
     */
    getPriceDistribution(products) {
        const buckets = {
            '$0-$10': 0,
            '$10-$25': 0,
            '$25-$50': 0,
            '$50-$100': 0,
            '$100+': 0
        };

        products.forEach(p => {
            const price = this.parsePrice(p.price);
            if (price <= 0) return;
            if (price < 10) buckets['$0-$10']++;
            else if (price < 25) buckets['$10-$25']++;
            else if (price < 50) buckets['$25-$50']++;
            else if (price < 100) buckets['$50-$100']++;
            else buckets['$100+']++;
        });

        return buckets;
    },

    /**
     * Bucket products into rating ranges for quality distribution analysis.
     *
     * @param {Object[]} products - Array of product objects with .rating field
     * @returns {Object<string, number>} Map of rating range labels to product counts
     */
    getRatingDistribution(products) {
        const buckets = {
            '5 Stars': 0,
            '4-4.9 Stars': 0,
            '3-3.9 Stars': 0,
            'Below 3 Stars': 0,
            'No Rating': 0
        };

        products.forEach(p => {
            const rating = this.parseRating(p.rating);
            if (rating >= 4.8) buckets['5 Stars']++;
            else if (rating >= 4) buckets['4-4.9 Stars']++;
            else if (rating >= 3) buckets['3-3.9 Stars']++;
            else if (rating > 0) buckets['Below 3 Stars']++;
            else buckets['No Rating']++;
        });

        return buckets;
    },

    /**
     * Calculate the opportunity score for a single product.
     *
     * Formula: score = (rating * log10(reviews + 1)) / sqrt(price)
     * Normalized to a 1-10 scale (multiplied by 2, clamped).
     *
     * The formula balances three signals:
     * - Rating: linear weight rewards quality
     * - Reviews: logarithmic factor prevents mega-sellers from dominating
     * - Price: inverse square root provides moderate price sensitivity
     *
     * Higher score = better arbitrage opportunity.
     *
     * @param {Object} product - Product object with price, rating, reviewCount
     * @returns {number} Opportunity score (1-10), or 0 if data is insufficient
     */
    calculateOpportunityScore(product) {
        const price = this.parsePrice(product.price);
        const rating = this.parseRating(product.rating);
        const reviews = this.parseReviewCount(product.reviewCount);

        if (price <= 0 || rating <= 0) return 0;

        const reviewFactor = Math.log10(reviews + 1);
        const priceFactor = Math.sqrt(price);

        const score = (rating * reviewFactor) / priceFactor;

        // Normalize to 1-10 scale
        return Math.min(10, Math.max(1, score * 2));
    },

    /**
     * Rank products by opportunity score and return the top N.
     *
     * @param {Object[]} products - Array of product objects
     * @param {number} [limit=10] - Maximum number of results
     * @returns {Object[]} Products sorted by descending opportunity score,
     *   each augmented with an .opportunityScore property
     */
    getTopOpportunities(products, limit = 10) {
        const scored = products.map(p => ({
            ...p,
            opportunityScore: this.calculateOpportunityScore(p)
        }));

        return scored
            .filter(p => p.opportunityScore > 0)
            .sort((a, b) => b.opportunityScore - a.opportunityScore)
            .slice(0, limit);
    },

    /**
     * Identify underpriced products -- those priced significantly below
     * the category average while maintaining strong ratings.
     *
     * @param {Object[]} products - Array of product objects
     * @param {number} [threshold=0.7] - Price threshold as fraction of average
     *   (0.7 = 30% below average)
     * @returns {Object[]} Products matching the underpriced criteria
     */
    findUnderpriced(products, threshold = 0.7) {
        const prices = products.map(p => this.parsePrice(p.price)).filter(p => p > 0);
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

        return products.filter(p => {
            const price = this.parsePrice(p.price);
            const rating = this.parseRating(p.rating);
            return price > 0 && price < avgPrice * threshold && rating >= 4.0;
        });
    },

    /**
     * Find underexposed products -- high-quality items with low review counts.
     * These represent opportunities with less established competition.
     *
     * @param {Object[]} products - Array of product objects
     * @param {number} [maxReviews=50] - Maximum review count threshold
     * @param {number} [minRating=4.0] - Minimum rating threshold
     * @returns {Object[]} Products matching the underexposed criteria
     */
    findUnderexposed(products, maxReviews = 50, minRating = 4.0) {
        return products.filter(p => {
            const rating = this.parseRating(p.rating);
            const reviews = this.parseReviewCount(p.reviewCount);
            return rating >= minRating && reviews > 0 && reviews <= maxReviews;
        });
    },

    /**
     * Generate actionable insights from the product dataset.
     * Analyzes the full product set and returns prioritized recommendations.
     *
     * @param {Object[]} products - Array of product objects
     * @returns {Object[]} Array of insight objects, each containing:
     *   - type: 'opportunity' | 'info'
     *   - priority: 'high' | 'medium' | 'low'
     *   - title: Human-readable insight headline
     *   - description: Detailed explanation with data points
     *   - action: Recommended next step
     *   - products: (optional) Related product subset
     */
    generateInsights(products) {
        const insights = [];

        const prices = products.map(p => this.parsePrice(p.price)).filter(p => p > 0);
        const priceStats = this.calculateStats(prices);

        const ratings = products.map(p => this.parseRating(p.rating)).filter(r => r > 0);
        const ratingStats = this.calculateStats(ratings);

        // Underpriced opportunities
        const underpriced = this.findUnderpriced(products);
        if (underpriced.length > 0) {
            insights.push({
                type: 'opportunity',
                priority: 'high',
                title: `${underpriced.length} underpriced products found`,
                description: `Products priced 30%+ below average ($${priceStats.avg}) with 4+ star rating`,
                products: underpriced.slice(0, 5),
                action: 'Consider sourcing these for resale'
            });
        }

        // Underexposed products
        const underexposed = this.findUnderexposed(products);
        if (underexposed.length > 0) {
            insights.push({
                type: 'opportunity',
                priority: 'medium',
                title: `${underexposed.length} underexposed products`,
                description: 'High-rated products with fewer than 50 reviews - less competition',
                products: underexposed.slice(0, 5),
                action: 'These have good potential with less established competition'
            });
        }

        // Price range insight
        insights.push({
            type: 'info',
            priority: 'low',
            title: 'Price Range Analysis',
            description: `Products range from $${priceStats.min} to $${priceStats.max} (avg: $${priceStats.avg})`,
            action: 'Sweet spot for this seller appears to be $' + priceStats.median
        });

        // Rating insight
        const highRatedCount = products.filter(p => this.parseRating(p.rating) >= 4.5).length;
        const percentHighRated = ((highRatedCount / products.length) * 100).toFixed(0);
        insights.push({
            type: 'info',
            priority: 'low',
            title: 'Quality Distribution',
            description: `${percentHighRated}% of products have 4.5+ star rating`,
            action: highRatedCount > products.length / 2
                ? 'This seller maintains good quality overall'
                : 'Mixed quality - check individual products carefully'
        });

        return insights;
    },

    /**
     * Generate a comprehensive analysis report combining all analytics.
     * Used by the Excel exporter to populate the Analytics and Insights sheets.
     *
     * @param {Object[]} products - Array of product objects
     * @returns {{
     *   summary: {totalProducts: number, priceStats: Object, ratingStats: Object, reviewStats: Object},
     *   distributions: {price: Object, rating: Object},
     *   topOpportunities: Object[],
     *   insights: Object[],
     *   generatedAt: string
     * }} Full analysis report
     */
    generateFullReport(products) {
        return {
            summary: {
                totalProducts: products.length,
                priceStats: this.calculateStats(products.map(p => this.parsePrice(p.price))),
                ratingStats: this.calculateStats(products.map(p => this.parseRating(p.rating))),
                reviewStats: this.calculateStats(products.map(p => this.parseReviewCount(p.reviewCount)))
            },
            distributions: {
                price: this.getPriceDistribution(products),
                rating: this.getRatingDistribution(products)
            },
            topOpportunities: this.getTopOpportunities(products, 10),
            insights: this.generateInsights(products),
            generatedAt: new Date().toISOString()
        };
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Analyzer;
}
