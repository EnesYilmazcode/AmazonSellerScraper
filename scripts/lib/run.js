/**
 * @fileoverview The scrape run record and its state machine.
 *
 * One run at a time, bound to the tab it started in. The service worker is
 * the only writer: it keeps the live record in chrome.storage.session under
 * `run` and a durable copy in IndexedDB. The popup reads it to render, and
 * content scripts never see it.
 *
 * States: idle (no run), starting, running, stopping, and the ends stopped,
 * blocked, failed and done. `reason` says why a run ended; `END_STATE` maps
 * each reason to its end state.
 *
 * Loaded as a plain global (`Run`) in the popup, and as a CommonJS module
 * in Jest and the bundled service worker.
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
        selectors_broken: 'ProScan could not read this page. Amazon may have shown an error or changed its layout.',
        storage_full: 'Browser storage is full, so the run stopped. Download your results. Starting a new scan clears them.',
        interrupted: 'The run ended early because its tab was closed or left the search.',
        storage_error: 'ProScan could not save a page, so the run stopped.',
        updated: 'ProScan was updated during the run, so it stopped. The products found before the update are kept.'
    };

    /** The state each end reason leaves a run in. */
    const END_STATE = {
        complete: 'done',
        stopped: 'stopped',
        blocked: 'blocked',
        selectors_broken: 'failed',
        storage_full: 'failed',
        storage_error: 'failed',
        interrupted: 'failed',
        updated: 'failed'
    };

    const STATES = ['idle', 'starting', 'running', 'stopping', 'stopped', 'blocked', 'failed', 'done'];
    const ENDS = ['stopped', 'blocked', 'failed', 'done'];
    const LIVE = ['starting', 'running', 'stopping'];

    /** Where each state may go. An ended run is never reopened; a new run is a new record. */
    const TRANSITIONS = {
        idle: ['starting'],
        starting: ['running', 'stopping', ...ENDS],
        running: ['stopping', ...ENDS],
        stopping: ENDS,
        stopped: [],
        blocked: [],
        failed: [],
        done: []
    };

    /** Page kinds a run can start on. */
    const STARTABLE = ['results', 'last'];

    function clampMaxPages(n) {
        const v = Number(n);
        return Number.isInteger(v) && v > 0 ? Math.min(v, MAX_PAGES_LIMIT) : DEFAULT_MAX_PAGES;
    }

    function create({ runId, tabId, maxPages, source = null, now = Date.now() }) {
        return {
            runId,
            tabId,
            state: 'starting',
            reason: null,
            source,
            page: 0,
            itemCount: 0,
            maxPages: clampMaxPages(maxPages),
            startedAt: now,
            heartbeat: now,
            finishedAt: null,
            lastUrl: null,
            nextHref: null,
            navAt: null,
            awaiting: false
        };
    }

    /** The state of `run`, or idle when there is none. */
    function stateOf(run) {
        return run && STATES.includes(run.state) ? run.state : 'idle';
    }

    function canTransition(from, to) {
        return (TRANSITIONS[from] || []).includes(to);
    }

    /** `run` moved to state `to` with `patch` applied. Throws on a move the machine does not allow. */
    function transition(run, to, patch = {}) {
        const from = stateOf(run);
        if (!canTransition(from, to)) throw new Error(`run cannot go from ${from} to ${to}`);
        return { ...run, ...patch, state: to };
    }

    function isActive(run) {
        return LIVE.includes(stateOf(run));
    }

    function isEnded(run) {
        return ENDS.includes(stateOf(run));
    }

    function isStale(run, now = Date.now()) {
        return isActive(run) && now - (run.heartbeat || 0) > STALE_MS;
    }

    /** True when `tabId` is the tab this live run belongs to. */
    function owns(run, tabId) {
        return isActive(run) && typeof tabId === 'number' && run.tabId === tabId;
    }

    // Query params that name a search page. Amazon rewrites the others
    // (qid, ref, crid, ...) on the way, so they are not compared.
    const PAGE_PARAMS = ['k', 'page', 'me', 'rh', 'i', 'node', 'srs', 'field-keywords'];

    /** True when `a` and `b` are the same search page, ignoring tracking params. */
    function samePage(a, b) {
        let x;
        let y;
        try {
            x = new URL(a);
            y = new URL(b);
        } catch (e) {
            return false;
        }
        const path = (u) => u.pathname.replace(/\/ref=[^/]*$/, '').replace(/\/$/, '');
        if (x.hostname !== y.hostname || path(x) !== path(y)) return false;
        const param = (u, p) => u.searchParams.get(p) || (p === 'page' ? '1' : '');
        return PAGE_PARAMS.every((p) => param(x, p) === param(y, p));
    }

    /** True when `href` is the page the run navigated to next. */
    function expects(run, href) {
        return isActive(run) && !!run.nextHref && samePage(run.nextHref, href);
    }

    /** `run` ended for `reason`. */
    function finish(run, reason, now = Date.now()) {
        const to = END_STATE[reason] || 'failed';
        return transition(run, to, { reason, finishedAt: now, nextHref: null, navAt: null, awaiting: false });
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
                // Every page after the first was reached through a Next
                // link, so "no results" there is not a real end.
                return pageNumber > 1 ? 'selectors_broken' : 'complete';
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

    /** What a search URL scans: a storefront (me=) or a keyword (k=). */
    function sourceOf(url, now = Date.now()) {
        let type = 'keyword';
        let sellerId = null;
        let keyword = null;
        try {
            const u = new URL(url);
            const me = u.searchParams.get('me');
            const k = u.searchParams.get('k');
            if (me) { type = 'storefront'; sellerId = me; } else if (k) keyword = k;
        } catch (e) { /* not a URL */ }
        return { type, sellerId, keyword, url: url || null, startedAt: new Date(now).toISOString() };
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
            case 'unreadable':
                return 'ProScan could not read the results on this page. Reload it, then start again.';
            default:
                return 'Open an Amazon search or storefront page, then start.';
        }
    }

    /** The status line for a run: {text, type}. */
    function describe(run, count) {
        if (!run) return null;
        if (isActive(run)) return { text: 'Scraping in progress... ' + count + ' items', type: 'info' };
        const text = (MESSAGES[run.reason] || 'Scraping ended.') + ' ' + count + ' products found.';
        return { text, type: run.reason === 'complete' ? 'success' : 'warning' };
    }

    return {
        KEY,
        DEFAULT_MAX_PAGES,
        STALE_MS,
        MESSAGES,
        END_STATE,
        STATES,
        STARTABLE,
        clampMaxPages,
        create,
        stateOf,
        canTransition,
        transition,
        isActive,
        isEnded,
        isStale,
        owns,
        samePage,
        expects,
        finish,
        outcome,
        pageDelay,
        sourceOf,
        refusal,
        describe
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Run;
}
