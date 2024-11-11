
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
        chrome.storage.local.set({
            isScrapingActive: true,
            currentItemCount: 0,
            results: []
        }, function() {
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                chrome.tabs.sendMessage(tabs[0].id, {type: 'START_SCRAPING'});
            });
        });
        updateItemCount(0);
        updateStatus('Scraping in progress...');
        setScrapingState(true);
    } else {
        chrome.storage.local.set({isScrapingActive: false});
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.tabs.sendMessage(tabs[0].id, {type: 'STOP_SCRAPING'});
        });
        updateStatus('Scraping stopped');
        setScrapingState(false);
    }
});

document.getElementById('downloadButton').addEventListener('click', function() {
    chrome.storage.local.get(['results'], function(data) {
        const results = data.results || [];
        
        // Create workbook and worksheet
        const wb = XLSX.utils.book_new();
        
        // Convert data to worksheet format
        const ws_data = [
            // Headers
            ['Product Name', 'ASIN', 'Price', 'Rating', 'Review Count']
        ];
        
        // Add data rows
        results.forEach(item => {
            ws_data.push([
                item.name,
                item.asin,
                item.price,
                item.rating,
                item.reviewCount
            ]);
        });
        
        // Create worksheet
        const ws = XLSX.utils.aoa_to_sheet(ws_data);
        
        // Set column widths
        const colWidths = [
            {wch: 50},  // Product Name
            {wch: 12},  // ASIN
            {wch: 10},  // Price
            {wch: 8},   // Rating
            {wch: 12}   // Review Count
        ];
        ws['!cols'] = colWidths;
        
        // Add worksheet to workbook
        XLSX.utils.book_append_sheet(wb, ws, "Amazon Products");
        
        // Style the header row
        const headerRange = XLSX.utils.decode_range(ws['!ref']);
        for (let C = headerRange.s.c; C <= headerRange.e.c; ++C) {
            const address = XLSX.utils.encode_cell({r: 0, c: C});
            if (!ws[address]) continue;
            ws[address].s = {
                font: { bold: true },
                fill: { fgColor: { rgb: "CCCCCC" } },
                alignment: { horizontal: "center" }
            };
        }
        
        // Generate Excel file
        const currentDate = new Date().toISOString().split('T')[0];
        const fileName = `amazon-products-${currentDate}.xlsx`;
        XLSX.writeFile(wb, fileName);
    });
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