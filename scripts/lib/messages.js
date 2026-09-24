/**
 * @fileoverview Every message the extension sends, in one place.
 *
 * `to` says who handles a message: the service worker ('worker'), the
 * content script in a tab ('tab'), or any open popup ('popup'). `from` says
 * who may send a worker message: 'tab' (a content script, so sender.tab is
 * set), 'page' (an extension page such as the popup), or 'any'. The worker
 * router refuses a message from the wrong kind of sender.
 *
 * Loaded as a plain global (`Msg`) in the popup and content scripts, and as
 * a CommonJS module in Jest and the bundled service worker.
 *
 * @module Msg
 */

const Msg = (() => {
    const CATALOG = {
        // Popup -> worker: the run
        START_RUN: { to: 'worker', from: 'page' },
        STOP_RUN: { to: 'worker', from: 'page' },
        GET_STATE: { to: 'worker', from: 'page' },

        // Content script -> worker: the run
        PAGE_READY: { to: 'worker', from: 'tab' },
        PAGE_RESULT: { to: 'worker', from: 'tab' },
        HEARTBEAT: { to: 'worker', from: 'tab' },

        // Spread analysis in the tab
        GET_RESULTS: { to: 'worker', from: 'any' },
        SPREAD_RESULT: { to: 'worker', from: 'tab' },

        // Chat
        CHAT_STATUS: { to: 'worker', from: 'any' },
        CHAT_MESSAGE: { to: 'worker', from: 'tab' },

        // Cloud account and export
        PROSCAN_AUTH_STATE: { to: 'worker', from: 'page' },
        PROSCAN_SIGN_IN: { to: 'worker', from: 'page' },
        PROSCAN_SIGN_OUT: { to: 'worker', from: 'page' },
        PROSCAN_EXPORT: { to: 'worker', from: 'page' },

        // Worker or popup -> content script
        PING: { to: 'tab' },
        PARSE_PAGE: { to: 'tab' },
        RUN_ENDED: { to: 'tab' },
        START_SPREAD_ANALYSIS: { to: 'tab' },
        STOP_SPREAD_ANALYSIS: { to: 'tab' },

        // Content script -> popup
        SPREAD_PROGRESS: { to: 'popup' },
        SPREAD_ANALYSIS_COMPLETE: { to: 'popup' }
    };

    const T = Object.freeze(Object.fromEntries(Object.keys(CATALOG).map(k => [k, k])));

    /** The catalog entry for a message, or null for an unknown or malformed one. */
    function spec(message) {
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') return null;
        return Object.prototype.hasOwnProperty.call(CATALOG, message.type) ? CATALOG[message.type] : null;
    }

    /**
     * Whether `sender` may send a worker message with this spec. A content
     * script sender always has a tab; an extension page never does.
     */
    function senderAllowed(entry, sender, extensionId) {
        if (!entry || entry.to !== 'worker') return false;
        const fromTab = !!(sender && sender.tab && typeof sender.tab.id === 'number');
        const ours = !sender || !sender.id || !extensionId || sender.id === extensionId;
        if (!ours) return false;
        if (entry.from === 'tab') return fromTab;
        if (entry.from === 'page') return !fromTab;
        return true;
    }

    return { T, CATALOG, spec, senderAllowed };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Msg;
}
