/**
 * @fileoverview Popup UI Controller
 *
 * Manages the extension popup interface including the analytics dashboard,
 * scraping controls, export buttons, and real-time progress updates.
 * Depends on Storage, Analyzer, and Exporter modules loaded via popup.html.
 *
 * State Management:
 * - isScrapingActive: tracks whether a scrape is in progress
 * - scrapedItemCount: running total across paginated pages
 * - currentResults: full array of scraped product objects
 *
 * Communication:
 * - Sends START_SCRAPING / STOP_SCRAPING to content script via chrome.tabs
 * - Receives UPDATE_PROGRESS, SCRAPING_COMPLETE, PAGE_COMPLETE from content script
 *
 * @module PopupUI
 * @requires Storage
 * @requires Analyzer
 * @requires Exporter
 */

/** @type {boolean} Whether scraping is currently in progress */
let isScrapingActive = false;

/** @type {number} Running count of scraped items across all pages */
let scrapedItemCount = 0;

/** @type {Object[]} Full array of scraped product objects */
let currentResults = [];

/** @type {boolean} Whether spread analysis is currently running */
let isSpreadAnalyzing = false;

/** @type {?{uid:string,email:string,displayName:string}} Signed-in ProScan user, or null */
let currentProScanUser = null;

/** @type {boolean} Whether a cloud export to ProScan is in progress */
let isExporting = false;

/**
 * Cached references to DOM elements used throughout the popup lifecycle.
 * Resolved once at module load time for performance.
 * @const {Object<string, HTMLElement>}
 */
const elements = {
    itemCount: document.getElementById('itemCount'),
    avgRating: document.getElementById('avgRating'),
    avgPrice: document.getElementById('avgPrice'),
    status: document.getElementById('status'),
    actionButton: document.getElementById('actionButton'),
    exportButtons: document.getElementById('exportButtons'),
    downloadExcel: document.getElementById('downloadExcel'),
    downloadCSV: document.getElementById('downloadCSV'),
    downloadJSON: document.getElementById('downloadJSON'),
    insightsPreview: document.getElementById('insightsPreview'),
    insightBadge: document.getElementById('insightBadge'),
    insightText: document.getElementById('insightText'),
    spreadButton: document.getElementById('spreadButton'),
    spreadProgress: document.getElementById('spreadProgress'),
    spreadProgressFill: document.getElementById('spreadProgressFill'),
    spreadProgressText: document.getElementById('spreadProgressText'),
    spreadResults: document.getElementById('spreadResults'),
    spreadHighCount: document.getElementById('spreadHighCount'),
    spreadAvgCV: document.getElementById('spreadAvgCV'),
    // ProScan cloud auth + export
    authForm: document.getElementById('authForm'),
    authEmail: document.getElementById('authEmail'),
    authPassword: document.getElementById('authPassword'),
    authSignInBtn: document.getElementById('authSignInBtn'),
    authError: document.getElementById('authError'),
    authAccount: document.getElementById('authAccount'),
    authStatusEmail: document.getElementById('authStatusEmail'),
    authSignOutBtn: document.getElementById('authSignOutBtn'),
    exportToProScanBtn: document.getElementById('exportToProScanBtn')
};

/**
 * Update the dashboard stats display with current results.
 * Calculates average price and rating using the Analyzer module
 * and triggers the insights preview update.
 *
 * @param {Object[]} results - Array of product objects
 */
function updateStats(results) {
    currentResults = results;
    elements.itemCount.textContent = results.length;

    if (results.length > 0) {
        const prices = results.map(r => Analyzer.parsePrice(r.price)).filter(p => p > 0);
        const ratings = results.map(r => Analyzer.parseRating(r.rating)).filter(r => r > 0);

        if (prices.length > 0) {
            const avgPrice = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
            elements.avgPrice.textContent = '$' + avgPrice;
        }

        if (ratings.length > 0) {
            const avgRating = (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1);
            elements.avgRating.textContent = avgRating;
        }

        updateInsightsPreview(results);
    }
}

/**
 * Show the top insight badge in the popup.
 * Requires at least 5 products for meaningful analysis.
 * Prioritizes high-priority insights (opportunities) over informational ones.
 *
 * @param {Object[]} results - Array of product objects
 */
function updateInsightsPreview(results) {
    if (results.length < 5) return;

    const insights = Analyzer.generateInsights(results);
    const topInsight = insights.find(i => i.priority === 'high') || insights[0];

    if (topInsight) {
        elements.insightText.textContent = topInsight.title;
        elements.insightBadge.className = 'insight-badge ' + (topInsight.type === 'opportunity' ? 'opportunity' : '');
        elements.insightsPreview.classList.remove('hidden');
    }
}

