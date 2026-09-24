/**
 * @fileoverview What one outbox entry writes to the cloud. Pure: records
 * from IndexedDB in, a list of document writes out.
 *
 * An entry is one page of a run ({kind:'page', pageIndex}) or the end of a
 * run ({kind:'run'}). A page writes its chunk, the product and history
 * documents of every ASIN on it, the run header and the source. The end of
 * a run writes the header and the source again with the final status.
 *
 * Each write is {path, data, fields}. `fields` null means replace the whole
 * document; otherwise only those fields are written, each replaced whole
 * (Firestore mergeFields), so a price that failed to parse is gone from
 * `latest` instead of kept from last week. A field given as an array is a
 * field path, e.g. ['d', '2026-06-09'].
 *
 * @module SyncPlan
 */

import {
    SV, MK, MAX_PAGE_ITEMS, pageIdOf, sourceOf, sourceIdOf, dayKeyOf, expireAtMs,
    runStatusOf, pointOf, deltaOf, timeMs, assertValid
} from '../../packages/schema/index.js';

const DAY_MS = 86400000;
const same = (v) => v;

/** Placements of `product` on page `pageIndex`. */
function onPage(product, pageIndex) {
    return (product.placements || []).filter((pl) => pl.page === pageIndex);
}

/** The run's source id, day key and source, also for a run from before 2.3. */
export function runKeys(run) {
    const source = run.source || {};
    const found = source.url ? sourceOf(source.url) : { type: source.type || 'keyword', sellerId: source.sellerId || null, keyword: source.keyword || null, url: null };
    const sourceId = run.sourceId || source.sourceId || sourceIdOf(found);
    const dayKey = run.dayKey || dayKeyOf(run.startedAt, new Date(run.startedAt).getTimezoneOffset());
    return {
        sourceId,
        dayKey,
        source: { type: found.type, sellerId: found.sellerId || null, keyword: found.keyword || null, url: found.url || source.url || null }
    };
}

/**
 * ASINs on this page whose product document may not exist yet: never seen,
 * or last seen by nobody signed in to this account. The caller reads them
 * and passes back the ones that are missing, which alone get firstSeenAt.
 */
export function firstSeenCandidates(entry, products) {
    if (entry.kind !== 'page') return [];
    return products
        .filter((p) => onPage(p, entry.pageIndex).length > 0)
        .filter((p) => !p.prev || p.prev.uid !== entry.uid)
        .map((p) => p.asin);
}

function counters(products) {
    const placements = products.flatMap((p) => p.placements || []);
    return {
        placements: placements.length,
        uniqueAsins: products.length,
        sponsored: placements.filter((pl) => pl.sponsored).length,
        priceParseFailures: products.filter((p) => !Number.isInteger(p.priceCents)).length,
        newSeen: products.filter((p) => p.delta && p.delta.isNew).length
    };
}

function runDoc(run, keys, products, pages, time) {
    const ended = !['starting', 'running', 'stopping'].includes(run.state);
    const first = pages.find((pg) => pg.pageIndex === 1) || pages[0];
    const total = first && Number.isInteger(first.total) ? first.total : null;
    return {
        sv: SV,
        runId: run.runId,
        sourceId: keys.sourceId,
        source: keys.source,
        mk: MK,
        dayKey: keys.dayKey,
        startedAt: time(run.startedAt),
        finishedAt: ended && run.finishedAt ? time(run.finishedAt) : null,
        status: runStatusOf(run.state),
        reason: ended ? run.reason || null : null,
        pagesDone: pages.length,
        maxPages: run.maxPages,
        pagesPlanned: ended && run.reason === 'complete' ? pages.length : null,
        totalResultsOnSerp: total,
        counters: counters(products)
    };
}

function sourceDoc(run, keys, pages, time) {
    const first = pages.find((pg) => pg.pageIndex === 1) || pages[0];
    const doc = {
        sv: SV,
        sourceId: keys.sourceId,
        type: keys.source.type,
        sellerId: keys.source.sellerId,
        keyword: keys.source.keyword,
        url: keys.source.url,
        lastRunId: run.runId,
        lastScrapedAt: time(run.startedAt)
    };
    if (first && Number.isInteger(first.total)) doc.catalogSize = first.total;
    return doc;
}

