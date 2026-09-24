/**
 * @fileoverview Tests for the chat widget in scripts/content/chatbot.js.
 * The widget must never see the key, must point at the real setting when no
 * key is set, and must render model output as text (F-62, F-65).
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'content', 'chatbot.js'), 'utf8');
const flush = () => new Promise(r => setTimeout(r, 0));

let shadow;
let sent;

function mount(replies) {
    document.body.innerHTML = '<div class="s-result-item" data-asin="B0AAAAAAA1"></div>';
    sent = [];
    chrome.runtime.id = 'test-extension';
    chrome.runtime.sendMessage = jest.fn(async (msg) => {
        sent.push(msg);
        const r = replies[msg.type];
        if (r instanceof Error) throw r;
        return typeof r === 'function' ? r(msg) : r;
    });
    // Force an open root so the test can look inside.
    const attach = Element.prototype.attachShadow;
    jest.spyOn(Element.prototype, 'attachShadow').mockImplementation(function () {
        shadow = attach.call(this, { mode: 'open' });
        return shadow;
    });
    // eslint-disable-next-line no-eval
    (0, eval)(SRC);
}

async function ask(text) {
    shadow.getElementById('ps-input').value = text;
    shadow.getElementById('ps-send').click();
    await flush();
    await flush();
    const bubbles = shadow.querySelectorAll('.proscan-bubble');
    return bubbles[bubbles.length - 1];
}

afterEach(() => {
    jest.restoreAllMocks();
    delete chrome.runtime.id;
});

test('with no key the greeting points at the popup setting', async () => {
    mount({ CHAT_STATUS: { hasKey: false, productCount: 12 } });
    await flush();
    expect(shadow.getElementById('ps-greeting').textContent).toMatch(/ProScan popup.*AI chat settings/);
    expect(shadow.getElementById('ps-badge').textContent).toBe('12 products');
});

test('the greeting names the run the chat covers', async () => {
    mount({ CHAT_STATUS: { hasKey: true, productCount: 48, source: 'search "usb c cable"', pages: 2 } });
    await flush();
    expect(shadow.getElementById('ps-greeting').textContent)
        .toBe('Ask me about the 48 products from your last ProScan scan (search "usb c cable", 2 pages).');
});

test('sends only the question and history, never products or a key', async () => {
    mount({ CHAT_STATUS: { hasKey: true, productCount: 1 }, CHAT_MESSAGE: { answer: 'first' } });
    await ask('cheapest?');
    await ask('and the next one?');
    const chats = sent.filter(m => m.type === 'CHAT_MESSAGE');
    expect(Object.keys(chats[0]).sort()).toEqual(['history', 'question', 'type']);
    expect(chats[0].history).toEqual([]);
    expect(chats[1].history).toEqual([{ role: 'user', text: 'cheapest?' }, { role: 'model', text: 'first' }]);
});

test('model output is rendered as text, not HTML', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    mount({ CHAT_STATUS: { hasKey: true, productCount: 1 }, CHAT_MESSAGE: { answer: evil } });
    const bubble = await ask('hi');
    expect(bubble.textContent).toBe(evil);
    expect(bubble.querySelector('img')).toBeNull();
    expect(bubble.querySelector('b')).toBeNull();
});

test('a worker error is shown as the worker wrote it', async () => {
    mount({ CHAT_STATUS: { hasKey: false, productCount: 0 }, CHAT_MESSAGE: { error: 'AI chat needs your own Gemini API key.' } });
    const bubble = await ask('hi');
    expect(bubble.textContent).toBe('AI chat needs your own Gemini API key.');
    expect(bubble.className).toMatch(/error/);
});

test('an orphaned script after an update says to reload, not to fix a key', async () => {
    mount({ CHAT_STATUS: { hasKey: true, productCount: 1 }, CHAT_MESSAGE: new Error('Extension context invalidated.') });
    delete chrome.runtime.id;
    const bubble = await ask('hi');
    expect(bubble.textContent).toBe('ProScan was updated. Reload this page to use the chat.');
});
