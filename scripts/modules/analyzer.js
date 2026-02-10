// analyzer.js - Data Analysis Functions
// Provides analytics and insights for scraped product data

const Analyzer = {
    // Parse price string to number
    parsePrice(priceStr) {
        if (!priceStr || priceStr === 'N/A') return 0;
        return parseFloat(String(priceStr).replace(/[^0-9.]/g, '')) || 0;
    },

    // Parse rating to number
    parseRating(rating) {
        if (!rating || rating === 'N/A') return 0;
        return parseFloat(rating) || 0;
    },

    // Parse review count to number
    parseReviewCount(count) {
        if (!count) return 0;
        return parseInt(String(count).replace(/[^0-9]/g, '')) || 0;
    },

    // Calculate basic statistics for a numeric array
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

    // Get price distribution buckets
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

    // Get rating distribution
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

    // Calculate opportunity score for arbitrage
    // Higher score = better opportunity
    calculateOpportunityScore(product) {
        const price = this.parsePrice(product.price);
        const rating = this.parseRating(product.rating);
        const reviews = this.parseReviewCount(product.reviewCount);

        if (price <= 0 || rating <= 0) return 0;

        // Formula: (rating * log(reviews+1)) / sqrt(price)
        // Favors: high rating, many reviews, lower price
        const reviewFactor = Math.log10(reviews + 1);
        const priceFactor = Math.sqrt(price);

        const score = (rating * reviewFactor) / priceFactor;

        // Normalize to 1-10 scale
        return Math.min(10, Math.max(1, score * 2));
    },

    // Get top opportunities
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

    // Identify underpriced products (below category average with good rating)
    findUnderpriced(products, threshold = 0.7) {
        const prices = products.map(p => this.parsePrice(p.price)).filter(p => p > 0);
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

        return products.filter(p => {
            const price = this.parsePrice(p.price);
            const rating = this.parseRating(p.rating);
            return price > 0 && price < avgPrice * threshold && rating >= 4.0;
        });
    },

    // Find products with high ratings but low reviews (underexposed)
    findUnderexposed(products, maxReviews = 50, minRating = 4.0) {
        return products.filter(p => {
            const rating = this.parseRating(p.rating);
            const reviews = this.parseReviewCount(p.reviewCount);
            return rating >= minRating && reviews > 0 && reviews <= maxReviews;
        });
    },

    // Generate actionable insights
    generateInsights(products) {
        const insights = [];

        // Get price stats
        const prices = products.map(p => this.parsePrice(p.price)).filter(p => p > 0);
        const priceStats = this.calculateStats(prices);

        // Get rating stats
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

    // Full analysis report
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
