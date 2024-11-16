chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'STOP_SCRAPING') {
        // Handle stopping the scraping process
        chrome.tabs.sendMessage(sender.tab.id, { type: 'STOP_SCRAPING' });
    }
}); 