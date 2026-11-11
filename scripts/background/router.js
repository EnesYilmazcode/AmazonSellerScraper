/**
 * @fileoverview The service worker's one message router.
 *
 * Handlers are registered by message type from scripts/lib/messages.js and
 * may return a value or a promise. The router answers with what the handler
 * returns, or {error} when it throws. A message meant for someone else, an
 * unknown type or a sender of the wrong kind is not answered, and the
 * channel is not held open for it.
 *
 * @module Router
 */

const Msg = require('../lib/messages.js');

function createRouter({ extensionId = null, log = console } = {}) {
    const handlers = new Map();

    function on(type, handler) {
        if (!Msg.CATALOG[type] || Msg.CATALOG[type].to !== 'worker') {
            throw new Error(`not a worker message: ${type}`);
        }
        if (handlers.has(type)) throw new Error(`handler already set for ${type}`);
        handlers.set(type, handler);
        return api;
    }

    /** The chrome.runtime.onMessage listener. */
    function listener(message, sender, sendResponse) {
        const entry = Msg.spec(message);
        const handler = entry && handlers.get(message.type);
        if (!handler) return false;
        if (!Msg.senderAllowed(entry, sender, extensionId)) {
            log.warn('[ProScan] Refused', message.type, 'from the wrong sender');
            return false;
        }
        let result;
        try {
            result = handler(message, sender);
        } catch (err) {
            sendResponse({ error: (err && err.message) || String(err) });
            return false;
        }
        if (!result || typeof result.then !== 'function') {
            sendResponse(result === undefined ? { ok: true } : result);
            return false;
        }
        result.then(
            (value) => sendResponse(value === undefined ? { ok: true } : value),
            (err) => {
                log.error('[ProScan]', message.type, 'failed:', err && err.message);
                sendResponse({ error: (err && err.message) || String(err) });
            }
        );
        return true;
    }

    const api = { on, listener, handles: (type) => handlers.has(type) };
    return api;
}

module.exports = { createRouter };
