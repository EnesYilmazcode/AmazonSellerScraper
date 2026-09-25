/**
 * @fileoverview "AI chat settings" in the popup: the user's own Gemini key.
 *
 * The key is kept in chrome.storage.local under geminiApiKey. Only the
 * popup writes it and only the service worker reads it; the chat widget on
 * Amazon asks the worker whether a key is set and never sees the value.
 *
 * @module AiKey
 */

const AiKey = (() => {
    const STORAGE_KEY = 'geminiApiKey';

    /** Trims a pasted key. Returns '' for anything that cannot be a key. */
    function normalize(raw) {
        const key = String(raw == null ? '' : raw).trim();
        return /^[A-Za-z0-9_.\-]{20,200}$/.test(key) ? key : '';
    }

    async function hasKey() {
        const data = await chrome.storage.local.get([STORAGE_KEY]);
        return typeof data[STORAGE_KEY] === 'string' && data[STORAGE_KEY].trim() !== '';
    }

    async function save(raw) {
        const key = normalize(raw);
        if (!key) return false;
        await chrome.storage.local.set({ [STORAGE_KEY]: key });
        return true;
    }

    async function clear() {
        await chrome.storage.local.remove(STORAGE_KEY);
    }

    function init(doc) {
        const input = doc.getElementById('geminiKeyInput');
        const saveBtn = doc.getElementById('geminiKeySave');
        const clearBtn = doc.getElementById('geminiKeyClear');
        const status = doc.getElementById('geminiKeyStatus');
        if (!input || !saveBtn || !clearBtn || !status) return Promise.resolve();

        const show = (set, message) => {
            status.textContent = message || (set ? 'Key saved. The chat button on Amazon is ready.' : 'No key set. AI chat is off.');
            input.placeholder = set ? 'Key saved (hidden). Paste a new one to replace it.' : 'Paste your Gemini API key';
            clearBtn.classList.toggle('hidden', !set);
        };

        saveBtn.addEventListener('click', async () => {
            if (await save(input.value)) {
                input.value = '';
                show(true);
            } else {
                show(await hasKey(), 'That does not look like a Gemini API key.');
            }
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn.click();
        });
        clearBtn.addEventListener('click', async () => {
            await clear();
            show(false, 'Key removed.');
        });

        return hasKey().then((set) => show(set));
    }

    return { STORAGE_KEY, normalize, hasKey, save, clear, init };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AiKey;
} else {
    document.addEventListener('DOMContentLoaded', () => AiKey.init(document));
}
