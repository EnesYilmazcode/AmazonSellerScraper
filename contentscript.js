// contentScript.js
let isScrapingActive = false;
let itemCount = 0;

// Add this to ensure the script runs when page loads
document.addEventListener('DOMContentLoaded', function() {
    chrome.storage.local.get(['isScrapingActive', 'currentItemCount'], function(data) {
        isScrapingActive = data.isScrapingActive || false;
        itemCount = data.currentItemCount || 0;
        
        if (isScrapingActive) {
            scrapeCurrentPage();
        }
    });
});

function getNextPageUrl() {
    const currentUrl = new URL(window.location.href);
    const currentPage = parseInt(currentUrl.searchParams.get('page')) || 1;
    const nextPage = currentPage + 1;
    
    currentUrl.searchParams.set('page', nextPage);
    currentUrl.searchParams.set('ref', `sr_pg_${nextPage}`);
    
    return currentUrl.toString();
}

function getCurrentPageItemCount() {
    const resultsText = document.querySelector('.s-desktop-toolbar .a-spacing-small span');
    if (resultsText) {
        const match = resultsText.textContent.match(/(\d+)-(\d+) of/);
        if (match) {
            return parseInt(match[2]) - parseInt(match[1]) + 1;
        }
    }
    return 0;
}

function scrapeCurrentPage() {
    if (!isScrapingActive) return;

    const listings = document.querySelectorAll('.s-result-item[data-asin]:not([data-asin=""])');
    let results = [];
    
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

    // Get current page numbers (e.g., from "1-16 of 88 results")
    const currentPageCount = getCurrentPageItemCount();
    
    // Update total count from storage and add current page
    chrome.storage.local.get(['currentItemCount'], function(data) {
        const previousCount = data.currentItemCount || 0;
        const newCount = previousCount + currentPageCount;
        
        // Send progress update
        chrome.runtime.sendMessage({
            type: 'UPDATE_PROGRESS',
            itemCount: newCount
        });

        // Store results and updated count
        chrome.storage.local.get(['results'], function(data) {
            let allResults = data.results || [];
            allResults = allResults.concat(results);
            
            chrome.storage.local.set({
                results: allResults,
                currentItemCount: newCount
            }, function() {
                const hasNextPage = !document.querySelector('.s-pagination-next.s-pagination-disabled');
                
                if (hasNextPage && isScrapingActive) {
                    const nextUrl = getNextPageUrl();
                    setTimeout(() => {
                        window.location.href = nextUrl;
                    }, 2000);
                } else {
                    // Get final total for completion
                    const resultsText = document.querySelector('.s-desktop-toolbar .a-spacing-small span');
                    const totalMatch = resultsText.textContent.match(/of\s+(\d+)\s+results/);
                    const finalTotal = totalMatch ? parseInt(totalMatch[1]) : newCount;
                    finishScraping(finalTotal);
                }
            });
        });
    });
}

function finishScraping(finalCount) {
    isScrapingActive = false;
    chrome.storage.local.set({
        isScrapingActive: false,
        currentItemCount: finalCount
    }, function() {
        chrome.runtime.sendMessage({
            type: 'SCRAPING_COMPLETE',
            itemCount: finalCount
        });
    });
}

// Reset counter when starting new scrape
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === 'START_SCRAPING') {
        isScrapingActive = true;
        chrome.storage.local.set({
            results: [],
            currentItemCount: 0,
            isScrapingActive: true
        }, function() {
            scrapeCurrentPage();
        });
    } else if (request.type === 'STOP_SCRAPING') {
        isScrapingActive = false;
        chrome.storage.local.set({isScrapingActive: false});
    }
});

// Make sure to run on page load
window.addEventListener('load', function() {
    chrome.storage.local.get(['isScrapingActive'], function(data) {
        isScrapingActive = data.isScrapingActive || false;
        if (isScrapingActive) {
            scrapeCurrentPage();
        }
    });
});