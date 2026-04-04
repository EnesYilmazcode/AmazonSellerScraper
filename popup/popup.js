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
    insightText: document.getElementById('insightText')
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

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
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

// --- Event Listeners ---

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
        });
    } else if (request.type === 'PAGE_COMPLETE') {
        scrapedItemCount += request.itemsScraped;
        elements.itemCount.textContent = scrapedItemCount;
    }
});

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    initializeUI();
});
