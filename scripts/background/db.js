/**
 * @fileoverview IndexedDB for everything a run collects.
 *
 * The service worker is the only user. chrome.storage.local keeps only
 * settings and schemaVersion; this database keeps the rest, in the
 * extension's own origin, which needs no permission and has far more room.
 *
 * Stores:
 * - runs        {runId, source, state, reason, pages[], itemCount, ...}
 * - products    one record per ASIN per run, key [runId, n] where n is the
 *               order it was found in; index runId
 * - placements  one page of a run, key [runId, pageIndex]; index runId
 * - lastValues  {asin, priceCents, rating, reviewCount, scrapedAt, ...};
 *               index scrapedAt
 * - outbox      products waiting for cloud sync, key seq; index runId
 * - spread      offer prices per product, key [runId, asin]; index runId
 * - meta        {key, value}, e.g. latestRunId
 *
 * Reads and writes each use one transaction. A write that runs out of room
 * rejects with a StorageError whose code is 'storage_full'.
 *
 * @module DB
 */

const NAME = 'proscan';
const VERSION = 1;

function storageError(err) {
    const e = new Error((err && err.message) || String(err || 'IndexedDB failed'));
    e.name = 'StorageError';
    e.code = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || '')) ? 'storage_full' : 'storage_error';
    return e;
}

function upgrade(db) {
    const has = (n) => db.objectStoreNames.contains(n);
    if (!has('runs')) db.createObjectStore('runs', { keyPath: 'runId' });
    if (!has('products')) db.createObjectStore('products', { keyPath: ['runId', 'n'] }).createIndex('runId', 'runId');
    if (!has('placements')) db.createObjectStore('placements', { keyPath: ['runId', 'pageIndex'] }).createIndex('runId', 'runId');
    if (!has('lastValues')) db.createObjectStore('lastValues', { keyPath: 'asin' }).createIndex('scrapedAt', 'scrapedAt');
    if (!has('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }).createIndex('runId', 'runId');
    if (!has('spread')) db.createObjectStore('spread', { keyPath: ['runId', 'asin'] }).createIndex('runId', 'runId');
    if (!has('meta')) db.createObjectStore('meta', { keyPath: 'key' });
}

/**
 * Opens the database. `indexedDB` is injectable for tests.
 * @returns {Promise<Object>} the DB api
 */
function open({ indexedDB = globalThis.indexedDB, name = NAME } = {}) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, VERSION);
        req.onupgradeneeded = () => upgrade(req.result);
        req.onerror = () => reject(storageError(req.error));
        req.onblocked = () => reject(storageError(new Error('database upgrade blocked')));
        req.onsuccess = () => {
            const idb = req.result;
            const db = api(idb);
            // Another context upgrading or deleting the database should not
            // hang on us; the caller opens it again.
            idb.onversionchange = () => { idb.close(); db.closed = true; };
            idb.onclose = () => { db.closed = true; };
            resolve(db);
        };
    });
}

