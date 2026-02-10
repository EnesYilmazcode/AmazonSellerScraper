// storage.js - Chrome Storage Wrapper
// Provides a clean API for interacting with chrome.storage.local

const Storage = {
    // Keys used in storage
    KEYS: {
        RESULTS: 'results',
        ITEM_COUNT: 'currentItemCount',
        IS_SCRAPING: 'isScrapingActive',
        SETTINGS: 'settings'
    },

    // Get a single value from storage
    async get(key) {
        return new Promise((resolve) => {
            chrome.storage.local.get([key], (data) => {
                resolve(data[key]);
            });
        });
    },

    // Get multiple values from storage
    async getMultiple(keys) {
        return new Promise((resolve) => {
            chrome.storage.local.get(keys, resolve);
        });
    },

    // Set a single value in storage
    async set(key, value) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [key]: value }, resolve);
        });
    },

    // Set multiple values in storage
    async setMultiple(data) {
        return new Promise((resolve) => {
            chrome.storage.local.set(data, resolve);
        });
    },

    // Clear all storage
    async clear() {
        return new Promise((resolve) => {
            chrome.storage.local.clear(resolve);
        });
    },

    // Get scraping state
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

    // Reset scraping state for new scrape
    async resetForNewScrape() {
        return this.setMultiple({
            [this.KEYS.RESULTS]: [],
            [this.KEYS.ITEM_COUNT]: 0,
            [this.KEYS.IS_SCRAPING]: true
        });
    },

    // Add results to existing results
    async appendResults(newResults) {
        const existing = await this.get(this.KEYS.RESULTS) || [];
        const combined = [...existing, ...newResults];
        await this.setMultiple({
            [this.KEYS.RESULTS]: combined,
            [this.KEYS.ITEM_COUNT]: combined.length
        });
        return combined.length;
    },

    // Mark scraping as complete
    async completeScraping(finalCount) {
        return this.setMultiple({
            [this.KEYS.IS_SCRAPING]: false,
            [this.KEYS.ITEM_COUNT]: finalCount
        });
    },

    // Get all results
    async getResults() {
        return await this.get(this.KEYS.RESULTS) || [];
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Storage;
}
