/**
 * @fileoverview The scrape run record.
 *
 * One run at a time, bound to the tab it started in. It is kept in
 * chrome.storage.local under `run` so the popup, the service worker and the
 * content script all see the same thing. The popup starts and stops it, the
 * content script in that tab moves it page by page and ends it with a
 * reason, and the service worker ends it if the tab goes away.
 *
 * Loaded as a plain global (`Run`) in the popup and content scripts, and as
 * a CommonJS module in Jest and the bundled service worker.
 *
 * @module Run
 */

const Run = (() => {
    const KEY = 'run';
    const DEFAULT_MAX_PAGES = 20;
    const MAX_PAGES_LIMIT = 400;

    // A running run whose tab has not checked in for this long is dead.
    const STALE_MS = 60 * 1000;

    /** How a run can end. Anything but complete is shown as a warning. */
    const MESSAGES = {
        complete: 'Scraping complete!',
        stopped: 'Scraping stopped.',
        blocked: 'Amazon showed a captcha or a sign-in page, so the run stopped. Solve it in the tab, then start again.',
        selectors_broken: 'ProScan could not read this page. Amazon may have changed its layout.',
        storage_full: 'Browser storage is full, so the run stopped. Download your results, then clear them.',
        interrupted: 'The run ended early because its tab was closed or left the search.',
        updated: 'ProScan was updated during the run, so it stopped. The products found before the update are kept.'
    };

    /** Page kinds a run can start on. */
    const STARTABLE = ['results', 'last'];

    function clampMaxPages(n) {
        const v = Number(n);
        return Number.isInteger(v) && v > 0 ? Math.min(v, MAX_PAGES_LIMIT) : DEFAULT_MAX_PAGES;
    }

    function create({ runId, tabId, maxPages, now = Date.now() }) {
        return {
            runId,
            tabId,
            status: 'running',
            page: 0,
            maxPages: clampMaxPages(maxPages),
            startedAt: now,
            heartbeat: now,
            finishedAt: null,
            lastUrl: null,
            nextHref: null
        };
    }

    function isActive(run) {
        return !!run && run.status === 'running';
    }

    function isStale(run, now = Date.now()) {
        return isActive(run) && now - (run.heartbeat || 0) > STALE_MS;
    }

    /** True when `tabId` is the tab this running run belongs to. */
    function owns(run, tabId) {
        return isActive(run) && typeof tabId === 'number' && run.tabId === tabId;
    }

    function finish(run, status, now = Date.now()) {
        return { ...run, status, finishedAt: now, nextHref: null };
    }

    /**
     * How a parsed page ends the run, or null when the run goes on.
     *
     * @param {{kind: string, products: Object[], nextHref: ?string, fill: Object}} page
     * @param {number} pageNumber - 1-based number of this page in the run
     * @param {number} maxPages
     */
    function outcome(page, pageNumber, maxPages) {
        switch (page.kind) {
            case 'captcha':
            case 'interstitial':
            case 'signin':
                return 'blocked';
            case 'unknown':
                return 'interrupted';
            case 'empty':
                return 'complete';
            case 'last':
            case 'results':
                break;
            default:
                return 'selectors_broken';
        }
        // Result cards were found, so none parsing means the selectors broke.
        if (page.products.length === 0) return 'selectors_broken';
        if (page.fill && page.fill.title < 0.5 && page.fill.price < 0.5) return 'selectors_broken';
        if (page.kind === 'last' || !page.nextHref || pageNumber >= maxPages) return 'complete';
        return null;
    }

    /** Wait before the next page: 2 to 4 seconds. */
    function pageDelay(rand = Math.random()) {
        return 2000 + Math.floor(rand * 2000);
    }

    /** What to tell the user about a page the run cannot start on. */
    function refusal(kind) {
        switch (kind) {
            case 'captcha':
            case 'interstitial':
                return 'Amazon is showing a captcha or a bot check on this tab. Solve it, then start again.';
            case 'signin':
                return 'This tab is on an Amazon sign-in page. Sign in, open a search, then start again.';
            case 'empty':
                return 'This search has no results to scrape.';
            default:
                return 'Open an Amazon search or storefront page, then start.';
        }
    }

    /** The status line for a run: {text, type}. */
    function describe(run, count) {
        if (!run) return null;
        if (isActive(run)) return { text: 'Scraping in progress... ' + count + ' items', type: 'info' };
        const text = (MESSAGES[run.status] || 'Scraping ended.') + ' ' + count + ' products found.';
        return { text, type: run.status === 'complete' ? 'success' : 'warning' };
    }

    return {
        KEY,
        DEFAULT_MAX_PAGES,
        STALE_MS,
        MESSAGES,
        STARTABLE,
        clampMaxPages,
        create,
        isActive,
        isStale,
        owns,
        finish,
        outcome,
        pageDelay,
        refusal,
        describe
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Run;
}
