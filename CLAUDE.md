# ProScan - Amazon Product Scraper + AI Analysis

## Project Overview

Chrome extension (Manifest V3) that scrapes Amazon seller product listings, provides analytics for resellers/arbitrage, and includes a floating AI chatbot on Amazon pages powered by Gemini API. No server required — everything runs client-side.

## Architecture (v2.3)

```text
AmazonSellerScraper/
├── manifest.json              # Extension config (v2.3)
├── popup/                     # UI Layer
│   ├── popup.html            # Popup interface (dashboard + settings)
│   ├── popup.css             # Popup styling
│   ├── popup.js              # UI logic
│   └── ai-key.js             # Gemini key field (AI chat settings)
├── scripts/
│   ├── content/
│   │   ├── scraper.js        # Parses a search page, reports it to the SW (parse only)
│   │   ├── chatbot.js        # Floating AI chatbot widget (Shadow DOM)
│   │   └── offer-fetcher.js  # Seller price fetching for spread analysis
│   ├── lib/
│   │   ├── parsers.js        # Pure search/offer parsing (global Parsers)
│   │   ├── messages.js       # Every message type and who may send it (global Msg)
│   │   ├── run.js            # Run state machine, bound to one tab (global Run)
│   │   ├── flags.js          # Build flags (global Flags); CLOUD_SYNC is on from 2.3
│   │   ├── migrate.js        # Storage schema migrations, run by the SW
│   │   └── chat.js           # Gemini request builder, run scoping, error text
│   ├── background/
│   │   ├── service-worker.js # Wires router, engine, chat, auth and migrations
│   │   ├── router.js         # The one typed message router
│   │   ├── engine.js         # The run engine; the only writer of run data
│   │   ├── db.js             # IndexedDB: runs, products, placements, lastValues, outbox, spread
│   │   ├── sync-plan.js      # Outbox entry -> cloud writes (pure)
│   │   └── sync.js           # Drains the outbox into Firestore, one entry at a time
│   └── modules/
│       ├── storage.js        # Chrome storage wrapper
│       ├── analyzer.js       # Data analysis & insights
│       ├── spread-analyzer.js # Price spread & arbitrage scoring
│       └── exporter.js       # Excel/CSV/JSON export
├── packages/
│   └── schema/index.js       # Cloud schema: types, validators, ids (shared with the dashboard)
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
| `scraper.js`         | Parses a page with `Parsers`, sends `PAGE_RESULT`         |
| `engine.js`          | Run state machine, page saves, navigation, heartbeat     |
| `chatbot.js`         | Floating AI chatbot widget on Amazon pages (Shadow DOM)   |
| `offer-fetcher.js`   | Fetches seller offer pages for price spread analysis      |
| `chatbot.css`        | Widget styles loaded into Shadow DOM                      |
| `storage.js`         | Async wrapper for chrome.storage.local                    |
| `analyzer.js`        | Opportunity scoring, insights, statistics                 |
| `spread-analyzer.js` | Price spread statistics (CV, std dev, arbitrage scoring)  |
| `exporter.js`        | Multi-format export (Excel, CSV, JSON)                    |
| `service-worker.js`  | Router wiring, Gemini API calls, migrations               |

## Data Flow

### Scraping

The service worker is the only writer (`scripts/background/engine.js`).

1. User clicks "Start Scraping" in popup; `popup.js` sends `START_RUN {tabId}` to the SW
2. The SW pings the tab. No answer: the popup offers `chrome.tabs.reload` and starts after the reload.
   A page that is not a search (captcha, sign-in, product page) is refused and nothing changes
3. The SW writes the run record (`scripts/lib/run.js`) to `chrome.storage.session` under `run`,
   bound to the tab id, and asks the tab to parse (`PARSE_PAGE`)
4. `scraper.js` classifies the page (results, last, empty, captcha, interstitial, signin, unknown),
   extracts products and sends `PAGE_RESULT`. It never writes storage and never navigates
5. The SW folds the page into the run and writes products, the page, lastValues and the run
   to IndexedDB in one transaction, then prunes lastValues
6. After 2 to 4 seconds the SW opens the page's Next link with `tabs.update`, up to `settings.maxPages`.
   The new page says `PAGE_READY`; only the run's tab is asked to parse
7. While a page is pending the tab sends `HEARTBEAT` every 2 seconds. That wakes a stopped SW,
   which reads the run from session storage and opens the next page when it is due
8. The run ends with a reason; Stop goes to the SW, which cancels the pending page. Closing the
   run's tab or taking it elsewhere ends the run as `interrupted`
9. `analyzer.js` generates insights and opportunity scores
10. User exports via `exporter.js` (Excel/CSV/JSON)

Run states: idle, starting, running, stopping, then stopped, blocked, failed or done.
`reason` says why it ended: complete, stopped, blocked, selectors_broken, storage_full,
storage_error, interrupted or updated.

### Cloud sync (2.3)

1. The popup signs in with email and password through the SW (`PROSCAN_SIGN_IN`); sign-up opens
   the dashboard, and "Forgot password?" sends `PROSCAN_RESET_PASSWORD` (same answer either way)
2. The SW keeps `account` {uid, email} in `chrome.storage.local` while signed in. The engine
   queues `{kind:'page', pageIndex, uid}` per saved page and `{kind:'run', uid}` when a run ends,
   only when an account is signed in
3. `lastValues` snapshots carry the uid that took them; another account's snapshot gives no delta
4. `scheduleFlush()` runs a few seconds after PAGE_RESULT, STOP_RUN, a tab change, popup open,
   sign-in, browser start and update. No alarms
5. `sync.js` drains the outbox for the signed-in uid, oldest first. `sync-plan.js` turns an entry
   into writes; each is `set` with `mergeFields`, so `latest`, `prev` and `delta` are replaced whole.
   `firstSeenAt` is written only when a read shows the product document does not exist
6. An entry is deleted after its own commit. Entries of another uid are left alone. An entry
   that fails schema validation is dropped, since retrying it would fail the same way
7. An expired or invalid token signs out and sets `authNotice: 'expired'`; the popup shows
   "Your session expired". A `permission-denied` (the rules refusing a write) is not a sign-out;
   the entry stays queued and `lastSync.error` records it

Cloud paths and shapes: `packages/schema/index.js` (keep the dashboard's copy identical, bump `SV`
on a shape change). Run id `{sourceId}_{startMs}`, minted once in `engine.start`; page id `p0001`;
`dayKey` is the local date the run started.

### AI Chatbot (client-side, no server)

1. `chatbot.js` injects a floating widget (bottom-right) on Amazon pages with product listings
2. Widget uses Shadow DOM to isolate styles from Amazon's CSS
3. User types a question (e.g. "What's the best deal under $30?")
4. `chatbot.js` sends `CHAT_MESSAGE` to `service-worker.js` with the question and the last few turns
5. The service worker reads the user's key from `chrome.storage.local` and the latest run from IndexedDB; the content script never sees the key
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
- `tests/setup/engine-rig.js` runs the real router and engine over fake-indexeddb with the real `scraper.js` in a JSDOM page per tab; `tests/unit/engine.test.js` drives runs through it
- `npm run test:contract` runs the real `sync.js` against the Firebase emulators with the dashboard's
  `firestore.rules` (`tools/contract.mjs`, `tests/contract/`); ESM files under `packages/` and
  `scripts/background/` load in Jest through `tests/setup/esm-to-cjs-transform.js`
- `npm run test:e2e` runs the same scenarios in Chromium (`tests/e2e/`), including the worker stopped via CDP between pages and 2.0 and 2.1 builds updated mid-run
- HTML fixtures in `tests/fixtures/` match the exact CSS selectors the code uses
- Chrome APIs (`storage`, `runtime`, `tabs`, `downloads`) are mocked in `tests/setup/chrome-mock.js`
- XLSX is mocked with jest.fn() stubs in exporter.test.js; export-xlsx.test.js uses the real libs/xlsx.full.min.js

## Chrome APIs Used

- `chrome.storage.local`: settings, the Gemini key, `schemaVersion`, and `account`, `authNotice`, `lastSync`
- `chrome.storage.session`: the live run record (content scripts cannot read it)
- IndexedDB: run data, in the extension origin; needs no permission
- `chrome.runtime.sendMessage/onMessage`: messages, all in `scripts/lib/messages.js`
- `chrome.downloads`: file downloads
- `chrome.tabs`: `sendMessage`, `update`, `onRemoved`, `onUpdated`; none need the `tabs` permission

No permission was added for the run engine: no `alarms`, `scripting`, `offscreen` or
`unlimitedStorage`. `npm run lock` fails on any addition.

## DOM Selectors (Amazon-specific, updated Sep 2026)

```javascript
// Product container: real result cards when the page marks them,
// otherwise any result item with an ASIN
'[data-component-type="s-search-result"]'
'.s-result-item[data-asin]:not([data-asin=""])'

