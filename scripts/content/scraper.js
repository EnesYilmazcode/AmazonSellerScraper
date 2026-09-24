/**
 * @fileoverview Amazon Product DOM Scraper
 *
 * Content script that extracts product data from Amazon search results
 * and seller pages. Uses a cascading selector strategy to handle
 * Amazon's frequently changing DOM structure.
 *
 * Selector Strategy:
 * Each data point (title, price, rating, reviews) has multiple selectors
 * ordered from most-stable to least-stable. The scraper tries each in
 * sequence and uses the first successful match. This makes the extension
 * resilient to Amazon A/B tests and layout changes.
 *
 * Runs:
 * A run belongs to the tab it started in (see scripts/lib/run.js). On each
 * page load the script asks the service worker for its tab id and scrapes
 * only when that tab owns the running run, so other Amazon tabs never join
 * it. Each page is classified first, so a captcha ends the run as blocked
 * rather than complete. The next page is the page's own Next link, opened
 * after a 2 to 4 second delay, up to the run's page cap.
 *
 * @module Scraper
 */

/** Tab id of this page, once known. */
let myTabId = null;
/** Pending navigation to the next page. */
let navTimer = null;
/** Runs this document has already scraped, so no page is scraped twice. */
const scrapedRuns = new Set();
/** Runs stopped while this page was being saved. */
const stoppedRuns = new Set();

/** False once the extension was updated or removed under this page. */
function alive() {
    try {
        return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
        return false;
    }
}

function getRun() {
    return new Promise(resolve => {
        chrome.storage.local.get([Run.KEY], data => resolve((data && data[Run.KEY]) || null));
    });
}

