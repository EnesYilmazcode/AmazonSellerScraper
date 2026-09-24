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
        // Real result cards; carousels and video widgets share the class above
        searchResult: '[data-component-type="s-search-result"]',

        // The title h2 sits inside the product link; a brand line is its own h2 before it
        titleLinked: 'a h2',
        titleRecipe: '[data-cy="title-recipe"] h2',
        title: 'h2 span',
        titleAlt: '.a-size-base-plus.a-color-base.a-text-normal',

        price: '.a-price[data-a-size="xl"] .a-offscreen',
        // a-text-price is a unit or strikethrough list price, never the buy price
        priceAlt: '.a-price:not(.a-text-price) .a-offscreen',
        secondaryOffer: '[data-cy="secondary-offer-recipe"]',

        rating: '[data-cy="reviews-ratings-slot"] .a-icon-alt',
        ratingAlt: '.a-icon-star-mini .a-icon-alt',
        ratingLegacy: '.a-icon-star-small .a-icon-alt',
        ratingText: '[data-cy="reviews-block"] span.a-size-base.a-color-secondary',

        // aria-label has the full number; display text may use K/M
        reviewCount: 'a[aria-label$="ratings"], a[aria-label$="rating"]',
        reviewCountAlt: '.a-size-mini.puis-normal-weight-text.s-underline-text',
        reviewCountLegacy: '.a-size-base.puis-normal-weight-text.s-underline-text',

        productLink: '.a-link-normal.s-no-outline',
        sponsored: '.puis-sponsored-label-text, .s-sponsored-label-text, [data-component-type="sp-sponsored-result"], a[href*="/sspa/"]',
        primeBadge: '.a-icon-prime, .s-prime',
        nextPage: '.s-pagination-next:not(.s-pagination-disabled)',
        nextPageLink: 'a.s-pagination-next[href]:not(.s-pagination-disabled)',
        nextPageDisabled: '.s-pagination-next.s-pagination-disabled',
        searchPage: '.s-main-slot, .s-search-results, [data-component-type="s-search-result"]',
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

    /** The product title, skipping a separate brand h2. Null if none. */
    function extractTitle(element) {
        const linked = element.querySelector(SEARCH_SELECTORS.titleLinked);
        const recipe = element.querySelectorAll(SEARCH_SELECTORS.titleRecipe);
        const el = linked || recipe[recipe.length - 1];
        const text = el ? el.innerText.trim() : '';
        return text || getText(element, SEARCH_SELECTORS.title, SEARCH_SELECTORS.titleAlt) || null;
    }

    /** Display price string such as "$19.99", or null. */
    function extractPrice(element) {
        const priceEl = element.querySelector(SEARCH_SELECTORS.price) ||
                        [...element.querySelectorAll(SEARCH_SELECTORS.priceAlt)]
                            .find(el => !el.closest(SEARCH_SELECTORS.secondaryOffer));

        if (priceEl) {
            const text = priceEl.innerText || priceEl.textContent;
            return text && text.trim() ? text.trim() : null;
        }
        return null;
    }

    /** "4.7 out of 5 stars" -> 4.7, or null. */
    function parseRatingText(text) {
        if (!text) return null;
        const match = text.match(/(\d+\.?\d*)/);
        return match ? parseFloat(match[1]) : null;
    }

    /** Rating from data-cy, star-mini, star-small, then plain text. Null if none. */
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

        return null;
    }

    /** "(108.3K)" -> 108300, "(1.2M)" -> 1200000, or null. */
    function parseReviewText(text) {
        if (!text) return null;
        const cleaned = text.replace(/[()]/g, '').trim();
        const match = cleaned.match(/^([\d,.]+)\s*([KMkm])?/);
        if (!match) return null;

        let num = parseFloat(match[1].replace(/,/g, ''));
        const suffix = (match[2] || '').toUpperCase();
        if (suffix === 'K') num *= 1000;
        if (suffix === 'M') num *= 1000000;
        return Math.round(num);
    }

    /** Review count from the aria-label, then the display text. Null if none. */
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

        return null;
    }

    function hasPrimeBadge(element) {
        return element.querySelector(SEARCH_SELECTORS.primeBadge) !== null;
    }

    /** True for a paid placement: the Sponsored label, an ad holder or an sspa ad link. */
    function isSponsored(element) {
        return element.classList.contains('AdHolder') ||
            element.querySelector(SEARCH_SELECTORS.sponsored) !== null;
    }

    /** The product page for an ASIN. Card links can be expiring sspa ad redirects. */
    function productUrl(asin) {
        return `https://www.amazon.com/dp/${asin}`;
    }

    /** One product record from a result card, or null without an ASIN. */
    function scrapeProduct(listing) {
        const asin = listing.dataset.asin;
        if (!asin) return null;

        const title = extractTitle(listing);
        const rawPrice = extractPrice(listing);
        // Only a dollar price counts; anything else keeps its currency and no amount.
        const priceCents = PriceLib.usdToCents(rawPrice);
        const price = priceCents === null ? null : rawPrice;
        const rating = extractRating(listing);
        const reviewCount = extractReviewCount(listing);
        const isPrime = hasPrimeBadge(listing);

        return {
            name: title,
            asin: asin,
            price: price,
            // Integer cents for sync and delta math; null when missing or not USD
            priceCents: priceCents,
            currency: PriceLib.currencyOf(rawPrice),
            rating: rating,
            reviewCount: reviewCount,
            isPrime: isPrime,
            sponsored: isSponsored(listing),
            url: productUrl(asin),
            scrapedAt: new Date().toISOString()
        };
    }

    /** Result count from the header ("1-48 of 523 results", "of over 10,000 results"), or 0. */
    function getTotalResults(doc) {
        const resultsEl = doc.querySelector(SEARCH_SELECTORS.resultsText);
        if (resultsEl) {
            const text = resultsEl.innerText;
            const match = text.match(/of (?:over )?(\d+[\d,]*) results/);
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

    /** True when the page has a Next button that is not disabled. */
    function hasNextPage(doc) {
        return !!doc.querySelector(SEARCH_SELECTORS.nextPage);
    }

    /**
     * The address of the next page: the Next link's own href when there is
     * one, the page number bumped by hand for an older span button, or null.
     */
    function nextPageHref(doc, url) {
        const link = doc.querySelector(SEARCH_SELECTORS.nextPageLink);
        if (link) return new URL(link.getAttribute('href'), url).href;
        return hasNextPage(doc) ? getNextPageUrl(url) : null;
    }

    /**
     * What kind of page this is when it has no result cards: a captcha, a
     * bot check, a sign-in wall, a search with nothing on it, or something
     * else (a product page, a broken layout).
     */
    function classifyPage(doc, url) {
        const path = url ? new URL(url).pathname : '';
        if (doc.querySelector('form[action*="validateCaptcha"], #captchacharacters')) return 'captcha';
        if (/robot check/i.test(doc.title || '')) return 'captcha';
        if (/^\/ap\/(signin|mfa|cvf)/.test(path) || doc.querySelector('form[name="signIn"], #ap_email, #ap_password')) return 'signin';
        const refresh = doc.querySelector('meta[http-equiv="refresh" i]');
        if (refresh || /bm-verify|_bm_|akamai/i.test(url || '')) return 'interstitial';
        if (path === '/s' || path.startsWith('/s/') || doc.querySelector(SEARCH_SELECTORS.searchPage)) return 'empty';
        return 'unknown';
    }

    /** Share of products with an ASIN, a title and a price. */
    function fillRates(products) {
        const n = products.length;
        const share = (ok) => (n ? products.filter(ok).length / n : 0);
        return {
            asin: share((p) => !!p.asin),
            title: share((p) => !!p.name),
            price: share((p) => p.priceCents !== null && p.priceCents !== undefined)
        };
    }

    /**
     * The search-result cards on a page. When the page marks its real results
     * with s-search-result, only those count; older layouts fall back to every
     * .s-result-item with an ASIN.
     */
    function resultCards(doc) {
        const all = [...doc.querySelectorAll(SEARCH_SELECTORS.productItem)];
        const main = all.filter(el => el.matches(SEARCH_SELECTORS.searchResult));
        return main.length ? main : all;
    }

    /**
     * One product per ASIN from the page's cards. Each product keeps every
     * placement ({position, sponsored, rank}), where rank counts organic
     * cards only. `sponsored` is true if any placement was an ad, and
     * `organicRank` is the rank of the first organic one, or null. The fields
     * come from the first organic card when there is one.
     */
    function dedupe(cards) {
        const products = [];
        const byAsin = new Map();
        let organic = 0;
        cards.forEach((card, i) => {
            const product = scrapeProduct(card);
            if (!product) return;
            const placement = {
                position: i + 1,
                sponsored: product.sponsored,
                rank: product.sponsored ? null : ++organic
            };
            const seen = byAsin.get(product.asin);
            if (!seen) {
                product.organicRank = placement.rank;
                product.placements = [placement];
                byAsin.set(product.asin, product);
                products.push(product);
                return;
            }
            seen.placements.push(placement);
            if (seen.organicRank === null && placement.rank !== null) {
                Object.assign(seen, product, {
                    sponsored: true,
                    organicRank: placement.rank,
                    placements: seen.placements
                });
            }
        });
        return products;
    }

    /**
     * Parses one search page.
     *
     * kind is 'results' when there is a next page, 'last' when there is not,
     * and otherwise what classifyPage says (empty, captcha, interstitial,
     * signin or unknown). nextHref follows the page's own Next link.
     * products holds each ASIN once; placements counts the cards.
     *
     * @param {Document} doc
     * @param {string} url - the page's address
     * @returns {{kind: string, products: Object[], placements: number, nextHref: string|null, total: number, fill: Object}}
     */
    function parseSearchPage(doc, url) {
        const cards = resultCards(doc);
        const total = getTotalResults(doc);
        if (cards.length === 0) {
            return { kind: classifyPage(doc, url), products: [], placements: 0, nextHref: null, total, fill: fillRates([]) };
        }

        const products = dedupe(cards);
        const nextHref = nextPageHref(doc, url);
        return {
            kind: nextHref ? 'results' : 'last',
            products,
            placements: products.reduce((n, p) => n + p.placements.length, 0),
            nextHref,
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
        extractTitle,
        extractPrice,
        parseRatingText,
        extractRating,
        parseReviewText,
        extractReviewCount,
        hasPrimeBadge,
        isSponsored,
        productUrl,
        scrapeProduct,
        getTotalResults,
        getNextPageUrl,
        hasNextPage,
        nextPageHref,
        classifyPage,
        resultCards,
        dedupe,
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