// Title: the h2 inside the product link, then the last title-recipe h2,
// then the old fallbacks (a brand line can be its own h2)
'a h2'
'[data-cy="title-recipe"] h2'
'h2 span'
'.a-size-base-plus.a-color-base.a-text-normal'

// Price: the main price; a-text-price is a unit or list price
'.a-price[data-a-size="xl"] .a-offscreen'
'.a-price:not(.a-text-price) .a-offscreen'   // outside secondary-offer-recipe

// Rating: cascading data-cy > star-mini > star-small > plain text
'[data-cy="reviews-ratings-slot"] .a-icon-alt'
'.a-icon-star-mini .a-icon-alt'
'.a-icon-star-small .a-icon-alt'
'[data-cy="reviews-block"] span.a-size-base.a-color-secondary'

// Review count: aria-label has the full number, display text has K/M
'a[aria-label$="ratings"], a[aria-label$="rating"]'
'.a-size-mini.puis-normal-weight-text.s-underline-text'

// Sponsored: AdHolder card, the label, or an sspa ad link
'.puis-sponsored-label-text, [data-component-type="sp-sponsored-result"], a[href*="/sspa/"]'

// Prime badge
'.a-icon-prime'
```

## Product record

One record per ASIN per run, from `Parsers.parseSearchPage` and the scraper:

- `name`, `price`, `rating`, `reviewCount`: null when the card has none, never 0 or "N/A"
- `priceCents`: integer cents from a dollar price only; `currency` is `USD`, another symbol, or null
- `url`: always `https://www.amazon.com/dp/{asin}`, never the sspa ad link
- `sponsored`: true if any placement was an ad; `organicRank`: run-wide rank of the first organic card, or null
- `placements`: every card the ASIN had, as `{page, position, sponsored, rank}`
- `img`: the card image on Amazon's image host, or null
- `prev`: the `lastValues` snapshot the delta was taken against, or null
- `delta`: taken once, on the ASIN's first sighting in the run, against `lastValues` from earlier runs.
  A field that fails to parse keeps its last good value in `lastValues`, with the time in `carried`

