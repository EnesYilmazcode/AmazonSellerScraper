/**
 * @fileoverview Tests for popup/ai-key.js, the Gemini key field (F-62).
 */

const fs = require('fs');
const path = require('path');
const AiKey = require('../../popup/ai-key.js');

const KEY = 'test_gemini_key_0123456789abcdef';
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'popup', 'popup.html'), 'utf8');

beforeEach(() => {
    chrome.storage.local._reset();
    chrome.storage.local.remove = (k) => {
        const store = chrome.storage.local._getStore();
        delete store[k];
        chrome.storage.local._reset();
        return chrome.storage.local.set(store);
    };
    document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
});

const flush = () => new Promise(r => setTimeout(r, 0));

test('the popup has the key field the error text points to', () => {
    expect(document.getElementById('aiSettings').textContent).toMatch(/AI chat settings/);
    expect(document.getElementById('geminiKeyInput').type).toBe('password');
    expect(html).toMatch(/<script src="ai-key.js"><\/script>/);
});

test('normalize trims a key and rejects junk', () => {
    expect(AiKey.normalize('  ' + KEY + '\n')).toBe(KEY);
    expect(AiKey.normalize('hello')).toBe('');
    expect(AiKey.normalize('<script>alert(1)</script>xxxxxxxxxxxxxxxxxx')).toBe('');
});

test('save stores the key in chrome.storage.local and clears the input', async () => {
    await AiKey.init(document);
    const input = document.getElementById('geminiKeyInput');
    input.value = KEY;
    document.getElementById('geminiKeySave').click();
    await flush();
    expect(chrome.storage.local._getStore().geminiApiKey).toBe(KEY);
    expect(input.value).toBe('');
    expect(document.getElementById('geminiKeyStatus').textContent).toMatch(/Key saved/);
    expect(document.getElementById('geminiKeyClear').classList.contains('hidden')).toBe(false);
});

test('an invalid key is not saved', async () => {
    await AiKey.init(document);
    document.getElementById('geminiKeyInput').value = 'nope';
    document.getElementById('geminiKeySave').click();
    await flush();
    expect(chrome.storage.local._getStore().geminiApiKey).toBeUndefined();
    expect(document.getElementById('geminiKeyStatus').textContent).toMatch(/does not look like/);
});

test('remove deletes the key', async () => {
    await chrome.storage.local.set({ geminiApiKey: KEY });
    await AiKey.init(document);
    expect(document.getElementById('geminiKeyInput').value).toBe('');
    expect(document.getElementById('geminiKeyInput').placeholder).toMatch(/Key saved/);
    document.getElementById('geminiKeyClear').click();
    await flush();
    expect(chrome.storage.local._getStore().geminiApiKey).toBeUndefined();
});