/**
 * Update the status bar message with an icon and styling.
 *
 * @param {string} message - Status message text
 * @param {'info'|'success'|'error'|'warning'} [type='info'] - Status type for styling
 */
function updateStatus(message, type = 'info') {
    elements.status.innerHTML = `<i class="fas fa-${getStatusIcon(type)}"></i> ${message}`;
    elements.status.className = 'status ' + type;
}

/**
 * Map status type to Font Awesome icon name.
 *
 * @param {string} type - Status type
 * @returns {string} Font Awesome icon identifier
 */
function getStatusIcon(type) {
    const icons = {
        info: 'info-circle',
        success: 'check-circle',
        error: 'exclamation-circle',
        warning: 'exclamation-triangle'
    };
    return icons[type] || 'info-circle';
}

/**
 * Toggle the UI between scraping and idle states.
 * Updates the action button text/style and shows/hides export buttons.
 *
 * @param {boolean} isActive - Whether scraping is in progress
 */
function setScrapingState(isActive) {
    isScrapingActive = isActive;

    if (isActive) {
        elements.actionButton.innerHTML = '<i class="fas fa-stop"></i> Stop Scraping';
        elements.actionButton.classList.add('stop');
        elements.exportButtons.classList.add('hidden');
    } else {
        elements.actionButton.innerHTML = '<i class="fas fa-play"></i> Start Scraping';
        elements.actionButton.classList.remove('stop');
        if (currentResults.length > 0) {
            elements.exportButtons.classList.remove('hidden');
        }
    }
}

/**
 * Toggle loading spinner on a download button during export generation.
 *
 * @param {HTMLButtonElement} button - The download button element
 * @param {boolean} loading - True to show spinner, false to restore original content
 */
function setDownloadLoading(button, loading) {
    if (loading) {
        button.innerHTML = '<span class="spinner"></span> Preparing...';
        button.disabled = true;
    } else {
        const icons = {
            downloadExcel: 'file-excel',
            downloadCSV: 'file-csv',
            downloadJSON: 'file-code'
        };
        const labels = {
            downloadExcel: 'Excel',
            downloadCSV: 'CSV',
            downloadJSON: 'JSON'
        };
        button.innerHTML = `<i class="fas fa-${icons[button.id]}"></i> ${labels[button.id]}`;
        button.disabled = false;
    }
}

/**
 * Initialize the popup UI from persisted storage state.
 * Called on DOMContentLoaded to restore scraping state, results,
 * and dashboard stats from the previous session.
 *
 * @async
 */
async function initializeUI() {
    const state = await Storage.getScrapingState();

    isScrapingActive = state.isActive;
    scrapedItemCount = state.itemCount;
    currentResults = state.results;

    updateStats(currentResults);
    setScrapingState(isScrapingActive);

    if (!isScrapingActive && currentResults.length > 0) {
        updateStatus('Ready to download ' + currentResults.length + ' products', 'success');
        elements.spreadButton.classList.remove('hidden');

        // Check if spread results already exist
        const spreadData = await new Promise(resolve => {
            chrome.storage.local.get(['spreadResults'], resolve);
        });
        if (spreadData.spreadResults && Object.keys(spreadData.spreadResults).length > 0) {
            displaySpreadResults();
        }
    }
}

/**
 * Start a new scraping session.
 * Resets storage and UI state, then sends START_SCRAPING to the active tab.
 *
 * @async
 */
async function startScraping() {
    isScrapingActive = true;

    await Storage.resetForNewScrape();

    chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
        // Mint a run id (with storefront/keyword source metadata from the tab
        // URL) before the content script begins; it persists across pagination.
        await Storage.beginRun(tabs[0] && tabs[0].url);
        chrome.tabs.sendMessage(tabs[0].id, { type: 'START_SCRAPING' });
    });

    // Reset UI
    elements.itemCount.textContent = '0';
    elements.avgRating.textContent = '-';
    elements.avgPrice.textContent = '-';
    elements.insightsPreview.classList.add('hidden');
    currentResults = [];

    updateStatus('Scraping in progress...', 'info');
    setScrapingState(true);
}

/**
 * Stop the current scraping session gracefully.
 * Updates storage and transitions the UI to the idle/download state.
 *
 * @async
 */
async function stopScraping() {
    isScrapingActive = false;

    await Storage.set(Storage.KEYS.IS_SCRAPING, false);

    updateStatus('Scraping stopped. Ready to download.', 'warning');
    setScrapingState(false);
}

// --- Spread Analysis ---

/**
 * Start the price spread analysis.
 * Sends a message to the offer-fetcher content script to begin
 * fetching offer pages for all scraped products.
 */
