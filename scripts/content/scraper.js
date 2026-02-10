// scraper.js - Amazon Product Scraper Content Script
// Handles DOM scraping and pagination on Amazon pages

let isScrapingActive = false;
let itemCount = 0;

// Selectors for Amazon product elements (updated Feb 2026)
const SELECTORS = {
    productItem: '.s-result-item[data-asin]:not([data-asin=""])',

    // Title — structural selector first, class-based fallback
    title: 'h2 span',
    titleAlt: '.a-size-base-plus.a-color-base.a-text-normal',

    // Price — data-attribute for main price, generic fallback
    price: '.a-price[data-a-size="xl"] .a-offscreen',
    priceAlt: '.a-price .a-offscreen',

    // Rating — data-cy attribute (stable), then current/legacy star classes
    rating: '[data-cy="reviews-ratings-slot"] .a-icon-alt',
    ratingAlt: '.a-icon-star-mini .a-icon-alt',
    ratingLegacy: '.a-icon-star-small .a-icon-alt',
    ratingText: '[data-cy="reviews-block"] span.a-size-base.a-color-secondary',

    // Review count — aria-label has full number, then display text fallbacks
    reviewCount: 'a[aria-label$="ratings"]',
    reviewCountAlt: '.a-size-mini.puis-normal-weight-text.s-underline-text',
    reviewCountLegacy: '.a-size-base.puis-normal-weight-text.s-underline-text',

    productLink: '.a-link-normal.s-no-outline',
    primeBadge: '.a-icon-prime, .s-prime',
    nextPageDisabled: '.s-pagination-next.s-pagination-disabled',
    resultsText: 'h2.a-size-base.a-spacing-small.a-spacing-top-small span',
    resultsToolbar: '.s-desktop-toolbar .a-spacing-small span'
};

// Initialize on page load
function initialize() {
    chrome.storage.local.get(['isScrapingActive', 'currentItemCount'], (data) => {
        isScrapingActive = data.isScrapingActive || false;
        itemCount = data.currentItemCount || 0;

        if (isScrapingActive) {
            scrapeCurrentPage();
        }
    });
}

// Extract text content safely
function getText(element, selector, fallbackSelector = null) {
    let el = element.querySelector(selector);
    if (!el && fallbackSelector) {
        el = element.querySelector(fallbackSelector);
    }
    return el ? el.innerText.trim() : null;
}

// Extract price from element
function extractPrice(element) {
    const priceEl = element.querySelector(SELECTORS.price) ||
                    element.querySelector(SELECTORS.priceAlt);

    if (priceEl) {
        const text = priceEl.innerText || priceEl.textContent;
        return text ? text.trim() : 'N/A';
    }
    return 'N/A';
}

// Parse rating number from text like "4.7 out of 5 stars" or "4.7"
function parseRatingText(text) {
    if (!text) return 0;
    const match = text.match(/(\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : 0;
}

// Extract rating from element — tries multiple selectors in order
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

// Parse abbreviated review counts: "(64)", "(108.3K)", "(77K)", "(1.2M)"
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

// Extract review count from element — tries aria-label first (has full number)
function extractReviewCount(element) {
    // 1. aria-label on the ratings link (e.g. "108,373 ratings") — most accurate
    const ariaLink = element.querySelector(SELECTORS.reviewCount);
    if (ariaLink) {
        const label = ariaLink.getAttribute('aria-label');
        if (label) {
            const cleaned = label.replace(/[^0-9]/g, '');
            const count = parseInt(cleaned);
            if (count > 0) return count;
        }
    }

    // 2. Current display text (a-size-mini) — may have K/M suffix
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

// Check if product has Prime badge
function hasPrimeBadge(element) {
    return element.querySelector(SELECTORS.primeBadge) !== null;
}

// Scrape a single product listing
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
        rating: rating,
        reviewCount: reviewCount,
        isPrime: isPrime,
        url: productUrl,
        scrapedAt: new Date().toISOString()
    };
}

// Get total results count from page
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

// Get URL for next page
function getNextPageUrl() {
    const currentUrl = new URL(window.location.href);
    const currentPage = parseInt(currentUrl.searchParams.get('page')) || 1;
    const nextPage = currentPage + 1;

    currentUrl.searchParams.set('page', nextPage);
    currentUrl.searchParams.set('ref', `sr_pg_${nextPage}`);

    return currentUrl.toString();
}

// Check if there's a next page
function hasNextPage() {
    return !document.querySelector(SELECTORS.nextPageDisabled);
}

// Main scraping function
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

    // Save results to storage
    chrome.storage.local.get(['currentItemCount', 'results'], (data) => {
        const previousCount = data.currentItemCount || 0;
        const previousResults = data.results || [];
        const newCount = previousCount + results.length;
        const allResults = [...previousResults, ...results];

        chrome.storage.local.set({
            results: allResults,
            currentItemCount: newCount
        }, () => {
            // Check for next page
            if (hasNextPage() && isScrapingActive) {
                const nextUrl = getNextPageUrl();
                console.log(`[ProScan] Navigating to next page: ${nextUrl}`);

                // Delay to avoid rate limiting
                setTimeout(() => {
                    window.location.href = nextUrl;
                }, 2000);
            } else {
                finishScraping(newCount);
            }
        });
    });
}

// Finish scraping and notify popup
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

// Listen for messages from popup
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

// Initialize on page load
document.addEventListener('DOMContentLoaded', initialize);
window.addEventListener('load', initialize);
