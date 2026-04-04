/**
 * @fileoverview Background Service Worker
 *
 * Central message router for the ProScan extension. Handles:
 * - Message routing between popup, content scripts, and external APIs
 * - Gemini 2.0 Flash API calls for the AI chatbot
 * - Optional server sync (fire-and-forget POST to local FastAPI backend)
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
 * - SCRAPING_COMPLETE: Triggers optional server sync
 * - CHAT_MESSAGE: Sends question + product context to Gemini API
 *
 * Returns true to keep the message channel open for async responses.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Route STOP_SCRAPING from popup to content script
    if (request.type === 'STOP_SCRAPING' && sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'STOP_SCRAPING' });
    }

    // When scraping completes, auto-sync to local server (optional)
    if (request.type === 'SCRAPING_COMPLETE') {
        console.log('[ProScan] Scraping completed:', request.itemCount, 'items');
        syncToServer();
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

/** @const {string} Local backend server URL for optional data sync */
const MCP_SERVER_URL = 'http://127.0.0.1:8000';

/**
 * Sync scraped products to the local FastAPI backend.
 * Fire-and-forget -- errors are logged but don't affect extension functionality.
 * The extension works fully standalone without the server.
 *
 * @async
 */
async function syncToServer() {
    try {
        const data = await chrome.storage.local.get(['results']);
        const results = data.results || [];

        if (results.length === 0) return;

        const response = await fetch(`${MCP_SERVER_URL}/api/products/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                products: results,
                seller_name: null,
                seller_url: null
            })
        });

        if (response.ok) {
            const result = await response.json();
            console.log(`[ProScan] Synced ${result.synced} products to MCP server`);
        } else {
            console.warn('[ProScan] Server sync failed:', response.status);
        }
    } catch (error) {
        // Server not running -- extension works standalone
        console.log('[ProScan] MCP server not available (standalone mode)');
    }
}

/**
 * Clean up on browser startup.
 * Resets the scraping flag in case the browser was closed mid-scrape.
 */
chrome.runtime.onStartup.addListener(() => {
    chrome.storage.local.set({
        isScrapingActive: false
    });
});
