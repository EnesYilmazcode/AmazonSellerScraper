/**
 * @fileoverview Amazon Offer Listing Fetcher
 *
 * Content script that fetches seller offer pages for each scraped product
 * to extract competing seller prices. Runs in the Amazon page context
 * (same-origin), enabling direct fetch() calls to offer listing URLs.
 *
 * Flow:
 * 1. Receives START_SPREAD_ANALYSIS message from popup
 * 2. Reads product ASINs from chrome.storage
 * 3. For each ASIN, fetches the offer listing page
 * 4. Parses seller prices using DOMParser + cascading selectors
 * 5. Stores spread data back in chrome.storage
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
 * CSS selectors for extracting prices from Amazon offer listing pages.
 * Multiple selectors for resilience against layout changes.
 * @const {Object}
 */
const OFFER_SELECTORS = {
    // AOD (All Offers Display) format — modern Amazon
    aodPriceBlock: '.aod-information-block .a-price .a-offscreen',

    // Classic offer listing page format
    offerListPrice: '#olpOfferList .a-price .a-offscreen',

    // Legacy offer listing format
    legacyOfferPrice: '.olpOfferPrice',

    // General fallback — any price element on the page
    generalPrice: '.a-price .a-offscreen'
};

/**
 * Build the offer listing URL for a given ASIN.
 * Uses the classic offer listing page format filtered to new condition.
 *
 * @param {string} asin - Amazon Standard Identification Number
 * @returns {string} Full URL for the offer listing page
 */
function buildOfferUrl(asin) {
    return `https://www.amazon.com/gp/offer-listing/${asin}/ref=dp_olp_all_mbc?ie=UTF8&condition=new`;
}

/**
 * Build the AOD (All Offers Display) AJAX URL for a given ASIN.
 * This endpoint returns HTML fragments with all seller offers.
 *
 * @param {string} asin - Amazon Standard Identification Number
 * @returns {string} AJAX endpoint URL
 */
function buildAodUrl(asin) {
    return `https://www.amazon.com/gp/aod/ajax?asin=${asin}&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp`;
}

/**
 * Parse a price string from Amazon's DOM into a numeric value.
 * Handles currency symbols, commas, and whitespace.
 *
 * @param {string} text - Raw price text (e.g., "$19.99", "$1,299.00")
 * @returns {number} Parsed price, or 0 if unparseable
 */
function parseOfferPrice(text) {
    if (!text) return 0;
    const cleaned = text.replace(/[^0-9.]/g, '');
    const price = parseFloat(cleaned);
    return isNaN(price) ? 0 : price;
}

/**
 * Extract all seller prices from an HTML document using cascading selectors.
 * Tries multiple selector strategies in order of specificity.
 *
 * @param {Document} doc - Parsed HTML document (from DOMParser)
 * @returns {number[]} Array of valid seller prices (> 0)
 */
function extractPricesFromDocument(doc) {
    const prices = [];

    // Try each selector strategy in order
    const selectorStrategies = [
        OFFER_SELECTORS.aodPriceBlock,
        OFFER_SELECTORS.offerListPrice,
        OFFER_SELECTORS.legacyOfferPrice,
        OFFER_SELECTORS.generalPrice
    ];

    for (const selector of selectorStrategies) {
        const elements = doc.querySelectorAll(selector);
        if (elements.length > 0) {
            elements.forEach(el => {
                const price = parseOfferPrice(el.textContent);
                if (price > 0) {
                    prices.push(price);
                }
            });
            // If we found prices with this selector, don't try fallbacks
            if (prices.length > 0) break;
        }
    }

    // Deduplicate prices (same price from different selector matches)
    return [...new Set(prices)];
}

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
        // Check if user cancelled
        if (!isAnalyzing) {
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

        // Save progress to storage incrementally
        await new Promise(resolve => {
            chrome.storage.local.set({ spreadResults }, resolve);
        });

        // Send progress update to popup
        chrome.runtime.sendMessage({
            type: 'SPREAD_PROGRESS',
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

    // Final save
    await new Promise(resolve => {
        chrome.storage.local.set({ spreadResults, isSpreadAnalyzing: false }, resolve);
    });

    chrome.runtime.sendMessage({
        type: 'SPREAD_ANALYSIS_COMPLETE',
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
    if (request.type === 'START_SPREAD_ANALYSIS') {
        if (isAnalyzing) {
            sendResponse({ status: 'already_running' });
            return true;
        }

        // Read products from storage and start analysis
        chrome.storage.local.get(['results'], (data) => {
            const products = data.results || [];
            if (products.length === 0) {
                sendResponse({ status: 'no_products' });
                return;
            }

            chrome.storage.local.set({ isSpreadAnalyzing: true }, () => {
                runSpreadAnalysis(products);
                sendResponse({ status: 'started', total: products.length });
            });
        });

        return true; // Keep channel open for async response
    }

    if (request.type === 'STOP_SPREAD_ANALYSIS') {
        isAnalyzing = false;
        sendResponse({ status: 'stopping' });
        return true;
    }

    return true;
});