function api(idb) {
    /** Runs `fn(tx)` in one transaction; resolves with fn's result once it commits. */
    function run(stores, mode, fn) {
        return new Promise((resolve, reject) => {
            let tx;
            try {
                tx = idb.transaction(stores, mode);
            } catch (err) {
                reject(storageError(err));
                return;
            }
            let out;
            tx.oncomplete = () => resolve(typeof out === 'function' ? out() : out);
            tx.onabort = () => reject(storageError(tx.error));
            tx.onerror = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); };
            try {
                out = fn(tx);
            } catch (err) {
                try { tx.abort(); } catch (e) { /* already done */ }
                reject(storageError(err));
            }
        });
    }

    /** A request's result, collected when the transaction commits. */
    function collect(request) {
        let value;
        request.onsuccess = () => { value = request.result; };
        return () => value;
    }

    function get(store, key) {
        return run([store], 'readonly', (tx) => collect(tx.objectStore(store).get(key)));
    }

    /** All records of `store`, or those whose `index` equals `key`. */
    function getAll(store, index, key) {
        return run([store], 'readonly', (tx) => {
            const s = tx.objectStore(store);
            return collect(index ? s.index(index).getAll(key) : s.getAll());
        });
    }

    function getMany(store, keys) {
        return run([store], 'readonly', (tx) => {
            const s = tx.objectStore(store);
            const got = keys.map((k) => collect(s.get(k)));
            return () => got.map((g) => g());
        });
    }

    function count(store) {
        return run([store], 'readonly', (tx) => collect(tx.objectStore(store).count()));
    }

    /**
     * Applies `ops` in one transaction, all or nothing. Each op is
     * {store, put}, {store, delete}, {store, deleteIndex: [index, key]}, or
     * {store, putIfAbsent, unlessIndex?: [index, key]}, which writes only
     * when no record has its key (or, with unlessIndex, none is in that
     * index under that key).
     */
    function write(ops) {
        const stores = [...new Set(ops.map((op) => op.store))];
        if (stores.length === 0) return Promise.resolve();
        return run(stores, 'readwrite', (tx) => {
            for (const op of ops) {
                const s = tx.objectStore(op.store);
                if ('put' in op) s.put(op.put);
                else if ('putIfAbsent' in op) {
                    const v = op.putIfAbsent;
                    const probe = op.unlessIndex
                        ? s.index(op.unlessIndex[0]).count(op.unlessIndex[1])
                        : s.count([].concat(s.keyPath).length > 1 ? s.keyPath.map((k) => v[k]) : v[s.keyPath]);
                    probe.onsuccess = () => { if (!probe.result) s.put(v); };
                }
                else if ('delete' in op) s.delete(op.delete);
                else if (op.deleteIndex) {
                    s.index(op.deleteIndex[0]).openKeyCursor(op.deleteIndex[1]).onsuccess = (ev) => {
                        const c = ev.target.result;
                        if (!c) return;
                        s.delete(c.primaryKey);
                        c.continue();
                    };
                }
            }
        });
    }

    async function getMeta(key) {
        const rec = await get('meta', key);
        return rec ? rec.value : undefined;
    }

    /** Products of run `runId`, in the order they were found. */
    async function runProducts(runId) {
        const rows = await getAll('products', 'runId', runId);
        return rows.sort((a, b) => a.n - b.n);
    }

    async function runPages(runId) {
        const rows = await getAll('placements', 'runId', runId);
        return rows.sort((a, b) => a.pageIndex - b.pageIndex);
    }

    /**
     * Bounds lastValues: drops snapshots last seen more than `maxAgeDays`
     * ago, then keeps the `max` most recently seen. A snapshot with no date
     * is never dropped for age but goes first when over the cap.
     */
    function pruneLastValues({ max, maxAgeDays, now = Date.now() }) {
        const cutoff = new Date(now - maxAgeDays * 86400000).toISOString();
        return run(['lastValues'], 'readwrite', (tx) => {
            const s = tx.objectStore('lastValues');
            const byDate = s.index('scrapedAt');
            let removed = 0;
            byDate.openKeyCursor(IDBKeyRange.upperBound(cutoff, true)).onsuccess = (ev) => {
                const c = ev.target.result;
                if (c) { s.delete(c.primaryKey); removed++; c.continue(); return; }
                s.count().onsuccess = (e) => {
                    let over = e.target.result - max;
                    if (over <= 0) return;
                    // Undated first: they are not in the index.
                    s.openCursor().onsuccess = (e2) => {
                        const cur = e2.target.result;
                        if (cur && over > 0) {
                            const t = cur.value.scrapedAt;
                            if (typeof t !== 'string') { cur.delete(); over--; removed++; }
                            cur.continue();
                            return;
                        }
                        if (over <= 0) return;
                        byDate.openKeyCursor().onsuccess = (e3) => {
                            const k = e3.target.result;
                            if (!k || over <= 0) return;
                            s.delete(k.primaryKey); over--; removed++;
                            k.continue();
                        };
                    };
                };
            };
            return () => removed;
        });
    }

    const db = {
        idb, run, get, getAll, getMany, count, write, getMeta, runProducts, runPages, pruneLastValues,
        closed: false,
        close() { idb.close(); db.closed = true; }
    };
    return db;
}

module.exports = { open, NAME, VERSION, storageError };
