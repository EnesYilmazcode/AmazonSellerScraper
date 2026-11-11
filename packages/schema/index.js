/**
 * @fileoverview The ProScan cloud schema: types, validators and id builders.
 *
 * One file shared by the extension (which writes) and the dashboard (which
 * reads). It has no imports and no Firebase code, so the dashboard can copy
 * it as is; keep the copies byte-identical and bump SV on any change to a
 * document's shape.
 *
 * Conventions:
 * - Money is integer cents.
 * - Unknown is null, never 0. In compact points (latest, prev, history
 *   days, page items) an unknown value is left out, so read it as
 *   `point.p ?? null`. The Firestore rules check `p is int` when present.
 * - Every document carries `sv`, the schema version it was written with.
 * - Times are Firestore Timestamps in the cloud. Builders and validators
 *   here take anything `timeMs` understands: a number of ms, a Date, or an
 *   object with toMillis().
 *
 * Paths, all under workspaces/{uid}:
 *   sources/{sourceId}                 SourceDoc
 *   runs/{runId}                       RunDoc
 *   runs/{runId}/pages/{pageId}        PageDoc
 *   products/{asin}                    ProductDoc (extension fields; lead,
 *                                      tags and verdict are the dashboard's)
 *   products/{asin}/history/daily      HistoryDoc
 *
 * @module Schema
 */

/** Schema version written into every document. */
export const SV = 1;

/** The one marketplace so far. */
export const MK = 'US';

export const ASIN_RE = /^[A-Z0-9]{10}$/;
export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Page chunks expire this long after the run started (TTL policy on expireAt). */
export const PAGE_TTL_DAYS = 400;

/** The rules cap a page chunk's items map at this size. */
export const MAX_PAGE_ITEMS = 120;

export const RUN_STATUS = ['active', 'complete', 'stopped', 'dead'];
export const SOURCE_TYPES = ['storefront', 'keyword'];

/**
 * @typedef {Object} Point  one observation of a product
 * @property {number} [p]   price, cents
 * @property {number} [r]   rating, 0 to 5, one decimal
 * @property {number} [v]   review count
 * @property {0|1}    [pr]  Prime badge
 * @property {number} [rk]  organic rank within the run, from 1
 * @property {0|1}    [sp]  sponsored card (page items only)
 */

/**
 * @typedef {Object} Delta  change against the previous observation
 * @property {number} [p]     price change, cents
 * @property {number} [pPct]  price change, percent of the previous price
 * @property {number} [r]     rating change
 * @property {number} [v]     review count change
 * @property {number} [days]  days between the two observations
 */

/**
 * @typedef {Object} Source
 * @property {'storefront'|'keyword'} type
 * @property {?string} sellerId
 * @property {?string} keyword
 * @property {?string} url
 */

/**
 * @typedef {Object} SourceDoc
 * @property {number} sv
 * @property {string} sourceId
 * @property {'storefront'|'keyword'} type
 * @property {?string} sellerId
 * @property {?string} keyword
 * @property {?string} url
 * @property {string} lastRunId
 * @property {*} lastScrapedAt
 * @property {number} [catalogSize]  result count Amazon showed, when known
 */

/**
 * @typedef {Object} RunDoc
 * @property {number} sv
 * @property {string} runId
 * @property {string} sourceId
 * @property {Source} source
 * @property {string} mk
 * @property {string} dayKey          local date the run started, YYYY-MM-DD
 * @property {*} startedAt
 * @property {*} finishedAt           null while active
 * @property {'active'|'complete'|'stopped'|'dead'} status
 * @property {?string} reason         how it ended, in the extension's words
 * @property {number} pagesDone
 * @property {number} maxPages
 * @property {?number} pagesPlanned   known only once a run completes
 * @property {?number} totalResultsOnSerp
 * @property {{placements:number, uniqueAsins:number, sponsored:number, priceParseFailures:number, newSeen:number}} counters
 */

/**
 * @typedef {Object} PageDoc
 * @property {number} sv
 * @property {string} runId
 * @property {number} page
 * @property {*} scrapedAt
 * @property {*} expireAt
 * @property {number} count           products first seen on this page
 * @property {number} placements      cards on this page
 * @property {string} kind            results or last
 * @property {Object<string, Point>} items  every ASIN on the page
 * @property {boolean} [truncated]    more than MAX_PAGE_ITEMS ASINs
 */

