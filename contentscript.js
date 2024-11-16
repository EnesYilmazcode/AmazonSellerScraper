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
        
        // Updated rating extraction
        const ratingText = listing.querySelector('.a-icon-alt')?.textContent || '';
        const rating = ratingText.split(' ')[0] || '0';
        
        // Updated review count extraction - multiple attempts
        let reviewCount = '0';
        // First attempt: direct number in span
        const reviewSpan = listing.querySelector('span[aria-label*="ratings"]');
        if (reviewSpan) {
            const ariaLabel = reviewSpan.getAttribute('aria-label');
            if (ariaLabel) {
                reviewCount = ariaLabel.split(' ')[0];
            }
        }
        // Second attempt: link text
        if (reviewCount === '0') {
            const reviewLink = listing.querySelector('a[href*="customerReviews"] span');
            if (reviewLink) {
                reviewCount = reviewLink.textContent.trim();
            }
        }
        
        // Clean the review count (remove commas and ensure it's a number)
        reviewCount = reviewCount.replace(/[^0-9]/g, '');
        
        if (nameElement && asin) {
            results.push({
                name: nameElement.innerText.trim(),
                asin: asin,
                price: priceElement ? priceElement.innerText.trim() : 'N/A',
                rating: rating,
                reviewCount: reviewCount || '0' // Ensure we always have a number
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

// In your scraping logic
const getRating = () => {
    // Try to get rating from the aria-label
    const ratingElement = document.querySelector('span[aria-label*="out of 5 stars"]');
    if (ratingElement) {
        const ariaLabel = ratingElement.getAttribute('aria-label');
        if (ariaLabel) {
            return ariaLabel.split(' ')[0];
        }
    }
    
    // Fallback: try to get from the alt text of star icon
    const starIcon = document.querySelector('.a-icon-star-small .a-icon-alt');
    if (starIcon) {
        const altText = starIcon.textContent;
        return altText.split(' ')[0];
    }
    
    return '0';
};

const getReviewCount = () => {
    // Try to get review count from aria-label
    const reviewElement = document.querySelector('span[aria-label*="ratings"]');
    if (reviewElement) {
        const ariaLabel = reviewElement.getAttribute('aria-label');
        return ariaLabel.split(' ')[0].replace(/,/g, '');
    }
    
    // Fallback to the text content
    const reviewLink = document.querySelector('a[href*="customerReviews"] span');
    if (reviewLink) {
        return reviewLink.textContent.trim().replace(/,/g, '');
    }
    
    return '0';
};

const productInfo = {
    // ... other fields ...
    rating: getRating(),
    reviewCount: getReviewCount(),
};