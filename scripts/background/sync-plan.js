/**
 * @fileoverview What one outbox entry writes to the cloud. Pure: records
 * from IndexedDB in, a list of document writes out.
 *
 * An entry is one page of a run ({kind:'page', pageIndex}) or the end of a
 * run ({kind:'run'}). A page writes its chunk, the product and history
 * documents of every ASIN on it, the run header and the source. The end of
 * a run writes the header and the source again with the final status.
 *
 * Each write is {path, data, fields} or {path, data, merge: true}. `fields`
 * null means replace the whole document; otherwise only those fields are
 * written, each replaced whole (Firestore mergeFields). A field given as an
 * array is a field path, e.g. ['d', '2026-06-09'].
 *
 * A product document is a `merge` write, so its sourceIds arrayUnion keeps
 * the sources written before (in a mergeFields mask it would be replaced
 * whole). `latest`, `prev` and `delta` are still replaced whole: every key
 * they can have and this write lacks is sent as a delete, so a price that
 * failed to parse is gone from `latest` instead of kept from last week.
 *
 * The run header and the source are written once per flush for each run,
 * on its last entry in that flush (`header`), not once per page.
 *
 * Firestore rules cap string lengths and list sizes the schema validators
 * do not know about. checkRuleCaps() applies the same caps here, so an
 * entry the rules would refuse on every try fails planning instead.
 *
 * @module SyncPlan
 */

import {
    SV, MK, MAX_PAGE_ITEMS, pageIdOf, sourceOf, sourceIdOf, dayKeyOf, expireAtMs,
    runStatusOf, pointOf, deltaOf, timeMs, assertValid
} from '../../packages/schema/index.js';

const DAY_MS = 86400000;
const same = (v) => v;
/** What a field delete looks like when the caller passes no converter. */
export const DELETE = Object.freeze({ delete: true });

/** Caps from the dashboard's firestore.rules that the schema does not check. */
export const RULE_CAPS = {
    keyword: 300, url: 2000, sellerId: 40, name: 1000, productUrl: 500, img: 1000,
    runId: 260, reason: 100, maxPages: 1000, page: 1000, kind: 20, sourceIds: 200
};

const tooLong = (v, max) => typeof v === 'string' && v.length > max;

/** Throws when `doc` of `kind` breaks a rules cap. */
export function checkRuleCaps(kind, doc) {
    const errs = [];
    const c = RULE_CAPS;
    if (kind === 'source') {
        if (tooLong(doc.keyword, c.keyword)) errs.push(`keyword: at most ${c.keyword} characters`);
        if (tooLong(doc.url, c.url)) errs.push(`url: at most ${c.url} characters`);
        if (tooLong(doc.sellerId, c.sellerId)) errs.push(`sellerId: at most ${c.sellerId} characters`);
        if (tooLong(doc.lastRunId, c.runId)) errs.push(`lastRunId: at most ${c.runId} characters`);
        if (!/^[sk]_[A-Za-z0-9_-]{1,200}$/.test(doc.sourceId || '')) errs.push('sourceId: s_ or k_ and 1 to 200 id characters');
    } else if (kind === 'run') {
        if (tooLong(doc.reason, c.reason)) errs.push(`reason: at most ${c.reason} characters`);
        if (doc.maxPages > c.maxPages) errs.push(`maxPages: at most ${c.maxPages}`);
    } else if (kind === 'page') {
        if (doc.page > c.page) errs.push(`page: at most ${c.page}`);
        if (tooLong(doc.kind, c.kind)) errs.push(`kind: at most ${c.kind} characters`);
    } else if (kind === 'product') {
        if (tooLong(doc.name, c.name)) errs.push(`name: at most ${c.name} characters`);
        if (tooLong(doc.url, c.productUrl)) errs.push(`url: at most ${c.productUrl} characters`);
        if (tooLong(doc.img, c.img)) errs.push(`img: at most ${c.img} characters`);
        if (doc.latest && tooLong(doc.latest.runId, c.runId)) errs.push(`latest.runId: at most ${c.runId} characters`);
        if (tooLong(doc.firstRunId, c.runId)) errs.push(`firstRunId: at most ${c.runId} characters`);
    }
    if (errs.length) throw new Error(`${kind} document breaks a rules cap: ${errs.join('; ')}`);
    return doc;
}

