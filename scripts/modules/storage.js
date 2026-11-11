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
        IS_SPREAD_ANALYZING: 'isSpreadAnalyzing',
        /** @type {string} Current scrape run id (minted per scrape, survives pagination) */
        SCRAPE_RUN_ID: 'scrapeRunId',
        /** @type {string} 1-based index of the last page persisted for this run */
        RUN_PAGE_INDEX: 'scrapeRunPageIndex',
        /** @type {string} Run source metadata { type, sellerId, keyword, url, startedAt } */
        RUN_META: 'scrapeRunMeta',
        /** @type {string} Per-page manifest for the run inbox */
        RUN_PAGES: 'scrapeRunPages',
        /** @type {string} Durable, append-only queue of products awaiting cloud sync */
        SYNC_QUEUE: 'syncQueue',
        /** @type {string} Per-ASIN last-seen snapshot for month-over-month deltas */
        LAST_VALUES: 'lastValues'
    },

    /** Share of the quota above which the popup warns that storage is nearly full. */
    NEAR_FULL: 0.9,

    /**
     * Runs chrome.storage.local[method] and rejects when Chrome reports an
     * error through runtime.lastError, instead of resolving as if it worked.
     * A quota error rejects with code 'storage_full'.
     */
    _call(method, ...args) {
        return new Promise((resolve, reject) => {
            chrome.storage.local[method](...args, (value) => {
                const err = chrome.runtime && chrome.runtime.lastError;
                if (err) return reject(this.error(err.message || String(err)));
                resolve(value);
            });
        });
    },

    /** An Error for a failed storage call, with code 'storage_full' or 'storage_error'. */
    error(message) {
        const err = new Error(message);
        err.name = 'StorageError';
        err.code = /quota/i.test(message) ? 'storage_full' : 'storage_error';
        return err;
    },

    /**
     * Retrieve a single value from chrome.storage.local.
     *
     * @param {string} key - Storage key to retrieve
     * @returns {Promise<*>} Resolves with the stored value, or undefined if not set
     */
    async get(key) {
        const data = await this._call('get', [key]);
        return (data || {})[key];
    },

    /**
     * Retrieve multiple values from storage in a single call.
     *
     * @param {string[]} keys - Array of storage keys to retrieve
     * @returns {Promise<Object>} Resolves with an object mapping keys to their values
     */
    async getMultiple(keys) {
        return (await this._call('get', keys)) || {};
    },

    /**
     * Store a single key-value pair. Rejects with a StorageError when the
     * write fails, for example when the quota is used up.
     *
     * @param {string} key - Storage key
     * @param {*} value - Value to store (must be JSON-serializable)
     * @returns {Promise<void>}
     */
    async set(key, value) {
        await this._call('set', { [key]: value });
    },

    /**
     * Store multiple key-value pairs in a single atomic operation.
     *
     * @param {Object} data - Object with key-value pairs to store
     * @returns {Promise<void>}
     */
    async setMultiple(data) {
        await this._call('set', data);
    },

    /**
     * Remove one key or a list of keys.
     *
     * @param {string|string[]} keys
     * @returns {Promise<void>}
     */
    async remove(keys) {
        await this._call('remove', keys);
    },

    /**
     * Clear all data from chrome.storage.local.
     * Use with caution -- this removes all extension state including settings.
     *
     * @returns {Promise<void>}
     */
    async clear() {
        await this._call('clear');
    },

    /**
     * Bytes in use against the local quota. `nearFull` is true from
     * NEAR_FULL of the quota up. Unknown usage reads as 0.
     *
     * @returns {Promise<{bytes: number, quota: number, nearFull: boolean}>}
     */
    async usage() {
        const quota = chrome.storage.local.QUOTA_BYTES || 10485760;
        let bytes = 0;
        if (typeof chrome.storage.local.getBytesInUse === 'function') {
            bytes = (await this._call('getBytesInUse', null)) || 0;
        }
        return { bytes, quota, nearFull: bytes >= quota * this.NEAR_FULL };
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
            [this.KEYS.IS_SCRAPING]: true,
            // Clear the prior run's spread data so it cannot leak into this
            // scrape's insights/exports (consumers read spreadResults[asin]).
            [this.KEYS.SPREAD_RESULTS]: {},
            [this.KEYS.IS_SPREAD_ANALYZING]: false
        });
    },

    /**
     * Begin a new scrape run: mint a run id and reset the per-run bookkeeping
     * (page index, source metadata, page manifest). Deliberately does NOT touch
     * the durable sync queue or lastValues — those persist across runs so that
     * unsynced data is never dropped and deltas survive between scrapes.
     *
     * @param {string} sourceUrl - The Amazon search/storefront URL being scraped
     * @returns {Promise<string>} The newly-minted run id
     */
    async beginRun(sourceUrl) {
        const runId = `${Date.now()}-${this._runSuffix()}`;
        const source = this._detectSource(sourceUrl || '');
        await this.setMultiple({
            [this.KEYS.SCRAPE_RUN_ID]: runId,
            [this.KEYS.RUN_PAGE_INDEX]: 0,
            [this.KEYS.RUN_META]: {
                type: source.type,
                sellerId: source.sellerId,
                keyword: source.keyword,
                url: sourceUrl || null,
                startedAt: new Date().toISOString()
            },
            [this.KEYS.RUN_PAGES]: []
        });
        return runId;
    },

    /**
     * Classify a scrape source URL as a storefront (me=) or keyword (k=) search.
     * @param {string} url
     * @returns {{type: string, sellerId: string|null, keyword: string|null}}
     */
    _detectSource(url) {
        try {
            const u = new URL(url);
            const me = u.searchParams.get('me');
            const k = u.searchParams.get('k');
            if (me) return { type: 'storefront', sellerId: me, keyword: null };
            if (k) return { type: 'keyword', sellerId: null, keyword: k };
        } catch (e) { /* not a parseable URL */ }
        return { type: 'keyword', sellerId: null, keyword: null };
    },

    /**
     * Short random suffix for run ids; prefers crypto.randomUUID where present.
     * @returns {string}
     */
    _runSuffix() {
        try {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                return crypto.randomUUID().slice(0, 8);
            }
        } catch (e) { /* fall through */ }
        return Math.random().toString(36).slice(2, 10);
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
