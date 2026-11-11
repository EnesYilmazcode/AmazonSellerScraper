/**
 * @fileoverview What kind of Amazon page a URL is, for the on-page dock.
 *
 * The dock offers Scrape only where a run can start (search results and
 * seller storefronts) and points seller pages at their storefront. It never
 * offers anything on product, cart, checkout, sign-in or account pages.
 *
 * Kinds:
 * - search: /s with a keyword or a category
 * - storefront: /s?me=SELLER, the seller's product list
 * - seller: /sp?seller=SELLER, the seller profile; its storefront is /s?me=SELLER
 * - store: /stores/..., a brand store; a run cannot start there
 * - never: product, cart, checkout, sign-in, account and order pages
 * - other: any other Amazon page
 *
 * Loaded as a plain global (`PageKind`) in content scripts and the popup,
 * and as a CommonJS module in Jest.
 *
 * @module PageKind
 */

const PageKind = (() => {
    // Paths where the dock must stay quiet, whatever the query says.
    const NEVER = [
        /\/dp\//i,
        /^\/gp\/product\//i,
        /^\/gp\/aw\/d\//i,
        /^\/gp\/offer-listing\//i,
        /^\/gp\/aod\//i,
        /^\/gp\/cart\//i,
        /^\/cart(\/|$)/i,
        /^\/gp\/buy\//i,
        /^\/checkout(\/|$)/i,
        /^\/gp\/checkout/i,
        /^\/ap\//i,
        /^\/ax\//i,
        /^\/gp\/css\//i,
        /^\/gp\/your-account/i,
        /^\/your-account/i,
        /^\/your-orders/i,
        /^\/gp\/yourstore/i,
        /^\/hz\//i,
        /^\/a\/addresses/i,
        /^\/cpe\/yourpayments/i,
        /^\/mn\/dcw\/myx/i
    ];

    // Of those, where the dock stays off the page entirely: money, sign-in
    // and account pages. Product pages keep the plain launcher for Ask.
    const HIDDEN = [
        /^\/gp\/cart\//i,
        /^\/cart(\/|$)/i,
        /^\/gp\/buy\//i,
        /^\/checkout(\/|$)/i,
        /^\/gp\/checkout/i,
        /^\/ap\//i,
        /^\/ax\//i,
        /^\/gp\/css\//i,
        /^\/gp\/your-account/i,
        /^\/your-account/i,
        /^\/your-orders/i,
        /^\/a\/addresses/i,
        /^\/cpe\/yourpayments/i,
        /^\/mn\/dcw\/myx/i
    ];

    const SELLER_ID = /^[A-Z0-9]{8,20}$/i;

    function parse(url) {
        try {
            const u = new URL(url);
            return /(^|\.)amazon\.com$/i.test(u.hostname) ? u : null;
        } catch (e) {
            return null;
        }
    }

    /** A seller id from a query value, or null when it does not look like one. */
    function sellerId(value) {
        const v = String(value || '').trim();
        return SELLER_ID.test(v) ? v.toUpperCase() : null;
    }

    /** The storefront URL for a seller id. */
    function storefrontUrl(id) {
        return `https://www.amazon.com/s?me=${encodeURIComponent(id)}&marketplaceID=ATVPDKIKX0DER`;
    }

    /**
     * @param {string} url
     * @returns {{kind: string, sellerId: ?string, keyword: ?string}}
     */
    function classify(url) {
        const u = parse(url);
        const out = { kind: 'other', sellerId: null, keyword: null };
        if (!u) return { ...out, kind: 'never' };
        const path = u.pathname;
        if (NEVER.some((re) => re.test(path))) return { ...out, kind: 'never' };

        if (path === '/s' || path.startsWith('/s/')) {
            const me = sellerId(u.searchParams.get('me'));
            if (me) return { ...out, kind: 'storefront', sellerId: me };
            const k = u.searchParams.get('k') || u.searchParams.get('field-keywords');
            if (k || u.searchParams.get('rh') || u.searchParams.get('i') || u.searchParams.get('node')) {
                return { ...out, kind: 'search', keyword: k ? k.trim() : null };
            }
            return out;
        }
        if (path === '/sp' || path.startsWith('/sp/')) {
            const id = sellerId(u.searchParams.get('seller'));
            return id ? { ...out, kind: 'seller', sellerId: id } : out;
        }
        if (path.startsWith('/stores/')) {
            return { ...out, kind: 'store', sellerId: sellerId(u.searchParams.get('seller') || u.searchParams.get('me')) };
        }
        return out;
    }

    /** True where the dock may suggest something: a scrape, or the way to one. */
    function suggests(url) {
        return ['search', 'storefront', 'seller', 'store'].includes(classify(url).kind);
    }

    /** True where a run can start from the page itself. */
    function scrapable(url) {
        return ['search', 'storefront'].includes(classify(url).kind);
    }

    /** True where the dock should not appear at all. */
    function hidden(url) {
        const u = parse(url);
        return !u || HIDDEN.some((re) => re.test(u.pathname));
    }

    return { classify, suggests, scrapable, hidden, storefrontUrl, sellerId };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = PageKind;
}
