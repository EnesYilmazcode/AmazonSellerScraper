/**
 * @fileoverview The run engine. The service worker is the only writer.
 *
 * The live run record is in chrome.storage.session, so it survives the
 * worker being stopped between pages but not a browser restart. What the
 * run collects goes to IndexedDB (db.js) in one transaction per page.
 *
 * A run moves page by page:
 * 1. START_RUN from the popup: ping the tab, make the run, ask the tab to
 *    parse (PARSE_PAGE).
 * 2. The content script parses and answers with PAGE_RESULT. The engine
 *    folds the page into the run and saves it.
 * 3. After a 2 to 4 second delay the engine opens the page's Next link with
 *    tabs.update. The new page says PAGE_READY and is asked to parse.
 *
 * The delay is a timer in the worker, which dies with it. The content
 * script's HEARTBEAT every few seconds wakes a stopped worker, and every
 * wake runs tick(), which opens the next page once it is due. All changes
 * go through one queue, so two messages never interleave their writes.
 *
 * @module Engine
 */

const Run = require('../lib/run.js');
const Msg = require('../lib/messages.js');
const Flags = require('../lib/flags.js');
const Delta = require('../modules/delta.js');
const Schema = require('../../packages/schema/index.js');

/** A page asked for but not reported this long is asked for again. */
const PAGE_TIMEOUT_MS = 20000;

/** Runs kept in IndexedDB. Starting a run removes the oldest past this. */
const KEEP_RUNS = 10;

/**
 * Folds one page's products into a run. Placements get the page number and
 * a run-wide organic rank. An ASIN the run already has only adds its
 * placements to that record. Pure: `runProducts` is not changed.
 *
 * @returns {{fresh: Object[], changed: Object[]}} new records, and copies
 *   of existing records that changed
 */
function foldPage(runProducts, pageProducts, pageIndex) {
    const organicBefore = runProducts.reduce(
        (n, r) => n + (r.placements || []).filter(pl => !pl.sponsored).length, 0);
    const known = new Map(runProducts.map(r => [r.asin, r]));
    const changed = new Map();
    const fresh = [];

    for (const product of pageProducts) {
        const placements = (product.placements || []).map(pl => ({
            page: pageIndex,
            ...pl,
            rank: pl.rank === null ? null : pl.rank + organicBefore
        }));
        const firstRank = (placements.find(pl => pl.rank !== null) || {}).rank;
        const organicRank = firstRank === undefined ? null : firstRank;

        const seen = changed.get(product.asin) || known.get(product.asin);
        if (!seen) {
            fresh.push({ ...product, placements, organicRank });
            continue;
        }
        changed.set(product.asin, {
            ...seen,
            placements: [...(seen.placements || []), ...placements],
            sponsored: !!seen.sponsored || !!product.sponsored,
            organicRank: seen.organicRank == null ? organicRank : seen.organicRank
        });
    }
    return { fresh, changed: [...changed.values()] };
}

/** The run as kept in IndexedDB: without the fields that only matter live. */
function durable(run) {
    const { heartbeat, navAt, awaiting, expectUrl, navigatedAt, ...rest } = run;
    return rest;
}

/** The signed-in account's uid, as the service worker keeps it in storage.local. */
async function accountUid(chrome) {
    const data = await chrome.storage.local.get('account');
    return (data && data.account && data.account.uid) || null;
}

/**
 * A lastValues snapshot counts for `uid` when this account took it, or when
 * it was taken signed out. Another account's snapshot does not.
 */
function prevFor(snap, uid) {
    if (!snap) return null;
    return !snap.uid || snap.uid === uid ? snap : null;
}

/**
 * @param {Object} deps
 * @param {Object} deps.chrome - chrome.* (storage.session, storage.local, tabs)
 * @param {function(): Promise<Object>} deps.openDb - resolves to the db.js api
 * @param {function(): Promise<?string>} [deps.owner] - uid of the signed-in account
 */
