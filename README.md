<p align="center">
  <img src="assets/logo.png" alt="ProScan Logo" width="128">
</p>

<h1 align="center">ProScan - Amazon Product Intelligence Platform</h1>

<p align="center">
  <strong>AI-powered Chrome extension for Amazon product scraping, analytics, and real-time insights</strong>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/proscan-amazon-product-sc/bikgignfnljpbmchlemkbbpboigodgap">
    <img src="https://img.shields.io/badge/Chrome_Web_Store-Install-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Web Store">
  </a>
  <img src="https://img.shields.io/badge/Manifest-V3-brightgreen" alt="Manifest V3">
  <img src="https://img.shields.io/badge/AI-Gemini_Flash-blue" alt="Gemini AI">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
</p>

---

## Overview

ProScan is a Chrome extension that scrapes Amazon product listings across multiple pages, runs analytics to identify arbitrage opportunities, and includes a floating AI chatbot powered by Google Gemini for real-time product Q&A -- all running client-side with no server required.

## Key Features

- **Multi-page scraping** -- Automatically navigates and extracts product data (name, ASIN, price, rating, reviews, Prime status) across paginated Amazon results
- **Opportunity scoring** -- Proprietary formula identifies high-value arbitrage opportunities based on rating, review velocity, and price positioning
- **Price spread analysis** -- Fetches competing seller prices for each product and calculates variability (Coefficient of Variation) to identify pricing disagreement -- a strong arbitrage signal
- **AI chatbot** -- Floating widget on Amazon pages answers questions about your last scan using Gemini Flash and your own free API key (e.g., "What's the best deal under $30?")
- **Analytics dashboard** -- Real-time stats, underpriced product detection, and quality distribution analysis
- **Multi-format export** -- Excel (with styled sheets and charts), CSV, and JSON with full analytics
- **Shadow DOM isolation** -- Chatbot widget styles are fully isolated from Amazon's CSS

## Architecture

```
                    Chrome Extension (Client-Side)
 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │  popup/              scripts/content/                    │
 │  ├── popup.html      ├── scraper.js    (DOM extraction)  │
 │  ├── popup.css       └── chatbot.js    (AI widget)       │
 │  └── popup.js                                            │
 │                      scripts/background/                 │
 │  scripts/modules/    └── service-worker.js               │
 │  ├── storage.js         (message routing + Gemini API)   │
 │  ├── analyzer.js                                         │
 │  └── exporter.js     styles/                             │
 │                      └── chatbot.css                     │
 └──────────────────────────────────────────────────────────┘
```

## Data Flow

### Scraping Pipeline

```
User clicks "Start Scraping"
  → popup.js pings the tab (offers a reload if ProScan is not loaded there)
  → popup.js creates a run bound to that tab and sends START_SCRAPING
  → scraper.js classifies the page, then extracts products
  → Results and run progress stored in chrome.storage.local
  → Follows the page's Next link after a 2 to 4 second delay
  → Repeats until the last page or the page cap (settings.maxPages, default 20)
  → The run ends with a reason: complete, stopped, blocked (captcha,
    bot check, sign-in), selectors_broken, storage_full or interrupted
  → analyzer.js generates insights and opportunity scores
  → User exports via exporter.js (Excel/CSV/JSON)
```

### AI Chatbot Flow

```
User types question in floating widget
  → chatbot.js sends CHAT_MESSAGE (question + last few turns) to service-worker.js
  → Service worker reads the user's key and the current run from storage
  → scripts/lib/chat.js builds the Gemini request (model id is GEMINI_MODEL there)
  → Response displayed in chat bubble as plain text
```

## Analytics Engine

### Opportunity Score Formula

```
score = (rating * log10(reviews + 1)) / sqrt(price)
```

Normalized to a 1-10 scale. Higher score = better arbitrage opportunity. The formula favors:
- **High ratings** (quality signal)
- **Many reviews** (logarithmic -- diminishing returns prevent outlier dominance)
- **Lower price** (inverse square root -- moderate price sensitivity)

### Insight Detection

| Insight | Criteria | Priority |
|---------|----------|----------|
| High price spread | CV > 30% across sellers for the same ASIN | High |
| Underpriced | 30%+ below average price with 4+ star rating | High |
| Underexposed | 4+ stars but fewer than 50 reviews | Medium |
| Price distribution | Min/max/average/median analysis | Low |
| Quality distribution | Percentage of products above 4.5 stars | Low |

### Price Spread Analysis

After scraping, click **Analyze Price Spreads** to fetch competing seller prices for each product. The system:

1. Fetches the offer listing page for each ASIN (2-second delay between requests)
2. Extracts all seller prices using cascading DOM selectors
3. Calculates the **Coefficient of Variation** (stdDev / mean * 100)
4. Scores arbitrage opportunity based on CV, seller count, and absolute dollar spread

```
Arbitrage Score = (CV / 15) * log10(sellers + 1) * min(1, spread / $20)
```