/** Asks the service worker which tab this page is in. */
function whoAmI() {
    return new Promise(resolve => {
        try {
            chrome.runtime.sendMessage({ type: 'WHO_AM_I' }, response => {
                if (chrome.runtime.lastError) return resolve(null);
                resolve(response && typeof response.tabId === 'number' ? response.tabId : null);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

/**
 * Resumes a run on page load when this tab owns it. Most Amazon pages have
 * no run, so storage is checked before the service worker is asked.
 */
async function initialize() {
    if (!alive()) return;
    const run = await getRun();
    if (!Run.isActive(run)) return;
    const tabId = await whoAmI();
    if (!Run.owns(run, tabId)) return;
    myTabId = tabId;

    // A reload of a page already scraped: go on from where the run was.
    if (run.lastUrl === location.href) {
        if (run.nextHref) scheduleNext(run.runId, run.nextHref);
        return;
    }
    scrapeCurrentPage(run.runId);
}

// Pure parsing lives in scripts/lib/parsers.js. These names stay for the page
// logic below and for the unit tests that load this file.
var {
    getText, extractPrice, parseRatingText, extractRating, parseReviewText,
    extractReviewCount, hasPrimeBadge, scrapeProduct
} = Parsers;

function getTotalResults() {
    return Parsers.getTotalResults(document);
}

function getNextPageUrl() {
    return Parsers.getNextPageUrl(window.location.href);
}

function hasNextPage() {
    return Parsers.hasNextPage(document);
}

/**
 * Scrapes the current page into run `runId`.
 *
 * The page is parsed and classified first. A page that ends the run (the
 * last page, the page cap, a captcha) is saved together with the run's end
 * in one write. Otherwise the next page is opened after a short delay.
 *
 * @param {string} runId
 */
function scrapeCurrentPage(runId) {
    if (scrapedRuns.has(runId)) return;
    scrapedRuns.add(runId);

    const page = Parsers.parseSearchPage(document, window.location.href);
    const results = page.products;
    console.log(`[ProScan] Page kind ${page.kind}, ${results.length} product listings`);

    const syncing = Flags.CLOUD_SYNC;
    const keys = [Run.KEY, 'currentItemCount', 'results', 'scrapeRunId', 'scrapeRunPageIndex', 'lastValues', 'scrapeRunPages'];
    chrome.storage.local.get(
        syncing ? [...keys, 'syncQueue'] : keys,
        (data) => {
            const run = data[Run.KEY];
            if (!run || run.runId !== runId || !Run.isActive(run)) return;

            const pageIndex = (data.scrapeRunPageIndex || 0) + 1; // 1-based page number
            const ending = Run.outcome(page, pageIndex, run.maxPages);
            const previousCount = data.currentItemCount || 0;

            if (results.length === 0 || ending === 'selectors_broken') {
                console.log(`[ProScan] Nothing to save on this page, run ends: ${ending}`);
                finishRun(runId, ending || 'complete');
                return;
            }

            const runKey = data.scrapeRunId || runId;
            const runResults = data.results || [];
            // With sync off nothing is queued, so the queue cannot grow.
            const syncQueue = syncing ? (data.syncQueue || []) : [];
            const fresh = mergeRepeats(results, pageIndex, runKey, runResults, syncQueue);

            chrome.runtime.sendMessage({
                type: 'UPDATE_PROGRESS',
                itemCount: fresh.length,
                results: fresh
            });

            // Only an ASIN's first sighting in the run gets a delta, taken
            // against the last run's snapshot, and rolls lastValues forward.
            const lastValues = data.lastValues || {};
            const stampedAt = new Date().toISOString();
            fresh.forEach(product => {
                product.runId = runKey;
                product.pageIndex = pageIndex;
                const prev = lastValues[product.asin] || null;
                product.delta = Delta.computeDeltas(product, prev);
                lastValues[product.asin] = Delta.snapshot(product, prev);
            });

            const newCount = previousCount + fresh.length;
            if (syncing) syncQueue.push(...fresh);
            const runPages = data.scrapeRunPages || [];
            runPages.push({
                runId: runKey, pageIndex, count: fresh.length, placements: page.placements,
                scrapedAt: stampedAt, url: location.href
            });

            const now = Date.now();
            let nextRun = { ...run, page: pageIndex, heartbeat: now, lastUrl: location.href, nextHref: page.nextHref };
            if (ending) nextRun = Run.finish(nextRun, ending, now);

            const save = {
                results: [...runResults, ...fresh],
                currentItemCount: newCount,
                scrapeRunPageIndex: pageIndex,
                lastValues: lastValues,
                scrapeRunPages: runPages,
                [Run.KEY]: nextRun,
                isScrapingActive: !ending
            };
            if (syncing) save.syncQueue = syncQueue;
            chrome.storage.local.set(save, () => {
                if (chrome.runtime.lastError) {
                    console.warn('[ProScan] Could not save the page:', chrome.runtime.lastError.message);
                    finishRun(runId, 'storage_full');
                    return;
                }
                if (syncing) chrome.runtime.sendMessage({ type: 'ENQUEUE_SYNC', runId: runKey, pageIndex: pageIndex });

                // Stop landed between the read and this write, which put the run back.
                if (!ending && stoppedRuns.has(runId)) {
                    finishRun(runId, 'stopped');
                } else if (ending) {
                    announceEnd(ending, newCount);
                } else {
                    scheduleNext(runId, page.nextHref);
                }
            });
        }
    );
}

/**
 * Folds this page's products into the run. Placements get the page number
 * and a run-wide organic rank. An ASIN already in the run only adds its
 * placements to the stored record (and its sync queue copy); the rest are
 * returned as new.
 */
function mergeRepeats(products, pageIndex, runKey, runResults, syncQueue) {
    const thisRun = runResults.filter(r => r.runId === runKey);
    const organicBefore = thisRun.reduce(
        (n, r) => n + (r.placements || []).filter(pl => !pl.sponsored).length, 0);
    const known = new Map(thisRun.map(r => [r.asin, r]));

    const fresh = [];
    products.forEach(product => {
        const placements = (product.placements || []).map(pl => ({
            page: pageIndex,
            ...pl,
            rank: pl.rank === null ? null : pl.rank + organicBefore
        }));
        const firstRank = (placements.find(pl => pl.rank !== null) || {}).rank;
        product.placements = placements;
        product.organicRank = firstRank === undefined ? null : firstRank;

        const seen = known.get(product.asin);
        if (!seen) {
            fresh.push(product);
            return;
        }
        const queued = syncQueue.find(q => q.asin === product.asin && q.runId === runKey);
        // The two can be one object when storage hands back shared references
        new Set([seen, queued]).forEach(rec => {
            if (!rec) return;
            rec.placements = [...(rec.placements || []), ...placements];
            rec.sponsored = !!rec.sponsored || product.sponsored;
            if (rec.organicRank == null) rec.organicRank = product.organicRank;
        });
    });
    return fresh;
}

/**
 * Opens `nextHref` after a 2 to 4 second delay, unless the run was stopped
 * or handed to another tab in the meantime.
 */
function scheduleNext(runId, nextHref) {
    clearTimeout(navTimer);
    const delay = Run.pageDelay();
    console.log(`[ProScan] Navigating to next page: ${nextHref}`);
    navTimer = setTimeout(async () => {
        navTimer = null;
        if (!alive()) return;
        const run = await getRun();
        if (!run || run.runId !== runId || !Run.owns(run, myTabId)) return;
        window.location.href = nextHref;
    }, delay);
}

/**
 * Ends run `runId` with `reason`, unless it already ended or another run
 * replaced it. Resolves once storage has the result.
 */
function finishRun(runId, reason) {
    clearTimeout(navTimer);
    navTimer = null;
    return new Promise(resolve => {
        chrome.storage.local.get([Run.KEY, 'currentItemCount'], (data) => {
            const run = data[Run.KEY];
            const count = data.currentItemCount || 0;
            if (!run || run.runId !== runId || !Run.isActive(run)) return resolve(false);
            chrome.storage.local.set({ [Run.KEY]: Run.finish(run, reason), isScrapingActive: false }, () => {
                console.log(`[ProScan] Run ended: ${reason}. Total items: ${count}`);
                announceEnd(reason, count);
                resolve(true);
            });
        });
    });
}

function announceEnd(reason, count) {
    chrome.runtime.sendMessage({ type: 'SCRAPING_COMPLETE', reason, itemCount: count });
}

/**
 * Messages from the popup:
 * - PING: is this script alive, and what kind of page is this
 * - START_SCRAPING {runId, tabId}: the popup made run `runId` for this tab
 * - STOP_SCRAPING {runId}: cancel the pending page and end the run as stopped
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'PING') {
        const page = Parsers.parseSearchPage(document, window.location.href);
        sendResponse({ ok: true, kind: page.kind, count: page.products.length });
        return false;
    }

    if (request.type === 'START_SCRAPING') {
        if (!request.runId) {
            sendResponse({ status: 'refused' });
            return false;
        }
        console.log('[ProScan] Starting scrape...');
        if (typeof request.tabId === 'number') myTabId = request.tabId;
        sendResponse({ status: 'started' });
        scrapeCurrentPage(request.runId);
        return false;
    }

    if (request.type === 'STOP_SCRAPING') {
        console.log('[ProScan] Stopping scrape...');
        clearTimeout(navTimer);
        navTimer = null;
        getRun().then(run => {
            const runId = request.runId || (run && run.runId);
            if (runId) stoppedRuns.add(runId);
            return finishRun(runId, 'stopped');
        }).then(() => sendResponse({ stopped: true }));
        return true;
    }

    return false;
});

// At document_idle the load events may already have fired, so run now.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}