async function startSpreadAnalysis() {
    if (currentResults.length === 0) {
        updateStatus('No products to analyze!', 'warning');
        return;
    }

    isSpreadAnalyzing = true;
    elements.spreadButton.innerHTML = '<i class="fas fa-stop"></i> Stop Analysis';
    elements.spreadButton.classList.add('stop');
    elements.spreadProgress.classList.remove('hidden');
    elements.spreadResults.classList.add('hidden');
    elements.spreadProgressFill.style.width = '0%';
    elements.spreadProgressText.textContent = `0/${currentResults.length}`;
    updateStatus('Analyzing price spreads...', 'info');

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'START_SPREAD_ANALYSIS' });
    });
}

/**
 * Stop the running spread analysis.
 */
function stopSpreadAnalysis() {
    isSpreadAnalyzing = false;
    elements.spreadButton.innerHTML = '<i class="fas fa-chart-bar"></i> Analyze Price Spreads';
    elements.spreadButton.classList.remove('stop');
    updateStatus('Spread analysis stopped.', 'warning');

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_SPREAD_ANALYSIS' });
    });
}

/**
 * Display the spread analysis results in the popup.
 * Reads spread data from storage and runs it through SpreadAnalyzer.
 */
async function displaySpreadResults() {
    const data = await new Promise(resolve => {
        chrome.storage.local.get(['spreadResults'], resolve);
    });

    const spreadResults = data.spreadResults || {};
    const analyzed = SpreadAnalyzer.analyzeAll(spreadResults);
    const summary = SpreadAnalyzer.generateSummary(analyzed);

    elements.spreadHighCount.textContent = summary.highSpreadCount;
    elements.spreadAvgCV.textContent = summary.avgCV + '%';
    elements.spreadResults.classList.remove('hidden');
    elements.spreadProgress.classList.add('hidden');

    // Show insight if there are high-spread products
    if (summary.highSpreadCount > 0) {
        updateStatus(
            `Found ${summary.highSpreadCount} products with high price spread!`,
            'success'
        );
    } else if (summary.withSpreadData > 0) {
        updateStatus(
            `Analyzed ${summary.withSpreadData} products. No high spreads found.`,
            'info'
        );
    }
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
    elements.authForm.classList.add('hidden');
    elements.authAccount.classList.remove('hidden');
    elements.authError.classList.add('hidden');
    elements.authError.textContent = '';
    elements.exportToProScanBtn.classList.remove('hidden');
}

/**
 * Render the signed-out state: show the sign-in form, hide the account state,
 * and hide the cloud-export button.
 */
function showSignInForm() {
    currentProScanUser = null;
    elements.authAccount.classList.add('hidden');
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
 * Restore the sign-in button to its idle state.
 */
function resetSignInButton() {
    elements.authSignInBtn.disabled = false;
    elements.authSignInBtn.innerHTML = '<i class="fas fa-right-to-bracket"></i> Sign in to ProScan';
}

/**
 * Query the worker for the current auth state on popup open and render the
 * matching view (sign-in form vs signed-in account).
 *
 * @async
 */
async function initializeAuthUI() {
    const response = await sendToWorker({ type: 'PROSCAN_AUTH_STATE' });
    if (response && response.user) {
        showSignedIn(response.user);
    } else {
        showSignInForm();
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
    elements.authSignInBtn.innerHTML = '<span class="spinner"></span> Signing in…';

    const response = await sendToWorker({ type: 'PROSCAN_SIGN_IN', email, password });

    if (response && response.user) {
        elements.authPassword.value = '';
        showSignedIn(response.user);
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
    const response = await sendToWorker({ type: 'PROSCAN_SIGN_OUT' });
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
    elements.exportToProScanBtn.innerHTML = '<span class="spinner"></span> Exporting…';
    updateStatus('Exporting to ProScan…', 'info');

    const response = await sendToWorker({ type: 'PROSCAN_EXPORT' });

    if (response && response.ok) {
        const count = response.products || 0;
        if (!response.written || count === 0) {
            updateStatus('No new products to export', 'info');
        } else {
            updateStatus(`Exported ${count} product${count === 1 ? '' : 's'} to ProScan`, 'success');
        }
    } else {
        updateStatus((response && response.error) || 'Export failed.', 'error');
    }

    isExporting = false;
    elements.exportToProScanBtn.disabled = false;
    elements.exportToProScanBtn.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Export to ProScan';
}

// --- Event Listeners ---

// ProScan cloud auth + export
elements.authSignInBtn.addEventListener('click', handleSignIn);
elements.authSignOutBtn.addEventListener('click', handleSignOut);
elements.exportToProScanBtn.addEventListener('click', handleExportToProScan);

// Enter-to-submit from the password field
elements.authPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        handleSignIn();
    }
});

