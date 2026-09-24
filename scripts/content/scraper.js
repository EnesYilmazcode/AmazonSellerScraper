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
 * Pagination:
 * After scraping a page, the script automatically navigates to the next
 * page with a 2-second delay to avoid rate limiting. Scraping continues
 * until no more pages exist or the user stops it.
 *
 * @module Scraper
 */

let isScrapingActive = false;
let itemCount = 0;

/**
 * Initialize the scraper on page load.
 * Checks storage to see if a scraping session is in progress
 * (e.g., after navigating to a new page) and resumes if so.
 */
function initialize() {
    chrome.storage.local.get(['isScrapingActive', 'currentItemCount'], (data) => {
        isScrapingActive = data.isScrapingActive || false;
        itemCount = data.currentItemCount || 0;

        if (isScrapingActive) {
            scrapeCurrentPage();
        }
    });
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
 * Main scraping function for the current page.
 *
 * Workflow:
 * 1. Parse the page with Parsers.parseSearchPage()
 * 2. Stop if it has no listings
 * 3. Send progress update to popup via chrome.runtime
 * 4. Append results to chrome.storage.local
 * 5. If more pages exist, navigate after a 2-second delay
 * 6. Otherwise, call finishScraping()
 */
function scrapeCurrentPage() {
    if (!isScrapingActive) return;

    const page = Parsers.parseSearchPage(document, window.location.href);
    const results = page.products;

    console.log(`[ProScan] Found ${results.length} product listings`);

    if (page.products.length === 0) {
        console.log('[ProScan] No listings found on this page');
        finishScraping(itemCount);
        return;
    }

    console.log(`[ProScan] Scraped ${results.length} products`);

    // Send progress update to popup
    chrome.runtime.sendMessage({
        type: 'UPDATE_PROGRESS',
        itemCount: results.length,
        results: results
    });

    // Save results to storage, stamping run context + month-over-month deltas,
    // and appending to the durable queue the service worker drains to Firestore.
    chrome.storage.local.get(
        ['currentItemCount', 'results', 'scrapeRunId', 'scrapeRunPageIndex', 'lastValues', 'syncQueue', 'scrapeRunPages'],
        (data) => {
            const runId = data.scrapeRunId || null;
            const pageIndex = (data.scrapeRunPageIndex || 0) + 1; // 1-based page number
            const lastValues = data.lastValues || {};
            const stampedAt = new Date().toISOString();

            // Stamp each product with run context + deltas vs its prior snapshot,
            // then roll its values forward into lastValues for the next run.
            results.forEach(product => {
                product.runId = runId;
                product.pageIndex = pageIndex;
                product.delta = Delta.computeDeltas(product, lastValues[product.asin] || null);
                lastValues[product.asin] = Delta.snapshot(product);
            });

            const previousCount = data.currentItemCount || 0;
            const previousResults = data.results || [];
            const newCount = previousCount + results.length;
            const allResults = [...previousResults, ...results];

            // Durable, append-only sync queue (survives SW restarts + navigation).
            const syncQueue = data.syncQueue || [];
            syncQueue.push(...results);

            // Per-page manifest so the run inbox can reconstruct pages pre-sync.
            const runPages = data.scrapeRunPages || [];
            runPages.push({ runId, pageIndex, count: results.length, scrapedAt: stampedAt, url: location.href });

            chrome.storage.local.set({
                results: allResults,
                currentItemCount: newCount,
                scrapeRunPageIndex: pageIndex,
                lastValues: lastValues,
                syncQueue: syncQueue,
                scrapeRunPages: runPages
            }, () => {
                // Nudge the service worker to flush now; the chrome.alarms tick is
                // the autonomous safety net if the popup/page closes first.
                chrome.runtime.sendMessage({ type: 'ENQUEUE_SYNC', runId: runId, pageIndex: pageIndex });

                // Checked after the write, as before the parser split
                if (page.nextHref && isScrapingActive) {
                    const nextUrl = page.nextHref;
                    console.log(`[ProScan] Navigating to next page: ${nextUrl}`);

                    // 2-second delay to avoid rate limiting
                    setTimeout(() => {
                        window.location.href = nextUrl;
                    }, 2000);
                } else {
                    finishScraping(newCount);
                }
            });
        }
    );
}

/**
 * Finalize the scraping session.
 * Updates storage state, logs completion, and notifies the popup.
 *
 * @param {number} finalCount - Total number of products scraped across all pages
 */
function finishScraping(finalCount) {
    isScrapingActive = false;

    chrome.storage.local.set({
        isScrapingActive: false,
        currentItemCount: finalCount
    }, () => {
        console.log(`[ProScan] Scraping complete. Total items: ${finalCount}`);

        chrome.runtime.sendMessage({
            type: 'SCRAPING_COMPLETE',
            itemCount: finalCount
        });
    });
}

/**
 * Message listener for commands from the popup.
 *
 * Supported messages:
 * - START_SCRAPING: Begin a new scraping session (resets state)
 * - STOP_SCRAPING: Gracefully halt the current session
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'START_SCRAPING') {
        console.log('[ProScan] Starting scrape...');
        isScrapingActive = true;
        itemCount = 0;

        chrome.storage.local.set({
            results: [],
            currentItemCount: 0,
            isScrapingActive: true
        }, () => {
            scrapeCurrentPage();
        });

        sendResponse({ status: 'started' });
    } else if (request.type === 'STOP_SCRAPING') {
        console.log('[ProScan] Stopping scrape...');
        isScrapingActive = false;

        chrome.storage.local.get(['currentItemCount'], (data) => {
            finishScraping(data.currentItemCount || 0);
        });

        sendResponse({ status: 'stopped' });
    }

    return true; // Keep message channel open for async response
});

// Initialize on page load -- both events for reliability
document.addEventListener('DOMContentLoaded', initialize);
window.addEventListener('load', initialize);
