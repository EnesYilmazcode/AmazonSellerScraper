/**
 * @fileoverview Pure page parsing for search results and seller offers.
 *
 * Everything here takes a Document, an element or a string and returns data.
 * Nothing reads storage, sends messages or navigates. It is loaded as a plain
 * global (`Parsers`) after price.js in the content scripts and the popup, and
 * as a CommonJS module in Jest and Node.
 *
 * The logic was moved here unchanged from scraper.js, offer-fetcher.js and
 * analyzer.js, known bugs included. The golden tests in tests/golden mark
 * each of those with its finding id.
 *
 * @module Parsers
 */

const Parsers = (() => {
    const PriceLib = typeof Price !== 'undefined' ? Price : require('../modules/price.js');

    /** Amazon search page selectors, primary then fallback. */
    const SEARCH_SELECTORS = {
        // Filtered to exclude empty ASINs (ad placeholders)
        productItem: '.s-result-item[data-asin]:not([data-asin=""])',

        title: 'h2 span',
        titleAlt: '.a-size-base-plus.a-color-base.a-text-normal',

        price: '.a-price[data-a-size="xl"] .a-offscreen',
        priceAlt: '.a-price .a-offscreen',

        rating: '[data-cy="reviews-ratings-slot"] .a-icon-alt',
        ratingAlt: '.a-icon-star-mini .a-icon-alt',
        ratingLegacy: '.a-icon-star-small .a-icon-alt',
        ratingText: '[data-cy="reviews-block"] span.a-size-base.a-color-secondary',

        // aria-label has the full number; display text may use K/M
        reviewCount: 'a[aria-label$="ratings"]',
        reviewCountAlt: '.a-size-mini.puis-normal-weight-text.s-underline-text',
        reviewCountLegacy: '.a-size-base.puis-normal-weight-text.s-underline-text',

        productLink: '.a-link-normal.s-no-outline',
        primeBadge: '.a-icon-prime, .s-prime',
        nextPageDisabled: '.s-pagination-next.s-pagination-disabled',
        resultsText: 'h2.a-size-base.a-spacing-small.a-spacing-top-small span',
        resultsToolbar: '.s-desktop-toolbar .a-spacing-small span'
    };

    /** Offer listing selectors, tried in order. */
    const OFFER_SELECTORS = {
        // AOD (All Offers Display) format
        aodPriceBlock: '.aod-information-block .a-price .a-offscreen',
        // Classic offer listing page
        offerListPrice: '#olpOfferList .a-price .a-offscreen',
        // Legacy offer listing
        legacyOfferPrice: '.olpOfferPrice',
        // Scoped to offer containers. The global '.a-price .a-offscreen' would
        // pick up buy-box, sponsored and accessory prices as fake offers.
        generalPrice: '#aod-offer-list .a-price .a-offscreen, [id^="aod-offer"] .a-price .a-offscreen, .olpOffer .a-price .a-offscreen'
    };

    // ── Search results ──────────────────────────────────────────

    /** Trimmed innerText of the first match, or null. */
    function getText(element, selector, fallbackSelector = null) {
        let el = element.querySelector(selector);
        if (!el && fallbackSelector) {
            el = element.querySelector(fallbackSelector);
        }
        return el ? el.innerText.trim() : null;
    }

    /** Display price string such as "$19.99", or "N/A". */
    function extractPrice(element) {
        const priceEl = element.querySelector(SEARCH_SELECTORS.price) ||
                        element.querySelector(SEARCH_SELECTORS.priceAlt);

        if (priceEl) {
            const text = priceEl.innerText || priceEl.textContent;
            return text ? text.trim() : 'N/A';
        }
        return 'N/A';
    }

    /** "4.7 out of 5 stars" -> 4.7, or 0. */
    function parseRatingText(text) {
        if (!text) return 0;
        const match = text.match(/(\d+\.?\d*)/);
        return match ? parseFloat(match[1]) : 0;
    }

    /** Rating from data-cy, star-mini, star-small, then plain text. 0 if none. */
    function extractRating(element) {
        const dataCy = element.querySelector(SEARCH_SELECTORS.rating);
        if (dataCy) {
            const val = parseRatingText(dataCy.textContent);
            if (val > 0) return val;
        }

        const starMini = element.querySelector(SEARCH_SELECTORS.ratingAlt);
        if (starMini) {
            const val = parseRatingText(starMini.textContent);
            if (val > 0) return val;
        }

        const starSmall = element.querySelector(SEARCH_SELECTORS.ratingLegacy);
        if (starSmall) {
            const val = parseRatingText(starSmall.textContent);
            if (val > 0) return val;
        }

        const ratingSpan = element.querySelector(SEARCH_SELECTORS.ratingText);
        if (ratingSpan) {
            const val = parseRatingText(ratingSpan.textContent);
            if (val > 0 && val <= 5) return val;
        }

        return 0;
    }

    /** "(108.3K)" -> 108300, "(1.2M)" -> 1200000, or 0. */
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

    /** Review count from the aria-label, then the display text. 0 if none. */
    function extractReviewCount(element) {
        const ariaLink = element.querySelector(SEARCH_SELECTORS.reviewCount);
        if (ariaLink) {
            const label = ariaLink.getAttribute('aria-label');
            if (label) {
                const cleaned = label.replace(/[^0-9]/g, '');
                const count = parseInt(cleaned);
                if (count > 0) return count;
            }
        }

        const miniEl = element.querySelector(SEARCH_SELECTORS.reviewCountAlt);
        if (miniEl) {
            const count = parseReviewText(miniEl.textContent);
            if (count > 0) return count;
        }

        const baseEl = element.querySelector(SEARCH_SELECTORS.reviewCountLegacy);
        if (baseEl) {
            const count = parseReviewText(baseEl.textContent);
            if (count > 0) return count;
        }

        return 0;
    }

    function hasPrimeBadge(element) {
        return element.querySelector(SEARCH_SELECTORS.primeBadge) !== null;
    }

    /** One product record from a result card, or null without an ASIN. */
    function scrapeProduct(listing) {
        const asin = listing.dataset.asin;
        if (!asin) return null;

        const title = getText(listing, SEARCH_SELECTORS.title, SEARCH_SELECTORS.titleAlt) || 'N/A';
        const price = extractPrice(listing);
        const rating = extractRating(listing);
        const reviewCount = extractReviewCount(listing);
        const isPrime = hasPrimeBadge(listing);

        const linkEl = listing.querySelector(SEARCH_SELECTORS.productLink);
        const productUrl = linkEl
            ? `https://www.amazon.com${linkEl.getAttribute('href')}`
            : 'N/A';

        return {
            name: title,
            asin: asin,
            price: price,
            // Integer cents for sync and delta math; null when unparseable
            priceCents: PriceLib.priceToCents(price),
            rating: rating,
            reviewCount: reviewCount,
            isPrime: isPrime,
            url: productUrl,
            scrapedAt: new Date().toISOString()
        };
    }

    /** Result count from the header ("1-48 of 523 results"), or 0. */
    function getTotalResults(doc) {
        const resultsEl = doc.querySelector(SEARCH_SELECTORS.resultsText);
        if (resultsEl) {
            const text = resultsEl.innerText;
            const match = text.match(/of (\d+[\d,]*) results/);
            if (match) {
                return parseInt(match[1].replace(/,/g, ''));
            }
        }
        return 0;
    }

    /** The current URL with page incremented and ref set to sr_pg_N. */
    function getNextPageUrl(href) {
        const currentUrl = new URL(href);
        const currentPage = parseInt(currentUrl.searchParams.get('page')) || 1;
        const nextPage = currentPage + 1;

        currentUrl.searchParams.set('page', nextPage);
        currentUrl.searchParams.set('ref', `sr_pg_${nextPage}`);

        return currentUrl.toString();
    }

    /** False only when a disabled Next button is present. */
    function hasNextPage(doc) {
        return !doc.querySelector(SEARCH_SELECTORS.nextPageDisabled);
    }

    /** Share of products with an ASIN, a title and a price. */
    function fillRates(products) {
        const n = products.length;
        const share = (ok) => (n ? products.filter(ok).length / n : 0);
        return {
            asin: share((p) => !!p.asin),
            title: share((p) => !!p.name && p.name !== 'N/A'),
            price: share((p) => p.priceCents !== null && p.priceCents !== undefined)
        };
    }

    /**
     * Parses one search page the way the scraper does today.
     *
     * kind is 'empty' when no result card matched, 'last' when the Next
     * button is disabled, else 'results'. nextHref is the hand-built next URL.
     *
     * @param {Document} doc
     * @param {string} url - the page's address
     * @returns {{kind: string, products: Object[], nextHref: string|null, total: number, fill: Object}}
     */
    function parseSearchPage(doc, url) {
        const listings = doc.querySelectorAll(SEARCH_SELECTORS.productItem);
        const total = getTotalResults(doc);
        if (listings.length === 0) {
            return { kind: 'empty', products: [], nextHref: null, total, fill: fillRates([]) };
        }

        const products = [];
        listings.forEach(listing => {
            const product = scrapeProduct(listing);
            if (product) products.push(product);
        });

        const more = hasNextPage(doc);
        return {
            kind: more ? 'results' : 'last',
            products,
            nextHref: more ? getNextPageUrl(url) : null,
            total,
            fill: fillRates(products)
        };
    }

    // ── Offers ──────────────────────────────────────────────────

    function buildOfferUrl(asin) {
        return `https://www.amazon.com/gp/offer-listing/${asin}/ref=dp_olp_all_mbc?ie=UTF8&condition=new`;
    }

    function buildAodUrl(asin) {
        return `https://www.amazon.com/gp/aod/ajax?asin=${asin}&condition=new&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp`;
    }

    /** Offer price text -> dollars, or 0. Keeps every digit and dot (F-38). */
    function parseOfferPrice(text) {
        if (!text) return 0;
        const cleaned = text.replace(/[^0-9.]/g, '');
        const price = parseFloat(cleaned);
        return isNaN(price) ? 0 : price;
    }

    /**
     * Seller prices in dollars from an offer page, from the first selector
     * that yields any. Not deduped: sellers often share a price.
     */
    function extractPricesFromDocument(doc) {
        const prices = [];
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
                if (prices.length > 0) break;
            }
        }
        return prices;
    }

    // ── Analyzer coercions ──────────────────────────────────────

    /** Analyzer's price coercion: dollars, or 0. */
    function toDollars(priceStr) {
        if (!priceStr || priceStr === 'N/A') return 0;
        return parseFloat(String(priceStr).replace(/[^0-9.]/g, '')) || 0;
    }

    function toRating(rating) {
        if (!rating || rating === 'N/A') return 0;
        return parseFloat(rating) || 0;
    }

    function toReviewCount(count) {
        if (!count) return 0;
        return parseInt(String(count).replace(/[^0-9]/g, '')) || 0;
    }

    return {
        SEARCH_SELECTORS,
        OFFER_SELECTORS,
        priceToCents: (input) => PriceLib.priceToCents(input),
        getText,
        extractPrice,
        parseRatingText,
        extractRating,
        parseReviewText,
        extractReviewCount,
        hasPrimeBadge,
        scrapeProduct,
        getTotalResults,
        getNextPageUrl,
        hasNextPage,
        fillRates,
        parseSearchPage,
        buildOfferUrl,
        buildAodUrl,
        parseOfferPrice,
        extractPricesFromDocument,
        toDollars,
        toRating,
        toReviewCount
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Parsers;
}
