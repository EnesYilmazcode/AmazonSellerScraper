# ProScan - Amazon Product Scraper + AI Analysis

## Project Overview

Chrome extension (Manifest V3) that scrapes Amazon seller product listings, provides analytics for resellers/arbitrage, and includes a floating AI chatbot on Amazon pages powered by Gemini API. No server required — everything runs client-side.

## Architecture (v2.0)

```text
AmazonSellerScraper/
├── manifest.json              # Extension config (v2.0)
├── popup/                     # UI Layer
│   ├── popup.html            # Popup interface (dashboard + settings)
│   ├── popup.css             # Popup styling
│   ├── popup.js              # UI logic
│   └── ai-key.js             # Gemini key field (AI chat settings)
├── scripts/
│   ├── content/
│   │   ├── scraper.js        # DOM scraping on Amazon pages
│   │   ├── chatbot.js        # Floating AI chatbot widget (Shadow DOM)
│   │   └── offer-fetcher.js  # Seller price fetching for spread analysis
│   ├── lib/
│   │   ├── parsers.js        # Pure search/offer parsing (global Parsers)
│   │   ├── run.js            # Scrape run record, bound to one tab (global Run)
│   │   └── chat.js           # Gemini request builder, run scoping, error text
│   ├── background/
│   │   └── service-worker.js # Message routing + Gemini API calls
│   └── modules/
│       ├── storage.js        # Chrome storage wrapper
│       ├── analyzer.js       # Data analysis & insights
│       ├── spread-analyzer.js # Price spread & arbitrage scoring
│       └── exporter.js       # Excel/CSV/JSON export
├── styles/
│   └── chatbot.css           # Chatbot widget styles (loaded into Shadow DOM)
├── tests/                     # Test suite (Jest)
│   ├── setup/
│   │   ├── chrome-mock.js    # In-memory Chrome API mock
│   │   └── dom-helpers.js    # vm-based content script loader + JSDOM
│   ├── fixtures/
│   │   ├── amazon-search-results.html  # Scraper HTML fixture (4 products)
│   │   ├── amazon-search-lastpage.html # Last page pagination fixture
│   │   ├── amazon-offer-aod.html       # AOD offer listing fixture
│   │   ├── amazon-offer-classic.html   # Classic offer listing fixture
│   │   └── sample-products.js          # Reusable product/spread data
│   ├── unit/                 # Unit tests per module
│   └── integration/          # Cross-module pipeline tests
├── libs/
│   └── xlsx.full.min.js      # Excel generation library
├── assets/
│   ├── logo.png              # Project logo
│   └── icons/                # Extension icons (16, 48, 128)
├── .gitignore
└── CLAUDE.md                  # This file
```

## Key Modules

| Module               | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `scraper.js`         | DOM scraping with cascading fallback selectors            |
| `chatbot.js`         | Floating AI chatbot widget on Amazon pages (Shadow DOM)   |
| `offer-fetcher.js`   | Fetches seller offer pages for price spread analysis      |
| `chatbot.css`        | Widget styles loaded into Shadow DOM                      |
| `storage.js`         | Async wrapper for chrome.storage.local                    |
| `analyzer.js`        | Opportunity scoring, insights, statistics                 |
| `spread-analyzer.js` | Price spread statistics (CV, std dev, arbitrage scoring)  |
| `exporter.js`        | Multi-format export (Excel, CSV, JSON)                    |
| `service-worker.js`  | Message routing, Gemini API calls                         |

## Data Flow

### Scraping

1. User clicks "Start Scraping" in popup
2. `popup.js` pings the tab; with no answer it offers `chrome.tabs.reload` and starts after the reload
3. `popup.js` writes a run record (`scripts/lib/run.js`, key `run`) bound to the tab id, then sends `START_SCRAPING`
4. `scraper.js` classifies the page (results, last, empty, captcha, interstitial, signin, unknown) and extracts products
5. Results and run progress stored in `chrome.storage.local` in one write per page
6. Follows the page's Next link after 2 to 4 seconds, up to `settings.maxPages`; on each load the content script asks the SW for its tab id (`WHO_AM_I`) and acts only if its tab owns the run
7. The run ends with a reason; Stop goes to the run's tab and cancels the pending navigation
8. `analyzer.js` generates insights and opportunity scores
9. User exports via `exporter.js` (Excel/CSV/JSON)

