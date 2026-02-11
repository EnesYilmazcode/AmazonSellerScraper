<p align="center">
  <img src="logo.png" alt="ProScan Logo" width="128">
</p>

<h1 align="center">ProScan - Amazon Product Scraper</h1>

<p align="center">
  A Chrome extension that scrapes Amazon product listings, analyzes the data, and includes an AI chatbot for product Q&A. Built for resellers and arbitrage.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/proscan-amazon-product-sc/bikgignfnljpbmchlemkbbpboigodgap">Chrome Web Store</a>
</p>

## Features

- Scrapes product data (name, ASIN, price, rating, reviews, Prime status) across multiple pages automatically
- AI chatbot powered by Gemini API that answers questions about your scraped products right on the Amazon page
- Analytics dashboard with opportunity scoring to help find good deals
- Identifies underpriced and underexposed products
- Export to Excel, CSV, or JSON
- Everything runs client-side, no server needed

## Tech Stack

- JavaScript (vanilla, no frameworks)
- Chrome Extension Manifest V3
- Google Gemini API (2.0 Flash)
- ChromaDB + sentence-transformers for RAG
- Shadow DOM for chatbot isolation
- XLSX.js for Excel generation

## Installation

1. Clone the repo or download the ZIP
2. Open Chrome and go to `chrome://extensions/`
3. Turn on "Developer mode" in the top right
4. Click "Load unpacked" and select the project folder

## Setting Up the AI Chatbot

1. Get a free Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Click the ProScan extension icon to open the popup
3. Go to Settings and paste your API key
4. The chatbot button will show up in the bottom-right corner on Amazon pages

## Usage

1. Go to any Amazon seller or search results page
2. Click the ProScan extension icon
3. Hit "Start Scraping" and let it run through the pages
4. Check the analytics dashboard for insights and opportunity scores
5. Use the AI chatbot on the page to ask questions about the products (e.g. "What's the best deal under $30?")
6. Export your data as Excel, CSV, or JSON

## Project Structure

```
AmazonSellerScraper/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── scripts/
│   ├── content/
│   │   ├── scraper.js          # DOM scraping on Amazon pages
│   │   └── chatbot.js          # Floating AI chatbot widget
│   ├── background/
│   │   └── service-worker.js   # Message routing + Gemini API calls
│   └── modules/
│       ├── storage.js          # Chrome storage wrapper
│       ├── analyzer.js         # Analytics and opportunity scoring
│       └── exporter.js         # Excel/CSV/JSON export
├── styles/
│   └── chatbot.css
├── libs/
│   └── xlsx.full.min.js
└── assets/
    └── icons/
```

## Developer

- **Enes Yilmaz**

## License

This project is licensed under the MIT License.
