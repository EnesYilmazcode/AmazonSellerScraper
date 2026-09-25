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
    const SEC_PER_PAGE = 6;
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
        gear: SVG('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M3.4 12.6l1.2-1.2M11.4 4.6l1.2-1.2"/>', { w: 1.5 }),
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
        plus: SVG('<path d="M3.5 8h9M8 3.5v9"/>', { w: 2 })
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

    function clock(ms) {
        try { return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
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
        pages: null,
        notice: null,
        busy: null,
        fresh: false,
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
        const wasLive = isLive(run());
        const st = await send({ type: 'RUN_STATUS' });
        if (st && !st.error) {
            ui.status = st;
            if (ui.pages === null) ui.pages = settings().maxPages;
            if (wasLive && !isLive(st.run)) ui.fresh = false;
        } else if (!alive()) {
            ui.orphaned = true;
        }
        render();
        // A background tab checks in less often; RUN_PROGRESS still reaches the run's own tab.
        if (isLive(run())) pollTimer = setTimeout(refresh, document.hidden ? POLL_MS * 5 : POLL_MS);
    }

    async function startHere(maxPages) {
        if (ui.busy) return;
        ui.busy = 'start';
        ui.notice = null;
        render();
        const r = await send({ type: 'START_RUN_HERE', maxPages });
        ui.busy = null;
        if (r && r.ok) {
            ui.fresh = false;
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
            ui.notice = { tone: 'info', text: `${FORMAT_LABEL[format]} download started.` };
        } else if (!r) {
            unreachable();
        } else {
            ui.notice = { tone: 'warn', text: r.message || 'ProScan could not make the file. Try again.' };
        }
        render();
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

    /** The pages strip: done, the one in progress, and pages the run never needed (hatched). */
    function ticks(r) {
        const max = Math.max(1, r.maxPages || 1);
        const n = Math.min(max, 20);
        const per = max / n;
        const done = r.page || 0;
        const live = isLive(r);
        const early = !live && r.reason === 'complete' && done < max;
        const row = h('div', { class: 'ticks', 'aria-hidden': 'true' });
        for (let i = 0; i < n; i++) {
            const from = i * per;
            const to = (i + 1) * per;
            let cls = '';
            if (done >= to - 1e-9) cls = 'done';
            else if (live && done >= from - 1e-9) cls = 'now';
            else if (!live && done > from) cls = 'done';
            else if (early) cls = 'skip';
            row.appendChild(h('i', { class: cls || null }));
        }
        return row;
    }

    function endLine(r) {
        if (r.reason !== 'complete') return null;
        if ((r.page || 0) < r.maxPages) {
            return `Page ${fmt(r.page)} was the last one, so the run ended early.`;
        }
        return `Stopped at your ${fmt(r.maxPages)}-page limit.`;
    }

    function noticeEl() {
        const n = ui.notice;
        if (!n) return null;
        return h('div', { class: 'notice' + (n.tone === 'info' ? ' info' : ''), role: n.tone === 'info' ? 'status' : 'alert' },
            h('span', { text: n.text }),
            n.action ? h('button', { text: n.action.label, 'data-k': 'notice', onclick: n.action.run }) : null);
    }

    function downloads(count) {
        const busy = (f) => ui.busy === f;
        return h('div', { class: 'actions' },
            h('button', { class: 'primary', 'data-k': 'xlsx', 'data-first': true, disabled: !!ui.busy, onclick: () => download('xlsx') },
                icon('down'), busy('xlsx') ? 'Making the Excel file' : 'Download Excel'),
            h('div', { class: 'formats' },
                h('button', { class: 'secondary', 'data-k': 'csv', disabled: !!ui.busy, 'aria-label': `Download ${plural(count, 'product')} as CSV`, onclick: () => download('csv') }, icon('file'), 'CSV'),
                h('button', { class: 'secondary', 'data-k': 'json', disabled: !!ui.busy, 'aria-label': `Download ${plural(count, 'product')} as JSON`, onclick: () => download('json') }, icon('file'), 'JSON')));
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
                mainButton('Open ProScan', `${plural(st.count, 'product')} saved`, 'Ready to download', mark({ badge: r.reason === 'complete' })),
                h('button', { class: 'pill', 'data-k': 'xlsx-quick', 'aria-label': 'Download Excel', disabled: !!ui.busy, onclick: () => download('xlsx') }, icon('down'), 'Excel'),
                chatButton(),
                hideButton('Hide for this tab'));
        }
        if (suggest && scrapable && page.startable) {
            const title = page.name || (page.kind === 'storefront' ? 'This storefront' : 'These results');
            const sub = page.kind === 'storefront' && page.total
                ? `${plural(page.total, 'product')} on this storefront`
                : `${plural(page.count, 'product')} on this page`;
            return launcherShell('suggest',
                mainButton(`Open ProScan for ${title}`, title, sub, mark()),
                h('button', { class: 'pill', 'data-k': 'scrape-quick', disabled: ui.busy === 'start', onclick: () => startHere() }, icon('play'), 'Scrape'),
                chatButton(),
                hideButton('Not now, hide for this tab'));
        }
        if (suggest && (page.kind === 'seller' || page.kind === 'store') && page.sellerId) {
            return launcherShell('suggest',
                mainButton('Open ProScan', page.name || 'This seller', 'Has a storefront to scrape', mark()),
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
        const pages = ui.pages || settings().maxPages;
        const willScrape = page.pagesAvail ? Math.min(pages, page.pagesAvail) : pages;
        const isStore = page.kind === 'storefront';
        const title = isStore ? `Scrape ${page.name || 'this storefront'}` : page.keyword ? `Scrape "${page.keyword}"` : 'Scrape these results';
        let sub;
        if (isStore && page.total) sub = `Seller storefront with ${plural(page.total, 'product')}${page.pagesAvail ? ` across about ${plural(page.pagesAvail, 'page')}` : ''}.`;
        else if (page.pagesAvail && page.pagesAvail > 1) sub = `${plural(page.count, 'product')} on this page, about ${plural(page.pagesAvail, 'page')} in all.`;
        else sub = `${plural(page.count, 'product')} on this page.`;
        const busy = ui.busy === 'start';
        return [
            lede(title, sub),
            h('div', { class: 'panel' },
                h('div', { class: 'row' },
                    h('div', { class: 'l' }, h('b', { text: 'Pages to scrape' }), h('span', { text: `${aboutTime(willScrape * SEC_PER_PAGE)} for ${plural(willScrape, 'page')}` })),
                    stepper(pages, (v) => { ui.pages = v; render(); }, 'Pages to scrape'))),
            noticeEl(),
            h('div', { class: 'actions' },
                h('button', { class: 'primary', 'data-k': 'scrape', 'data-first': true, disabled: busy || !!ui.spread, onclick: () => startHere(ui.pages || settings().maxPages) },
                    icon('play'), busy ? 'Starting' : isStore ? 'Scrape this storefront' : 'Scrape this search'),
                h('div', { class: 'split' },
                    h('p', { class: 'note' }, icon('info'), h('span', { text: 'ProScan turns the pages in this tab.' })),
                    h('button', { class: 'quiet', 'data-k': 'notnow-card', onclick: notNow, text: 'Not now' })))
        ];
    }

    function runningView(r) {
        const cur = Math.min((r.page || 0) + 1, r.maxPages);
        let left = '';
        if (r.page > 0 && r.startedAt) {
            const per = (Date.now() - r.startedAt) / 1000 / r.page;
            const secs = Math.max(0, (r.maxPages - r.page) * per);
            left = secs < 60 ? 'Under a minute left' : `About ${Math.round(secs / 60)} min left`;
        }
        return [
            lede(`Scraping ${runLabel(r)}`, r.thisTab ? 'Keep this tab open. You can keep browsing in other tabs.' : 'This scrape runs in another tab. Keep that tab open.'),
            h('div', { class: 'panel', role: 'status', 'aria-live': 'polite' },
                h('div', { class: 'progress-top' }, h('b', { text: `Page ${fmt(cur)} of ${fmt(r.maxPages)}` }), left ? h('span', { text: left }) : null),
                ticks(r),
                h('div', { class: 'count' }, h('b', { text: fmt(r.itemCount) }), ` ${r.itemCount === 1 ? 'product' : 'products'} saved so far`)),
            noticeEl(),
            h('div', { class: 'actions' },
                h('button', { class: 'secondary', 'data-k': 'stop', 'data-first': true, disabled: ui.busy === 'stop', onclick: stopRun },
                    icon('stop'), ui.busy === 'stop' ? 'Stopping' : `Stop and keep ${plural(r.itemCount, 'product')}`))
        ];
    }

    function facts(summary) {
        if (!summary) return null;
        const items = [];
        if (summary.medianCents !== null) items.push([`$${(summary.medianCents / 100).toFixed(2)}`, 'Median price']);
        if (summary.avgRating !== null) items.push([summary.avgRating.toFixed(1), 'Avg rating']);
        if (summary.sponsoredPct !== null) items.push([`${summary.sponsoredPct}%`, 'Sponsored']);
        if (!items.length) return null;
        return h('dl', { class: 'facts' }, items.map(([v, l]) => h('div', {}, h('dt', { text: l }), h('dd', { text: v }))));
    }

    function doneView(r, st) {
        const n = st.count || 0;
        let title;
        let sub;
        let kind;
        if (r.reason === 'complete') {
            kind = 'ok';
            title = `${plural(n, 'product')} saved`;
            const at = r.finishedAt ? ` at ${clock(r.finishedAt)}` : '';
            sub = (r.page || 0) < r.maxPages
                ? `Reached the last page${at}, ${plural(r.page, 'page')} in all.`
                : `${plural(r.page, 'page')}, finished${at}.`;
        } else if (r.reason === 'stopped') {
            kind = 'neutral';
            title = `Stopped with ${plural(n, 'product')}`;
            sub = `You stopped it after page ${fmt(r.page)} of ${fmt(r.maxPages)}.`;
        } else {
            kind = 'warn';
            title = n > 0 ? `${plural(n, 'product')} saved` : 'Nothing was saved';
            sub = (Run.MESSAGES && Run.MESSAGES[r.reason]) || 'The run ended early.';
        }
        const line = endLine(r);
        const out = [
            lede(title, sub, stateIcon(kind)),
            h('div', { class: 'panel' },
                ticks(r),
                line ? h('p', { class: 'endline', text: line }) : null,
                n > 0 && facts(st.summary) ? h('div', { style: 'margin-top:12px' }, facts(st.summary)) : null),
            noticeEl()
        ];
        if (n > 0) {
            out.push(downloads(n));
            out.push(spreadBlock(st));
        }
        if (scrapable && page.startable && !ui.spread) {
            out.push(h('div', { class: 'split' },
                h('span', {}),
                h('button', { class: 'quiet', 'data-k': 'again', onclick: () => { ui.fresh = true; ui.notice = null; pendingFocus = 'first'; render(); }, text: 'Scrape again' })));
        }
        return out;
    }

    function elsewhereView(st) {
        let title = 'Open a search or a storefront';
        let sub = 'ProScan scrapes Amazon search results and seller storefronts. Open one and press Scrape.';
        let action = null;
        if (scrapable && page.refusedKind) {
            title = 'ProScan cannot scrape this page yet';
            sub = Run.refusal(page.refusedKind);
        } else if ((page.kind === 'seller' || page.kind === 'store') && page.sellerId) {
            title = page.name ? `${page.name} has a storefront` : 'This seller has a storefront';
            sub = 'Open it to scrape every product the seller lists.';
            action = h('a', { class: 'primary', 'data-k': 'storefront-card', 'data-first': true, href: PageKind.storefrontUrl(page.sellerId) }, 'Open the storefront');
        }
        const out = [lede(title, sub), action, noticeEl()];
        const r = run();
        if (st && st.count > 0 && r) {
            out.push(h('div', { class: 'panel' },
                h('div', { class: 'progress-top' }, h('b', { text: 'Last scrape' }), h('span', { text: r.finishedAt ? clock(r.finishedAt) : '' })),
                h('div', { class: 'count', style: 'margin-top:6px' }, h('b', { text: fmt(st.count) }), ` ${st.count === 1 ? 'product' : 'products'} from ${runLabel(r)}`),
                ticks(r)));
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
        if (ui.spread || (isEnded(r) && r.thisTab && !ui.fresh)) return doneView(r, st);
        if (scrapable && page.startable) return readyView();
        return elsewhereView(st);
    }

    function askView() {
        const cs = ui.chat.status;
        if (!cs) return [h('p', { class: 'note', text: 'Loading' })];
        const out = [];
        const count = cs.productCount || 0;
        if (count > 0) {
            out.push(h('div', { class: 'scope' }, icon('scan'),
                h('span', { text: `Answers use this scan: ${cs.source || 'your last scan'}, ${plural(count, 'item')}` })));
        }
        if (cs.unreachable) {
            out.push(h('div', { class: 'notice', role: 'alert' }, h('span', { text: alive() ? 'Could not reach ProScan. Reload this page and try again.' : 'ProScan was updated. Reload this page to ask.' })));
            return out;
        }
        if (!cs.hasKey) {
            out.push(lede('Answers need your own Gemini key', 'It is free from Google AI Studio and stays on this computer. You add it on ProScan\'s settings page, not on Amazon.'));
            out.push(h('button', { class: 'primary', 'data-k': 'add-key', 'data-first': true, onclick: () => openSettingsPage('key') }, 'Add a key in ProScan settings', icon('ext')));
            return out;
        }
        if (count === 0) {
            out.push(lede('Nothing to ask about yet', 'Scrape a search or a storefront first, then ask about what it found.'));
            return out;
        }
        const thread = h('div', { class: 'thread', 'aria-live': 'polite' });
        if (ui.chat.messages.length === 0) {
            thread.appendChild(h('div', { class: 'msg ai', text: `Ask anything about these ${plural(count, 'product')}: prices, ratings, sellers, which to skip.` }));
        }
        for (const m of ui.chat.messages) {
            thread.appendChild(h('div', { class: `msg ${m.who}${m.error ? ' error' : ''}${m.wait ? ' wait' : ''}`, text: m.wait ? 'Thinking...' : m.text }));
        }
        out.push(thread);
        if (ui.chat.messages.length === 0) {
            out.push(h('div', { class: 'chips' },
                ['Best value under $30', 'Which ones are sponsored?', 'Highest rated with 1,000+ reviews'].map((q, i) =>
                    h('button', { class: 'chip', 'data-k': `chip-${i}`, text: q, onclick: () => ask(q) }))));
        }
        const input = h('input', {
            type: 'text', 'data-k': 'compose', 'data-first': true, placeholder: 'Ask about these products', 'aria-label': 'Ask about these products',
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
        const statusDot = (on, text) => h('span', { class: 'status' + (on ? ' on' : '') }, h('i', {}), text);
        const sections = [
            h('div', { class: 'set' },
                h('div', { class: 'row' },
                    h('div', { class: 'l' }, h('b', { text: 'Pages per run' }), h('span', { text: 'Up to 400. Fewer pages finish faster.' })),
                    stepper(s.maxPages, (v) => { ui.pages = v; saveSettings({ maxPages: v }); }, 'Pages per run')),
                h('div', { class: 'row' },
                    h('div', { class: 'l', id: 'ps-suggest-label' }, h('b', { text: 'Suggest Scrape' }), h('span', { text: 'On search results and storefronts' })),
                    h('button', {
                        class: 'switch', role: 'switch', 'data-k': 'suggest', 'data-first': true, 'aria-checked': String(s.suggest !== false), 'aria-labelledby': 'ps-suggest-label',
                        onclick: () => saveSettings({ suggest: s.suggest === false })
                    }))),
            h('div', { class: 'set' },
                h('div', { class: 'row' },
                    h('div', { class: 'l' }, h('b', { text: 'AI answers' }), statusDot(!!st.hasKey, st.hasKey ? 'Gemini key added' : 'No key yet')),
                    h('button', { class: 'secondary compact', 'data-k': 'key', onclick: () => openSettingsPage('key') }, st.hasKey ? 'Change key' : 'Add key', icon('ext'))),
                h('p', { class: 'note' }, icon('info'), h('span', { text: 'Keys are entered on ProScan\'s own settings page, never on an Amazon page.' })))
        ];
        if (st.cloudSync) {
            sections.push(h('div', { class: 'set' },
                h('div', { class: 'row' },
                    h('div', { class: 'l' }, h('b', {}, 'Dashboard sync ', h('span', { class: 'optional', text: '(optional)' })), statusDot(!!st.signedIn, st.signedIn ? 'Signed in' : 'Not signed in')),
                    h('button', { class: 'secondary compact', 'data-k': 'sync', onclick: () => openSettingsPage('sync') }, st.signedIn ? 'Manage' : 'Sign in', icon('ext')))));
        }
        sections.push(noticeEl());
        sections.push(h('p', { class: 'foot' }, h('span', { text: 'Scans stay on this computer unless you sign in.' }), h('span', { text: version ? `ProScan ${version}` : '' })));
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

        root.replaceChildren(ui.open ? card() : launcher());
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
                setOpen(false);
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
