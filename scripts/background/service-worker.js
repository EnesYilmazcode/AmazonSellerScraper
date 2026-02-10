// service-worker.js - Background Service Worker for ProScan
// Handles message routing between popup and content scripts

// Gemini API config
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// Message routing
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

    // AI chatbot — call Gemini API with product context
    if (request.type === 'CHAT_MESSAGE') {
        handleChatMessage(request.question, request.products)
            .then(answer => sendResponse({ answer }))
            .catch(err => sendResponse({ error: err.message }));
        return true; // keep channel open for async response
    }

    return true;
});

// Handle chat message via Gemini API
async function handleChatMessage(question, products) {
    const data = await chrome.storage.local.get(['geminiApiKey']);
    const apiKey = data.geminiApiKey;

    if (!apiKey) {
        throw new Error('No API key set. Open the ProScan popup and add your Gemini API key in Settings.');
    }

    const productCount = products.length;
    const productList = products.map(p =>
        `- ${p.name} | ASIN: ${p.asin} | Price: ${p.price} | Rating: ${p.rating}/5 | Reviews: ${p.reviewCount} | Prime: ${p.isPrime ? 'Yes' : 'No'}`
    ).join('\n');

    const prompt = `You are ProScan AI, a product analysis assistant for Amazon shoppers and resellers.
You have data on ${productCount} products scraped from an Amazon page.
Answer the user's question concisely. Reference specific product names and prices.
If the data doesn't contain enough info to answer, say so.

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

// Handle extension installation/update
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

// Sync scraped data to local MCP server (fire-and-forget)
const MCP_SERVER_URL = 'http://127.0.0.1:8000';

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
        // Server not running - this is fine, extension works standalone
        console.log('[ProScan] MCP server not available (standalone mode)');
    }
}

// Clean up on browser startup
chrome.runtime.onStartup.addListener(() => {
    // Reset scraping state in case browser was closed during scrape
    chrome.storage.local.set({
        isScrapingActive: false
    });
});
