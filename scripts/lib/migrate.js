/**
 * @fileoverview Storage schema migrations.
 *
 * `schemaVersion` in chrome.storage.local says which shape the stored data
 * has. Storage without it came from 2.0 or earlier (version 2). Each step
 * is idempotent and runs in order from the service worker on install,
 * update and browser start.
 *
 * 2 to 3 (upgrading from the 2.0 store build, F-100, F-101):
 * - result rows get priceCents, null for unknown values, and /dp/ URLs
 * - lastValues is seeded from those rows, so the first 2.1 scrape of the
 *   same search shows real price and review changes since the 2.0 scrape,
 *   and firstSeenAt keeps the date 2.0 first saw the product
 * - a 2.0 run cut off by the update is recorded as ended, not resumed
 * - the untouched 2.0 default settings are dropped, so 2.1 defaults apply
 *
 * Loaded as a CommonJS module in Jest and the bundled service worker.
 *
 * @module Migrate
 */

const Migrate = (() => {
    const PriceLib = typeof Price !== 'undefined' ? Price : require('../modules/price.js');
    const RunLib = typeof Run !== 'undefined' ? Run : require('./run.js');
    const DeltaLib = typeof Delta !== 'undefined' ? Delta : require('../modules/delta.js');

    const CURRENT = 3;
    const LEGACY_RUN = 'legacy-2.0';
    const ASIN = /^[A-Z0-9]{10}$/;

    function versionOf(store) {
        return Number.isInteger(store && store.schemaVersion) ? store.schemaVersion : 2;
    }

    // 2.0 wrote 0 for a missing rating or review count, and 1.x wrote 'N/A'.
    const known = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

    /** A 2.0 or 1.x result row in the 2.1 product shape. Newer rows pass through. */
    function upgradeRow(row) {
        if (!row || typeof row !== 'object' || row.runId) return row;
        const out = { ...row };
        if (!('priceCents' in row)) {
            out.priceCents = typeof row.price === 'number'
                ? PriceLib.priceToCents(row.price)
                : PriceLib.usdToCents(row.price);
        }
        if (out.priceCents === null) out.price = null;
        if (out.name === 'N/A' || out.name === '') out.name = null;
        out.rating = known(row.rating);
        out.reviewCount = known(row.reviewCount);
        if (ASIN.test(row.asin || '')) out.url = `https://www.amazon.com/dp/${row.asin}`;
        return out;
    }

    const STEPS = {
        /** 2 -> 3. Returns {set, remove}. */
        3(store, now) {
            const set = {};
            const remove = [];

            const results = Array.isArray(store.results) ? store.results.map(upgradeRow) : null;
            if (results) set.results = results;

            // Seed from the first sighting of each ASIN; never replace a newer snapshot.
            const lastValues = { ...(store.lastValues || {}) };
            (results || []).forEach(row => {
                if (!row || row.runId || !ASIN.test(row.asin || '') || lastValues[row.asin]) return;
                const seenAt = typeof row.scrapedAt === 'string' ? row.scrapedAt : null;
                lastValues[row.asin] = {
                    priceCents: row.priceCents,
                    rating: row.rating,
                    reviewCount: row.reviewCount,
                    runId: LEGACY_RUN,
                    scrapedAt: seenAt,
                    firstSeenAt: seenAt
                };
            });
            set.lastValues = DeltaLib.prune(lastValues, { now });

            // A 2.0 run has no run record. If its flag is still up, the update cut it off.
            if (store.isScrapingActive && !RunLib.isActive(store[RunLib.KEY])) {
                set.isScrapingActive = false;
                set[RunLib.KEY] = RunLib.finish(
                    RunLib.create({ runId: LEGACY_RUN, tabId: null, now }), 'updated', now);
            }

            const s = store.settings;
            if (s && Object.keys(s).length === 2 && s.pageDelay === 2000 && s.maxPages === 100) {
                remove.push('settings');
            }
            return { set, remove };
        }
    };

    /**
     * What it takes to bring `store` to the current version, or null when it
     * is already there. Pure: reads `store`, returns the writes.
     *
     * @param {Object} store - everything in chrome.storage.local
     * @param {{now?: number}} [opts]
     * @returns {{from: number, to: number, set: Object, remove: string[]}|null}
     */
    function plan(store, { now = Date.now() } = {}) {
        const from = versionOf(store);
        if (from >= CURRENT) return null;
        let state = { ...store };
        const remove = new Set();
        for (let v = from + 1; v <= CURRENT; v++) {
            const step = STEPS[v](state, now);
            state = { ...state, ...step.set };
            step.remove.forEach(k => { remove.add(k); delete state[k]; });
        }
        const set = {};
        Object.keys(state).forEach(k => { if (state[k] !== store[k]) set[k] = state[k]; });
        set.schemaVersion = CURRENT;
        return { from, to: CURRENT, set, remove: [...remove] };
    }

    /**
     * Runs the migration against a chrome.storage area. Removals go first and
     * schemaVersion is written last with the rest, so a failed write leaves
     * the old version in place to be retried.
     *
     * @param {chrome.storage.StorageArea} area
     * @param {{now?: number}} [opts]
     * @returns {Promise<Object|null>} the plan that was applied, or null
     */
    async function run(area, opts) {
        const store = await area.get(null);
        const p = plan(store || {}, opts);
        if (!p) return null;
        if (p.remove.length) await area.remove(p.remove);
        await area.set(p.set);
        return p;
    }

    return { CURRENT, LEGACY_RUN, versionOf, upgradeRow, plan, run };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Migrate;
}
