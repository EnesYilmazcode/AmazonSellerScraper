# ProScan internals

The deep detail behind the [README](../README.md): how a run moves through the extension, sync, the chat, the scores and the Chrome APIs it uses.

## Data Flow

### Scraping Pipeline

```
User presses Scrape in the dock (or in the popup)
  → dock.js sends START_RUN_HERE; the worker takes the tab from
    sender.tab.id, never from the message. The popup sends START_RUN {tabId}
  → The worker pings the tab (the popup offers a reload if ProScan is not
    loaded there), makes a run bound to that tab and asks it to parse
  → scraper.js classifies the page, extracts products and sends PAGE_RESULT;
    it never writes storage and never navigates
  → The worker saves the page to IndexedDB in one transaction
  → After a 2 to 4 second delay the worker opens the page's Next link
    with tabs.update, and the new page reports in
  → Repeats until the last page or the page cap (settings.maxPages, default 20)
  → The run ends with a reason: complete, stopped, blocked (captcha,
    bot check, sign-in), selectors_broken, storage_full, interrupted or
    updated (the extension updated mid-run)
  → After each saved page the worker sends RUN_PROGRESS to the run's tab.
    Every page is a new document, so the dock rebuilds from RUN_STATUS
  → analyzer.js generates insights and opportunity scores
  → Download in the dock sends DOWNLOAD {format}; the worker makes the file
    with Exporter.build and saves it through chrome.downloads. A file over
    about 1.5 MB goes back to the page, which saves it with a download link
```

### The dock

```
On every Amazon page but cart, checkout, sign-in and account pages:
  search results (/s?k=) or a storefront (/s?me=)  → "Scrape" suggested
  seller profile (/sp?seller=) or a brand store     → "Open storefront"
  anywhere else, product pages included             → ProScan + Ask
Open, it is a card: Scrape (start, progress, stop, downloads, compare
seller prices) and Ask (the chat), plus settings (pages per run, the
suggestion on or off, links to the key and sign-in on ProScan's own page).
```

Keys and passwords are never typed on Amazon: keystrokes inside a shadow root still reach the page's own listeners. The dock's settings open ProScan's settings page instead.

### Cloud Sync

```
Signed in to a ProScan account in the popup (email and password)
  → Each saved page goes into the IndexedDB outbox, tagged with the account's uid;
    the end of the run goes in after its pages
  → A few seconds after a page, a run end, a popup open or a browser start,
    the worker flushes the outbox (no alarms). After a failed flush the next
    automatic one waits 30 s, doubling up to an hour
  → sync.js writes one entry at a time: the page chunk, and a product and a
    history document per ASIN on the page. The run header and the source go
    once per run per flush. latest, prev and delta are replaced whole, never
    merged; sourceIds keeps every source
  → An entry leaves the outbox only once its own writes commit; a page saved
    during a flush goes out before the flush returns
  → An entry the rules refuse is set aside, so the entries behind it still sync;
    the popup counts them and Export to ProScan tries them again
  → Export to ProScan flushes right away
```

Write cost: a page of k products is 1 + 2k writes, plus 2 per run per flush. A 20 page run of 48 products a page is about 1,960 writes. Spark allows 20,000 writes a day for the whole project, shared by every user, so about 10 such runs a day fill it (audit F-23).

The document shapes, ids and validators are in `packages/schema/index.js`, which the dashboard copies. Money is integer cents, unknown values are null (left out of compact points), and every document carries `sv`. A signed-out user queues nothing. If Firebase drops the session, the popup says so and the queued pages wait for the same account to sign in again.

### AI Chatbot Flow

```
User types a question in the dock's Ask tab
  → dock.js sends CHAT_MESSAGE (question + last few turns) to service-worker.js
  → Service worker reads the user's key and the latest run from its storage
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

After scraping, click **Compare seller prices** in the dock or the popup to fetch competing seller prices for each product. The system:

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

## Chrome APIs Used

- `chrome.storage.local` -- Settings, the schema version, and the signed-in account (`account`, `authNotice`, `lastSync`)
- `chrome.storage.session` -- The live run record, written by the service worker
- IndexedDB (the extension's own origin, no permission) -- Runs, products, pages, lastValues and the sync outbox. Starting a run keeps the 10 newest runs and removes older ones, except runs still waiting to sync.
- `chrome.runtime.sendMessage` / `onMessage` -- Messages, all listed in `scripts/lib/messages.js`
- `chrome.downloads` -- File downloads, from the popup and, for the dock, from the service worker
- `chrome.tabs` -- Messages to the run's tab, `tabs.update` for the next page, `onRemoved` / `onUpdated` to notice the tab going away, and `tabs.create` to open ProScan's settings page from the dock (none of these need the `tabs` permission)

2.4 adds no permission, host or match pattern, and drops `web_accessible_resources`: the dock needs no file from the extension.

## Project Structure

```
AmazonSellerScraper/
├── manifest.json                  # Extension config (Manifest V3)
├── popup/
│   ├── popup.html                # Extension popup interface
│   ├── popup.css                 # Popup styling (light and dark)
│   ├── popup.js                  # Fallback Scrape, downloads, settings
│   └── ai-key.js                 # The Gemini key field
├── scripts/
│   ├── content/
│   │   ├── scraper.js            # Parses a search page and reports it to the worker
│   │   ├── offer-fetcher.js      # Seller offer page fetching for spread analysis
│   │   ├── dock-styles.js        # The dock's stylesheet, as a string
│   │   └── dock.js               # The on-page dock: Scrape, Ask, settings (closed Shadow DOM)
│   ├── lib/
│   │   ├── parsers.js            # Pure search and offer page parsing
│   │   ├── messages.js           # Every message type and who may send it
│   │   ├── run.js                # The run state machine and its end reasons
│   │   ├── page-kind.js          # Search, storefront, seller or a page to stay off
│   │   ├── flags.js              # Build flags (cloud sync is on from 2.3)
│   │   ├── migrate.js            # Storage schema migrations (schemaVersion)
│   │   └── chat.js               # Gemini request builder and run scoping
│   ├── background/
│   │   ├── service-worker.js     # Wires the router, the engine, the chat and migrations
│   │   ├── router.js             # The one message router
│   │   ├── engine.js             # Runs scrapes; the only writer of run data
│   │   ├── download.js           # Files for the dock, through chrome.downloads
│   │   ├── db.js                 # IndexedDB stores
│   │   ├── sync-plan.js          # What each outbox entry writes (pure)
│   │   └── sync.js               # Drains the outbox into Firestore
│   └── modules/
│       ├── storage.js            # Chrome storage abstraction layer
│       ├── analyzer.js           # Analytics engine + opportunity scoring
│       ├── spread-analyzer.js    # Price spread statistics (CV, arbitrage score)
│       └── exporter.js           # Multi-format export (Excel/CSV/JSON)
├── packages/
│   └── schema/index.js           # Cloud schema shared with the dashboard
├── libs/
│   └── xlsx.full.min.js          # Excel generation library
└── assets/
    ├── logo.png                  # Project logo
    └── icons/                    # Extension icons (16, 48, 128px)
```

