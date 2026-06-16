/**
 * @fileoverview Canonical price parsing — integer cents.
 *
 * ProScan historically parsed Amazon price strings into floating-point
 * dollars in three different places (scraper, analyzer, offer-fetcher),
 * each with a slightly different regex. Floating dollars are lossy for the
 * cloud sync + delta math (e.g. 0.1 + 0.2 !== 0.3), so the canonical
 * representation for synced data is an INTEGER number of cents.
 *
 * Loaded as a plain global (`Price`) in both the Amazon page context and the
 * popup, and as a CommonJS module in Jest — matching the pattern used by
 * storage.js / analyzer.js. It must be listed BEFORE its consumers in
 * manifest.json content_scripts and in popup.html.
 *
 * @module Price
 */

const Price = {
    /**
     * Parse an Amazon price into an integer number of cents.
     * US-locale aware: comma is a thousands separator, dot is the decimal.
     * Returns `null` (not 0) for unparseable / absent prices so callers can
     * distinguish "no price" from a genuine $0.00.
     *
     * @param {string|number|null|undefined} input - e.g. "$1,299.99", 19.99, "N/A"
     * @returns {number|null} Integer cents, or null if unparseable
     *
     * @example
     * Price.priceToCents("$19.99")    // => 1999
     * Price.priceToCents("$1,299.00") // => 129900
     * Price.priceToCents("N/A")       // => null
     */
    priceToCents(input) {
        if (input === null || input === undefined) return null;
        if (typeof input === 'number') {
            return Number.isFinite(input) ? Math.round(input * 100) : null;
        }
        // Strip currency symbols, letters, and whitespace; keep digits/separators.
        let cleaned = String(input).replace(/[^0-9.,]/g, '');
        if (!cleaned) return null;
        // US format: remove thousands commas, leaving the decimal dot.
        cleaned = cleaned.replace(/,/g, '');
        // Guard against malformed multi-dot strings: keep only the first dot.
        const firstDot = cleaned.indexOf('.');
        if (firstDot !== -1) {
            cleaned = cleaned.slice(0, firstDot + 1) +
                      cleaned.slice(firstDot + 1).replace(/\./g, '');
        }
        const value = parseFloat(cleaned);
        if (isNaN(value)) return null;
        return Math.round(value * 100);
    },

    /**
     * Format integer cents back into a display string.
     *
     * @param {number|null|undefined} cents - Integer cents
     * @returns {string} e.g. "$19.99", or "N/A" for null/NaN
     */
    centsToDisplay(cents) {
        if (cents === null || cents === undefined || isNaN(cents)) return 'N/A';
        const sign = cents < 0 ? '-' : '';
        return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
    },

    /**
     * Back-compat shim returning floating-point DOLLARS (not cents).
     * Mirrors the legacy parsePrice contract (0 for unparseable) so callers
     * that still think in dollars can delegate here without behaviour change.
     *
     * @param {string|number|null|undefined} input
     * @returns {number} Dollars, or 0 if unparseable
     */
    parsePrice(input) {
        const cents = this.priceToCents(input);
        return cents === null ? 0 : cents / 100;
    }
};

// Export for Jest (CommonJS); harmless no-op in the browser/page context.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Price;
}
