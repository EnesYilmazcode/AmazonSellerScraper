/**
 * @fileoverview Amazon search page parser, in the page.
 *
 * Parse only: this script never writes storage and never navigates. The
 * service worker runs the scrape (scripts/background/engine.js).
 *
 * On load the script says PAGE_READY. When this tab owns the running run
 * and the worker is waiting for a page, it answers with the page number,
 * and the script parses the page (scripts/lib/parsers.js) and sends it back
 * as PAGE_RESULT. While the worker waits to open the next page, the script
 * sends a HEARTBEAT every few seconds, which also wakes a stopped worker.
 * Other Amazon tabs get told they have no part in the run and stay quiet.
 *
 * Every call into the extension is guarded by alive(): after an update or
 * a removal the old script stays in open tabs with no extension behind it.
 *
 * @module Scraper
 */

const HEARTBEAT_MS = 2000;
const RETRY_MS = 1000;

/** Pages this document already reported, by run and page number. */
const reported = new Set();
let heartbeatTimer = null;

/** False once the extension was updated or removed under this page. */
function alive() {
    try {
        return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
        return false;
    }
}

/** Sends `message` to the worker; resolves null when nothing answers. */
function send(message) {
    return new Promise(resolve => {
        if (!alive()) return resolve(null);
        try {
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError) return resolve(null);
                resolve(response || null);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

// Pure parsing lives in scripts/lib/parsers.js. These names stay for the
// unit tests that load this file.
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

function parsePage() {
    return Parsers.parseSearchPage(document, window.location.href);
}

function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
}

function startHeartbeat(runId) {
    stopHeartbeat();
    heartbeatTimer = setInterval(async () => {
        if (!alive()) return stopHeartbeat();
        const reply = await send({ type: Msg.T.HEARTBEAT, runId });
        if (reply && reply.active === false) stopHeartbeat();
    }, HEARTBEAT_MS);
}

/** Parses this page as page `page` of run `runId` and reports it, once. */
function parseAndReport(runId, page) {
    const key = runId + ':' + page;
    if (reported.has(key)) return;
    reported.add(key);
    const result = parsePage();
    console.log(`[ProScan] Page ${page} kind ${result.kind}, ${result.products.length} product listings`);
    report({ type: Msg.T.PAGE_RESULT, runId, page, url: window.location.href, result }, 3);
}

async function report(message, tries) {
    const reply = await send(message);
    if (!reply) {
        // The worker may be starting up; it drops a page it already has.
        if (tries > 1 && alive()) setTimeout(() => report(message, tries - 1), RETRY_MS);
        // Never got through, so a later PARSE_PAGE may try again.
        else reported.delete(message.runId + ':' + message.page);
        return;
    }
    if (reply.next === 'wait') startHeartbeat(message.runId);
    else stopHeartbeat();
}

/** Tells the worker this page is up, and does what it says. */
async function announce(tries = 3) {
    if (!alive()) return;
    const reply = await send({ type: Msg.T.PAGE_READY, url: window.location.href });
    if (!reply) {
        if (tries > 1) setTimeout(() => announce(tries - 1), RETRY_MS);
        return;
    }
    if (reply.parse) parseAndReport(reply.runId, reply.page);
    else if (reply.heartbeat) startHeartbeat(reply.runId);
}

/**
 * Messages from the worker and the popup:
 * - PING: is this script alive, and what kind of page is this
 * - PARSE_PAGE {runId, page}: parse this page for the run
 * - RUN_ENDED: the run is over, stop the heartbeat
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!alive() || !request) return false;

    if (request.type === Msg.T.PING) {
        const page = parsePage();
        sendResponse({ ok: true, kind: page.kind, count: page.products.length, url: window.location.href });
        return false;
    }

    if (request.type === Msg.T.PARSE_PAGE) {
        if (!request.runId || !request.page) {
            sendResponse({ ok: false });
            return false;
        }
        sendResponse({ ok: true });
        setTimeout(() => parseAndReport(request.runId, request.page), 0);
        return false;
    }

    if (request.type === Msg.T.RUN_ENDED) {
        stopHeartbeat();
        return false;
    }

    return false;
});

// At document_idle the load events may already have fired, so run now.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => announce(), { once: true });
} else {
    announce();
}