/**
 * @typedef {Object} ProductDoc
 * @property {number} sv
 * @property {string} asin
 * @property {string} mk
 * @property {?string} name
 * @property {string} url
 * @property {?string} img
 * @property {Point & {at:*, runId:string, dayKey:string}} latest
 * @property {?(Point & {at:*})} prev
 * @property {?Delta} delta
 * @property {string[]} sourceIds
 * @property {*} [firstSeenAt]        set once, when the document is created
 * @property {string} [firstRunId]
 */

/**
 * @typedef {Object} HistoryDoc
 * @property {number} sv
 * @property {string} asin
 * @property {Object<string, Point>} d  dayKey to point
 */

// ── Ids ─────────────────────────────────────────────────────────

/** 32-bit FNV-1a of a string, base 36. */
export function hash(s) {
    let h = 0x811c9dc5;
    for (const ch of String(s)) {
        const c = ch.codePointAt(0);
        h ^= c & 0xff;
        h = Math.imul(h, 0x01000193);
        if (c > 0xff) {
            h ^= c >>> 8;
            h = Math.imul(h, 0x01000193);
        }
    }
    return (h >>> 0).toString(36);
}

export function slugify(s) {
    return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const SELLER_RE = /^[A-Z0-9]{6,20}$/;
// Query params that change per visit, not per search.
const NOISE = new Set(['page', 'ref', 'qid', 'xpid', 'crid', 'sprefix', 'dib', 'dib_tag', 'sr', 'ds', 'pd_rd_r', 'pf_rd_r']);

/** The seller in a search URL: me=, seller=, or p_6:/me: inside rh=. */
function sellerIn(params) {
    const direct = params.get('me') || params.get('seller');
    if (direct) return direct.toUpperCase();
    const m = (params.get('rh') || '').match(/(?:^|,)(?:p_6|me):([A-Za-z0-9]+)/);
    return m ? m[1].toUpperCase() : null;
}

/**
 * What an Amazon search URL scans.
 * @param {string} url
 * @returns {Source}
 */
export function sourceOf(url) {
    let params = null;
    try {
        params = new URL(url).searchParams;
    } catch (e) {
        return { type: 'keyword', sellerId: null, keyword: null, url: url || null };
    }
    const seller = sellerIn(params);
    if (seller && SELLER_RE.test(seller)) {
        return { type: 'storefront', sellerId: seller, keyword: params.get('k') || null, url };
    }
    const keyword = params.get('k') || params.get('field-keywords') || null;
    return { type: 'keyword', sellerId: null, keyword: keyword ? keyword.trim() : null, url };
}

/**
 * The source id: s_{sellerId} for a storefront, k_{slug} for a keyword.
 * A keyword with non-ASCII letters, or one too long, keeps what it can of
 * the slug and adds a hash, so two keywords never share an id. A search
 * with neither gets k_x{hash} of its query.
 * @param {Source} source
 * @returns {string}
 */
export function sourceIdOf(source) {
    if (source && source.type === 'storefront' && source.sellerId) return `s_${source.sellerId}`;
    const kw = source && source.keyword ? String(source.keyword).normalize('NFC').trim().toLowerCase() : '';
    if (kw) {
        const slug = slugify(kw);
        // eslint-disable-next-line no-control-regex
        const plain = !/[^\x00-\x7f]/.test(kw) && slug.length > 0 && slug.length <= 80;
        return plain ? `k_${slug}` : `k_${slug ? slug.slice(0, 60) + '-' : ''}h${hash(kw)}`;
    }
    let query = '';
    try {
        const u = new URL(source.url);
        query = [...u.searchParams.entries()]
            .filter(([k]) => !NOISE.has(k))
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('&');
        query = u.pathname + '?' + query;
    } catch (e) { /* no URL */ }
    return query ? `k_x${hash(query)}` : 'k_unknown';
}

/** Run id: {sourceId}_{startMs}, minted once when the run starts. */
export function runIdOf(sourceId, startMs) {
    return `${sourceId}_${startMs}`;
}

/** Page chunk id: p0001 for page 1. */
export function pageIdOf(page) {
    return 'p' + String(page).padStart(4, '0');
}

/**
 * The local date at `ms` as YYYY-MM-DD. `tzOffsetMin` is what
 * Date#getTimezoneOffset gives where the scan ran (minutes behind UTC), so
 * an evening scan in the US files under its own day.
 */
export function dayKeyOf(ms, tzOffsetMin = 0) {
    return new Date(ms - tzOffsetMin * 60000).toISOString().slice(0, 10);
}

export function expireAtMs(startMs) {
    return startMs + PAGE_TTL_DAYS * 86400000;
}

/**
 * The cloud status for an extension run: active while it runs, then
 * complete, stopped (by the user or a block page) or dead.
 */
export function runStatusOf(state) {
    switch (state) {
        case 'starting':
        case 'running':
        case 'stopping':
            return 'active';
        case 'done':
            return 'complete';
        case 'stopped':
        case 'blocked':
            return 'stopped';
        default:
            return 'dead';
    }
}

// ── Values ──────────────────────────────────────────────────────

/** Milliseconds from a number, Date, ISO string or Timestamp; null otherwise. */
export function timeMs(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
    if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isNaN(t) ? null : t;
    }
    if (v && typeof v.toMillis === 'function') return v.toMillis();
    return null;
}