// Spread analysis button: toggle start/stop
elements.spreadButton.addEventListener('click', () => {
    if (!isSpreadAnalyzing) {
        startSpreadAnalysis();
    } else {
        stopSpreadAnalysis();
    }
});

// Action button: toggle scraping on/off
elements.actionButton.addEventListener('click', async () => {
    if (!isScrapingActive) {
        await startScraping();
    } else {
        await stopScraping();
    }
});

// Excel export with full analytics report
elements.downloadExcel.addEventListener('click', async () => {
    if (currentResults.length === 0) {
        updateStatus('No results to download!', 'warning');
        return;
    }

    setDownloadLoading(elements.downloadExcel, true);
    updateStatus('Generating Excel report...', 'info');

    try {
        const analysisReport = Analyzer.generateFullReport(currentResults);
        const { blob, filename } = Exporter.exportToExcel(currentResults, analysisReport);

        Exporter.triggerDownload(blob, filename, (downloadId) => {
            if (downloadId) {
                updateStatus('Download started!', 'success');
            } else {
                updateStatus('Download failed. Try again.', 'error');
            }
            setDownloadLoading(elements.downloadExcel, false);
        });
    } catch (error) {
        console.error('Excel export error:', error);
        updateStatus('Error generating Excel file', 'error');
        setDownloadLoading(elements.downloadExcel, false);
    }
});

// CSV export
elements.downloadCSV.addEventListener('click', async () => {
    if (currentResults.length === 0) {
        updateStatus('No results to download!', 'warning');
        return;
    }

    setDownloadLoading(elements.downloadCSV, true);

    try {
        const { blob, filename } = Exporter.exportToCSV(currentResults);

        Exporter.triggerDownload(blob, filename, (downloadId) => {
            if (downloadId) {
                updateStatus('CSV download started!', 'success');
            } else {
                updateStatus('Download failed. Try again.', 'error');
            }
            setDownloadLoading(elements.downloadCSV, false);
        });
    } catch (error) {
        console.error('CSV export error:', error);
        updateStatus('Error generating CSV file', 'error');
        setDownloadLoading(elements.downloadCSV, false);
    }
});

// JSON export with analytics
elements.downloadJSON.addEventListener('click', async () => {
    if (currentResults.length === 0) {
        updateStatus('No results to download!', 'warning');
        return;
    }

    setDownloadLoading(elements.downloadJSON, true);

    try {
        const { blob, filename } = Exporter.exportToJSON(currentResults, true);

        Exporter.triggerDownload(blob, filename, (downloadId) => {
            if (downloadId) {
                updateStatus('JSON download started!', 'success');
            } else {
                updateStatus('Download failed. Try again.', 'error');
            }
            setDownloadLoading(elements.downloadJSON, false);
        });
    } catch (error) {
        console.error('JSON export error:', error);
        updateStatus('Error generating JSON file', 'error');
        setDownloadLoading(elements.downloadJSON, false);
    }
});

/**
 * Listen for real-time messages from the content script.
 *
 * Message types:
 * - UPDATE_PROGRESS: Incremental results from each page
 * - SCRAPING_COMPLETE: Final notification when all pages are done
 * - PAGE_COMPLETE: Per-page item count update
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'UPDATE_PROGRESS') {
        scrapedItemCount += request.itemCount;
        if (request.results) {
            currentResults = [...currentResults, ...request.results];
            updateStats(currentResults);
        } else {
            elements.itemCount.textContent = scrapedItemCount;
        }
        updateStatus('Scraping in progress... ' + scrapedItemCount + ' items', 'info');
    } else if (request.type === 'SCRAPING_COMPLETE') {
        Storage.getResults().then(results => {
            currentResults = results;
            updateStats(currentResults);
            updateStatus('Scraping complete! ' + results.length + ' products found.', 'success');
            setScrapingState(false);
            // Show spread analysis button
            if (results.length > 0) {
                elements.spreadButton.classList.remove('hidden');
            }
        });
    } else if (request.type === 'PAGE_COMPLETE') {
        scrapedItemCount += request.itemsScraped;
        elements.itemCount.textContent = scrapedItemCount;
    } else if (request.type === 'SPREAD_PROGRESS') {
        // Update spread analysis progress bar
        const percent = Math.round((request.current / request.total) * 100);
        elements.spreadProgressFill.style.width = percent + '%';
        elements.spreadProgressText.textContent = `${request.current}/${request.total}`;
    } else if (request.type === 'SPREAD_ANALYSIS_COMPLETE') {
        isSpreadAnalyzing = false;
        elements.spreadButton.innerHTML = '<i class="fas fa-chart-bar"></i> Analyze Price Spreads';
        elements.spreadButton.classList.remove('stop');
        displaySpreadResults();
    }
});

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    initializeUI();
    initializeAuthUI();
});
