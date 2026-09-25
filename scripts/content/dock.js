/**
 * @fileoverview The ProScan dock: the one on-page surface, bottom-right.
 *
 * It replaces the old chat bubble. Collapsed, it is a launcher: on a search
 * or a seller storefront it offers Scrape in one click, on a seller page it
 * points at the storefront, and elsewhere it is a small ProScan button with
 * Ask next to it. Opened, it is a card with two tabs: Scrape (start, follow,
 * stop and download a run) and Ask (the Gemini chat), plus settings.
 *
 * The dock never writes run data. It asks the service worker to start a run
 * in this tab (START_RUN_HERE; the worker takes the tab from sender.tab),
 * follows it with RUN_STATUS and the worker's RUN_PROGRESS and RUN_ENDED,
 * and asks for files with DOWNLOAD. Every page of a run is a new document,
 * so the dock rebuilds from RUN_STATUS on each load.
 *
 * Keys and passwords are never typed here: keystrokes in a shadow root
 * still reach the page's own listeners. Settings links open ProScan's own
 * page instead (OPEN_SETTINGS).
 *
 * Closed shadow root, constructed stylesheet (dock-styles.js), system
 * fonts, inline SVG icons. "Not now" hides the suggestion for the rest of
 * the tab session (sessionStorage).
 *
 * @module Dock
 */

