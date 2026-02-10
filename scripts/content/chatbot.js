// chatbot.js — ProScan floating AI chatbot on Amazon pages
// Uses Shadow DOM to isolate styles from Amazon's CSS

(function () {
    // Only run on pages with product listings
    if (!document.querySelector('.s-result-item[data-asin]')) return;

    let isOpen = false;
    let shadow;
    let messagesEl;
    let inputEl;
    let sendBtn;
    let badgeEl;

    // SVG icons (inline to avoid external dependencies)
    const ICON_CHAT = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
    const ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
    const ICON_BOT = '<svg viewBox="0 0 24 24"><path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 110 2h-1v1a3 3 0 01-3 3H6a3 3 0 01-3-3v-1H2a1 1 0 110-2h1a7 7 0 017-7h1V5.73A2 2 0 0112 2zM9 14a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2z"/></svg>';

    // Create the widget
    function init() {
        const host = document.createElement('div');
        host.id = 'proscan-chatbot-host';
        document.body.appendChild(host);

        shadow = host.attachShadow({ mode: 'closed' });

        // Load stylesheet
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('styles/chatbot.css');
        shadow.appendChild(link);

        // Build HTML
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <button class="proscan-toggle" title="ProScan AI">${ICON_CHAT}</button>
            <div class="proscan-panel">
                <div class="proscan-header">
                    <span class="proscan-header-title">${ICON_BOT} ProScan AI</span>
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

        // Cache elements
        const panel = shadow.querySelector('.proscan-panel');
        const toggle = shadow.querySelector('.proscan-toggle');
        const closeBtn = shadow.querySelector('.proscan-close');
        messagesEl = shadow.getElementById('ps-messages');
        inputEl = shadow.getElementById('ps-input');
        sendBtn = shadow.getElementById('ps-send');
        badgeEl = shadow.getElementById('ps-badge');

        // Toggle open/close
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

        // Send on click or Enter
        sendBtn.addEventListener('click', sendMessage);
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendMessage();
        });

        // Update badge with product count
        updateProductBadge();
    }

    // Update the product count badge
    function updateProductBadge() {
        chrome.storage.local.get(['results'], (data) => {
            const count = (data.results || []).length;
            badgeEl.textContent = count + ' product' + (count !== 1 ? 's' : '');
        });
    }

    // Add a message bubble
    function addBubble(text, type) {
        const bubble = document.createElement('div');
        bubble.className = 'proscan-bubble ' + type;
        bubble.textContent = text;
        messagesEl.appendChild(bubble);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return bubble;
    }

    // Send a chat message
    async function sendMessage() {
        const question = inputEl.value.trim();
        if (!question) return;

        addBubble(question, 'user');
        inputEl.value = '';
        sendBtn.disabled = true;

        const loadingBubble = addBubble('Thinking...', 'ai loading');

        try {
            // Get products from storage
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

    // Wait for DOM then initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
