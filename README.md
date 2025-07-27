# Amazon Seller Scraper

Amazon Seller Scraper is a Chrome extension designed to scrape Amazon seller data, including all items across multiple pages, and export the results to an Excel file.

Published on the Chrome Web Store. Check it out [here](proscanbot.web.app)

## Features

- Scrapes item details such as name, ASIN, price, rating, and review count.
- Supports scraping across multiple pages.
- Exports scraped data to an Excel file.

## Installation

1. Clone the repository or download the ZIP file.
2. Extract the contents of the ZIP file if downloaded.
3. Open Chrome and navigate to `chrome://extensions/`.
4. Enable "Developer mode" in the top right corner.
5. Click on "Load unpacked" and select the directory where you extracted the extension files.

## Usage

1. Navigate to any Amazon seller's page.
2. Click on the Amazon Seller Scraper extension icon.
3. In the popup, click on the "Scrape Items" button to start scraping.
4. The extension will automatically scrape all items across multiple pages.
5. Once scraping is complete, click on the "Download Excel" button to download the scraped data.

## Files

- `manifest.json`: Defines the extension's metadata and permissions.
- `popup.html`: The HTML file for the extension's popup interface.
- `popup.css`: The CSS file for styling the popup interface.
- `popup.js`: The JavaScript file for handling popup interactions.
- `contentscript.js`: The content script for scraping data from Amazon pages.
- `xlsx.full.min.js`: Library for generating Excel files.

## Icon Files

- `icon16.png`: 16x16 icon for the extension.
- `icon48.png`: 48x48 icon for the extension.
- `icon128.png`: 128x128 icon for the extension.

## Developer

- **Enes Yilmaz**

## License

This project is licensed under the MIT License.