| CV Range | Signal | Meaning |
|----------|--------|---------|
| 0-5% | Very Low | Commodity pricing, tight consensus |
| 5-15% | Low | Normal variance |
| 15-30% | Moderate | Some pricing disagreement |
| 30-50% | High | Strong arbitrage signal |
| 50%+ | Very High | Major pricing disagreement |

See [docs/PRICE_SPREAD_ANALYSIS.md](docs/PRICE_SPREAD_ANALYSIS.md) for the full feature specification.

## Installation

1. Clone the repository and build it:
   ```bash
   git clone https://github.com/EnesYilmazcode/AmazonSellerScraper.git
   cd AmazonSellerScraper
   npm ci
   npm run build
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `dist/` folder. The repo root does not load on its own, because the service worker has to be bundled.

To use the AI chat, open the ProScan popup, expand **AI chat settings** and paste a Gemini API key (free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)). The key stays in `chrome.storage.local`; only the service worker reads it and sends it to Google.

For local Firebase work, `npm run build:dev` points the build at the emulators under the `demo-proscan` project.

## Release checks

`npm test` runs the Jest suite and the tool tests. `npm run check` builds, then runs the permission lock (nothing may be added over `tools/live-manifest.json`, the published v2.0 manifest), the version gate and the secret scan. `npm run zip` writes the store package to `dist-zips/` and refuses a dev build, a stray file, uncommitted changes (`node tools/zip.mjs --allow-dirty` overrides that for local tries), or any gate failure. CI runs all of these.

The Jest suite includes a golden corpus of saved Amazon pages (`tests/pages/`, see its README). `npm run test:e2e` loads the built extension into Chromium and runs scrape scenarios against those pages, with every request answered locally. Run `npx playwright install --no-shell chromium` once first. Known bugs run as expected failures tagged with their audit finding id; `PROSCAN_SHOW_KNOWN=1 npm run test:e2e` shows what they fail on.

The Jest suite includes a golden corpus of saved Amazon pages (`tests/pages/`, see its README). `npm run test:e2e` loads the built extension into Chromium and runs scrape scenarios against those pages, with every request answered locally. Run `npx playwright install --no-shell chromium` once first. Known bugs run as expected failures tagged with their audit finding id; `PROSCAN_SHOW_KNOWN=1 npm run test:e2e` shows what they fail on.

## Usage

1. Navigate to any Amazon search results or seller page
2. Click the ProScan extension icon
3. Hit **Start Scraping** -- it will automatically paginate through results
4. View analytics in the dashboard (item count, average rating, average price)
5. Use the floating AI chatbot (bottom-right) to ask questions about products
6. Export data as **Excel** (multi-sheet with analytics), **CSV**, or **JSON**

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Extension | Vanilla JavaScript | UI, DOM scraping, export |
| Extension | Chrome Manifest V3 | Extension framework |
| Extension | Shadow DOM | Chatbot style isolation |
| Extension | XLSX.js | Excel generation |
| AI | Google Gemini Flash (bring your own key) | Chatbot |

## Chrome APIs Used

- `chrome.storage.local` -- Persistent state and product data
- `chrome.runtime.sendMessage` / `onMessage` -- Inter-script messaging
- `chrome.downloads` -- File export downloads
- `chrome.tabs` -- Active tab communication

## Project Structure

```
AmazonSellerScraper/
├── manifest.json                  # Extension config (Manifest V3)
├── popup/
│   ├── popup.html                # Extension popup interface
│   ├── popup.css                 # Popup styling (dark theme)
│   └── popup.js                  # UI state management and export handling
├── scripts/
│   ├── content/
│   │   ├── scraper.js            # Scrape loop: storage, messages, pagination
│   │   ├── chatbot.js            # Floating AI chatbot (Shadow DOM)
│   │   └── offer-fetcher.js      # Seller offer page fetching for spread analysis
│   ├── lib/
│   │   ├── parsers.js            # Pure search and offer page parsing
│   │   ├── run.js                # The scrape run record and its end reasons
│   │   └── chat.js               # Gemini request builder and run scoping
│   ├── background/
│   │   └── service-worker.js     # Message routing + Gemini API
│   └── modules/
│       ├── storage.js            # Chrome storage abstraction layer
│       ├── analyzer.js           # Analytics engine + opportunity scoring
│       ├── spread-analyzer.js    # Price spread statistics (CV, arbitrage score)
│       └── exporter.js           # Multi-format export (Excel/CSV/JSON)
├── styles/
│   └── chatbot.css               # Chatbot widget styles (Shadow DOM)
├── libs/
│   └── xlsx.full.min.js          # Excel generation library
└── assets/
    ├── logo.png                  # Project logo
    └── icons/                    # Extension icons (16, 48, 128px)
```

## Developer

- **Enes Yilmaz**

## License

This project is licensed under the MIT License.
