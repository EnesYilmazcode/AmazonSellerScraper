import { auth, db } from './firebase-init.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth/web-extension';
import { syncToCloud } from './sync.js';
import Chat from '../lib/chat.js';

/**
 * @fileoverview Background Service Worker
 *
 * Central message router for the ProScan extension. Handles:
 * - Message routing between popup, content scripts, and external APIs
 * - Gemini calls for the AI chatbot (see scripts/lib/chat.js)
 * - Extension lifecycle events (install, update, startup)
 *
 * Runs as a Manifest V3 service worker -- no persistent background page.
 * Wakes on message events and API calls, then goes idle.
 *
 * @module ServiceWorker
 */

const chatDeps = {
    getStorage: (keys) => chrome.storage.local.get(keys),
    fetchFn: (url, init) => fetch(url, init),
};

/**
 * Main message listener -- routes messages between extension components.
 *
 * Message types handled:
 * - STOP_SCRAPING: Forwarded from popup to the active tab's content script
 * - SCRAPING_COMPLETE: Logs scrape completion
 * - CHAT_STATUS: Whether a Gemini key is set, and which run the chat covers
 * - CHAT_MESSAGE: Answers a question about the current run with Gemini
 *
 * The chat handlers read the key and the run from storage here, so the key
 * never passes through the content script.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Route STOP_SCRAPING from popup to content script
    if (request.type === 'STOP_SCRAPING' && sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'STOP_SCRAPING' });
    }

    // Log scrape completion
    if (request.type === 'SCRAPING_COMPLETE') {
        console.log('[ProScan] Scraping completed:', request.itemCount, 'items');
    }

    if (request.type === 'CHAT_STATUS') {
        Chat.status(chatDeps).then(sendResponse, () => sendResponse({ hasKey: false, productCount: 0 }));
        return true;
    }

    if (request.type === 'CHAT_MESSAGE') {
        Chat.answerQuestion({ question: request.question, history: request.history }, chatDeps)
            .then(sendResponse, (err) => sendResponse({ error: 'Chat failed: ' + err.message }));
        return true; // keep channel open for async response
    }

    return true;
});

/**
 * Handle extension installation and update events.
 * On fresh install, initializes chrome.storage with default values.
 * On update, logs the new version number.
 */
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('[ProScan] Extension installed');

        // Initialize storage with defaults
        chrome.storage.local.set({
            results: [],
            currentItemCount: 0,
            isScrapingActive: false,
            settings: {
                pageDelay: 2000,
                maxPages: 100
            }
        });
    } else if (details.reason === 'update') {
        console.log('[ProScan] Extension updated to version', chrome.runtime.getManifest().version);
    }
});

/**
 * Clean up on browser startup.
 * Resets the scraping flag in case the browser was closed mid-scrape.
 */
chrome.runtime.onStartup.addListener(() => {
    chrome.storage.local.set({
        isScrapingActive: false
    });
});

// ════════════════════════════════════════════════════════════════════════════
// M3 cloud sync — Firebase Auth (extension-native) + Firestore write path.
// The popup is a plain (unbundled) page; it drives sign-in / export by sending
// these messages to the worker, which owns the single Firebase instance.
// ════════════════════════════════════════════════════════════════════════════

/** Resolve the current Firebase user, waiting for auth to rehydrate from
 *  IndexedDB after a cold service-worker start. */
function currentUser() {
    return new Promise((resolve) => {
        if (auth.currentUser) return resolve(auth.currentUser);
        const unsub = onAuthStateChanged(auth, (u) => {
            unsub();
            resolve(u);
        });
    });
}

/** Trim a Firebase user to the popup-safe shape. */
const publicUser = (u) =>
    u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null;

/** Map Firebase auth error codes to friendly popup messages. */
function friendlyAuthError(err) {
    switch (err && err.code) {
        case 'auth/invalid-credential':
        case 'auth/wrong-password':
        case 'auth/user-not-found':
            return 'Email or password is incorrect.';
        case 'auth/invalid-email':
            return 'That email address does not look valid.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Wait a minute and try again.';
        case 'auth/network-request-failed':
            return 'Network error — check your connection.';
        case 'auth/operation-not-allowed':
            return 'Email sign-in is not enabled for this project yet.';
        default:
            return ((err && err.message) || 'Sign-in failed.').replace(/^Firebase:\s*/, '');
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'PROSCAN_AUTH_STATE') {
        currentUser().then((u) => sendResponse({ user: publicUser(u) }));
        return true;
    }

    if (request.type === 'PROSCAN_SIGN_IN') {
        signInWithEmailAndPassword(auth, request.email, request.password)
            .then((cred) => sendResponse({ user: publicUser(cred.user) }))
            .catch((err) => sendResponse({ error: friendlyAuthError(err) }));
        return true;
    }

    if (request.type === 'PROSCAN_SIGN_OUT') {
        signOut(auth)
            .then(() => sendResponse({ ok: true }))
            .catch((err) => sendResponse({ error: err.message }));
        return true;
    }

    if (request.type === 'PROSCAN_EXPORT') {
        (async () => {
            const user = await currentUser();
            if (!user) return sendResponse({ error: 'Sign in to ProScan first.' });
            const bundle = await chrome.storage.local.get([
                'syncQueue',
                'scrapeRunMeta',
                'scrapeRunPages',
            ]);
            if (!bundle.syncQueue || bundle.syncQueue.length === 0) {
                return sendResponse({ ok: true, written: 0, products: 0 });
            }
            try {
                const result = await syncToCloud(user.uid, bundle);
                // Clear only the drained queue; keep lastValues so future scrapes
                // still compute month-over-month deltas.
                await chrome.storage.local.set({ syncQueue: [] });
                sendResponse({ ok: true, ...result });
            } catch (err) {
                console.error('[ProScan] cloud export failed', err);
                sendResponse({ error: (err && err.message) || 'Export failed.' });
            }
        })();
        return true;
    }

    return false; // not a sync message — let the other listener handle it
});