const isInt = (v) => Number.isInteger(v);
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * A compact point from an extension product record, leaving out what is
 * unknown.
 * @param {{priceCents?:?number, rating?:?number, reviewCount?:?number, isPrime?:boolean, organicRank?:?number}} rec
 * @returns {Point}
 */
export function pointOf(rec) {
    const pt = {};
    if (isInt(rec.priceCents) && rec.priceCents >= 0) pt.p = rec.priceCents;
    if (typeof rec.rating === 'number' && rec.rating > 0 && rec.rating <= 5) pt.r = round1(rec.rating);
    if (isInt(rec.reviewCount) && rec.reviewCount >= 0) pt.v = rec.reviewCount;
    if (typeof rec.isPrime === 'boolean') pt.pr = rec.isPrime ? 1 : 0;
    if (isInt(rec.organicRank) && rec.organicRank > 0) pt.rk = rec.organicRank;
    return pt;
}

/**
 * The delta between two points, or null when nothing can be compared.
 * @param {Point} now
 * @param {?Point} prev
 * @param {?number} [days]
 * @returns {?Delta}
 */
export function deltaOf(now, prev, days = null) {
    if (!prev) return null;
    const d = {};
    if (isInt(now.p) && isInt(prev.p)) {
        d.p = now.p - prev.p;
        if (prev.p > 0) d.pPct = round1((d.p / prev.p) * 100);
    }
    if (typeof now.r === 'number' && typeof prev.r === 'number') d.r = round1(now.r - prev.r);
    if (isInt(now.v) && isInt(prev.v)) d.v = now.v - prev.v;
    if (Object.keys(d).length === 0) return null;
    if (isInt(days) && days >= 0) d.days = days;
    return d;
}

// ── Validators ──────────────────────────────────────────────────
// Each returns a list of problems; empty means valid.

const isStr = (v) => typeof v === 'string';
const isStrOrNull = (v) => v === null || isStr(v);
const isTime = (v) => timeMs(v) !== null && typeof v !== 'string';

function checkPoint(pt, where, errs, { sp = false } = {}) {
    if (!pt || typeof pt !== 'object') { errs.push(`${where}: not a map`); return; }
    for (const [k, v] of Object.entries(pt)) {
        if (v === null || v === undefined) errs.push(`${where}.${k}: unknown values are left out, not null`);
    }
    if ('p' in pt && !(isInt(pt.p) && pt.p >= 0)) errs.push(`${where}.p: cents must be a whole number`);
    if ('r' in pt && !(typeof pt.r === 'number' && pt.r >= 0 && pt.r <= 5)) errs.push(`${where}.r: rating out of range`);
    if ('v' in pt && !(isInt(pt.v) && pt.v >= 0)) errs.push(`${where}.v: review count must be a whole number`);
    if ('pr' in pt && pt.pr !== 0 && pt.pr !== 1) errs.push(`${where}.pr: must be 0 or 1`);
    if ('rk' in pt && !(isInt(pt.rk) && pt.rk > 0)) errs.push(`${where}.rk: rank must be 1 or more`);
    if ('sp' in pt && (!sp || (pt.sp !== 0 && pt.sp !== 1))) errs.push(`${where}.sp: only page items carry sp, as 0 or 1`);
}

