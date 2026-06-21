import { auth, db } from './firebase-init.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth/web-extension';
import { syncToCloud } from './sync.js';

/**
 * @fileoverview Background Service Worker
 *
 * Central message router for the ProScan extension. Handles:
 * - Message routing between popup, content scripts, and external APIs
 * - Gemini 2.0 Flash API calls for the AI chatbot
 * - Extension lifecycle events (install, update, startup)
 *
 * Runs as a Manifest V3 service worker -- no persistent background page.
 * Wakes on message events and API calls, then goes idle.
 *
 * @module ServiceWorker
 */

/** @const {string} Gemini API endpoint for content generation */
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

/**
 * Fallback API key (base64-encoded). Used only when the user hasn't
 * configured their own key via the popup settings panel.
 * @const {string}
 * @private
 */
const _t = 'QUl6YVN5RHdfOVhQLXRpQ0tLX3lkQThCd0ZrZUpxNWdTdTAxNUhj';

/**
 * Decode the fallback API key.
 * @returns {string} Decoded API key
 * @private
 */
const _dk = () => atob(_t);

/**
 * Main message listener -- routes messages between extension components.
 *
 * Message types handled:
 * - STOP_SCRAPING: Forwarded from popup to the active tab's content script
 * - SCRAPING_COMPLETE: Logs scrape completion
 * - CHAT_MESSAGE: Sends question + product context to Gemini API
 *
 * Returns true to keep the message channel open for async responses.
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

    // AI chatbot -- call Gemini API with product context
    if (request.type === 'CHAT_MESSAGE') {
        handleChatMessage(request.question, request.products)
            .then(answer => sendResponse({ answer }))
            .catch(err => sendResponse({ error: err.message }));
        return true; // keep channel open for async response
    }

    return true;
});

/**
 * Handle a chat message by calling the Gemini 2.0 Flash API.
 *
 * Builds a prompt with the system role, product context, and user question.
 * Uses the user's API key from chrome.storage if available, otherwise
 * falls back to the built-in key.
 *
 * @param {string} question - User's natural language question
 * @param {Object[]} products - Array of product objects for context
 * @returns {Promise<string>} AI-generated response text
 * @throws {Error} On invalid API key or Gemini API failure
 */
async function handleChatMessage(question, products) {
    const data = await chrome.storage.local.get(['geminiApiKey']);
    const apiKey = data.geminiApiKey || _dk();

    const productCount = products.length;
    const productList = products.map(p =>
        `- ${p.name} | ASIN: ${p.asin} | Price: ${p.price} | Rating: ${p.rating}/5 | Reviews: ${p.reviewCount} | Prime: ${p.isPrime ? 'Yes' : 'No'}`
    ).join('\n');

    const prompt = `You are ProScan AI, a product analysis assistant for Amazon shoppers and resellers.
You have data on ${productCount} products scraped from an Amazon page.
Answer the user's question concisely and very shortly. Reference specific product names and prices.
If the data doesn't contain enough info to answer, say so. Dont formate your response in markdown.
Be confidant, dont say "thats subjected but.." or "i'm not sure but...".

Products:
${productList}

User question: ${question}`;

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (response.status === 400 || response.status === 403) {
            throw new Error('Invalid API key. Check your Gemini API key in the ProScan popup.');
        }
        throw new Error(err.error?.message || 'Gemini API error: ' + response.status);
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini.');
    return text;
}

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