(function () {
    if (window.top !== window) return;
    if (typeof PageKind === 'undefined' || PageKind.hidden(location.href)) return;
    if (document.getElementById('proscan-dock-host')) return;

    const POLL_MS = 2000;
    const SEC_PER_OFFER = 2.5;
    const RECENT_MS = 30 * 60 * 1000;
    const MAX_HISTORY = 6;
    const KEY_NOT_NOW = 'proscan.dock.notNow';
    const KEY_OPEN = 'proscan.dock.open';
    const LIVE = ['starting', 'running', 'stopping'];
    const FORMAT_LABEL = { xlsx: 'Excel', csv: 'CSV', json: 'JSON' };

    const SVG = (body, { fill = false, w = 1.8, box = 16 } = {}) =>
        `<svg viewBox="0 0 ${box} ${box}" ${fill ? 'fill="currentColor"' : `fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`} aria-hidden="true" focusable="false">${body}</svg>`;
    const I = {
        mark: SVG('<circle cx="6.5" cy="15.5" r="3.5"/><circle cx="17.5" cy="15.5" r="3.5"/><path d="M4 13 6 5.5h3L10 12"/><path d="M20 13 18 5.5h-3L14 12"/><path d="M10 14.5h4"/>', { box: 24, w: 2 }),
        x: SVG('<path d="M4 4l8 8M12 4l-8 8"/>'),
        min: SVG('<path d="M4 6l4 4 4-4"/>'),
        gear: SVG('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>', { box: 24, w: 2 }),
        play: SVG('<path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z"/>', { fill: true }),
        stop: SVG('<rect x="4" y="4" width="8" height="8" rx="1.5"/>', { fill: true }),
        down: SVG('<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>'),
        file: SVG('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>', { w: 1.5 }),
        chev: SVG('<path d="M6 3.5 10.5 8 6 12.5"/>'),
        back: SVG('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
        ok: SVG('<path d="M3.5 8.5 6.5 11.5 12.5 5"/>', { w: 2.2 }),
        warn: SVG('<path d="M8 4.5v4.2M8 11.2v.1"/>', { w: 2.2 }),
        pause: SVG('<path d="M6 4.5v7M10 4.5v7"/>', { w: 2 }),
        info: SVG('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4M8 4.9v.1"/>', { w: 1.5 }),
        send: SVG('<path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/>'),
        chat: SVG('<path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h0a1.5 1.5 0 0 1-1.5-1.5z"/>', { w: 1.5 }),
        scan: SVG('<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M2 5.5h12"/>', { w: 1.5 }),
        ext: SVG('<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7"/>', { w: 1.6 }),
        minus: SVG('<path d="M3.5 8h9"/>', { w: 2 }),
        plus: SVG('<path d="M3.5 8h9M8 3.5v9"/>', { w: 2 }),
        again: SVG('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>', { w: 1.6 })
    };

    // ── Small helpers ───────────────────────────────────────────

    function readFlag(key) {
        try { return window.sessionStorage.getItem(key) === '1'; } catch (e) { return false; }
    }
    function writeFlag(key, on) {
        try { window.sessionStorage.setItem(key, on ? '1' : '0'); } catch (e) { /* storage blocked */ }
    }

    /** False once the extension was updated or removed under this page. */
    function alive() {
        try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
    }

    /** Sends `message` to the worker; resolves null when nothing answers. */
    function send(message) {
        return new Promise((resolve) => {
            if (!alive()) return resolve(null);
            try {
                const out = chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) return resolve(null);
                    resolve(response || null);
                });
                // Test doubles answer with a promise instead of the callback.
                if (out && typeof out.then === 'function') out.then((r) => resolve(r || null), () => resolve(null));
            } catch (e) {
                resolve(null);
            }
        });
    }

    const fmt = (n) => Number(n || 0).toLocaleString('en-US');
    const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
    const isLive = (run) => !!run && LIVE.includes(run.state);
    const isEnded = (run) => !!run && !!run.state && !LIVE.includes(run.state) && run.state !== 'idle';

    function aboutTime(seconds) {
        if (seconds < 60) return 'Under a minute';
        const m = Math.round(seconds / 60);
        return `About ${m} ${m === 1 ? 'minute' : 'minutes'}`;
    }

    /**
     * Builds an element. `attrs` takes class, text, on<event> handlers and
     * any attribute; children are nodes or strings (as text). `html` is for
     * the icon constants only.
     */
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'text') el.textContent = v;
            else if (k === 'html') el.innerHTML = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : String(v));
        }
        for (const c of children.flat()) {
            if (c === null || c === undefined || c === false) continue;
            el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return el;
    }
    const icon = (name) => h('span', { html: I[name], style: 'display:contents' });

    // ── This page ───────────────────────────────────────────────

    function textOf(sel) {
        const el = document.querySelector(sel);
        const t = el && (el.textContent || '').replace(/\s+/g, ' ').trim();
        return t && t.length <= 60 ? t : null;
    }

    /** The store name from the tab title ("Amazon.com: Northfield Goods"), or null. */
    function storeName() {
        const t = (document.title || '').replace(/^\s*Amazon\.com\s*[:|-]?\s*/i, '').trim();
        return t && t.length <= 60 && !/^amazon/i.test(t) ? t : null;
    }

    /** A seller id from a link on the page, for brand store pages. */
    function sellerFromLinks() {
        const links = document.querySelectorAll('a[href*="seller="], a[href*="me="]');
        for (let i = 0; i < links.length && i < 60; i++) {
            try {
                const u = new URL(links[i].href, location.href);
                const id = PageKind.sellerId(u.searchParams.get('seller') || u.searchParams.get('me'));
                if (id) return id;
            } catch (e) { /* not a URL */ }
        }
        return null;
    }

    function describePage() {
        const url = location.href;
        const where = PageKind.classify(url);
        let parsed = null;
        if (where.kind === 'search' || where.kind === 'storefront') {
            try { parsed = Parsers.parseSearchPage(document, url); } catch (e) { parsed = null; }
        }
        const count = parsed ? parsed.products.length : 0;
        const total = parsed && Number.isInteger(parsed.total) && parsed.total > 0 ? parsed.total : null;
        let sellerId = where.sellerId;
        if (where.kind === 'store' && !sellerId) sellerId = sellerFromLinks();
        let name = null;
        if (where.kind === 'storefront') name = storeName();
        else if (where.kind === 'search') name = where.keyword ? `"${where.keyword}"` : null;
        else if (where.kind === 'seller') name = textOf('#seller-name') || textOf('#sellerName-rd') || textOf('h1');
        else if (where.kind === 'store') name = storeName();
        return {
            kind: where.kind,
            keyword: where.keyword,
            sellerId,
            name,
            count,
            total,
            pagesAvail: total && count ? Math.min(Math.ceil(total / count), 400) : null,
            startable: !!parsed && ['results', 'last'].includes(parsed.kind),
            refusedKind: parsed && !['results', 'last'].includes(parsed.kind) ? parsed.kind : null
        };
    }

    const page = describePage();
    const scrapable = page.kind === 'search' || page.kind === 'storefront';

    // ── State ───────────────────────────────────────────────────

    const ui = {
        open: readFlag(KEY_OPEN),
        animate: false,
        tab: 'scrape',
        status: null,
        orphaned: false,
        notice: null,
        busy: null,
        menu: false,
        toast: null,
        spread: null,
        notNow: readFlag(KEY_NOT_NOW),
        chat: { status: null, messages: [], draft: '', sending: false }
    };
    const history = [];

    let shadow;
    let root;
    let pollTimer = null;

    const run = () => (ui.status && ui.status.run) || null;
    const settings = () => (ui.status && ui.status.settings) || { maxPages: 20, suggest: true };

    function runLabel(r) {
        const src = (r && r.source) || {};
        if (src.type === 'storefront') {
            if (src.name) return src.name;
            if (page.kind === 'storefront' && page.sellerId === src.sellerId && page.name) return page.name;
            return 'this storefront';
        }
        return src.keyword ? `"${src.keyword}"` : 'these results';
    }

    function recent(r) {
        return !!r && !!r.finishedAt && Date.now() - r.finishedAt < RECENT_MS;
    }

    // ── Talking to the worker ──────────────────────────────────

    function unreachable() {
        ui.orphaned = !alive();
        ui.notice = {
            tone: 'warn',
            text: ui.orphaned ? 'ProScan was updated. Reload this page to use it.' : 'Could not reach ProScan. Reload this page and try again.',
            action: { label: 'Reload', run: () => location.reload() }
        };
    }

    async function refresh() {
        clearTimeout(pollTimer);
        const st = await send({ type: 'RUN_STATUS' });
        if (st && !st.error) {
            ui.status = st;
        } else if (!alive()) {
            ui.orphaned = true;
        }
        render();
        // A background tab checks in less often; RUN_PROGRESS still reaches the run's own tab.
        if (isLive(run())) pollTimer = setTimeout(refresh, document.hidden ? POLL_MS * 5 : POLL_MS);
    }

    async function startHere() {
        if (ui.busy) return;
        ui.busy = 'start';
        ui.notice = null;
        render();
        const r = await send({ type: 'START_RUN_HERE' });
        ui.busy = null;
        if (r && r.ok) {
            setOpen(true, { focus: 'stop' });
            await refresh();
            return;
        }
        if (!r) unreachable();
        else ui.notice = { tone: 'warn', text: r.message || 'ProScan could not start on this page.' };
        if (r && r.error === 'busy') await refresh();
        setOpen(true);
    }

    async function stopRun() {
        if (ui.busy) return;
        ui.busy = 'stop';
        render();
        const r = await send({ type: 'STOP_RUN_HERE' });
        ui.busy = null;
        if (!r) unreachable();
        await refresh();
    }

    function saveHere({ base64, mime, filename }) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const a = h('a', { href: url, download: filename, hidden: true });
        shadow.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async function download(format) {
        if (ui.busy) return;
        ui.busy = format;
        ui.notice = null;
        render();
        const r = await send({ type: 'DOWNLOAD', format });
        ui.busy = null;
        if (r && r.ok) {
            if (r.via === 'page') saveHere(r);
            toast(`${FORMAT_LABEL[format]} downloaded`);
        } else if (!r) {
            unreachable();
        } else {
            toast(r.message || 'ProScan could not make the file. Try again.', 'warn');
        }
        render();
    }

    let toastTimer = null;

    /** A short message over the dock that goes away on its own, so the card keeps its shape. */
    function toast(text, tone = 'info') {
        ui.toast = { text, tone };
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { ui.toast = null; render(); }, tone === 'warn' ? 6000 : 2500);
    }

    async function compareSellers() {
        if (ui.spread || typeof runSpreadAnalysis !== 'function' || (typeof isAnalyzing !== 'undefined' && isAnalyzing)) return;
        const data = await send({ type: 'GET_RESULTS' });
        const products = (data && data.results) || [];
        if (products.length === 0) return;
        ui.spread = { current: 0, total: products.length };
        render();
        const unwatch = watchSpread((ev) => {
            if (ev.done) {
                ui.spread = null;
                unwatch();
                refresh();
            } else {
                ui.spread = { current: ev.current, total: ev.total };
                render();
            }
        });
        runSpreadAnalysis(products);
    }

    function saveSettings(patch) {
        ui.status = { ...(ui.status || {}), settings: { ...settings(), ...patch } };
        render();
        send({ type: 'SAVE_SETTINGS', ...patch }).then((r) => {
            if (r && r.settings && ui.status) {
                ui.status.settings = r.settings;
                render();
            }
        });
    }

    function openSettingsPage(section) {
        send({ type: 'OPEN_SETTINGS', section }).then((r) => { if (!r) { unreachable(); render(); } });
    }

    async function loadChat() {
        const st = await send({ type: 'CHAT_STATUS' });
        ui.chat.status = st || { hasKey: false, productCount: 0, unreachable: true };
        render();
    }

    async function ask(question) {
        const q = String(question || '').trim();
        if (!q || ui.chat.sending) return;
        ui.chat.messages.push({ who: 'me', text: q });
        ui.chat.messages.push({ who: 'ai', text: 'Thinking', wait: true });
        ui.chat.draft = '';
        ui.chat.sending = true;
        render();
        const r = await send({ type: 'CHAT_MESSAGE', question: q, history: history.slice(-MAX_HISTORY) });
        const last = ui.chat.messages[ui.chat.messages.length - 1];
        last.wait = false;
        if (r && r.answer) {
            last.text = r.answer;
            history.push({ role: 'user', text: q }, { role: 'model', text: r.answer });
            history.splice(0, Math.max(0, history.length - MAX_HISTORY));
        } else {
            last.error = true;
            last.text = r && r.error ? r.error : (alive() ? 'Could not reach ProScan. Reload this page and try again.' : 'ProScan was updated. Reload this page to ask.');
        }
        ui.chat.sending = false;
        render({ focus: 'compose' });
    }

    // ── Opening and closing ─────────────────────────────────────

    let pendingFocus = null;

    function setOpen(open, { tab, focus } = {}) {
        ui.open = open;
        ui.animate = open;
        if (tab) ui.tab = tab;
        writeFlag(KEY_OPEN, open);
        pendingFocus = focus || (open ? 'first' : 'launcher');
        if (open && ui.tab === 'ask' && !ui.chat.status) loadChat();
        render();
    }

    function notNow() {
        ui.notNow = true;
        writeFlag(KEY_NOT_NOW, true);
        setOpen(false);
    }

    // ── Pieces ──────────────────────────────────────────────────

    function mark({ small = false, ring = null, badge = false } = {}) {
        const m = h('span', { class: 'mark' + (small ? ' small' : ''), html: I.mark, 'aria-hidden': 'true' });
        if (ring !== null) {
            const c = 2 * Math.PI * 23;
            const r = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            r.setAttribute('class', 'ring');
            r.setAttribute('viewBox', '0 0 50 50');
            r.innerHTML = `<circle class="track" cx="25" cy="25" r="23"/><circle class="val" cx="25" cy="25" r="23" stroke-dasharray="${(c * Math.max(0.04, ring)).toFixed(1)} 999"/>`;
            m.appendChild(r);
        }
        if (badge) m.appendChild(h('span', { class: 'badge', html: I.ok }));
        return m;
    }

    /** The pages strip: one segment per page up to the page limit, filled as pages are scraped. */
    function ticks(r) {
        const live = isLive(r);
        const done = r.page || 0;
        const max = Math.max(1, r.maxPages || 1, done);
        const n = Math.min(max, 20);
        const per = max / n;
        const row = h('div', { class: 'ticks', title: plural(done, 'page'), 'aria-hidden': 'true' });
        for (let i = 0; i < n; i++) {
            let cls = null;
            if (done >= (i + 1) * per - 1e-9) cls = 'done';
            else if (live && done >= i * per - 1e-9) cls = 'now';
            row.appendChild(h('i', { class: cls }));
        }
        return row;
    }

    /** The count as the one big number, with an optional control on its right. */
    function tally(n, extra) {
        return h('div', { class: 'tally' },
            h('p', { class: 'num' }, h('b', { text: fmt(n) }), ` ${n === 1 ? 'product' : 'products'}`),
            extra || null);
    }

    function noticeEl() {
        const n = ui.notice;
        if (!n) return null;
        return h('div', { class: 'notice' + (n.tone === 'info' ? ' info' : ''), role: n.tone === 'info' ? 'status' : 'alert' },
            h('span', { text: n.text }),
            n.action ? h('button', { text: n.action.label, 'data-k': 'notice', onclick: n.action.run }) : null);
    }

    /** Download Excel, with CSV and JSON behind the arrow on its right. */
    function downloads(count, extra = null) {
        const pick = (f) => { ui.menu = false; download(f); };
        const item = (f) => h('button', {
            role: 'menuitem', 'data-k': f, disabled: !!ui.busy, 'aria-label': `Download ${plural(count, 'product')} as ${FORMAT_LABEL[f]}`, onclick: () => pick(f)
        }, icon('file'), FORMAT_LABEL[f]);
        return h('div', { class: 'dl' },
            h('div', { class: 'dl-row' },
                h('button', { class: 'primary dl-main', 'data-k': 'xlsx', 'data-first': true, disabled: !!ui.busy, onclick: () => pick('xlsx') },
                    icon('down'), ui.busy === 'xlsx' ? 'Downloading' : 'Download Excel'),
                h('button', {
                    class: 'primary dl-more', 'data-k': 'formats', 'aria-label': 'Other formats', 'aria-haspopup': 'menu', 'aria-expanded': String(!!ui.menu),
                    disabled: !!ui.busy, onclick: () => { ui.menu = !ui.menu; pendingFocus = ui.menu ? 'csv' : 'formats'; render(); }
                }, icon('min')),
                extra),
            ui.menu ? h('div', { class: 'menu', role: 'menu', 'aria-label': 'Other formats' }, item('csv'), item('json')) : null);
    }

    function spreadBlock(st) {
        if (ui.spread) {
            const { current, total } = ui.spread;
            return h('div', { class: 'panel', role: 'status', 'aria-live': 'polite' },
                h('div', { class: 'progress-top' }, h('b', { text: `Checking seller prices, ${fmt(current)} of ${fmt(total)}` })),
                h('div', { class: 'bar' }, h('i', { style: `width:${total ? Math.round((current / total) * 100) : 0}%` })),
                h('p', { class: 'endline', style: 'margin-top:8px', text: 'Keep this tab on this page until it finishes.' }),
                h('div', { style: 'margin-top:10px' },
                    h('button', { class: 'secondary compact', 'data-k': 'spread-stop', onclick: () => stopSpreadAnalysis() }, icon('stop'), 'Stop checking')));
        }
        if (st.spreadCount > 0) {
            return h('p', { class: 'note' }, icon('ok'),
                h('span', { text: `Seller prices checked for ${plural(st.spreadCount, 'product')}. They are in the Excel and CSV files.` }));
        }
        const minutes = aboutTime(st.count * SEC_PER_OFFER).toLowerCase();
        return h('button', { class: 'linkrow', 'data-k': 'spread', disabled: !!ui.busy, onclick: compareSellers },
            h('span', { class: 'l' }, h('b', { text: 'Compare seller prices' }), h('span', { text: `Checks other sellers' offers, ${minutes}` })),
            icon('chev'));
    }

    // ── Launchers ───────────────────────────────────────────────

    function launcherShell(cls, ...children) {
        return h('div', { class: 'launcher ' + cls, role: 'region', 'aria-label': 'ProScan' }, ...children);
    }

    function mainButton(label, text, sub, markEl, drop = true) {
        return h('button', { class: 'launch-main', 'data-k': 'launcher', 'aria-expanded': 'false', 'aria-label': label, onclick: () => setOpen(true, { tab: 'scrape' }) },
            markEl,
            h('span', { class: 'launch-text' + (drop ? ' can-drop' : '') }, h('b', { text }), sub ? h('span', { text: sub }) : null));
    }

    const chatButton = () => h('button', {
        class: 'icon-btn', 'data-k': 'chat', 'aria-label': 'Ask about products', title: 'Ask', onclick: () => setOpen(true, { tab: 'ask' })
    }, icon('chat'));

    const hideButton = (label) => h('button', { class: 'icon-btn', 'data-k': 'notnow', 'aria-label': label, title: 'Not now', onclick: notNow }, icon('x'));

    function launcher() {
        const st = ui.status;
        const r = run();
        if (isLive(r)) {
            const cur = Math.min((r.page || 0) + 1, r.maxPages);
            const where = r.thisTab ? '' : ' in another tab';
            return launcherShell('running',
                mainButton(`Open ProScan, scraping page ${cur} of ${r.maxPages}${where}`, `Page ${fmt(cur)} of ${fmt(r.maxPages)}`,
                    `${plural(r.itemCount, 'product')} so far${where}`, mark({ ring: (r.page || 0) / r.maxPages }), false),
                h('button', { class: 'pill outline', 'data-k': 'stop', disabled: ui.busy === 'stop', 'aria-label': `Stop scraping and keep ${plural(r.itemCount, 'product')}`, onclick: stopRun },
                    icon('stop'), 'Stop'));
        }
        const suggest = settings().suggest !== false && !ui.notNow;
        if (isEnded(r) && r.thisTab && recent(r) && !ui.notNow && st && st.count > 0) {
            return launcherShell('done',
                mainButton('Open ProScan', plural(st.count, 'product'), null, mark({ badge: r.reason === 'complete' })),
                h('button', { class: 'pill', 'data-k': 'xlsx-quick', 'aria-label': 'Download Excel', disabled: !!ui.busy, onclick: () => download('xlsx') }, icon('down'), 'Excel'),
                chatButton(),
                hideButton('Hide for this tab'));
        }
        if (suggest && scrapable && page.startable) {
            const title = page.name || (page.kind === 'storefront' ? 'This storefront' : 'These results');
            const sub = plural(page.kind === 'storefront' && page.total ? page.total : page.count, 'product');
            return launcherShell('suggest',
                mainButton(`Open ProScan for ${title}`, title, sub, mark()),
                h('button', { class: 'pill', 'data-k': 'scrape-quick', disabled: ui.busy === 'start', onclick: () => startHere() }, icon('play'), 'Scrape'),
                chatButton(),
                hideButton('Not now, hide for this tab'));
        }
        if (suggest && (page.kind === 'seller' || page.kind === 'store') && page.sellerId) {
            return launcherShell('suggest',
                mainButton('Open ProScan', page.name || 'This seller', null, mark()),
                h('a', { class: 'pill', 'data-k': 'storefront', href: PageKind.storefrontUrl(page.sellerId) }, 'Open storefront'),
                chatButton(),
                hideButton('Not now, hide for this tab'));
        }
        return launcherShell('plain',
            h('button', { class: 'launch-main', 'data-k': 'launcher', 'aria-expanded': 'false', 'aria-label': 'Open ProScan', onclick: () => setOpen(true, { tab: 'scrape' }) },
                mark(), h('b', { text: 'ProScan' })),
            h('span', { class: 'sep', 'aria-hidden': 'true' }),
            chatButton());
    }

    // ── Card ────────────────────────────────────────────────────

    function header() {
        const minimize = h('button', { class: 'icon-btn', 'data-k': 'minimize', 'aria-label': 'Minimize ProScan', 'aria-expanded': 'true', title: 'Minimize', onclick: () => setOpen(false) }, icon('min'));
        if (ui.tab === 'settings') {
            return h('div', { class: 'head' },
                h('button', { class: 'back', 'data-k': 'back', 'aria-label': 'Back from settings', onclick: () => { ui.tab = 'scrape'; pendingFocus = 'first'; render(); } }, icon('back'), 'Settings'),
                h('span', { class: 'grow' }),
                minimize);
        }
        const tab = (id, label) => h('button', {
            role: 'tab', id: `ps-tab-${id}`, 'data-k': `tab-${id}`, 'aria-selected': String(ui.tab === id), 'aria-controls': 'ps-panel',
            tabindex: ui.tab === id ? '0' : '-1', text: label,
            onclick: () => { ui.tab = id; if (id === 'ask' && !ui.chat.status) loadChat(); pendingFocus = `tab-${id}`; render(); }
        });
        const tabs = h('div', {
            class: 'tabs', role: 'tablist', 'aria-label': 'ProScan',
            onkeydown: (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                ui.tab = ui.tab === 'scrape' ? 'ask' : 'scrape';
                if (ui.tab === 'ask' && !ui.chat.status) loadChat();
                pendingFocus = `tab-${ui.tab}`;
                render();
            }
        }, tab('scrape', 'Scrape'), tab('ask', 'Ask'));
        return h('div', { class: 'head' },
            mark({ small: true }),
            tabs,
            h('span', { class: 'grow' }),
            h('button', { class: 'icon-btn', 'data-k': 'gear', 'aria-label': 'Settings', title: 'Settings', onclick: () => { ui.tab = 'settings'; pendingFocus = 'first'; render(); } }, icon('gear')),
            minimize);
    }

    function lede(title, sub, iconEl) {
        const text = h('div', {}, h('h2', { text: title }), sub ? h('p', { text: sub }) : null);
        return h('div', { class: 'lede' + (iconEl ? ' withicon' : '') }, iconEl, text);
    }

    function stateIcon(kind) {
        const name = kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'pause';
        return h('span', { class: 'state-icon' + (kind === 'ok' ? '' : ` ${kind}`), html: I[name], 'aria-hidden': 'true' });
    }

    function stepper(value, onChange, label) {
        const set = (v) => onChange(Math.max(1, Math.min(400, Math.round(Number(v) || 1))));
        return h('div', { class: 'stepper' },
            h('button', { 'data-k': 'fewer', 'aria-label': 'Fewer pages', onclick: () => set(value - 1) }, icon('minus')),
            h('input', {
                type: 'number', min: '1', max: '400', inputmode: 'numeric', value: String(value), 'aria-label': label, 'data-k': 'pages',
                onchange: (e) => set(e.target.value)
            }),
            h('button', { 'data-k': 'more', 'aria-label': 'More pages', onclick: () => set(value + 1) }, icon('plus')));
    }

    function readyView() {
        const isStore = page.kind === 'storefront';
        const title = isStore ? (page.name || 'This storefront') : page.keyword ? `"${page.keyword}"` : 'These results';
        const total = isStore && page.total ? page.total : page.count;
        const busy = ui.busy === 'start';
        return [
            lede(title, plural(total, 'product')),
            noticeEl(),
            h('button', { class: 'primary', 'data-k': 'scrape', 'data-first': true, disabled: busy || !!ui.spread, onclick: () => startHere() },
                icon('play'), busy ? 'Starting' : 'Scrape')
        ];
    }

    function runningView(r) {
        const cur = Math.min((r.page || 0) + 1, r.maxPages);
        const stop = h('button', {
            class: 'secondary compact', 'data-k': 'stop', 'data-first': true, disabled: ui.busy === 'stop',
            'aria-label': `Stop and keep ${plural(r.itemCount, 'product')}`, onclick: stopRun
        }, icon('stop'), ui.busy === 'stop' ? 'Stopping' : 'Stop');
        return [
            h('div', { class: 'hero', role: 'status', 'aria-live': 'polite' },
                tally(r.itemCount, stop),
                ticks(r),
                h('p', { class: 'meta', text: `Page ${fmt(cur)} of ${fmt(r.maxPages)}${r.thisTab ? '' : ', in another tab'}` })),
            noticeEl()
        ];
    }

    function doneView(r, st) {
        const n = st.count || 0;
        let meta = null;
        if (r.reason === 'stopped') meta = h('p', { class: 'meta', text: 'Stopped' });
        else if (r.reason !== 'complete') meta = h('p', { class: 'meta warn', text: (Run.MESSAGES && Run.MESSAGES[r.reason]) || 'The run ended early.' });
        const again = scrapable && page.startable && !ui.spread
            ? h('button', {
                class: 'again', 'data-k': 'again', 'aria-label': 'Scrape again', title: 'Scrape again', disabled: ui.busy === 'start',
                onclick: () => { ui.notice = null; ui.menu = false; startHere(); }
            }, icon('again'))
            : null;
        const out = [
            h('div', { class: 'hero' }, tally(n), ticks(r), meta),
            noticeEl()
        ];
        if (n > 0) out.push(downloads(n, again));
        else if (again) out.push(h('button', { class: 'primary', 'data-k': 'scrape', 'data-first': true, onclick: () => startHere() }, icon('play'), 'Scrape again'));
        // Compare seller prices stays hidden until the offer parser works on
        // Amazon's current pages (audit F-30); a check already running still shows.
        if (ui.spread) out.push(spreadBlock(st));
        return out;
    }

    function elsewhereView(st) {
        let title = 'Open a search or a storefront';
        let sub = null;
        let action = null;
        if (scrapable && page.refusedKind) {
            title = 'ProScan cannot scrape this page';
            sub = Run.refusal(page.refusedKind);
        } else if ((page.kind === 'seller' || page.kind === 'store') && page.sellerId) {
            title = page.name || 'This seller';
            action = h('a', { class: 'primary', 'data-k': 'storefront-card', 'data-first': true, href: PageKind.storefrontUrl(page.sellerId) }, 'Open storefront');
        }
        const out = [lede(title, sub), action, noticeEl()];
        const r = run();
        if (st && st.count > 0 && r) {
            out.push(h('div', { class: 'hero' }, tally(st.count), ticks(r), h('p', { class: 'meta', text: `Last scrape: ${runLabel(r)}` })));
            out.push(downloads(st.count));
        }
        return out;
    }

    function scrapeView() {
        const st = ui.status;
        const r = run();
        if (ui.orphaned || !st) {
            if (!ui.notice && ui.orphaned) unreachable();
            return [lede('ProScan', st ? '' : 'Loading'), noticeEl()];
        }
        if (isLive(r)) return runningView(r);
        if (ui.spread || (isEnded(r) && r.thisTab)) return doneView(r, st);
        if (scrapable && page.startable) return readyView();
        return elsewhereView(st);
    }

    function askView() {
        const cs = ui.chat.status;
        if (!cs) return [h('p', { class: 'note', text: 'Loading' })];
        const out = [];
        const count = cs.productCount || 0;
        if (count > 0) {
            out.push(h('div', { class: 'scope', title: cs.source || '' }, icon('scan'), h('span', { text: plural(count, 'product') })));
        }
        if (cs.unreachable) {
            out.push(h('div', { class: 'notice', role: 'alert' }, h('span', { text: alive() ? 'Could not reach ProScan. Reload this page and try again.' : 'ProScan was updated. Reload this page to ask.' })));
            return out;
        }
        if (!cs.hasKey) {
            out.push(lede('Add a free Gemini key to ask'));
            out.push(h('button', { class: 'primary', 'data-k': 'add-key', 'data-first': true, onclick: () => openSettingsPage('key') }, 'Add key', icon('ext')));
            return out;
        }
        if (count === 0) {
            out.push(lede('Scrape something first'));
            return out;
        }
        const thread = h('div', { class: 'thread', 'aria-live': 'polite' });
        for (const m of ui.chat.messages) {
            thread.appendChild(h('div', { class: `msg ${m.who}${m.error ? ' error' : ''}${m.wait ? ' wait' : ''}`, text: m.wait ? 'Thinking...' : m.text }));
        }
        out.push(thread);
        if (ui.chat.messages.length === 0) {
            out.push(h('div', { class: 'chips' },
                ['Best under $30', 'Top rated', 'Sponsored ones'].map((q, i) =>
                    h('button', { class: 'chip', 'data-k': `chip-${i}`, text: q, onclick: () => ask(q) }))));
        }
        const input = h('input', {
            type: 'text', 'data-k': 'compose', 'data-first': true, placeholder: 'Ask anything', 'aria-label': 'Ask about these products',
            value: ui.chat.draft, autocomplete: 'off', disabled: ui.chat.sending,
            oninput: (e) => { ui.chat.draft = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(ui.chat.draft); } }
        });
        out.push(h('div', { class: 'compose' }, input,
            h('button', { class: 'send', 'data-k': 'send', 'aria-label': 'Send', disabled: ui.chat.sending, onclick: () => ask(ui.chat.draft) }, icon('send'))));
        return out;
    }

    function settingsView() {
        const st = ui.status || {};
        const s = settings();
        const version = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return ''; } })();
        const row = (label, control, id) => h('div', { class: 'row' }, h('span', { class: 'label', id: id || null, text: label }), control);
        const sections = [
            h('div', { class: 'set' },
                row('Pages per run', stepper(s.maxPages, (v) => saveSettings({ maxPages: v }), 'Pages per run')),
                row('Suggest Scrape', h('button', {
                    class: 'switch', role: 'switch', 'data-k': 'suggest', 'data-first': true, 'aria-checked': String(s.suggest !== false), 'aria-labelledby': 'ps-suggest-label',
                    onclick: () => saveSettings({ suggest: s.suggest === false })
                }), 'ps-suggest-label'),
                row('Gemini key', h('button', { class: 'secondary compact', 'data-k': 'key', onclick: () => openSettingsPage('key') }, st.hasKey ? 'Change' : 'Add', icon('ext'))),
                st.cloudSync
                    ? row('Dashboard sync', h('button', { class: 'secondary compact', 'data-k': 'sync', onclick: () => openSettingsPage('sync') }, st.signedIn ? 'Manage' : 'Sign in', icon('ext')))
                    : null)
        ];
        sections.push(noticeEl());
        if (version) sections.push(h('p', { class: 'foot' }, h('span', { text: `ProScan ${version}` })));
        return sections;
    }

    function card() {
        const view = ui.tab === 'settings' ? settingsView() : ui.tab === 'ask' ? askView() : scrapeView();
        const body = h('div', {
            class: 'body', id: 'ps-panel',
            role: ui.tab === 'settings' ? null : 'tabpanel',
            'aria-labelledby': ui.tab === 'settings' ? null : `ps-tab-${ui.tab}`
        }, view);
        return h('section', {
            class: 'card', role: 'dialog', 'aria-label': 'ProScan',
            style: ui.animate ? null : 'animation:none'
        }, header(), body);
    }

    // ── Rendering ───────────────────────────────────────────────

    function render({ focus } = {}) {
        if (!root) return;
        const active = shadow.activeElement;
        const keep = focus || pendingFocus || (active && active.getAttribute && active.getAttribute('data-k'));
        let caret = null;
        if (active && active.tagName === 'INPUT' && active.type === 'text') caret = [active.selectionStart, active.selectionEnd];
        const thread = root.querySelector('.thread');
        const stuck = thread ? thread.scrollHeight - thread.scrollTop - thread.clientHeight < 8 : true;

        const tb = ui.toast
            ? h('div', { class: 'toast' + (ui.toast.tone === 'warn' ? ' warn' : ''), role: ui.toast.tone === 'warn' ? 'alert' : 'status' },
                icon(ui.toast.tone === 'warn' ? 'warn' : 'ok'), h('span', { text: ui.toast.text }))
            : null;
        root.replaceChildren(...[tb, ui.open ? card() : launcher()].filter(Boolean));
        ui.animate = false;
        pendingFocus = null;

        const t = root.querySelector('.thread');
        if (t && stuck) t.scrollTop = t.scrollHeight;
        if (!keep) return;
        let el = null;
        if (keep === 'first') el = root.querySelector('[data-first]:not([disabled])') || root.querySelector('button:not([disabled])');
        else if (keep === 'launcher') el = root.querySelector('[data-k="launcher"]');
        else el = root.querySelector(`[data-k="${keep}"]:not([disabled])`);
        if (!el && active && root.contains(active)) el = root.querySelector('button:not([disabled])');
        if (el) {
            el.focus({ preventScroll: true });
            if (caret && el.tagName === 'INPUT' && typeof el.setSelectionRange === 'function') {
                try { el.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ }
            }
        }
    }

    function adoptStyles() {
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(DOCK_CSS);
            shadow.adoptedStyleSheets = [sheet];
            return;
        } catch (e) { /* no constructed sheets here */ }
        shadow.appendChild(h('style', { text: DOCK_CSS }));
    }

    function init() {
        const host = document.createElement('div');
        host.id = 'proscan-dock-host';
        host.setAttribute('style', 'all:initial;position:fixed;z-index:2147483647;right:0;bottom:0;width:0;height:0;');
        (document.body || document.documentElement).appendChild(host);
        shadow = host.attachShadow({ mode: 'closed' });
        adoptStyles();
        root = h('div', { class: 'dock' });
        // Keys typed in the dock stay out of Amazon's shortcuts.
        ['keydown', 'keyup', 'keypress'].forEach((type) => root.addEventListener(type, (e) => {
            if (type === 'keydown' && e.key === 'Escape' && ui.open) {
                e.preventDefault();
                if (ui.menu) { ui.menu = false; pendingFocus = 'formats'; render(); } else setOpen(false);
            }
            e.stopPropagation();
        }));
        shadow.appendChild(root);
        render();
        refresh();
        if (ui.open && ui.tab === 'ask') loadChat();

        chrome.runtime.onMessage.addListener((m) => {
            if (!alive() || !m) return false;
            if (m.type === 'RUN_PROGRESS' || m.type === 'RUN_ENDED') refresh();
            return false;
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