function checkSv(doc, errs) {
    if (!doc || typeof doc !== 'object') { errs.push('not a document'); return false; }
    if (doc.sv !== SV) errs.push(`sv: expected ${SV}`);
    return true;
}

/** @returns {string[]} */
export function validateSource(doc) {
    const errs = [];
    if (!checkSv(doc, errs)) return errs;
    if (!isStr(doc.sourceId) || !/^[sk]_/.test(doc.sourceId)) errs.push('sourceId: expected s_ or k_');
    if (!SOURCE_TYPES.includes(doc.type)) errs.push('type: storefront or keyword');
    if (!isStrOrNull(doc.sellerId)) errs.push('sellerId: string or null');
    if (!isStrOrNull(doc.keyword)) errs.push('keyword: string or null');
    if (!isStrOrNull(doc.url)) errs.push('url: string or null');
    if (!isStr(doc.lastRunId)) errs.push('lastRunId: string');
    if (!isTime(doc.lastScrapedAt)) errs.push('lastScrapedAt: time');
    if ('catalogSize' in doc && !(isInt(doc.catalogSize) && doc.catalogSize >= 0)) errs.push('catalogSize: whole number');
    return errs;
}

/** @returns {string[]} */
export function validateRun(doc) {
    const errs = [];
    if (!checkSv(doc, errs)) return errs;
    if (!isStr(doc.runId)) errs.push('runId: string');
    if (!isStr(doc.sourceId)) errs.push('sourceId: string');
    if (isStr(doc.runId) && isStr(doc.sourceId) && !doc.runId.startsWith(doc.sourceId + '_')) errs.push('runId: must start with sourceId_');
    if (!doc.source || !SOURCE_TYPES.includes(doc.source.type)) errs.push('source.type: storefront or keyword');
    if (doc.mk !== MK) errs.push(`mk: ${MK}`);
    if (!isStr(doc.dayKey) || !DAY_KEY_RE.test(doc.dayKey)) errs.push('dayKey: YYYY-MM-DD');
    if (!isTime(doc.startedAt)) errs.push('startedAt: time');
    if (doc.finishedAt !== null && !isTime(doc.finishedAt)) errs.push('finishedAt: time or null');
    if (!RUN_STATUS.includes(doc.status)) errs.push(`status: one of ${RUN_STATUS.join(', ')}`);
    if (doc.status === 'active' && doc.finishedAt !== null) errs.push('finishedAt: null while active');
    if (!isStrOrNull(doc.reason)) errs.push('reason: string or null');
    if (!isInt(doc.pagesDone) || doc.pagesDone < 0) errs.push('pagesDone: whole number');
    if (!isInt(doc.maxPages) || doc.maxPages < 1) errs.push('maxPages: whole number');
    if (doc.pagesPlanned !== null && !isInt(doc.pagesPlanned)) errs.push('pagesPlanned: whole number or null');
    if (doc.totalResultsOnSerp !== null && !isInt(doc.totalResultsOnSerp)) errs.push('totalResultsOnSerp: whole number or null');
    const c = doc.counters || {};
    for (const k of ['placements', 'uniqueAsins', 'sponsored', 'priceParseFailures', 'newSeen']) {
        if (!isInt(c[k]) || c[k] < 0) errs.push(`counters.${k}: whole number`);
    }
    return errs;
}

