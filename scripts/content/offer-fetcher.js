/**
 * @fileoverview Amazon Offer Listing Fetcher
 *
 * Content script that fetches seller offer pages for each scraped product
 * to extract competing seller prices. Runs in the Amazon page context
 * (same-origin), enabling direct fetch() calls to offer listing URLs.
 *
 * Flow:
 * 1. Receives START_SPREAD_ANALYSIS message from popup
 * 2. Asks the service worker for the last run's products (GET_RESULTS)
 * 3. For each ASIN, fetches the offer listing page
 * 4. Parses seller prices using DOMParser + cascading selectors
 * 5. Sends each product's spread data to the worker (SPREAD_RESULT), which
 *    stores it; this script never writes storage
 * 6. Sends progress updates to popup
 *
 * Rate limiting: 2-second delay between requests to avoid Amazon throttling.
 * Stoppable: listens for STOP_SPREAD_ANALYSIS to cancel mid-run.
 *
 * @module OfferFetcher
 */

/** @type {boolean} Whether spread analysis is currently running */
let isAnalyzing = false;

/**
 * Callbacks in this page that follow the analysis (the dock). A content
 * script's runtime.sendMessage never reaches the same page, so the dock
 * watches here. Each gets {current, total} per product and {done, total}.
 */
const spreadWatchers = new Set();

function watchSpread(fn) {
    spreadWatchers.add(fn);
    return () => spreadWatchers.delete(fn);
}

function notifySpread(event) {
    spreadWatchers.forEach(fn => {
        try { fn(event); } catch (e) { /* a watcher's error is its own */ }
    });
}

/** Stops the analysis after the product it is on. */
function stopSpreadAnalysis() {
    isAnalyzing = false;
}

/** False once the extension was updated or removed under this page. */
function offersAlive() {
    try {
        return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
        return false;
    }
}

/** Sends `message` to the extension; resolves null when nothing answers. */
function tell(message) {
    return new Promise(resolve => {
        if (!offersAlive()) return resolve(null);
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

// Pure parsing lives in scripts/lib/parsers.js. These names stay for the fetch
// loop below and for the unit tests that load this file.
var { buildOfferUrl, buildAodUrl, parseOfferPrice, extractPricesFromDocument } = Parsers;

/**
 * Fetch the offer listing page for a single ASIN and extract seller prices.
 * Tries the AOD AJAX endpoint first, then falls back to the classic page.
 *
 * @param {string} asin - Amazon Standard Identification Number
 * @returns {Promise<{sellerPrices: number[], fetchedAt: string}|null>}
 *   Offer data or null on failure
 */
async function fetchOfferPrices(asin) {
    const parser = new DOMParser();

    // Strategy 1: AOD AJAX endpoint (faster, lighter response)
    try {
        const aodResponse = await fetch(buildAodUrl(asin), {
            credentials: 'include',
            headers: { 'Accept': 'text/html' }
        });

        if (aodResponse.ok) {
            const html = await aodResponse.text();
            const doc = parser.parseFromString(html, 'text/html');
            const prices = extractPricesFromDocument(doc);

            if (prices.length > 0) {
                return {
                    sellerPrices: prices,
                    fetchedAt: new Date().toISOString()
                };
            }
        }
    } catch (e) {
        console.log(`[ProScan Spread] AOD fetch failed for ${asin}, trying classic page`);
    }

    // Strategy 2: Classic offer listing page (fallback)
    try {
        const response = await fetch(buildOfferUrl(asin), {
            credentials: 'include',
            headers: { 'Accept': 'text/html' }
        });

        if (response.ok) {
            const html = await response.text();
            const doc = parser.parseFromString(html, 'text/html');
            const prices = extractPricesFromDocument(doc);

            if (prices.length > 0) {
                return {
                    sellerPrices: prices,
                    fetchedAt: new Date().toISOString()
                };
            }
        }
    } catch (e) {
        console.log(`[ProScan Spread] Classic fetch also failed for ${asin}: ${e.message}`);
    }

    return null;
}

/**
 * Sleep for a specified number of milliseconds.
 * Used for rate limiting between offer page requests.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run the full spread analysis across all scraped products.
 * Fetches offer pages sequentially with rate limiting,
 * stores results progressively, and sends progress updates.
 *
 * @param {Object[]} products - Array of scraped product objects
 */
async function runSpreadAnalysis(products) {
    isAnalyzing = true;
    const spreadResults = {};
    const total = products.length;

    console.log(`[ProScan Spread] Starting analysis for ${total} products`);

    for (let i = 0; i < total; i++) {
        // Check if user cancelled, or the extension went away
        if (!isAnalyzing || !offersAlive()) {
            console.log('[ProScan Spread] Analysis cancelled by user');
            break;
        }

        const product = products[i];
        const asin = product.asin;

        console.log(`[ProScan Spread] Fetching offers for ${asin} (${i + 1}/${total})`);

        // Fetch offer prices for this ASIN
        const offerData = await fetchOfferPrices(asin);

        if (offerData) {
            spreadResults[asin] = {
                asin: asin,
                productName: product.name,
                listPrice: product.price,
                ...offerData
            };
            console.log(`[ProScan Spread] Found ${offerData.sellerPrices.length} offers for ${asin}`);
        } else {
            spreadResults[asin] = null;
            console.log(`[ProScan Spread] No offers found for ${asin}`);
        }

        // The worker stores it
        await tell({ type: Msg.T.SPREAD_RESULT, asin, data: spreadResults[asin] });

        notifySpread({ current: i + 1, total, asin, hasData: offerData !== null });

        // Send progress update to popup
        tell({
            type: Msg.T.SPREAD_PROGRESS,
            current: i + 1,
            total: total,
            asin: asin,
            hasData: offerData !== null
        });

        // Rate limiting: wait 2 seconds between requests
        if (i < total - 1 && isAnalyzing) {
            await delay(2000);
        }
    }

    // Analysis complete
    isAnalyzing = false;
    notifySpread({ done: true, total, analyzed: Object.keys(spreadResults).length });

    tell({
        type: Msg.T.SPREAD_ANALYSIS_COMPLETE,
        totalAnalyzed: Object.keys(spreadResults).length
    });

    console.log(`[ProScan Spread] Analysis complete. Processed ${Object.keys(spreadResults).length} products`);
}

/**
 * Message listener for spread analysis commands from the popup.
 *
 * Supported messages:
 * - START_SPREAD_ANALYSIS: Begin fetching offer pages for all scraped products
 * - STOP_SPREAD_ANALYSIS: Cancel the running analysis
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!offersAlive() || !request) return false;

    if (request.type === Msg.T.START_SPREAD_ANALYSIS) {
        if (isAnalyzing) {
            sendResponse({ status: 'already_running' });
            return false;
        }

        tell({ type: Msg.T.GET_RESULTS }).then((data) => {
            const products = (data && data.results) || [];
            if (products.length === 0) {
                sendResponse({ status: 'no_products' });
                return;
            }
            runSpreadAnalysis(products);
            sendResponse({ status: 'started', total: products.length });
        });

        return true; // Keep channel open for async response
    }

    if (request.type === Msg.T.STOP_SPREAD_ANALYSIS) {
        isAnalyzing = false;
        sendResponse({ status: 'stopping' });
        return false;
    }

    return false;
});
