/**
 * @fileoverview Popup UI Controller
 *
 * The popup is the fallback to the dock on the page (scripts/content/dock.js).
 * It says what the current tab is, offers the same Scrape, follows the run,
 * downloads the latest run's files, and holds the two things that must never
 * be typed on an Amazon page: the Gemini key and the ProScan sign-in.
 *
 * State Management:
 * The service worker owns the run and everything it found. The popup never
 * writes either: it asks the worker (GET_STATE) and renders the whole view
 * from the run record it gets back, and again whenever the record in
 * chrome.storage.session changes.
 *
 * Communication:
 * - START_RUN / STOP_RUN / GET_STATE to the worker (scripts/lib/messages.js)
 * - PING to the active tab: what kind of page it is, and to start after a reload
 * - SPREAD_ANALYSIS_COMPLETE from the offer fetcher
 *
 * Opened in a tab as popup.html#key or #sync (the dock's settings links),
 * it unfolds that setting.
 *
 * @module PopupUI
 * @requires Storage
 * @requires Analyzer
 * @requires Exporter
 */

/** @type {boolean} Whether scraping is currently in progress */
let isScrapingActive = false;

/** @type {Object[]} Products of the latest run, from the worker */
let currentResults = [];

/** @type {Object} Spread data of the latest run, ASIN to offers */
let currentSpread = {};

/** @type {?Object} The latest run record, from the worker */
let currentRun = null;

/** @type {number} Page of the live run the results were last fetched for */
let renderedPage = -1;

/** @type {boolean} Whether spread analysis is currently running */
let isSpreadAnalyzing = false;

/** @type {?{uid:string,email:string,displayName:string}} Signed-in ProScan user, or null */
let currentProScanUser = null;

/** @type {boolean} Whether a cloud export to ProScan is in progress */
let isExporting = false;

/** @type {?{kind: string, count: number, url: string, title: string, where: Object}} The active tab, as last seen */
let currentTab = null;

/** @type {number} Bumped per refreshTab call, so only the newest one draws */
let tabSeq = 0;

/** Inline icons: the popup loads nothing from the network. */
const ICONS = {
    play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z"/></svg>',
    stop: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
    down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>',
    spin: '<span class="spinner" aria-hidden="true"></span>'
};

/** Sets a button to an icon and a text label; the label is text, never HTML. */
function setButton(button, icon, label) {
    button.innerHTML = icon ? ICONS[icon] : '';
    button.appendChild(document.createTextNode((icon ? ' ' : '') + label));
}

/**
 * Cached references to DOM elements used throughout the popup lifecycle.
 * @const {Object<string, HTMLElement>}
 */
const elements = {
    itemCount: document.getElementById('itemCount'),
    itemWord: document.getElementById('itemWord'),
    status: document.getElementById('status'),
    hereTitle: document.getElementById('hereTitle'),
    hereSub: document.getElementById('hereSub'),
    actionButton: document.getElementById('actionButton'),
    reloadTabButton: document.getElementById('reloadTabButton'),
    lastScrape: document.getElementById('lastScrape'),
    lastSource: document.getElementById('lastSource'),
    lastBig: document.getElementById('lastBig'),
    lastTicks: document.getElementById('lastTicks'),
    exportButtons: document.getElementById('exportButtons'),
    downloadExcel: document.getElementById('downloadExcel'),
    downloadMore: document.getElementById('downloadMore'),
    downloadMenu: document.getElementById('downloadMenu'),
    downloadCSV: document.getElementById('downloadCSV'),
    downloadJSON: document.getElementById('downloadJSON'),
    spreadButton: document.getElementById('spreadButton'),
    aiKeySummary: document.getElementById('aiKeySummary'),
    // ProScan cloud auth + export
    authForm: document.getElementById('authForm'),
    authEmail: document.getElementById('authEmail'),
    authPassword: document.getElementById('authPassword'),
    authSignInBtn: document.getElementById('authSignInBtn'),
    authError: document.getElementById('authError'),
    authAccount: document.getElementById('authAccount'),
    authStatusEmail: document.getElementById('authStatusEmail'),
    authSignOutBtn: document.getElementById('authSignOutBtn'),
    authNotice: document.getElementById('authNotice'),
    authResetBtn: document.getElementById('authResetBtn'),
    authSignUpLink: document.getElementById('authSignUpLink'),
    authSummarySub: document.getElementById('authSummarySub'),
    authSync: document.getElementById('authSync'),
    exportToProScanBtn: document.getElementById('exportToProScanBtn')
};

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;

