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
 * 3 to 4 (2.2, the service worker run engine):
 * - everything but settings moves out of chrome.storage.local into
 *   IndexedDB (scripts/background/db.js): result rows become the products
 *   of their run, scrapeRunPages its pages, lastValues and spread data
 *   their own stores
 * - a 2.1 run still marked running was cut off by the update and ends as
 *   updated
 * - the IndexedDB writes commit before anything is removed, so a failure
 *   leaves version 3 in place to be retried
 *
 * Loaded as a CommonJS module in Jest and the bundled service worker.
 *
 * @module Migrate
 */

const Migrate = (() => {
    const PriceLib = typeof Price !== 'undefined' ? Price : require('../modules/price.js');
    const RunLib = typeof Run !== 'undefined' ? Run : require('./run.js');
    const DeltaLib = typeof Delta !== 'undefined' ? Delta : require('../modules/delta.js');

    const CURRENT = 4;

    /** Keys 3 to 4 moves out of chrome.storage.local. */
    const MOVED = [
        'results', 'currentItemCount', 'isScrapingActive', 'scrapeRunId', 'scrapeRunPageIndex',
        'scrapeRunMeta', 'scrapeRunPages', 'syncQueue', 'lastValues', 'spreadResults',
        'isSpreadAnalyzing', 'run'
    ];
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
        },

        /** 3 -> 4. Returns {set, remove, idb}, idb being db.js write ops. */
        4(store, now) {
            const remove = MOVED.filter(k => k in store);
            return { set: {}, remove, idb: toIdb(store, now) };
        }
    };

    /** A run record 2.1 kept in chrome.storage.local, in the 2.2 shape. */
    function upgradeRun(old, now) {
        if (!old || typeof old.runId !== 'string') return null;
        if (RunLib.STATES.includes(old.state)) return old;
        const reason = old.status === 'running' ? 'updated' : (RunLib.END_STATE[old.status] ? old.status : 'complete');
        const { status, heartbeat, ...rest } = old;
        return { ...rest, state: RunLib.END_STATE[reason], reason, finishedAt: old.finishedAt || now };
    }

    /** The IndexedDB writes that hold what `store` kept in chrome.storage.local. */
    function toIdb(store, now) {
        const ops = [];
        const results = Array.isArray(store.results) ? store.results.filter(r => r && typeof r === 'object') : [];
        const oldRun = upgradeRun(store[RunLib.KEY], now);
        const runOf = (row) => row.runId || store.scrapeRunId || LEGACY_RUN;

        const byRun = new Map();
        const add = (row) => {
            const runId = runOf(row);
            if (!byRun.has(runId)) byRun.set(runId, []);
            byRun.get(runId).push({ ...row, runId });
        };
        results.forEach(add);
        // Queued products of runs whose results are gone. Only unreleased builds queued any.
        const queued = Array.isArray(store.syncQueue) ? store.syncQueue.filter(r => r && ASIN.test(r.asin || '')) : [];
        const inResults = new Set(results.map(r => runOf(r) + ':' + r.asin));
        queued.filter(r => !inResults.has(runOf(r) + ':' + r.asin)).forEach(add);

        const latestRunId = results.length ? runOf(results[0]) : (oldRun ? oldRun.runId : null);
        const runIds = new Set([...byRun.keys(), ...(oldRun ? [oldRun.runId] : [])]);
        for (const runId of runIds) {
            const rows = byRun.get(runId) || [];
            rows.forEach((row, n) => ops.push({ store: 'products', put: { ...row, n } }));
            const base = oldRun && oldRun.runId === runId
                ? oldRun
                : { runId, state: 'done', reason: 'complete', startedAt: null, finishedAt: null };
            const source = runId === store.scrapeRunId && store.scrapeRunMeta ? store.scrapeRunMeta : (base.source || null);
            ops.push({ store: 'runs', put: { ...base, source, itemCount: rows.length } });
        }

        (Array.isArray(store.scrapeRunPages) ? store.scrapeRunPages : []).forEach(pg => {
            if (!pg || !Number.isInteger(pg.pageIndex)) return;
            ops.push({ store: 'placements', put: { ...pg, runId: pg.runId || store.scrapeRunId || LEGACY_RUN } });
        });

        Object.entries(store.lastValues || {}).forEach(([asin, snap]) => {
            if (snap && typeof snap === 'object') ops.push({ store: 'lastValues', put: { ...snap, asin } });
        });

        // The outbox numbers its own entries, so ones the engine already
        // added are never overwritten, and a retry adds nothing twice.
        [...new Set(queued.map(runOf))].forEach((runId) => {
            ops.push({
                store: 'outbox',
                putIfAbsent: { runId, pageIndex: null, queuedAt: now },
                unlessIndex: ['runId', runId]
            });
        });

        if (latestRunId) {
            Object.entries(store.spreadResults || {}).forEach(([asin, data]) => {
                ops.push({ store: 'spread', put: { runId: latestRunId, asin, data: data || null } });
            });
            // A retry that runs after a 2.2 run must not point back at 2.1.
            ops.push({ store: 'meta', putIfAbsent: { key: 'latestRunId', value: latestRunId } });
        }
        return ops;
    }

    /**
     * What it takes to bring `store` to the current version, or null when it
     * is already there. Pure: reads `store`, returns the writes.
     *
     * @param {Object} store - everything in chrome.storage.local
     * @param {{now?: number, to?: number}} [opts] - `to` stops at an earlier version
     * @returns {{from: number, to: number, set: Object, remove: string[], idb: Object[]}|null}
     */
    function plan(store, { now = Date.now(), to = CURRENT } = {}) {
        const from = versionOf(store);
        if (from >= to) return null;
        let state = { ...store };
        const remove = new Set();
        const idb = [];
        for (let v = from + 1; v <= to; v++) {
            const step = STEPS[v](state, now);
            state = { ...state, ...step.set };
            step.remove.forEach(k => { remove.add(k); delete state[k]; });
            if (step.idb) idb.push(...step.idb);
        }
        const set = {};
        Object.keys(state).forEach(k => { if (state[k] !== store[k]) set[k] = state[k]; });
        set.schemaVersion = to;
        return { from, to, set, remove: [...remove].filter(k => k in store), idb };
    }

    /**
     * Runs the migration against a chrome.storage area. The IndexedDB writes
     * commit first, in one transaction, then the removals, and schemaVersion
     * is written last with the rest. A failure at any point leaves the old
     * version in place to be retried, and a retry rewrites the same keyed
     * records.
     *
     * @param {chrome.storage.StorageArea} area
     * @param {{now?: number, to?: number, openDb?: function(): Promise<Object>}} [opts]
     * @returns {Promise<Object|null>} the plan that was applied, or null
     */
    async function run(area, opts = {}) {
        const store = await area.get(null);
        const p = plan(store || {}, opts);
        if (!p) return null;
        if (p.idb.length) {
            if (!opts.openDb) throw new Error('migration needs IndexedDB');
            await (await opts.openDb()).write(p.idb);
        }
        if (p.remove.length) await area.remove(p.remove);
        await area.set(p.set);
        return p;
    }

    return { CURRENT, LEGACY_RUN, MOVED, versionOf, upgradeRow, upgradeRun, toIdb, plan, run };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Migrate;
}
