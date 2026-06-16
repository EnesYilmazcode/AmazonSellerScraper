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
 * CSS selectors for Amazon product page elements.
 * Updated February 2026 to reflect current Amazon DOM structure.
 * Each field has primary + fallback selectors for resilience.
 *
 * @const {Object}
 */
const SELECTORS = {
    /** Product result container -- filtered to exclude empty ASINs (ad placeholders) */
    productItem: '.s-result-item[data-asin]:not([data-asin=""])',

    /** Title -- structural selector (h2 > span) is more stable than class-based */
    title: 'h2 span',
    titleAlt: '.a-size-base-plus.a-color-base.a-text-normal',

    /** Price -- data-attribute selector targets the primary displayed price */
    price: '.a-price[data-a-size="xl"] .a-offscreen',
    priceAlt: '.a-price .a-offscreen',

    /** Rating -- cascading from most to least stable */
    rating: '[data-cy="reviews-ratings-slot"] .a-icon-alt',
    ratingAlt: '.a-icon-star-mini .a-icon-alt',
    ratingLegacy: '.a-icon-star-small .a-icon-alt',
    ratingText: '[data-cy="reviews-block"] span.a-size-base.a-color-secondary',

    /** Review count -- aria-label has full number; display text may use K/M abbreviations */
    reviewCount: 'a[aria-label$="ratings"]',
    reviewCountAlt: '.a-size-mini.puis-normal-weight-text.s-underline-text',
    reviewCountLegacy: '.a-size-base.puis-normal-weight-text.s-underline-text',

    productLink: '.a-link-normal.s-no-outline',
    primeBadge: '.a-icon-prime, .s-prime',
    nextPageDisabled: '.s-pagination-next.s-pagination-disabled',
    resultsText: 'h2.a-size-base.a-spacing-small.a-spacing-top-small span',
    resultsToolbar: '.s-desktop-toolbar .a-spacing-small span'
};

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

/**
 * Safely extract text content from a DOM element using cascading selectors.
 *
 * @param {HTMLElement} element - Parent element to search within
 * @param {string} selector - Primary CSS selector
 * @param {string|null} [fallbackSelector=null] - Fallback CSS selector
 * @returns {string|null} Trimmed text content, or null if no match
 */
function getText(element, selector, fallbackSelector = null) {
    let el = element.querySelector(selector);
    if (!el && fallbackSelector) {
        el = element.querySelector(fallbackSelector);
    }
    return el ? el.innerText.trim() : null;
}

/**
 * Extract the product price from a listing element.
 * Tries the primary price selector (xl size, usually the main price)
 * then falls back to any .a-price element.
 *
 * @param {HTMLElement} element - Product listing DOM element
 * @returns {string} Price string (e.g., "$19.99") or "N/A"
 */
function extractPrice(element) {
    const priceEl = element.querySelector(SELECTORS.price) ||
                    element.querySelector(SELECTORS.priceAlt);

    if (priceEl) {
        const text = priceEl.innerText || priceEl.textContent;
        return text ? text.trim() : 'N/A';
    }
    return 'N/A';
}

/**
 * Parse a numeric rating from text like "4.7 out of 5 stars" or "4.7".
 *
 * @param {string|null} text - Raw rating text from Amazon DOM
 * @returns {number} Parsed rating (0-5), or 0 if unparseable
 */