/** The count in the last-scrape card. */
function updateStats(results) {
    currentResults = results;
    elements.itemCount.textContent = fmt(results.length);
    elements.itemWord.textContent = results.length === 1 ? 'product' : 'products';
}

/**
 * Show a status line under the tab description, or hide it with ''.
 *
 * @param {string} message - Status message text
 * @param {'info'|'success'|'error'|'warning'} [type='info'] - Status type for styling
 */
function updateStatus(message, type = 'info') {
    elements.status.textContent = message || '';
    elements.status.className = 'status ' + type + (message ? '' : ' hidden');
}

/**
 * Toggle the main button between Scrape and Stop.
 *
 * @param {boolean} isActive - Whether scraping is in progress
 */
function setScrapingState(isActive) {
    isScrapingActive = isActive;
    elements.actionButton.classList.toggle('stop', isActive);
    if (isActive) {
        setButton(elements.actionButton, 'stop', 'Stop');
    } else {
        setButton(elements.actionButton, 'play', 'Scrape');
    }
    elements.exportButtons.classList.toggle('hidden', isActive || currentResults.length === 0);
    if (isActive) showFormats(false);
}

const DOWNLOAD_LABELS = { downloadExcel: 'Excel', downloadCSV: 'CSV', downloadJSON: 'JSON' };

/** Opens or closes the CSV and JSON row under Download Excel. */
function showFormats(open) {
    elements.downloadMenu.classList.toggle('hidden', !open);
    elements.downloadMore.setAttribute('aria-expanded', String(open));
}

/**
 * Toggle loading state on a download button during export generation.
 *
 * @param {HTMLButtonElement} button - The download button element
 * @param {boolean} loading - True while the file is made
 */
function setDownloadLoading(button, loading) {
    button.disabled = loading;
    if (loading) setButton(button, 'spin', 'Making');
    else if (button.id === 'downloadExcel') setButton(button, 'down', 'Download Excel');
    else setButton(button, null, DOWNLOAD_LABELS[button.id]);
}

/** The pages strip: one segment per page up to the page limit, filled as pages are scraped. */
function drawTicks(run) {
    const box = elements.lastTicks;
    box.textContent = '';
    if (!run) return;
    const done = run.page || 0;
    const max = Math.max(1, run.maxPages || 1, done);
    const n = Math.min(max, 20);
    const per = max / n;
    const live = Run.isActive(run);
    for (let i = 0; i < n; i++) {
        const tick = document.createElement('i');
        if (done >= (i + 1) * per - 1e-9) tick.className = 'done';
        else if (live && done >= i * per - 1e-9) tick.className = 'now';
        box.appendChild(tick);
    }
}

/** What a run scraped: the store name or the keyword in quotes. */
function sourceLabel(run) {
    const src = (run && run.source) || {};
    if (src.type === 'storefront') return src.name || 'Storefront';
    return src.keyword ? `"${src.keyword}"` : 'Search';
}

/** The last-scrape card: count, source and the pages strip. */
function renderLast(run) {
    const has = !!run && (currentResults.length > 0 || Run.isActive(run));
    elements.lastScrape.classList.toggle('hidden', !has);
    if (!has) return;
    elements.lastSource.textContent = sourceLabel(run);
    // While a run is live the heading above already has the count.
    elements.lastBig.classList.toggle('hidden', Run.isActive(run));
    drawTicks(run);
}