/** @returns {string[]} */
export function validatePage(doc) {
    const errs = [];
    if (!checkSv(doc, errs)) return errs;
    if (!isStr(doc.runId)) errs.push('runId: string');
    if (!isInt(doc.page) || doc.page < 1) errs.push('page: 1 or more');
    if (!isTime(doc.scrapedAt)) errs.push('scrapedAt: time');
    if (!isTime(doc.expireAt)) errs.push('expireAt: time');
    if (!isInt(doc.count) || doc.count < 0) errs.push('count: whole number');
    if (!isInt(doc.placements) || doc.placements < 0) errs.push('placements: whole number');
    if (!doc.items || typeof doc.items !== 'object') {
        errs.push('items: map');
    } else {
        const keys = Object.keys(doc.items);
        if (keys.length > MAX_PAGE_ITEMS) errs.push(`items: at most ${MAX_PAGE_ITEMS}`);
        for (const asin of keys) {
            if (!ASIN_RE.test(asin)) errs.push(`items.${asin}: not an ASIN`);
            checkPoint(doc.items[asin], `items.${asin}`, errs, { sp: true });
        }
    }
    return errs;
}

/** @returns {string[]} */
export function validateProduct(doc) {
    const errs = [];
    if (!checkSv(doc, errs)) return errs;
    if (!isStr(doc.asin) || !ASIN_RE.test(doc.asin)) errs.push('asin: 10 letters and digits');
    if (doc.mk !== MK) errs.push(`mk: ${MK}`);
    if ('name' in doc && !isStrOrNull(doc.name)) errs.push('name: string or null');
    if ('img' in doc && doc.img !== null && !(isStr(doc.img) && /^https:\/\//.test(doc.img))) errs.push('img: https URL or null');
    if (!isStr(doc.url)) errs.push('url: string');
    if (!doc.latest) {
        errs.push('latest: map');
    } else {
        const { at, runId, dayKey, ...pt } = doc.latest;
        checkPoint(pt, 'latest', errs);
        if (!isTime(at)) errs.push('latest.at: time');
        if (!isStr(runId)) errs.push('latest.runId: string');
        if (!isStr(dayKey) || !DAY_KEY_RE.test(dayKey)) errs.push('latest.dayKey: YYYY-MM-DD');
    }
    if (doc.prev !== null && doc.prev !== undefined) {
        const { at, ...pt } = doc.prev;
        checkPoint(pt, 'prev', errs);
        if (at !== undefined && !isTime(at)) errs.push('prev.at: time');
    }
    if (doc.delta !== null && doc.delta !== undefined) {
        const d = doc.delta;
        if ('p' in d && !isInt(d.p)) errs.push('delta.p: cents must be a whole number');
        if ('pPct' in d && typeof d.pPct !== 'number') errs.push('delta.pPct: number');
        if ('r' in d && typeof d.r !== 'number') errs.push('delta.r: number');
        if ('v' in d && !isInt(d.v)) errs.push('delta.v: whole number');
        if ('days' in d && !isInt(d.days)) errs.push('delta.days: whole number');
        for (const [k, v] of Object.entries(d)) if (v === null) errs.push(`delta.${k}: left out, not null`);
    }
    if ('sourceIds' in doc && !(Array.isArray(doc.sourceIds) && doc.sourceIds.every(isStr))) errs.push('sourceIds: list of strings');
    if ('firstSeenAt' in doc && !isTime(doc.firstSeenAt)) errs.push('firstSeenAt: time');
    return errs;
}

/** @returns {string[]} */
export function validateHistory(doc) {
    const errs = [];
    if (!checkSv(doc, errs)) return errs;
    if (!isStr(doc.asin) || !ASIN_RE.test(doc.asin)) errs.push('asin: 10 letters and digits');
    if (!doc.d || typeof doc.d !== 'object') {
        errs.push('d: map');
    } else {
        for (const [day, pt] of Object.entries(doc.d)) {
            if (!DAY_KEY_RE.test(day)) errs.push(`d.${day}: not a day key`);
            checkPoint(pt, `d.${day}`, errs);
        }
    }
    return errs;
}

const VALIDATORS = {
    source: validateSource,
    run: validateRun,
    page: validatePage,
    product: validateProduct,
    history: validateHistory
};

/** Throws when `doc` is not a valid document of `kind`. */
export function assertValid(kind, doc) {
    const errs = VALIDATORS[kind](doc);
    if (errs.length) throw new Error(`invalid ${kind} document: ${errs.join('; ')}`);
    return doc;
}