### AI Chatbot (client-side, no server)

1. `chatbot.js` injects a floating widget (bottom-right) on Amazon pages with product listings
2. Widget uses Shadow DOM to isolate styles from Amazon's CSS
3. User types a question (e.g. "What's the best deal under $30?")
4. `chatbot.js` sends `CHAT_MESSAGE` to `service-worker.js` with the question and the last few turns
5. The service worker reads the user's key and the current run from `chrome.storage.local`; the content script never sees the key
6. `scripts/lib/chat.js` builds the request: model id in `GEMINI_MODEL`, key in the `x-goog-api-key` header, titles in a fenced JSON block marked untrusted
7. Response displayed in chat bubble as text, never HTML

## Setup

1. Load unpacked extension in `chrome://extensions`
2. Click the ProScan popup, expand AI chat settings, paste your Gemini API key (free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey))
3. Navigate to Amazon seller/search page → scrape → export
4. The AI chatbot button appears in the bottom-right corner on Amazon pages with product listings

## Testing

### JavaScript (Jest + JSDOM)

```bash
npm test              # Run all JS tests
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests only
npm run test:coverage # With coverage report
```

**Test architecture:**
- Pure logic modules (`analyzer.js`, `spread-analyzer.js`) are tested via `require()` directly
- Content scripts (`scraper.js`, `offer-fetcher.js`) have no `module.exports` — loaded via `vm.runInContext` into a JSDOM context with Chrome API mocks and an `innerText` polyfill
- HTML fixtures in `tests/fixtures/` match the exact CSS selectors the code uses
- Chrome APIs (`storage`, `runtime`, `tabs`, `downloads`) are mocked in `tests/setup/chrome-mock.js`
- XLSX is mocked with jest.fn() stubs for workbook creation

## Chrome APIs Used

- `chrome.storage.local` — state persistence
- `chrome.runtime.sendMessage/onMessage` — inter-script communication
- `chrome.downloads` — file downloads
- `chrome.tabs` — active tab messaging

## DOM Selectors (Amazon-specific, updated Feb 2026)

```javascript
// Product container
'.s-result-item[data-asin]:not([data-asin=""])'

// Title — structural first, class fallback
'h2 span'
'.a-size-base-plus.a-color-base.a-text-normal'

// Price — data attribute for main price
'.a-price[data-a-size="xl"] .a-offscreen'
'.a-price .a-offscreen'

// Rating — cascading: data-cy > star-mini > star-small > plain text
'[data-cy="reviews-ratings-slot"] .a-icon-alt'
'.a-icon-star-mini .a-icon-alt'
'.a-icon-star-small .a-icon-alt'
'[data-cy="reviews-block"] span.a-size-base.a-color-secondary'

// Review count — aria-label has full number, display text has K/M suffix
'a[aria-label$="ratings"]'
'.a-size-mini.puis-normal-weight-text.s-underline-text'

// Prime badge
'.a-icon-prime'
```

## Analytics

### Opportunity Score

Formula: `(rating * log(reviews+1)) / sqrt(price)`
- Higher score = better arbitrage opportunity

### Price Spread Analysis

For each scraped ASIN, fetches competing seller prices and calculates:
- Coefficient of Variation (CV) = stdDev / mean * 100
- Arbitrage Score = (CV/15) * log10(sellers+1) * min(1, spread/$20)
- Combined score blends base opportunity (60%) with spread arbitrage (40%)

See `docs/PRICE_SPREAD_ANALYSIS.md` for the full specification.

### Insights

- High price spread products (CV > 30% across sellers)
- Underpriced products (30%+ below avg with 4+ stars)
- Underexposed products (good ratings, <50 reviews)
- Price/rating distributions

## Completed

- [x] Modular extension architecture
- [x] Multi-format export (Excel, CSV, JSON)
- [x] In-popup analytics dashboard
- [x] Opportunity scoring
- [x] Price spread analysis (seller price variability detection)
- [x] Floating AI chatbot on Amazon pages (Gemini API, no server needed)
- [x] Shadow DOM isolation for chatbot widget
- [x] API key management in popup settings
- [x] Comprehensive test suite (214 Jest tests)

## Future

- [ ] Historical data tracking
- [ ] Historical spread tracking (CV over time)
- [ ] BSR (Best Seller Rank) extraction
- [ ] Category detection
