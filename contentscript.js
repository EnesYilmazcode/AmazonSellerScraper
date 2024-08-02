// contentScript.js
let isScrapingActive = false;
let retryCount = 0;
const MAX_RETRIES = 3;

function scrapeCurrentPage() {
    if (!isScrapingActive) return;

    let results = [];
    const resultsText = document.documentElement.innerText.match(/1-\d+ of ([\d,]+) results/);
    let totalListed = resultsText ? parseInt(resultsText[1].replace(/,/g, ''), 10) : 0;

    const listings = document.querySelectorAll('.s-result-item');
    listings.forEach(listing => {
        const nameElement = listing.querySelector('h2 a span');
        const asin = listing.dataset.asin;
        const priceElement = listing.querySelector('.a-price .a-offscreen');
        const ratingElement = listing.querySelector('.a-icon-star-small .a-icon-alt');
        const reviewCountElement = listing.querySelector('span[aria-label$="stars"]');

        if (nameElement && asin) {
            results.push({
                name: nameElement.innerText.trim(),
                asin: asin,
                price: priceElement ? priceElement.innerText.trim() : 'N/A',
                rating: ratingElement ? ratingElement.innerText.split(' ')[0] : 'N/A',
                reviewCount: reviewCountElement ? reviewCountElement.innerText.split(' ')[0] : 'N/A'
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
                const nextPageUrl = getNextPageUrl();
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

function getNextPageUrl() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    
    // Check if we're on the first page
    if (!params.has('page')) {
        // If on first page, construct URL for second page
        params.set('i', 'merchant-items');
        params.set('page', '2');
        if (!params.has('qid')) {
            params.set('qid', Date.now().toString());
        }
        params.set('ref', 'sr_pg_2');
        url.search = params.toString();
        return url.href;
    } else {
        // For subsequent pages, increment the page number
        const currentPage = parseInt(params.get('page'));
        const nextPage = currentPage + 1;
        params.set('page', nextPage.toString());
        params.set('ref', `sr_pg_${nextPage}`);
        url.search = params.toString();
        return url.href;
    }
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

// Start scraping when the page loads if scraping is active
window.addEventListener('load', function() {
    chrome.storage.local.get('isScrapingActive', function(data) {
        isScrapingActive = data.isScrapingActive;
        if (isScrapingActive) {
            retryCount = 0;
            scrapeCurrentPage();
        }
    });
});