function createEngine({
    chrome,
    openDb,
    now = Date.now,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    flags = Flags,
    log = console,
    owner = () => accountUid(chrome)
}) {
    let dbPromise = null;
    let timer = null;
    let chain = Promise.resolve();

    /** The open database, opened again if it was closed under us. */
    async function db() {
        if (dbPromise) {
            const open = await dbPromise.catch(() => null);
            if (open && !open.closed) return open;
        }
        dbPromise = openDb();
        try {
            return await dbPromise;
        } catch (err) {
            dbPromise = null;
            throw err;
        }
    }

    /** Runs `fn` after every change queued before it. */
    function serial(fn) {
        const p = chain.then(fn, fn);
        chain = p.catch(() => {});
        return p;
    }

    async function getRun() {
        const data = await chrome.storage.session.get(Run.KEY);
        return (data && data[Run.KEY]) || null;
    }

    const saveRun = (run) => chrome.storage.session.set({ [Run.KEY]: run });

    function sendToTab(tabId, message) {
        return new Promise((resolve) => {
            try {
                chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
                    if (chrome.runtime.lastError) return resolve(null);
                    resolve(response || null);
                });
            } catch (e) {
                resolve(null);
            }
        });
    }

    function schedule(ms) {
        if (timer) clearTimer(timer);
        timer = setTimer(() => { timer = null; tick(); }, Math.max(0, ms));
    }

    function cancelTimer() {
        if (timer) clearTimer(timer);
        timer = null;
    }

    /** Outbox entries for a signed-in account; none when sync is off or nobody is signed in. */
    async function outbox(runId, kind, extra = {}) {
        if (!flags.CLOUD_SYNC) return [];
        const uid = await owner();
        if (!uid) return [];
        return [{ store: 'outbox', put: { runId, kind, uid, queuedAt: now(), ...extra } }];
    }

    /** Ends `run` for `reason` and tells its tab. Returns the ended run. */
    async function end(run, reason) {
        const ended = Run.finish(run, reason, now());
        cancelTimer();
        await saveRun(ended);
        try {
            // A run with saved pages sends its final header to the cloud.
            const queued = ended.page > 0 ? await outbox(ended.runId, 'run') : [];
            await (await db()).write([{ store: 'runs', put: durable(ended) }, ...queued]);
        } catch (err) {
            log.warn('[ProScan] Could not record the end of the run:', err.message);
        }
        log.log(`[ProScan] Run ended: ${reason}. ${ended.itemCount} items`);
        sendToTab(ended.tabId, { type: Msg.T.RUN_ENDED, runId: ended.runId, reason });
        return ended;
    }

    /** The live run, after ending it if its tab stopped checking in. */
    async function liveRun() {
        const run = await getRun();
        if (Run.isStale(run, now())) return end(run, 'interrupted');
        return run;
    }

    /**
     * Keeps the newest `keep` runs (KEEP_RUNS - 1 by default, so the one
     * starting makes KEEP_RUNS). A run still in the outbox or still live is
     * never removed.
     */
    async function pruneRuns(store, keep = KEEP_RUNS - 1) {
        const [runs, outbox] = await Promise.all([store.getAll('runs'), store.getAll('outbox')]);
        const pending = new Set(outbox.map(e => e.runId));
        const old = runs
            .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
            .slice(keep)
            .filter(r => !pending.has(r.runId) && !Run.isActive(r));
        if (old.length === 0) return 0;
        const ops = [];
        for (const { runId } of old) {
            ops.push({ store: 'runs', delete: runId });
            for (const s of ['products', 'placements', 'spread']) ops.push({ store: s, deleteIndex: ['runId', runId] });
        }
        await store.write(ops);
        return old.length;
    }

    function start({ tabId }) {
        return serial(async () => {
            if (typeof tabId !== 'number') return { error: 'refused', message: Run.refusal('unknown') };
            const current = await liveRun();
            if (Run.isActive(current)) {
                return { error: 'busy', message: 'A run is already going. Stop it before starting another.' };
            }
            const pong = await sendToTab(tabId, { type: Msg.T.PING });
            if (!pong || !pong.ok) return { error: 'no_receiver' };
            if (!Run.STARTABLE.includes(pong.kind)) {
                return { error: 'refused', kind: pong.kind, message: Run.refusal(pong.kind) };
            }

            const local = await chrome.storage.local.get('settings');
            const settings = (local && local.settings) || {};
            const t = now();
            // One id for the run, here and in the cloud: {sourceId}_{startMs}.
            const found = Schema.sourceOf(pong.url);
            const sourceId = Schema.sourceIdOf(found);
            const runId = Schema.runIdOf(sourceId, t);
            let run = Run.create({
                runId, tabId, maxPages: settings.maxPages, now: t,
                source: { ...found, sourceId, startedAt: new Date(t).toISOString() }
            });
            run = { ...run, sourceId, dayKey: Schema.dayKeyOf(t, new Date(t).getTimezoneOffset()) };
            await saveRun(run);
            const first = [
                { store: 'runs', put: durable(run) },
                { store: 'meta', put: { key: 'latestRunId', value: runId } }
            ];
            try {
                await pruneRuns(await db());
            } catch (err) {
                log.warn('[ProScan] Could not remove old runs:', err.message);
            }
            try {
                try {
                    await (await db()).write(first);
                } catch (err) {
                    if (err.code !== 'storage_full') throw err;
                    // Full: drop every older run that is not waiting to sync, then try once more.
                    await pruneRuns(await db(), 0);
                    await (await db()).write(first);
                }
            } catch (err) {
                await end(run, err.code === 'storage_full' ? 'storage_full' : 'storage_error');
                return { error: err.code || 'storage_error', message: Run.MESSAGES[err.code] || Run.MESSAGES.storage_error };
            }

            run = Run.transition(run, 'running', { awaiting: true, expectUrl: pong.url, navigatedAt: t });
            await saveRun(run);
            const ack = await sendToTab(tabId, { type: Msg.T.PARSE_PAGE, runId, page: 1 });
            if (!ack || !ack.ok) {
                await end(run, 'interrupted');
                return { error: 'no_receiver' };
            }
            return { ok: true, runId };
        });
    }

    /**
     * The latest run IndexedDB still has as live when session storage has
     * no run: the extension was disabled and enabled again, or its process
     * crashed. Nothing can resume it, so it is ended as `reason`. Returns
     * the ended record, or null. Call inside serial().
     */
    async function endOrphan(store, reason) {
        if (await getRun()) return null;
        const latestId = await store.getMeta('latestRunId');
        const rec = latestId ? await store.get('runs', latestId) : null;
        if (!Run.isActive(rec)) return null;
        const ended = Run.finish(rec, reason, now());
        await store.write([{ store: 'runs', put: durable(ended) }]);
        return ended;
    }

    function stop() {
        return serial(async () => {
            const run = await getRun();
            if (!run) {
                const ended = await endOrphan(await db(), 'stopped').catch(() => null);
                return { ok: true, stopped: !!ended };
            }
            if (!Run.isActive(run)) return { ok: true, stopped: false };
            const stopping = Run.transition(run, 'stopping');
            await saveRun(stopping);
            await end(stopping, 'stopped');
            return { ok: true, stopped: true };
        });
    }

    /** A page in some tab finished loading. Only the run's tab is asked to parse. */
    function pageReady({ url }, sender) {
        return serial(async () => {
            const run = await liveRun();
            const tabId = sender && sender.tab ? sender.tab.id : null;
            if (!Run.owns(run, tabId) || run.state !== 'running') return { idle: true };
            // Only the page the engine opened is parsed. A search the user
            // typed in the tab while it was loading ends the run instead.
            if (run.awaiting && (!run.expectUrl || Run.samePage(run.expectUrl, url))) {
                return { parse: true, runId: run.runId, page: run.page + 1 };
            }
            if (url === run.lastUrl) return { heartbeat: true, runId: run.runId };
            // The tab went somewhere else while the next page was pending.
            await end(run, 'interrupted');
            return { idle: true };
        });
    }

    function pageResult({ runId, page, url, result }, sender) {
        return serial(async () => {
            const run = await liveRun();
            const tabId = sender && sender.tab ? sender.tab.id : null;
            if (!Run.owns(run, tabId) || run.runId !== runId || run.state !== 'running' ||
                !run.awaiting || page !== run.page + 1 || !result || !Array.isArray(result.products)) {
                return { ok: false, ignored: true };
            }
            const ending = Run.outcome(result, page, run.maxPages);
            if (result.products.length === 0 || ending === 'selectors_broken') {
                const ended = await end(run, ending || 'complete');
                return { ok: true, next: 'end', reason: ended.reason };
            }

            const t = now();
            let store;
            let ops;
            let next;
            try {
                store = await db();
                const existing = await store.runProducts(runId);
                const { fresh, changed } = foldPage(existing, result.products, page);
                const snaps = await store.getMany('lastValues', fresh.map(p => p.asin));
                const uid = await owner();
                ops = [];
                fresh.forEach((p, i) => {
                    p.runId = runId;
                    p.pageIndex = page;
                    p.n = existing.length + i;
                    const prev = prevFor(snaps[i], uid);
                    // Only an ASIN's first sighting in the run gets a delta.
                    p.delta = Delta.computeDeltas(p, prev);
                    p.prev = prev ? {
                        priceCents: prev.priceCents ?? null, rating: prev.rating ?? null,
                        reviewCount: prev.reviewCount ?? null, scrapedAt: prev.scrapedAt || null, uid: prev.uid || null
                    } : null;
                    const snap = { asin: p.asin, ...Delta.snapshot(p, prev) };
                    if (uid) snap.uid = uid;
                    ops.push({ store: 'lastValues', put: snap });
                    ops.push({ store: 'products', put: p });
                });
                changed.forEach(p => ops.push({ store: 'products', put: p }));
                ops.push({
                    store: 'placements',
                    put: {
                        runId, pageIndex: page, count: fresh.length, placements: result.placements || 0,
                        kind: result.kind, fill: result.fill || null, scrapedAt: new Date(t).toISOString(), url,
                        total: Number.isInteger(result.total) && result.total > 0 ? result.total : null
                    }
                });
                ops.push(...await outbox(runId, 'page', { pageIndex: page }));

                next = {
                    ...run, page, itemCount: run.itemCount + fresh.length, heartbeat: t,
                    lastUrl: url, nextHref: result.nextHref || null, awaiting: false
                };
                if (ending) {
                    next = Run.finish(next, ending, t);
                    ops.push(...await outbox(runId, 'run'));
                } else {
                    next.navAt = t + Run.pageDelay(random());
                }
                ops.push({ store: 'runs', put: durable(next) });
                await store.write(ops);
            } catch (err) {
                log.warn('[ProScan] Could not save the page:', err.message);
                const ended = await end(run, err.code === 'storage_full' ? 'storage_full' : 'storage_error');
                return { ok: false, next: 'end', reason: ended.reason };
            }

            await saveRun(next);
            store.pruneLastValues({ max: Delta.MAX_ENTRIES, maxAgeDays: Delta.MAX_AGE_DAYS, now: t })
                .catch(err => log.warn('[ProScan] Could not prune lastValues:', err.message));
            if (ending) {
                log.log(`[ProScan] Run ended: ${ending}. ${next.itemCount} items`);
                sendToTab(next.tabId, { type: Msg.T.RUN_ENDED, runId, reason: ending });
                return { ok: true, next: 'end', reason: ending };
            }
            schedule(next.navAt - t);
            return { ok: true, next: 'wait' };
        });
    }

    /** Opens the next page once it is due, and re-asks a page that never reported. */
    function tick() {
        return serial(async () => {
            let run = await liveRun();
            if (!run || run.state !== 'running') return;
            const t = now();
            if (!run.awaiting && run.nextHref && run.navAt != null) {
                if (run.navAt > t) {
                    if (!timer) schedule(run.navAt - t);
                    return;
                }
                run = { ...run, awaiting: true, expectUrl: run.nextHref, navigatedAt: t, navAt: null };
                await saveRun(run);
                log.log(`[ProScan] Navigating to next page: ${run.expectUrl}`);
                try {
                    await chrome.tabs.update(run.tabId, { url: run.expectUrl });
                } catch (err) {
                    await end(run, 'interrupted');
                    return;
                }
                // If the page never reports, ask it again.
                schedule(PAGE_TIMEOUT_MS + 1000);
                return;
            }
            if (run.awaiting && t - (run.navigatedAt || 0) > PAGE_TIMEOUT_MS) {
                await saveRun({ ...run, navigatedAt: t });
                schedule(PAGE_TIMEOUT_MS + 1000);
                const ack = await sendToTab(run.tabId, { type: Msg.T.PARSE_PAGE, runId: run.runId, page: run.page + 1 });
                if (ack) return;
                // No script answers. Still on Amazon means still loading; a hidden URL means the tab left.
                const tab = await chrome.tabs.get(run.tabId).catch(() => null);
                if (!tab || !tab.url) await end(run, 'interrupted');
            }
        });
    }

    function heartbeat({ runId }, sender) {
        return serial(async () => {
            const run = await liveRun();
            const tabId = sender && sender.tab ? sender.tab.id : null;
            if (!Run.owns(run, tabId) || run.runId !== runId) return { active: false };
            await saveRun({ ...run, heartbeat: now() });
            return { active: true };
        }).then((out) => { tick(); return out; });
    }

    function tabRemoved(tabId) {
        return serial(async () => {
            const run = await getRun();
            if (Run.isActive(run) && run.tabId === tabId) await end(run, 'interrupted');
        });
    }

    /**
     * The run's tab started loading a page the engine did not open: a reload
     * is fine, anything else means the user took the tab elsewhere. Without
     * the tabs permission a non-Amazon URL is hidden, which also counts.
     */
    function tabUpdated(tabId, info, tab) {
        if (!info || info.status !== 'loading') return Promise.resolve();
        return serial(async () => {
            const run = await getRun();
            if (!Run.owns(run, tabId) || run.state !== 'running' || run.awaiting) return;
            const url = info.url || (tab && tab.url);
            if (url && url === run.lastUrl) return;
            await end(run, 'interrupted');
        });
    }

    /**
     * A browser restart or an update empties session storage, so a run
     * IndexedDB still has as live was cut off: `interrupted` after a
     * restart, `updated` after an update.
     */
    function recover(reason = 'interrupted') {
        return serial(async () => {
            if (await getRun()) return;
            const store = await db();
            const latest = await store.getMeta('latestRunId');
            const rec = latest ? await store.get('runs', latest) : null;
            if (Run.isActive(rec)) {
                const queued = rec.page > 0 ? await outbox(rec.runId, 'run') : [];
                await store.write([{ store: 'runs', put: durable(Run.finish(rec, reason, now())) }, ...queued]);
            }
        });
    }

    /** The latest run and what it found, for the popup and the chat. */
    async function latest() {
        const live = await liveRun();
        let store;
        try {
            store = await db();
        } catch (err) {
            // The run record is in session storage, so the popup can still say how it ended.
            return { run: live, results: [], pages: [], spread: {}, error: err.code || 'storage_error' };
        }
        const runId = (live && live.runId) || await store.getMeta('latestRunId');
        if (!runId) return { run: null, results: [], pages: [], spread: {} };
        const [rec, results, pages, spreadRows] = await Promise.all([
            store.get('runs', runId),
            store.runProducts(runId),
            store.runPages(runId),
            store.getAll('spread', 'runId', runId)
        ]);
        const spread = {};
        spreadRows.forEach(r => { spread[r.asin] = r.data; });
        let run = live && live.runId === runId ? live : (rec || null);
        if (!live && Run.isActive(rec)) {
            // Live in IndexedDB only: no session record means nothing drives it.
            run = (await endOrphan(store, 'interrupted').catch(() => null)) || Run.finish(rec, 'interrupted', now());
        }
        return { run, results, pages, spread };
    }

    function getState() {
        return serial(latest);
    }

    async function getResults() {
        const { run, results } = await getState();
        return { runId: run ? run.runId : null, results };
    }

    function spreadResult({ asin, data }) {
        return serial(async () => {
            const store = await db();
            const runId = await store.getMeta('latestRunId');
            if (!runId || typeof asin !== 'string') return { ok: false };
            await store.write([{ store: 'spread', put: { runId, asin, data: data || null } }]);
            return { ok: true };
        });
    }

    /** What chat.js reads, in the shape it was written for. */
    async function chatData(keys) {
        const local = await chrome.storage.local.get(keys.filter(k => k === 'geminiApiKey'));
        const { run, results, pages } = await getState();
        return {
            ...local,
            results,
            scrapeRunId: run ? run.runId : null,
            scrapeRunMeta: run ? run.source : null,
            scrapeRunPages: pages
        };
    }

    return {
        start, stop, pageReady, pageResult, heartbeat, tick, tabRemoved, tabUpdated, recover,
        getState, getResults, spreadResult, chatData, db
    };
}

module.exports = { createEngine, foldPage, durable, prevFor, PAGE_TIMEOUT_MS, KEEP_RUNS };
