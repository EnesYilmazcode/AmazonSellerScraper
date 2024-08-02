document.getElementById('scrapeButton').addEventListener('click', function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'START_SCRAPING' });
    });
});

document.getElementById('stopButton').addEventListener('click', function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_SCRAPING' });
    });
});

document.getElementById('downloadButton').addEventListener('click', function() {
    chrome.storage.local.get('results', function(data) {
        let results = data.results || [];
        let worksheet = XLSX.utils.json_to_sheet(results);
        let workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Results");
        XLSX.writeFile(workbook, 'Amazon_Seller_Data.xlsx');
    });
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === 'UPDATE_PROGRESS') {
        document.getElementById('notification').innerText = request.message;
    } else if (request.type === 'SCRAPING_COMPLETE') {
        document.getElementById('notification').innerText = request.message;
        document.getElementById('downloadButton').style.display = 'block';
    }
});