/** The name of the page in the tab: the store, the "keyword" or the seller. */
function tabName(tab) {
    const where = tab.where || {};
    if (where.kind === 'search') return where.keyword ? `"${where.keyword}"` : null;
    const t = String(tab.title || '')
        .replace(/^\s*Amazon\.com\s*[:|-]?\s*/i, '')
        .replace(/^Seller Profile\s*[:|-]?\s*/i, '')
        .trim();
    return t && t.length <= 60 && !/^amazon/i.test(t) ? t : null;
}

/** Sets the heading and its one muted line; an empty sub hides the line. */
function setHere(title, sub, canScrape) {
    elements.hereTitle.textContent = title;
    elements.hereSub.textContent = sub || '';
    elements.hereSub.classList.toggle('hidden', !sub);
    elements.actionButton.classList.toggle('hidden', !canScrape);
}

/** The top of the popup: what the active tab is and whether Scrape works there. */
function renderHere() {
    const run = currentRun;
    if (Run.isActive(run)) {
        setHere(`Page ${fmt(Math.min((run.page || 0) + 1, run.maxPages))} of ${fmt(run.maxPages)}`, plural(run.itemCount || 0, 'product'), true);
        return;
    }
    const tab = currentTab;
    const where = tab && tab.where ? tab.where : { kind: 'other' };
    if (!isScrapingActive) setButton(elements.actionButton, 'play', 'Scrape');
    const scrapable = where.kind === 'search' || where.kind === 'storefront';
    if (scrapable && tab.kind && !Run.STARTABLE.includes(tab.kind)) {
        setHere('Nothing to scrape yet', Run.refusal(tab.kind), false);
    } else if (scrapable) {
        // A tab that did not answer still gets Scrape, which offers to reload it.
        const name = tabName(tab) || (where.kind === 'storefront' ? 'Storefront' : 'Search results');
        setHere(name, tab.kind ? plural(tab.count, 'product') : '', true);
    } else if (where.kind === 'seller' && where.sellerId) {
        setHere(tabName(tab) || 'Open the storefront', '', false);
    } else {
        setHere('Open a search or a storefront', '', false);
    }
}

/**
 * Render the whole view from the worker's state: the run record, its
 * products and its spread data.
 *
 * @param {{run: ?Object, results: Object[], spread: Object}} state
 */
function render(state) {
    const run = (state && state.run) || null;
    currentRun = run;
    currentResults = (state && state.results) || [];
    currentSpread = (state && state.spread) || {};
    isScrapingActive = Run.isActive(run);
    renderedPage = run ? run.page : -1;

    updateStats(currentResults);
    setScrapingState(isScrapingActive);
    renderHere();
    renderLast(run);

    const line = Run.describe(run, currentResults.length);
    if (line && !isScrapingActive && run.reason !== 'complete') updateStatus(line.text, line.type);
    else updateStatus('');

    // Compare seller prices (#spreadButton) stays hidden: Amazon's current
    // offer pages broke the price check (audit F-30).
}

/** Fetch the worker's state and render it. */
async function refresh() {
    const state = await sendToWorker({ type: Msg.T.GET_STATE });
    if (state && (state.run || !state.error)) render(state);
    else updateStatus('Could not reach ProScan. Close and reopen the popup.', 'error');
    return state;
}

/** Warn when the extension's storage is nearly full. */
async function warnIfNearlyFull() {
    if (isScrapingActive) return;
    try {
        const { usage, quota } = await navigator.storage.estimate();
        if (quota && usage >= quota * Storage.NEAR_FULL) {
            const pct = Math.round((usage / quota) * 100);
            updateStatus(`Storage is ${pct}% full. Download your results.`, 'warning');
        }
    } catch (e) { /* no estimate in this context */ }
}

/** The tab the popup was opened over, or null. */
function activeTab() {
    return new Promise(resolve => {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve((tabs && tabs[0]) || null));
    });
}

