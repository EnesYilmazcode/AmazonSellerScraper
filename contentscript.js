// contentScript.js
let isScrapingActive = false;
let itemCount = 0;

// Ensure the script runs when the page loads
document.addEventListener('DOMContentLoaded', function () {
    chrome.storage.local.get(['isScrapingActive', 'currentItemCount'], function (data) {
        isScrapingActive = data.isScrapingActive || false;
        itemCount = data.currentItemCount || 0;

        if (isScrapingActive) {
            scrapeCurrentPage();
        }
    });
});

// Function to get the URL for the next page
function getNextPageUrl() {
    const currentUrl = new URL(window.location.href);
    const currentPage = parseInt(currentUrl.searchParams.get('page')) || 1;
    const nextPage = currentPage + 1;

    currentUrl.searchParams.set('page', nextPage);
    currentUrl.searchParams.set('ref', `sr_pg_${nextPage}`);

    return currentUrl.toString();
}

// Function to get the number of items on the current page
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

// Function to scrape the current page
function scrapeCurrentPage() {
    if (!isScrapingActive) return;

    // Extract total results from the page
    let totalResults = 0;
    const resultsTextElement = document.querySelector('h2.a-size-base.a-spacing-small.a-spacing-top-small span');

    if (resultsTextElement) {
        const resultsText = resultsTextElement.innerText;
        const match = resultsText.match(/of (\d+) results/);
        if (match) {
            totalResults = parseInt(match[1], 10); // Extract the total count from the first capturing group
        }
    } else {
        console.warn('Results text element not found.');
    }

    const listings = document.querySelectorAll('.s-result-item[data-asin]:not([data-asin=""])');
    let results = [];
    
    if (listings.length === 0) {
        console.log('No listings found on this page.');
        finishScraping(itemCount); // Call finishScraping with the current item count
        return; // Exit if no listings are found
    }

    listings.forEach(listing => {
        if (!listing) return; // Check if listing is defined

        // Extracting the ASIN
        const asin = listing.dataset.asin;

        // Extracting the product title
        const titleElement = listing.querySelector('.a-size-medium.a-color-base.a-text-normal');
        const title = titleElement ? titleElement.innerText.trim() : 'N/A';

        // Extracting the price
        const priceElement = listing.querySelector('.a-price-symbol + .a-price-whole, .a-offscreen');
        const price = priceElement ? priceElement.innerText : 'N/A';

        // Extracting the overall star rating
        const ratingElement = listing.querySelector('.a-icon-star-small .a-icon-alt');
        const rating = ratingElement ? 
            parseFloat(ratingElement.innerText.split(' ')[0]) : 'N/A';

        // Extracting the total number of ratings
        const reviewCountElement = listing.querySelector('.a-size-base.puis-normal-weight-text.s-underline-text');
        const reviewCount = reviewCountElement ? 
            parseInt(reviewCountElement.innerText.replace(/[()]/g, '').trim()) : 0;

        // Extracting the product URL
        const productLinkElement = listing.querySelector('.a-link-normal.s-no-outline');
        const productUrl = productLinkElement ? 
            `https://www.amazon.com${productLinkElement.getAttribute('href')}` : 'N/A';

        const item = {
            name: title,
            asin: asin,
            price: price,
            rating: rating,
            reviewCount: reviewCount,
            url: productUrl
        };

        results.push(item);
    });

    // Send the total number of items scraped at once
    chrome.runtime.sendMessage({
        type: 'UPDATE_PROGRESS',
        itemCount: results.length, // Send the total number of items found
        results: results // Send all results
    });

    // Debugging log to see collected results
    console.log('Collected results:', results);
    console.log('Total results:', totalResults); // Log the total results for debugging

    // Update total count from storage and add current page
    chrome.storage.local.get(['currentItemCount'], function(data) {
        const previousCount = data.currentItemCount || 0;
        const newCount = previousCount + results.length; // Update with the number of results collected
        
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
                    finishScraping(newCount);
                }
            });
        });
    });
}

// Function to finish scraping
function finishScraping(finalCount) {
    isScrapingActive = false;
    chrome.storage.local.set({
        isScrapingActive: false,
        currentItemCount: finalCount
    }, function () {
        chrome.runtime.sendMessage({
            type: 'SCRAPING_COMPLETE',
            itemCount: finalCount
        });
    });
}

// Reset counter when starting new scrape
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.type === 'START_SCRAPING') {
        isScrapingActive = true;
        chrome.storage.local.set({
            results: [],
            currentItemCount: 0,
            isScrapingActive: true
        }, function () {
            scrapeCurrentPage();
        });
    } else if (request.type === 'STOP_SCRAPING') {
        isScrapingActive = false;
        chrome.storage.local.set({ results: [], currentItemCount: 0 }); // Reset results
        finishScraping(0); // Call finishScraping with 0
    }
});

// Make sure to run on page load
window.addEventListener('load', function () {
    chrome.storage.local.get(['isScrapingActive'], function (data) {
        isScrapingActive = data.isScrapingActive || false;
        if (isScrapingActive) {
            scrapeCurrentPage();
        }
    });
});

// Function to get the rating of a product
const getRating = () => {
    // Try to get rating from the aria-label
    const ratingElement = document.querySelector('span[aria-label*="out of 5 stars"]');
    if (ratingElement) {
        const ariaLabel = ratingElement.getAttribute('aria-label');
        if (ariaLabel) {
            return ariaLabel.split(' ')[0]; // Extract the rating
        }
    }

    // Fallback: try to get from the alt text of star icon
    const starIcon = document.querySelector('.a-icon-star-small .a-icon-alt');
    if (starIcon) {
        const altText = starIcon.textContent;
        return altText.split(' ')[0]; // Extract the rating
    }

    // Additional fallback: check for other potential rating elements
    const alternativeRating = document.querySelector('.a-icon-alt');
    if (alternativeRating) {
        return alternativeRating.textContent.split(' ')[0]; // Extract the rating
    }

    return '0'; // Default return if no rating found
};

// Function to get the review count of a product
const getReviewCount = (listing) => {
    // Try to get review count from aria-label
    const reviewElement = listing.querySelector('span[aria-label*="ratings"]');
    if (reviewElement) {
        const ariaLabel = reviewElement.getAttribute('aria-label');
        return ariaLabel.split(' ')[0].replace(/,/g, ''); // Extract and clean the review count
    }

    // Fallback to the text content
    const reviewLink = listing.querySelector('a[href*="customerReviews"] span');
    if (reviewLink) {
        return reviewLink.textContent.trim().replace(/,/g, ''); // Extract and clean the review count
    }

    // Additional fallback: check for other potential review count elements
    const alternativeReviewCount = listing.querySelector('.a-size-small .a-link-normal');
    if (alternativeReviewCount) {
        return alternativeReviewCount.textContent.trim().replace(/,/g, ''); // Extract and clean the review count
    }

    return '0'; // Default return if no review count found
};