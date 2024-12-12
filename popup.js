let isScrapingActive = false;

function updateItemCount(items) {
    document.getElementById('itemCount').textContent = items;
}

function updateStatus(message) {
    document.getElementById('status').textContent = message;
}

function setScrapingState(isActive) {
    const actionButton = document.getElementById('actionButton');
    const downloadButton = document.getElementById('downloadButton');
    
    isScrapingActive = isActive;
    actionButton.textContent = isActive ? 'Stop Scraping' : 'Start Scraping';
    actionButton.classList.toggle('stop', isActive);
    downloadButton.classList.toggle('hidden', isActive);
}

// Initialize UI
chrome.storage.local.get(['isScrapingActive', 'currentItemCount'], function(data) {
    isScrapingActive = data.isScrapingActive || false;
    updateItemCount(data.currentItemCount || 0);
    setScrapingState(isScrapingActive);
});

document.getElementById('actionButton').addEventListener('click', function() {
    if (!isScrapingActive) {
        // Start scraping
        isScrapingActive = true;
        this.textContent = 'Stop Scraping';
        this.classList.add('stop');
        chrome.storage.local.set({ results: [] }); // Reset results
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.tabs.sendMessage(tabs[0].id, {type: 'START_SCRAPING'});
        });
        updateItemCount(0);
        updateStatus('Scraping in progress...');
        setScrapingState(true);
    } else {
        // Stop scraping
        isScrapingActive = false;
        this.textContent = 'Start Scraping';
        this.classList.remove('stop');
        document.getElementById('downloadButton').classList.remove('hidden');
        showNotification('Scraping stopped. You can download the results now.', 'info');
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.tabs.sendMessage(tabs[0].id, {type: 'STOP_SCRAPING'});
        });
        updateStatus('Scraping stopped');
        setScrapingState(false);
    }
});

function showNotification(message, type = 'info') {
    const status = document.getElementById('status');
    status.textContent = message;
    
    // Remove previous status classes
    status.classList.remove('info', 'error', 'success');
    
    // Add new status class
    if (type) {
        status.classList.add(type);
    }
}

function showLoadingSpinner() {
    const downloadButton = document.getElementById('downloadButton');
    downloadButton.innerHTML = `
        <span class="spinner"></span>
        Preparing Download...
    `;
    downloadButton.disabled = true;
}

function resetDownloadButton() {
    const downloadButton = document.getElementById('downloadButton');
    downloadButton.innerHTML = `
        <i class="fas fa-download"></i> Download Results
    `;
    downloadButton.disabled = false;
}

function getFileName(results) {
    const date = new Date().toISOString().split('T')[0];
    let storeName = 'amazon_store';
    
    // Try to get seller name from the first result
    if (results && results.length > 0 && results[0].sellerName) {
        storeName = results[0].sellerName;
    }
    
    const sanitizedSellerName = storeName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `${sanitizedSellerName}_scraped_data_${date}.xlsx`;
}

document.getElementById('downloadButton').addEventListener('click', async function() {
    // Ensure the button is not hidden and is clickable
    if (this.classList.contains('hidden')) return;

    // Show loading state
    this.innerHTML = `
        <i class="fas fa-spinner fa-spin"></i> Preparing Download...
    `;
    this.disabled = true;

    try {
        const data = await chrome.storage.local.get(['results']);
        const results = data.results || [];
        
        if (results.length === 0) {
            showNotification('No results to download!', 'error');
            resetDownloadButton();
            return;
        }

        // Create the main data worksheet
        const wb = XLSX.utils.book_new();
        
        // Data Sheet
        const ws_data = [
            ['Amazon Product Analysis Report', '', '', '', ''],
            [],
            ['Report Details', '', '', 'Summary Statistics', ''],
            ['Generated Date:', new Date().toLocaleDateString(), '', 'Total Products:', results.length],
            ['Time:', new Date().toLocaleTimeString(), '', 'Average Rating:', `=ROUND(AVERAGEIF(D9:D${8 + results.length},">0"),2)`],
            ['Status:', 'Complete', '', 'Average Price:', `=ROUND(AVERAGEIF(C9:C${8 + results.length},">0"),2)`],
            [],
            ['Product Name', 'ASIN', 'Price ($)', 'Rating', 'Review Count']
        ];

        // Clean and add data rows
        results.forEach(item => {
            const price = item.price ? parseFloat(item.price.replace(/[^0-9.]/g, '')) : 0;
            const rating = item.rating ? parseFloat(item.rating) : 0;
            const reviewCount = parseInt(item.reviewCount) || 0;
            
            ws_data.push([
                item.name || '',
                item.asin || '',
                price,
                rating,
                reviewCount
            ]);
        });

        // Create main data worksheet
        const ws = XLSX.utils.aoa_to_sheet(ws_data);

        // Add the worksheet to the workbook
        XLSX.utils.book_append_sheet(wb, ws, 'Data');

        // Generate the Excel file
        const wbout = XLSX.write(wb, { 
            bookType: 'xlsx', 
            type: 'base64' 
        });

        // Create a download link
        const fileName = getFileName(results);
        const downloadLink = document.createElement('a');
        downloadLink.href = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${wbout}`;
        downloadLink.download = fileName;
        
        // Append to body, click, and remove
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);

        showNotification('Download started successfully!', 'success');

    } catch (error) {
        console.error('Download error:', error);
        showNotification('Error preparing file. Please try again.', 'error');
    } finally {
        resetDownloadButton();
    }
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === 'UPDATE_PROGRESS') {
        updateItemCount(request.itemCount);
        updateStatus('Scraping in progress...');
    } else if (request.type === 'SCRAPING_COMPLETE') {
        updateItemCount(request.itemCount);
        updateStatus('Scraping complete!');
        setScrapingState(false);
    }
});