/** Every key each replaced map of a product document can hold. */
const MAP_KEYS = {
    latest: ['p', 'r', 'v', 'pr', 'rk', 'at', 'runId', 'dayKey'],
    prev: ['p', 'r', 'v', 'pr', 'rk', 'at'],
    delta: ['p', 'pPct', 'r', 'v', 'days']
};

/** `doc` with the keys its replaced maps lack set to `del()`, for a merge write. */
function withDeletes(doc, del) {
    const out = { ...doc };
    for (const [field, keys] of Object.entries(MAP_KEYS)) {
        const v = doc[field];
        if (!v || typeof v !== 'object') continue;
        const filled = { ...v };
        for (const k of keys) if (!(k in filled)) filled[k] = del();
        out[field] = filled;
    }
    return out;
}

/** Placements of `product` on page `pageIndex`. */
function onPage(product, pageIndex) {
    return (product.placements || []).filter((pl) => pl.page === pageIndex);
}

const clamp = (v, max) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);

/** The run's source id, day key and source, also for a run from before 2.3. */
export function runKeys(run) {
    const source = run.source || {};
    const found = source.url ? sourceOf(source.url) : { type: source.type || 'keyword', sellerId: source.sellerId || null, keyword: source.keyword || null, url: null };
    const sourceId = run.sourceId || source.sourceId || sourceIdOf(found);
    const dayKey = run.dayKey || dayKeyOf(run.startedAt, new Date(run.startedAt).getTimezoneOffset());
    return {
        sourceId,
        dayKey,
        source: {
            type: found.type,
            sellerId: found.sellerId || null,
            keyword: clamp(found.keyword || null, RULE_CAPS.keyword),
            url: clamp(found.url || source.url || null, RULE_CAPS.url)
        }
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
 * @param {function():*} [args.del] a field delete, for merge writes
 * @param {boolean} [args.header] also write the run header and the source
 * @returns {{path: string[], data: Object, fields?: ?Array, merge?: boolean}[]}
 */
export function planEntry({ entry, run: rec, products, pages, missing = new Set(), time = same, union = same, del = () => DELETE, header: withHeader = true }) {
    const run = { ...rec, startedAt: timeMs(rec.startedAt), finishedAt: timeMs(rec.finishedAt) };
    const ws = ['workspaces', entry.uid];
    const keys = runKeys(run);
    const writes = [];

    if (entry.kind === 'page') {
        const pageRec = pages.find((pg) => pg.pageIndex === entry.pageIndex);
        if (pageRec) {
            const chunk = pageDoc(run, pageRec, products, time);
            assertValid('page', chunk);
            checkRuleCaps('page', chunk);
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
            checkRuleCaps('product', doc);
            writes.push({ path: [...ws, 'products', p.asin], data: withDeletes(doc, del), merge: true });

            const point = pointOf(p);
            assertValid('history', { sv: SV, asin: p.asin, d: { [keys.dayKey]: point } });
            writes.push({
                path: [...ws, 'products', p.asin, 'history', 'daily'],
                data: { sv: SV, asin: p.asin, d: { [keys.dayKey]: point } },
                fields: ['sv', 'asin', ['d', keys.dayKey]]
            });
        }
    }

    if (!withHeader && entry.kind !== 'run') return writes;
    const head = runDoc(run, keys, products, pages, time);
    assertValid('run', head);
    checkRuleCaps('run', head);
    writes.push({ path: [...ws, 'runs', run.runId], data: head, fields: Object.keys(head) });
    const source = sourceDoc(run, keys, pages, time);
    assertValid('source', source);
    checkRuleCaps('source', source);
    writes.push({ path: [...ws, 'sources', keys.sourceId], data: source, fields: Object.keys(source) });
    return writes;
}
