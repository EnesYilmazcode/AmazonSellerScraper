// contentScript.js
let isScrapingActive = false;
let retryCount = 0;
const MAX_RETRIES = 3;

function scrapeCurrentPage() {
    if (!isScrapingActive) return;

    let results = [];
    const resultsText = document.documentElement.innerText.match(/1-\d+ of ([\d,]+) results/);
    let totalListed = resultsText ? parseInt(resultsText[1].replace(/,/g, ''), 10) : 0;

    // Find the number of products sold by the seller and send to the popup
    const sellerProductsElement = document.querySelector('.a-section.a-spacing-none.sf-rib-v1-summary-sort-container span');
    if (sellerProductsElement) {
        const sellerProductsCount = sellerProductsElement.innerText.match(/\d+/)[0];
        chrome.runtime.sendMessage({
            type: 'SELLER_PRODUCT_COUNT',
            count: sellerProductsCount
        });
    } else {
        chrome.runtime.sendMessage({
            type: 'SELLER_PRODUCT_COUNT',
            count: "Unknown" // Handle case where count is not found
        });
    }

    const listings = document.querySelectorAll('.s-result-item');
    listings.forEach(listing => {
        const nameElement = listing.querySelector('h2 a span');
        const asin = listing.dataset.asin;
        const priceElement = listing.querySelector('.a-price .a-offscreen');
        const ratingElement = listing.querySelector('.a-icon-star-small .a-icon-alt');

        if (nameElement && asin) {
            results.push({
                name: nameElement.innerText.trim(),
                asin: asin,
                price: priceElement ? priceElement.innerText.trim() : 'N/A',
                rating: ratingElement ? ratingElement.innerText.split(' ')[0] : 'N/A'
            });
        }
    });

    if (results.length === 0 && retryCount < MAX_RETRIES) {
        retryCount++;
        chrome.runtime.sendMessage({
            type: 'UPDATE_PROGRESS',
            message: `No results found. Retrying... (Attempt ${retryCount} of ${MAX_RETRIES})`
        });
        setTimeout(scrapeCurrentPage, 5000); // Wait 5 seconds before retrying
        return;
    }

    retryCount = 0; // Reset retry count on successful scrape

    chrome.storage.local.get('results', function(data) {
        let allResults = data.results || [];
        allResults = allResults.concat(results);
        chrome.storage.local.set({results: allResults}, function() {
            chrome.runtime.sendMessage({
                type: 'UPDATE_PROGRESS', 
                message: `Scraped ${allResults.length} out of ${totalListed} items`
            });

            if (isScrapingActive) {
                const nextPageUrl = getNextPageUrl(totalListed, allResults.length);
                if (nextPageUrl) {
                    const randomWait = Math.floor(Math.random() * (5000 - 2000 + 1) + 2000);
                    setTimeout(() => {
                        window.location.href = nextPageUrl;
                    }, randomWait);
                } else {
                    finishScraping(allResults.length);
                }
            }
        });
    });
}

function getNextPageUrl(totalListed, scrapedItemsCount) {
    const nextPageButton = document.querySelector('a.s-pagination-next');
    
    if (nextPageButton && !nextPageButton.classList.contains('s-pagination-disabled')) {
        return nextPageButton.href;
    }
    
    return null;
}

function finishScraping(totalScraped) {
    isScrapingActive = false;
    chrome.storage.local.set({isScrapingActive: false}, function() {
        chrome.runtime.sendMessage({
            type: 'SCRAPING_COMPLETE', 
            message: `Scraping complete. Total items: ${totalScraped}`
        });
    });
}

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === 'START_SCRAPING') {
        chrome.storage.local.set({results: [], isScrapingActive: true}, function() {
            isScrapingActive = true;
            retryCount = 0;
            scrapeCurrentPage();
        });
    } else if (request.type === 'STOP_SCRAPING') {
        isScrapingActive = false;
        chrome.storage.local.set({isScrapingActive: false});
    }
});

window.addEventListener('load', function() {
    chrome.storage.local.get('isScrapingActive', function(data) {
        isScrapingActive = data.isScrapingActive;
        if (isScrapingActive) {
            retryCount = 0;
            scrapeCurrentPage();
        }
    });
});
