/**
 * @fileoverview Month-over-month delta engine.
 *
 * Computes per-ASIN changes (price / rating / review-count) between the
 * current observation and the previously-seen snapshot. Snapshots live in
 * chrome.storage.local under `lastValues` and persist across scrape runs and
 * page navigations, so deltas are computed entirely client-side — no extra
 * Firestore reads, keeping the platform inside the free tier.
 *
 * Loaded as a plain global (`Delta`) in the Amazon page context and as a
 * CommonJS module in Jest, matching price.js / storage.js. Must be listed in
 * manifest.json content_scripts AFTER price.js (it consumes integer cents).
 *
 * @module Delta
 */

const Delta = {
    /**
     * Round to one decimal place, avoiding binary-float noise
     * (e.g. 4.6 - 4.5 === 0.09999999999999964).
     * @param {number} n
     * @returns {number}
     */
    _round1(n) {
        return Math.round(n * 10) / 10;
    },

    /**
     * Compute deltas between a freshly-scraped product and its prior snapshot.
     * Price delta is in integer cents (negative = price DROP, a buyer win).
     * Any field whose current or prior value is unknown yields a null delta,
     * so the dashboard can render "—" rather than a bogus 0.
     *
     * @param {Object} current - Scraped product (must carry priceCents/rating/reviewCount)
     * @param {Object|null} prev - Prior snapshot from lastValues[asin], or null if first sight
     * @returns {{isNew: boolean, dPriceCents: number|null, dRating: number|null, dReviews: number|null}}
     */
    computeDeltas(current, prev) {
        if (!prev) {
            return { isNew: true, dPriceCents: null, dRating: null, dReviews: null };
        }

        const haveNum = (a, b) => typeof a === 'number' && typeof b === 'number';

        const dPriceCents = haveNum(current.priceCents, prev.priceCents)
            ? current.priceCents - prev.priceCents
            : null;
        const dRating = haveNum(current.rating, prev.rating)
            ? this._round1(current.rating - prev.rating)
            : null;
        const dReviews = haveNum(current.reviewCount, prev.reviewCount)
            ? current.reviewCount - prev.reviewCount
            : null;

        return { isNew: false, dPriceCents, dRating, dReviews };
    },

    /**
     * Build the lastValues snapshot to persist for a scraped product, so the
     * next run can diff against it. Stores integer cents and the run that
     * observed the values. Missing numeric fields become null (not 0) to
     * preserve the "unknown vs zero" distinction.
     *
     * A field this scrape could not read keeps the previous snapshot's value,
     * so one failed parse does not wipe the baseline. `carried` then maps the
     * field to when that value was last actually seen.
     *
     * @param {Object} product - Scraped product
     * @param {Object|null} [prev] - The snapshot this one replaces
     * @returns {{priceCents: number|null, rating: number|null, reviewCount: number|null, runId: string|null, scrapedAt: string|null, carried?: Object}}
     */
    snapshot(product, prev = null) {
        const numOrNull = (v) => (typeof v === 'number' ? v : null);
        const snap = {
            priceCents: numOrNull(product.priceCents),
            rating: numOrNull(product.rating),
            reviewCount: numOrNull(product.reviewCount),
            runId: typeof product.runId === 'string' ? product.runId : null,
            scrapedAt: typeof product.scrapedAt === 'string' ? product.scrapedAt : null
        };
        const carried = {};
        for (const field of ['priceCents', 'rating', 'reviewCount']) {
            if (snap[field] !== null || !prev || numOrNull(prev[field]) === null) continue;
            snap[field] = prev[field];
            carried[field] = (prev.carried && prev.carried[field]) || prev.scrapedAt || null;
        }
        if (Object.keys(carried).length) snap.carried = carried;
        return snap;
    }
};

// Export for Jest (CommonJS); harmless no-op in the browser/page context.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Delta;
}
