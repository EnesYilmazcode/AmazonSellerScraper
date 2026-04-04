/**
 * @fileoverview Floating AI Chatbot Widget (Shadow DOM)
 *
 * Injects a floating chat widget on Amazon product pages that lets users
 * ask natural-language questions about scraped products. Uses Shadow DOM
 * to fully isolate widget styles from Amazon's CSS, preventing conflicts.
 *
 * Architecture:
 * - IIFE wraps the entire module for scope isolation
 * - Shadow DOM (closed mode) prevents Amazon CSS interference
 * - Communicates with service-worker.js via chrome.runtime.sendMessage
 * - Reads product data from chrome.storage.local (populated by scraper.js)
 *
 * Widget Components:
 * - Toggle button: circular icon (bottom-right corner, max z-index)
 * - Chat panel: header with product badge, scrollable messages, text input
 * - Message bubbles: AI (green), User (blue), Error (red), Loading (italic)
 *
 * @module Chatbot
 */

(function () {
    // Only activate on pages with product listings
    if (!document.querySelector('.s-result-item[data-asin]')) return;

    /** @type {boolean} Whether the chat panel is currently open */
    let isOpen = false;

    /** @type {ShadowRoot} Closed shadow root for style isolation */
    let shadow;

    /** @type {HTMLElement} Messages container element */
    let messagesEl;

    /** @type {HTMLInputElement} Text input element */
    let inputEl;

    /** @type {HTMLButtonElement} Send button element */
    let sendBtn;

    /** @type {HTMLElement} Product count badge element */
    let badgeEl;

    // Asset URLs resolved via chrome.runtime for extension context
    const LOGO_URL = chrome.runtime.getURL('assets/icons/icon128.png');
    const ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';

    /**
     * Initialize the chatbot widget.
     * Creates the Shadow DOM host, loads styles, builds the HTML structure,
     * and attaches event listeners for toggle, close, send, and keyboard input.
     */
    function init() {
        const host = document.createElement('div');
        host.id = 'proscan-chatbot-host';
        document.body.appendChild(host);

        shadow = host.attachShadow({ mode: 'closed' });

        // Load stylesheet into Shadow DOM
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('styles/chatbot.css');
        shadow.appendChild(link);

        // Build widget HTML structure
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <button class="proscan-toggle" title="ProScan AI"><img src="${LOGO_URL}" alt="ProScan" /></button>
            <div class="proscan-panel">
                <div class="proscan-header">
                    <span class="proscan-header-title"><img src="${LOGO_URL}" alt="" /> ProScan AI</span>
                    <span class="proscan-badge" id="ps-badge">0 products</span>
                    <button class="proscan-close">&times;</button>
                </div>
                <div class="proscan-messages" id="ps-messages">
                    <div class="proscan-bubble ai">Ask me anything about the products on this page.</div>
                </div>
                <div class="proscan-input-row">
                    <input class="proscan-input" id="ps-input" type="text" placeholder="e.g. What's the best deal under $30?" />
                    <button class="proscan-send" id="ps-send" title="Send">${ICON_SEND}</button>
                </div>
            </div>
        `;
        shadow.appendChild(wrapper);

        // Cache DOM references within Shadow DOM
        const panel = shadow.querySelector('.proscan-panel');
        const toggle = shadow.querySelector('.proscan-toggle');
        const closeBtn = shadow.querySelector('.proscan-close');
        messagesEl = shadow.getElementById('ps-messages');
        inputEl = shadow.getElementById('ps-input');
        sendBtn = shadow.getElementById('ps-send');
        badgeEl = shadow.getElementById('ps-badge');

        // Toggle panel open/close
        toggle.addEventListener('click', () => {
            isOpen = !isOpen;
            panel.classList.toggle('open', isOpen);
            if (isOpen) {
                inputEl.focus();
                updateProductBadge();
            }
        });

        closeBtn.addEventListener('click', () => {
            isOpen = false;
            panel.classList.remove('open');
        });

        // Send message on button click or Enter key
        sendBtn.addEventListener('click', sendMessage);
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendMessage();
        });

        updateProductBadge();
    }

    /**
     * Update the product count badge in the chat header.
     * Reads the current result count from chrome.storage.local.
     */
    function updateProductBadge() {
        chrome.storage.local.get(['results'], (data) => {
            const count = (data.results || []).length;
            badgeEl.textContent = count + ' product' + (count !== 1 ? 's' : '');
        });
    }

    /**
     * Append a message bubble to the chat messages area.
     *
     * @param {string} text - Message text content
     * @param {string} type - CSS class(es) for bubble styling ('user', 'ai', 'ai loading', 'ai error')
     * @returns {HTMLElement} The created bubble element (useful for updating loading messages)
     */
    function addBubble(text, type) {
        const bubble = document.createElement('div');
        bubble.className = 'proscan-bubble ' + type;
        bubble.textContent = text;
        messagesEl.appendChild(bubble);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return bubble;
    }

    /**
     * Send the user's question to the Gemini API via the service worker.
     *
     * Flow:
     * 1. Read user input and display as user bubble
     * 2. Show "Thinking..." loading bubble
     * 3. Read scraped products from chrome.storage.local
     * 4. Send CHAT_MESSAGE to service worker with question + product context
     * 5. Update loading bubble with AI response (or error)
     * 6. Re-enable input for next question
     *
     * @async
     */
    async function sendMessage() {
        const question = inputEl.value.trim();
        if (!question) return;

        addBubble(question, 'user');
        inputEl.value = '';
        sendBtn.disabled = true;

        const loadingBubble = addBubble('Thinking...', 'ai loading');

        try {
            // Read products from storage for context
            const data = await chrome.storage.local.get(['results']);
            const products = (data.results || []).map(p => ({
                name: p.name,
                asin: p.asin,
                price: p.price,
                rating: p.rating,
                reviewCount: p.reviewCount,
                isPrime: p.isPrime
            }));

            // Send to service worker for Gemini API call
            const response = await chrome.runtime.sendMessage({
                type: 'CHAT_MESSAGE',
                question: question,
                products: products
            });

            if (response && response.answer) {
                loadingBubble.textContent = response.answer;
                loadingBubble.className = 'proscan-bubble ai';
            } else if (response && response.error) {
                loadingBubble.textContent = response.error;
                loadingBubble.className = 'proscan-bubble ai error';
            } else {
                loadingBubble.textContent = 'No response received.';
                loadingBubble.className = 'proscan-bubble ai error';
            }
        } catch (err) {
            loadingBubble.textContent = 'Something went wrong. Check the extension popup for API key setup.';
            loadingBubble.className = 'proscan-bubble ai error';
        }

        sendBtn.disabled = false;
        inputEl.focus();
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