/** Sends `message` to tab `tabId`; resolves null when nothing answers. */
function sendToTab(tabId, message) {
    return new Promise(resolve => {
        try {
            chrome.tabs.sendMessage(tabId, message, response => {
                if (chrome.runtime.lastError) return resolve(null);
                resolve(response || null);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

const AMAZON_URL = /^https:\/\/([a-z0-9-]+\.)*amazon\.com\//i;

/** Looks at the active tab (PING) and redraws the top of the popup. */
async function refreshTab() {
    const seq = ++tabSeq;
    const tab = await activeTab();
    let seen;
    if (!tab || !AMAZON_URL.test(tab.url || '')) {
        seen = tab ? { kind: null, count: 0, url: tab.url || '', title: '', where: { kind: 'other' } } : null;
    } else {
        const pong = await sendToTab(tab.id, { type: Msg.T.PING });
        seen = {
            kind: pong && pong.ok ? pong.kind : null,
            count: pong && pong.ok ? pong.count : 0,
            url: tab.url,
            title: (pong && pong.title) || tab.title || '',
            where: PageKind.classify(tab.url)
        };
    }
    // A later call (the popup aimed at another tab) wins.
    if (seq !== tabSeq) return;
    currentTab = seen;
    renderHere();
}

/**
 * Initialize the popup UI from the worker's state.
 *
 * @async
 */
async function initializeUI() {
    await refresh();
    await refreshTab();
    await warnIfNearlyFull();
}

/**
 * Start a new scraping session.
 *
 * The worker pings the tab and changes nothing if the content script is not
 * there (an open tab keeps the old script after an update) or the page is
 * not a search. The 10 newest runs are kept; the view moves to the new one.
 *
 * @async
 */
async function startScraping() {
    elements.reloadTabButton.classList.add('hidden');
    const tab = await activeTab();
    if (!tab || !AMAZON_URL.test(tab.url || '')) {
        updateStatus(Run.refusal('unknown'), 'warning');
        return;
    }

    const resp = await sendToWorker({ type: Msg.T.START_RUN, tabId: tab.id });
    if (resp && resp.ok) {
        await refresh();
        return;
    }
    if (resp && resp.error === 'no_receiver') {
        offerReload(tab.id);
        return;
    }
    refreshTab();
    updateStatus((resp && (resp.message || resp.error)) || 'Could not start the run.', 'warning');
}

/**
 * The tab has no live content script. Offer to reload it, then start once
 * the reloaded page has finished loading.
 *
 * @param {number} tabId
 */
function offerReload(tabId) {
    updateStatus('ProScan is not running on this tab yet. Reload the tab to start.', 'warning');
    elements.reloadTabButton.classList.remove('hidden');
    elements.reloadTabButton.onclick = () => {
        elements.reloadTabButton.classList.add('hidden');
        updateStatus('Reloading the tab...', 'info');
        const onUpdated = (id, info) => {
            if (id !== tabId || info.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            startWhenReady(tabId, 10);
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.reload(tabId);
    };
}

/** Starts once the reloaded tab answers a ping, trying a few times. */
async function startWhenReady(tabId, tries) {
    const pong = await sendToTab(tabId, { type: Msg.T.PING });
    if (pong && pong.ok) return startScraping();
    if (tries <= 1) {
        updateStatus('The tab still does not answer. Close it and open the search again.', 'error');
        return;
    }
    setTimeout(() => startWhenReady(tabId, tries - 1), 300);
}

/**
 * Stop the current run. The worker cancels the pending page and records
 * the run as stopped.
 *
 * @async
 */
async function stopScraping() {
    await sendToWorker({ type: Msg.T.STOP_RUN });
    await refresh();
}

// --- Spread Analysis ---
// The button is hidden (audit F-30); this is kept so it can come back.

function setSpreadButton(running) {
    elements.spreadButton.textContent = running ? 'Stop checking seller prices' : 'Compare seller prices';
    // Starting a run navigates the tab and would cut the analysis off.
    elements.actionButton.disabled = running;
}

function toggleSpreadAnalysis() {
    if (currentResults.length === 0) return;
    isSpreadAnalyzing = !isSpreadAnalyzing;
    setSpreadButton(isSpreadAnalyzing);
    const type = isSpreadAnalyzing ? Msg.T.START_SPREAD_ANALYSIS : Msg.T.STOP_SPREAD_ANALYSIS;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        chrome.tabs.sendMessage(tabs[0].id, { type });
    });
}

// --- ProScan Cloud Auth + Export ---


/**
 * Send a message to the background service worker and resolve with its
 * response. The sync/auth handlers are async (return true), so responses may
 * arrive after a Firebase cold start.
 *
 * @param {Object} message - Message payload (must include a `type`)
 * @returns {Promise<Object>} The worker's response, or {error} on channel failure
 */
function sendToWorker(message) {
    return new Promise(resolve => {
        chrome.runtime.sendMessage(message, response => {
            if (chrome.runtime.lastError) {
                resolve({ error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response || {});
        });
    });
}

/**
 * Render the signed-in account state: show the email + sign-out button,
 * hide the sign-in form, and reveal the cloud-export button.
 *
 * @param {{uid:string,email:string,displayName:string}} user
 */
function showSignedIn(user) {
    currentProScanUser = user;
    elements.authStatusEmail.textContent = user.email || user.displayName || 'Signed in';
    elements.authSummarySub.textContent = 'Signed in';
    elements.authForm.classList.add('hidden');
    elements.authAccount.classList.remove('hidden');
    elements.authError.classList.add('hidden');
    elements.authError.textContent = '';
    elements.authNotice.classList.add('hidden');
    elements.exportToProScanBtn.classList.toggle('hidden', !Flags.CLOUD_SYNC);
}

/**
 * The sync line under the account: what is waiting, or when it last synced.
 *
 * @param {{pending?: number, failed?: number, lastSync?: ?{at:number, error:?string}}} state
 */
function showSyncState(state) {
    const pending = (state && state.pending) || 0;
    const failed = (state && state.failed) || 0;
    const last = state && state.lastSync;
    let text = '';
    if (pending > 0) {
        text = `${plural(pending, 'page')} waiting to sync.`;
        if (last && last.error) text += ' The last try failed.';
    } else if (last && !last.error) {
        text = 'All synced.';
    }
    if (failed > 0) text += ` ${plural(failed, 'page')} refused.`;
    text = text.trim();
    elements.authSync.textContent = text;
    elements.authSync.classList.toggle('hidden', !text);
}

/**
 * Render the signed-out state: show the sign-in form, hide the account state,
 * and hide the cloud-export button.
 */
function showSignInForm(notice = null) {
    currentProScanUser = null;
    elements.authAccount.classList.add('hidden');
    elements.authSync.classList.add('hidden');
    elements.authNotice.textContent = notice === 'expired'
        ? 'Session expired. Sign in again.'
        : '';
    elements.authNotice.classList.toggle('hidden', notice !== 'expired');
    elements.authSummarySub.textContent = 'Off';
    // An expired session is the one case worth unfolding the panel for.
    if (notice === 'expired') document.getElementById('authPanel').open = true;
    elements.authForm.classList.remove('hidden');
    elements.authError.classList.add('hidden');
    elements.authError.textContent = '';
    elements.exportToProScanBtn.classList.add('hidden');
    resetSignInButton();
}

/**
 * Show an inline error message under the sign-in form.
 *
 * @param {string} message
 */
function showAuthError(message) {
    elements.authError.textContent = message;
    elements.authError.classList.remove('hidden');
}

/**
 * Ask the worker to send a password reset email for the typed address.
 * The answer is the same whether or not the account exists.
 *
 * @async
 */
async function handleResetPassword() {
    const email = elements.authEmail.value.trim();
    if (!email) {
        showAuthError('Enter your email above, then tap Forgot password.');
        return;
    }
    elements.authResetBtn.disabled = true;
    const response = await sendToWorker({ type: Msg.T.PROSCAN_RESET_PASSWORD, email });
    elements.authResetBtn.disabled = false;
    if (response && response.ok) {
        elements.authError.classList.add('hidden');
        elements.authNotice.textContent = response.message;
        elements.authNotice.classList.remove('hidden');
    } else {
        showAuthError((response && response.error) || 'Could not send the reset email.');
    }
}

/**
 * Restore the sign-in button to its idle state.
 */
function resetSignInButton() {
    elements.authSignInBtn.disabled = false;
    setButton(elements.authSignInBtn, null, 'Sign in');
}

/**
 * Query the worker for the current auth state on popup open and render the
 * matching view (sign-in form vs signed-in account).
 *
 * @async
 */
async function initializeAuthUI() {
    // Sign-in only serves the cloud export, which is off in this build.
    if (!Flags.CLOUD_SYNC) return;
    document.getElementById('authPanel').classList.remove('hidden');
    const response = await sendToWorker({ type: Msg.T.PROSCAN_AUTH_STATE });
    if (response && response.dashboardUrl) elements.authSignUpLink.href = response.dashboardUrl;
    if (response && response.user) {
        showSignedIn(response.user);
        showSyncState(response);
    } else {
        showSignInForm(response && response.notice);
    }
}

/**
 * Sign in to ProScan with the entered email/password. Disables the button and
 * shows a spinner while the worker talks to Firebase.
 *
 * @async
 */
async function handleSignIn() {
    const email = elements.authEmail.value.trim();
    const password = elements.authPassword.value;

    elements.authError.classList.add('hidden');

    if (!email || !password) {
        showAuthError('Enter your email and password.');
        return;
    }

    elements.authSignInBtn.disabled = true;
    setButton(elements.authSignInBtn, 'spin', 'Signing in');

    const response = await sendToWorker({ type: Msg.T.PROSCAN_SIGN_IN, email, password });

    if (response && response.user) {
        elements.authPassword.value = '';
        showSignedIn(response.user);
        showSyncState({ pending: 0 });
    } else {
        showAuthError((response && response.error) || 'Sign-in failed.');
        resetSignInButton();
    }
}

/**
 * Sign out of ProScan and return to the sign-in form.
 *
 * @async
 */
async function handleSignOut() {
    elements.authSignOutBtn.disabled = true;
    const response = await sendToWorker({ type: Msg.T.PROSCAN_SIGN_OUT });
    elements.authSignOutBtn.disabled = false;

    if (response && response.ok) {
        showSignInForm();
    } else {
        updateStatus((response && response.error) || 'Sign-out failed.', 'error');
    }
}

/**
 * Push the latest scrape to the signed-in user's ProScan cloud workspace.
 * Nudges the user to sign in first if needed; otherwise disables the button,
 * shows progress, and reports the result via the status bar.
 *
 * @async
 */
async function handleExportToProScan() {
    if (!currentProScanUser) {
        updateStatus('Sign in to ProScan first.', 'warning');
        return;
    }
    if (isExporting) return;

    isExporting = true;
    elements.exportToProScanBtn.disabled = true;
    setButton(elements.exportToProScanBtn, 'spin', 'Sending');
    updateStatus('Sending to your dashboard.', 'info');

    const response = await sendToWorker({ type: Msg.T.PROSCAN_EXPORT });

    if (response && response.ok) {
        const count = response.products || 0;
        const failed = response.failed || 0;
        if (failed > 0) {
            updateStatus(`Synced ${count} product${count === 1 ? '' : 's'}; ${failed} page${failed === 1 ? '' : 's'} could not sync.`, 'warning');
        } else if (!response.entries) {
            updateStatus('Everything is already synced.', 'info');
        } else {
            updateStatus(`Synced ${count} product${count === 1 ? '' : 's'} to ProScan`, 'success');
        }
        showSyncState({ pending: 0, failed, lastSync: { at: Date.now(), error: null } });
    } else if (response && response.expired) {
        showSignInForm('expired');
        updateStatus(response.error, 'warning');
    } else {
        updateStatus((response && response.error) || 'Export failed.', 'error');
    }

    isExporting = false;
    elements.exportToProScanBtn.disabled = false;
    setButton(elements.exportToProScanBtn, null, 'Send to dashboard');
}

// --- Event Listeners ---

// ProScan cloud auth + export
elements.authSignInBtn.addEventListener('click', handleSignIn);
elements.authSignOutBtn.addEventListener('click', handleSignOut);
elements.authResetBtn.addEventListener('click', handleResetPassword);
elements.exportToProScanBtn.addEventListener('click', handleExportToProScan);

// Enter-to-submit from the password field
elements.authPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        handleSignIn();
    }
});

elements.spreadButton.addEventListener('click', toggleSpreadAnalysis);

// Action button: toggle scraping on/off
elements.actionButton.addEventListener('click', async () => {
    // One click at a time: start waits on the tab before it changes anything.
    elements.actionButton.disabled = true;
    try {
        if (!isScrapingActive) {
            await startScraping();
        } else {
            await stopScraping();
        }
    } catch (err) {
        console.error('[ProScan] Start or stop failed:', err && err.message);
        updateStatus('Something went wrong. Close and reopen the popup, then try again.', 'error');
    } finally {
        elements.actionButton.disabled = isSpreadAnalyzing;
    }
});

/**
 * Makes the file for `format` with Exporter.build (the same code the
 * worker uses for the page) and opens the save dialog.
 */
function downloadFile(button, format) {
    if (currentResults.length === 0) {
        updateStatus('There is nothing to download yet.', 'warning');
        return;
    }
    setDownloadLoading(button, true);
    try {
        const { blob, filename } = Exporter.build(format, currentResults, currentSpread);
        Exporter.triggerDownload(blob, filename, (downloadId) => {
            if (!downloadId) updateStatus('The download did not start. Try again.', 'error');
            setDownloadLoading(button, false);
            showFormats(false);
        });
    } catch (error) {
        console.error('[ProScan] Export failed:', error);
        updateStatus(`ProScan could not make the ${DOWNLOAD_LABELS[button.id]} file.`, 'error');
        setDownloadLoading(button, false);
    }
}

elements.downloadExcel.addEventListener('click', () => downloadFile(elements.downloadExcel, 'xlsx'));
elements.downloadCSV.addEventListener('click', () => downloadFile(elements.downloadCSV, 'csv'));
elements.downloadJSON.addEventListener('click', () => downloadFile(elements.downloadJSON, 'json'));
elements.downloadMore.addEventListener('click', () => showFormats(elements.downloadMenu.classList.contains('hidden')));

// The offer fetcher in the tab says when the seller price check is done.
chrome.runtime.onMessage.addListener((request) => {
    if (request && request.type === Msg.T.SPREAD_ANALYSIS_COMPLETE) {
        isSpreadAnalyzing = false;
        setSpreadButton(false);
        refresh();
    }
    return false;
});

// The worker writes the run record to session storage on every change, so
// the view follows it: a new page, the end of the run, a closed tab.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.geminiApiKey) showKeySummary(!!changes.geminiApiKey.newValue);
    if (area !== 'session' || !changes[Run.KEY]) return;
    const run = changes[Run.KEY].newValue;
    if (!run) return;
    if (!Run.isActive(run) || run.page !== renderedPage || !isScrapingActive) {
        refresh();
    } else {
        currentRun = run;
        renderHere();
        setScrapingState(true);
    }
});

/** The state on the right of the Gemini key row. */
function showKeySummary(set) {
    elements.aiKeySummary.textContent = set ? 'Added' : 'Not set';
}

/** popup.html#key or #sync, opened from the dock: unfold that setting. */
function openFromHash() {
    const hash = (location.hash || '').slice(1);
    if (!hash) return;
    document.body.classList.add('in-tab');
    const panel = document.getElementById(hash === 'sync' ? 'authPanel' : 'aiSettings');
    if (!panel || panel.classList.contains('hidden')) return;
    panel.open = true;
    const field = hash === 'sync' ? elements.authEmail : document.getElementById('geminiKeyInput');
    if (field) field.focus();
    panel.scrollIntoView({ block: 'nearest' });
}

// For scripts that aim the popup at a tab after it opened (the screenshot harness).
window.ProScanPopup = { refreshTab, refresh };

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    try { document.getElementById('version').textContent = chrome.runtime.getManifest().version; } catch (e) { /* no manifest */ }
    chrome.storage.local.get('geminiApiKey').then((d) => showKeySummary(!!(d && d.geminiApiKey)), () => {});
    initializeUI();
    initializeAuthUI().then(openFromHash, openFromHash);
});