function pageDoc(run, pageRec, products, time) {
    const items = {};
    let truncated = false;
    for (const p of products) {
        const here = onPage(p, pageRec.pageIndex);
        if (here.length === 0) continue;
        if (Object.keys(items).length >= MAX_PAGE_ITEMS) { truncated = true; break; }
        const organic = here.filter((pl) => !pl.sponsored && Number.isInteger(pl.rank)).map((pl) => pl.rank);
        const pt = pointOf({ ...p, organicRank: organic.length ? Math.min(...organic) : null });
        pt.sp = organic.length ? 0 : 1;
        items[p.asin] = pt;
    }
    const doc = {
        sv: SV,
        runId: run.runId,
        page: pageRec.pageIndex,
        scrapedAt: time(timeMs(pageRec.scrapedAt) ?? run.startedAt),
        expireAt: time(expireAtMs(run.startedAt)),
        count: pageRec.count || 0,
        placements: pageRec.placements || 0,
        kind: pageRec.kind || 'results',
        items
    };
    if (Number.isInteger(pageRec.total)) doc.total = pageRec.total;
    if (truncated) doc.truncated = true;
    return doc;
}

function productDoc(run, keys, p, time, union) {
    const at = timeMs(p.scrapedAt) ?? run.startedAt;
    const now = pointOf(p);
    const prevAt = p.prev ? timeMs(p.prev.scrapedAt) : null;
    const prevPt = p.prev ? pointOf({ priceCents: p.prev.priceCents, rating: p.prev.rating, reviewCount: p.prev.reviewCount }) : null;
    const days = prevAt !== null ? Math.floor((at - prevAt) / DAY_MS) : null;
    const doc = {
        sv: SV,
        asin: p.asin,
        mk: MK,
        url: `https://www.amazon.com/dp/${p.asin}`,
        latest: { ...now, at: time(at), runId: run.runId, dayKey: keys.dayKey },
        prev: prevPt ? { ...prevPt, ...(prevAt !== null ? { at: time(prevAt) } : {}) } : null,
        delta: deltaOf(now, prevPt, days),
        sourceIds: union([keys.sourceId])
    };
    // A name or image this card lacked keeps the last one written.
    if (typeof p.name === 'string' && p.name) doc.name = p.name;
    if (typeof p.img === 'string' && p.img) doc.img = p.img;
    return doc;
}

/**
 * The writes for one outbox entry.
 *
 * @param {Object} args
 * @param {{kind:string, runId:string, uid:string, pageIndex?:number}} args.entry
 * @param {Object} args.run       the run record from IndexedDB
 * @param {Object[]} args.products the run's products
 * @param {Object[]} args.pages    the run's page records
 * @param {Set<string>} [args.missing] ASINs with no product document yet
 * @param {function(number):*} [args.time]  ms to a Firestore Timestamp
 * @param {function(string[]):*} [args.union] values to arrayUnion
 * @returns {{path: string[], data: Object, fields: ?Array}[]}
 */
export function planEntry({ entry, run: rec, products, pages, missing = new Set(), time = same, union = same }) {
    const run = { ...rec, startedAt: timeMs(rec.startedAt), finishedAt: timeMs(rec.finishedAt) };
    const ws = ['workspaces', entry.uid];
    const keys = runKeys(run);
    const writes = [];

    if (entry.kind === 'page') {
        const pageRec = pages.find((pg) => pg.pageIndex === entry.pageIndex);
        if (pageRec) {
            const chunk = pageDoc(run, pageRec, products, time);
            assertValid('page', chunk);
            writes.push({ path: [...ws, 'runs', run.runId, 'pages', pageIdOf(pageRec.pageIndex)], data: chunk, fields: null });
        }
        for (const p of products) {
            if (onPage(p, entry.pageIndex).length === 0) continue;
            const doc = productDoc(run, keys, p, time, union);
            if (missing.has(p.asin)) {
                doc.firstSeenAt = doc.latest.at;
                doc.firstRunId = run.runId;
            }
            assertValid('product', { ...doc, sourceIds: [keys.sourceId] });
            writes.push({ path: [...ws, 'products', p.asin], data: doc, fields: Object.keys(doc) });

            const point = pointOf(p);
            assertValid('history', { sv: SV, asin: p.asin, d: { [keys.dayKey]: point } });
            writes.push({
                path: [...ws, 'products', p.asin, 'history', 'daily'],
                data: { sv: SV, asin: p.asin, d: { [keys.dayKey]: point } },
                fields: ['sv', 'asin', ['d', keys.dayKey]]
            });
        }
    }

    const header = runDoc(run, keys, products, pages, time);
    assertValid('run', header);
    writes.push({ path: [...ws, 'runs', run.runId], data: header, fields: Object.keys(header) });
    const source = sourceDoc(run, keys, pages, time);
    assertValid('source', source);
    writes.push({ path: [...ws, 'sources', keys.sourceId], data: source, fields: Object.keys(source) });
    return writes;
}