function parseRatingText(text) {
    if (!text) return 0;
    const match = text.match(/(\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : 0;
}

/**
 * Extract the product rating using a four-level cascading selector strategy:
 * 1. data-cy attribute (most stable across Amazon updates)
 * 2. Current star class (a-icon-star-mini)
 * 3. Legacy star class (a-icon-star-small)
 * 4. Plain text in reviews block
 *
 * @param {HTMLElement} element - Product listing DOM element
 * @returns {number} Rating value (0-5), or 0 if not found
 */
function extractRating(element) {
    // 1. data-cy attribute (most stable across Amazon updates)
    const dataCy = element.querySelector(SELECTORS.rating);
    if (dataCy) {
        const val = parseRatingText(dataCy.textContent);
        if (val > 0) return val;
    }

    // 2. Current Amazon star class (a-icon-star-mini)
    const starMini = element.querySelector(SELECTORS.ratingAlt);
    if (starMini) {
        const val = parseRatingText(starMini.textContent);
        if (val > 0) return val;
    }

    // 3. Legacy star class (a-icon-star-small)
    const starSmall = element.querySelector(SELECTORS.ratingLegacy);
    if (starSmall) {
        const val = parseRatingText(starSmall.textContent);
        if (val > 0) return val;
    }

    // 4. Plain text rating shown in reviews block (e.g. "4.7" as visible text)
    const ratingSpan = element.querySelector(SELECTORS.ratingText);
    if (ratingSpan) {
        const val = parseRatingText(ratingSpan.textContent);
        if (val > 0 && val <= 5) return val;
    }

    return 0;
}

/**
 * Parse abbreviated review count text into an integer.
 * Handles formats like "(64)", "(108.3K)", "(77K)", "(1.2M)".
 *
 * @param {string|null} text - Raw review count text
 * @returns {number} Parsed integer review count, or 0
 *
 * @example
 * parseReviewText("(108.3K)") // => 108300
 * parseReviewText("(1.2M)")   // => 1200000
 */
function parseReviewText(text) {
    if (!text) return 0;
    const cleaned = text.replace(/[()]/g, '').trim();
    const match = cleaned.match(/^([\d,.]+)\s*([KMkm])?/);
    if (!match) return 0;

    let num = parseFloat(match[1].replace(/,/g, ''));
    const suffix = (match[2] || '').toUpperCase();
    if (suffix === 'K') num *= 1000;
    if (suffix === 'M') num *= 1000000;
    return Math.round(num);
}

/**
 * Extract the review count from a product listing.
 * Tries three sources in order of accuracy:
 * 1. aria-label on ratings link (exact number, e.g., "108,373 ratings")
 * 2. Current display text (may use K/M abbreviations)
 * 3. Legacy display text format
 *
 * @param {HTMLElement} element - Product listing DOM element
 * @returns {number} Review count, or 0 if not found
 */
function extractReviewCount(element) {
    // 1. aria-label on the ratings link -- most accurate
    const ariaLink = element.querySelector(SELECTORS.reviewCount);
    if (ariaLink) {
        const label = ariaLink.getAttribute('aria-label');
        if (label) {
            const cleaned = label.replace(/[^0-9]/g, '');
            const count = parseInt(cleaned);
            if (count > 0) return count;
        }
    }

    // 2. Current display text (a-size-mini) -- may have K/M suffix
    const miniEl = element.querySelector(SELECTORS.reviewCountAlt);
    if (miniEl) {
        const count = parseReviewText(miniEl.textContent);
        if (count > 0) return count;
    }

    // 3. Legacy display text (a-size-base)
    const baseEl = element.querySelector(SELECTORS.reviewCountLegacy);
    if (baseEl) {
        const count = parseReviewText(baseEl.textContent);
        if (count > 0) return count;
    }

    return 0;
}

/**
 * Check if a product listing has an Amazon Prime badge.
 *
 * @param {HTMLElement} element - Product listing DOM element
 * @returns {boolean} True if Prime-eligible
 */
function hasPrimeBadge(element) {
    return element.querySelector(SELECTORS.primeBadge) !== null;
}

/**
 * Extract all data from a single product listing element.
 *
 * @param {HTMLElement} listing - Product listing DOM element with data-asin attribute
 * @returns {Object|null} Product object or null if ASIN is missing
 * @returns {string} return.name - Product title
 * @returns {string} return.asin - Amazon Standard Identification Number
 * @returns {string} return.price - Price string (e.g., "$19.99")
 * @returns {number} return.rating - Rating value (0-5)
 * @returns {number} return.reviewCount - Total review count
 * @returns {boolean} return.isPrime - Prime eligibility
 * @returns {string} return.url - Full Amazon product URL
 * @returns {string} return.scrapedAt - ISO timestamp of when the product was scraped
 */
function scrapeProduct(listing) {
    const asin = listing.dataset.asin;
    if (!asin) return null;

    const title = getText(listing, SELECTORS.title, SELECTORS.titleAlt) || 'N/A';
    const price = extractPrice(listing);
    const rating = extractRating(listing);
    const reviewCount = extractReviewCount(listing);
    const isPrime = hasPrimeBadge(listing);

    // Get product URL
    const linkEl = listing.querySelector(SELECTORS.productLink);
    const productUrl = linkEl
        ? `https://www.amazon.com${linkEl.getAttribute('href')}`
        : 'N/A';

    return {
        name: title,
        asin: asin,
        price: price,
        // Canonical integer-cents price for cloud sync + delta math; null when
        // the display price is absent/unparseable (Price loaded via manifest).
        priceCents: Price.priceToCents(price),
        rating: rating,
        reviewCount: reviewCount,
        isPrime: isPrime,
        url: productUrl,
        scrapedAt: new Date().toISOString()
    };
}

/**
 * Extract the total number of search results from the Amazon results page header.
 *
 * @returns {number} Total result count, or 0 if not found
 */
function getTotalResults() {
    const resultsEl = document.querySelector(SELECTORS.resultsText);
    if (resultsEl) {
        const text = resultsEl.innerText;
        const match = text.match(/of (\d+[\d,]*) results/);
        if (match) {
            return parseInt(match[1].replace(/,/g, ''));
        }
    }
    return 0;
}

/**
 * Construct the URL for the next page of search results.
 * Increments the page parameter and updates the ref parameter.
 *
 * @returns {string} Full URL for the next results page
 */
function getNextPageUrl() {
    const currentUrl = new URL(window.location.href);
    const currentPage = parseInt(currentUrl.searchParams.get('page')) || 1;
    const nextPage = currentPage + 1;

    currentUrl.searchParams.set('page', nextPage);
    currentUrl.searchParams.set('ref', `sr_pg_${nextPage}`);

    return currentUrl.toString();
}

/**
 * Check if there is a next page of results available.
 * Returns false if the "Next" pagination button is disabled.
 *
 * @returns {boolean} True if more pages exist
 */
function hasNextPage() {
    return !document.querySelector(SELECTORS.nextPageDisabled);
}

/**
 * Main scraping function for the current page.
 *
 * Workflow:
 * 1. Query all product listing elements on the page
 * 2. Extract data from each listing via scrapeProduct()
 * 3. Send progress update to popup via chrome.runtime
 * 4. Append results to chrome.storage.local
 * 5. If more pages exist, navigate after a 2-second delay
 * 6. Otherwise, call finishScraping()
 */
function scrapeCurrentPage() {
    if (!isScrapingActive) return;

    const listings = document.querySelectorAll(SELECTORS.productItem);
    const results = [];

    console.log(`[ProScan] Found ${listings.length} product listings`);

    if (listings.length === 0) {
        console.log('[ProScan] No listings found on this page');
        finishScraping(itemCount);
        return;
    }

    listings.forEach(listing => {
        const product = scrapeProduct(listing);
        if (product) {
            results.push(product);
        }
    });

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

                // Check for next page
                if (hasNextPage() && isScrapingActive) {
                    const nextUrl = getNextPageUrl();
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