## Storage

- `chrome.storage.local` carries `schemaVersion` (4) and settings. Storage without it came from 2.0.
  `scripts/lib/migrate.js` brings it up to date on install, update and browser start;
  each step is idempotent. 2 to 3 adds `priceCents`, nulls and `/dp/` URLs to 2.0 rows,
  seeds `lastValues` from them (with `firstSeenAt`), ends a run the update cut off as
  `updated`, and drops the untouched 2.0 default settings. 3 to 4 moves results, pages,
  lastValues, spread data and the run into IndexedDB (a run still running is `updated`);
  the IndexedDB writes commit before anything is removed.
- IndexedDB `proscan` (`scripts/background/db.js`): `runs`, `products` (key `[runId, n]`,
  n is the order found), `placements` (one record per page), `lastValues` (by ASIN),
  `outbox` (`{kind, runId, uid, pageIndex}` entries waiting for sync), `spread` and `meta` (`latestRunId`). The popup shows
  the latest run's products.
  `tests/fixtures/v2.0-storage.json` is what the live 2.0 build stores, captured with
  `node tests/e2e/capture-v20-storage.mjs`.
- `lastValues` is pruned after every page: 5,000 ASINs, none older than a year
  (`Delta.MAX_ENTRIES`, `Delta.MAX_AGE_DAYS`).
- A page write that fails ends the run as `storage_full` (quota) or `storage_error`.
  The popup warns from 90% of `navigator.storage.estimate()`.
- Cloud sync was off in 2.1 and 2.2 and is on from 2.3 (`Flags.CLOUD_SYNC`). Signed out, nothing
  goes into the outbox.

## Export

- CSV: UTF-8 with a BOM, CRLF, every text field quoted (RFC 4180). Text starting with
  `=`, `+`, `-`, `@`, tab or CR gets a leading `'`. Price is a number of dollars from
  `priceCents`; unknown values are empty cells and real zeros stay 0.
- Excel: prices, ratings, review counts and scores are numbers; unknowns are empty.
  `tests/unit/export-xlsx.test.js` writes the workbook with the real SheetJS and checks
  every XML part parses.

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
