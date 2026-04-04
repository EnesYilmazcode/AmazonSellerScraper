/**
 * @fileoverview Chrome Storage Abstraction Layer
 *
 * Provides a Promise-based API over chrome.storage.local for managing
 * extension state, scraping results, and user settings. All methods
 * return Promises for consistent async/await usage throughout the extension.
 *
 * @module Storage
 * @see {@link https://developer.chrome.com/docs/extensions/reference/api/storage}
 */

const Storage = {
    /**
     * Canonical keys used across all storage operations.
     * Centralizing keys here prevents typo-related bugs and makes
     * storage schema changes a single-point update.
     *
     * @enum {string}
     */
    KEYS: {
        /** @type {string} Array of scraped product objects */
        RESULTS: 'results',
        /** @type {string} Running count of scraped items across all pages */
        ITEM_COUNT: 'currentItemCount',
        /** @type {string} Boolean flag -- true while scraping is in progress */
        IS_SCRAPING: 'isScrapingActive',
        /** @type {string} User preferences (page delay, max pages, API key) */
        SETTINGS: 'settings',
        /** @type {string} Map of ASIN → spread data from offer fetcher */
        SPREAD_RESULTS: 'spreadResults',
        /** @type {string} Boolean flag -- true while spread analysis is running */
        IS_SPREAD_ANALYZING: 'isSpreadAnalyzing'
    },

    /**
     * Retrieve a single value from chrome.storage.local.
     *
     * @param {string} key - Storage key to retrieve
     * @returns {Promise<*>} Resolves with the stored value, or undefined if not set
     *
     * @example
     * const results = await Storage.get(Storage.KEYS.RESULTS);
     */
    async get(key) {
        return new Promise((resolve) => {
            chrome.storage.local.get([key], (data) => {
                resolve(data[key]);
            });
        });
    },

    /**
     * Retrieve multiple values from storage in a single call.
     * More efficient than multiple get() calls for batch reads.
     *
     * @param {string[]} keys - Array of storage keys to retrieve
     * @returns {Promise<Object>} Resolves with an object mapping keys to their values
     *
     * @example
     * const { results, currentItemCount } = await Storage.getMultiple(['results', 'currentItemCount']);
     */
    async getMultiple(keys) {
        return new Promise((resolve) => {
            chrome.storage.local.get(keys, resolve);
        });
    },

    /**
     * Store a single key-value pair in chrome.storage.local.
     *
     * @param {string} key - Storage key
     * @param {*} value - Value to store (must be JSON-serializable)
     * @returns {Promise<void>}
     */
    async set(key, value) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [key]: value }, resolve);
        });
    },

    /**
     * Store multiple key-value pairs in a single atomic operation.
     *
     * @param {Object} data - Object with key-value pairs to store
     * @returns {Promise<void>}
     *
     * @example
     * await Storage.setMultiple({ results: [], currentItemCount: 0 });
     */
    async setMultiple(data) {
        return new Promise((resolve) => {
            chrome.storage.local.set(data, resolve);
        });
    },

    /**
     * Clear all data from chrome.storage.local.
     * Use with caution -- this removes all extension state including settings.
     *
     * @returns {Promise<void>}
     */
    async clear() {
        return new Promise((resolve) => {
            chrome.storage.local.clear(resolve);
        });
    },

    /**
     * Get a snapshot of the current scraping state.
     * Fetches isActive, itemCount, and results in a single storage read.
     *
     * @returns {Promise<{isActive: boolean, itemCount: number, results: Object[]}>}
     *   Scraping state with safe defaults (false, 0, []) for missing values
     */
    async getScrapingState() {
        const data = await this.getMultiple([
            this.KEYS.IS_SCRAPING,
            this.KEYS.ITEM_COUNT,
            this.KEYS.RESULTS
        ]);
        return {
            isActive: data[this.KEYS.IS_SCRAPING] || false,
            itemCount: data[this.KEYS.ITEM_COUNT] || 0,
            results: data[this.KEYS.RESULTS] || []
        };
    },

    /**
     * Reset storage for a fresh scraping session.
     * Clears previous results, resets item count, and sets scraping flag to active.
     * Called at the start of every new scrape operation.
     *
     * @returns {Promise<void>}
     */
    async resetForNewScrape() {
        return this.setMultiple({
            [this.KEYS.RESULTS]: [],
            [this.KEYS.ITEM_COUNT]: 0,
            [this.KEYS.IS_SCRAPING]: true
        });
    },

    /**
     * Append newly scraped products to the existing results array.
     * Called after each page is scraped to accumulate results across pagination.
     *
     * @param {Object[]} newResults - Array of product objects from the latest page
     * @returns {Promise<number>} Total result count after appending
     */
    async appendResults(newResults) {
        const existing = await this.get(this.KEYS.RESULTS) || [];
        const combined = [...existing, ...newResults];
        await this.setMultiple({
            [this.KEYS.RESULTS]: combined,
            [this.KEYS.ITEM_COUNT]: combined.length
        });
        return combined.length;
    },

    /**
     * Mark the current scraping session as complete.
     * Sets the scraping flag to false and updates the final item count.
     *
     * @param {number} finalCount - Total number of products scraped
     * @returns {Promise<void>}
     */
    async completeScraping(finalCount) {
        return this.setMultiple({
            [this.KEYS.IS_SCRAPING]: false,
            [this.KEYS.ITEM_COUNT]: finalCount
        });
    },

    /**
     * Retrieve all scraped product results from storage.
     *
     * @returns {Promise<Object[]>} Array of product objects, or empty array if none
     */
    async getResults() {
        return await this.get(this.KEYS.RESULTS) || [];
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Storage;
}
