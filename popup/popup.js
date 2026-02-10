// popup.js - UI Logic for ProScan Extension
// Uses Storage, Analyzer, and Exporter modules

let isScrapingActive = false;
let scrapedItemCount = 0;
let currentResults = [];

// DOM Elements
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

// Update UI with current stats
function updateStats(results) {
    currentResults = results;
    elements.itemCount.textContent = results.length;

    if (results.length > 0) {
        // Calculate averages using Analyzer
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

        // Show top insight
        updateInsightsPreview(results);
    }
}

// Update insights preview
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

// Update status message
function updateStatus(message, type = 'info') {
    elements.status.innerHTML = `<i class="fas fa-${getStatusIcon(type)}"></i> ${message}`;
    elements.status.className = 'status ' + type;
}

function getStatusIcon(type) {
    const icons = {
        info: 'info-circle',
        success: 'check-circle',
        error: 'exclamation-circle',
        warning: 'exclamation-triangle'
    };
    return icons[type] || 'info-circle';
}

// Set scraping state
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

// Show loading state on download button
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

// Initialize UI from storage
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

// Start scraping
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

// Stop scraping
async function stopScraping() {
    isScrapingActive = false;

    await Storage.set(Storage.KEYS.IS_SCRAPING, false);

    updateStatus('Scraping stopped. Ready to download.', 'warning');
    setScrapingState(false);
}

// Handle action button click
elements.actionButton.addEventListener('click', async () => {
    if (!isScrapingActive) {
        await startScraping();
    } else {
        await stopScraping();
    }
});

// Handle Excel download
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

// Handle CSV download
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

// Handle JSON download
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

// Listen for messages from content script
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

// ===== Settings Section =====

const settingsToggle = document.getElementById('settingsToggle');
const settingsBody = document.getElementById('settingsBody');
const settingsArrow = document.getElementById('settingsArrow');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveApiKeyBtn = document.getElementById('saveApiKey');

// Toggle settings panel
settingsToggle.addEventListener('click', () => {
    settingsBody.classList.toggle('hidden');
    settingsArrow.classList.toggle('open');
});

// Load saved API key
async function loadApiKey() {
    const data = await chrome.storage.local.get(['geminiApiKey']);
    if (data.geminiApiKey) {
        // Show masked key
        apiKeyInput.value = data.geminiApiKey.slice(0, 8) + '...' + data.geminiApiKey.slice(-4);
        apiKeyInput.dataset.saved = 'true';
    }
}

// Save API key
saveApiKeyBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key || apiKeyInput.dataset.saved === 'true') {
        // If showing masked key, clear to let user enter new one
        if (apiKeyInput.dataset.saved === 'true') {
            apiKeyInput.value = '';
            apiKeyInput.dataset.saved = '';
            apiKeyInput.focus();
            return;
        }
        return;
    }

    await chrome.storage.local.set({ geminiApiKey: key });
    apiKeyInput.value = key.slice(0, 8) + '...' + key.slice(-4);
    apiKeyInput.dataset.saved = 'true';
    updateStatus('API key saved! AI chatbot is now active on Amazon pages.', 'success');
});

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    initializeUI();
    loadApiKey();
});
