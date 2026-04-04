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
│   └── popup.js              # UI logic + API key management
├── scripts/
│   ├── content/
│   │   ├── scraper.js        # DOM scraping on Amazon pages
│   │   ├── chatbot.js        # Floating AI chatbot widget (Shadow DOM)
│   │   └── offer-fetcher.js  # Seller price fetching for spread analysis
│   ├── background/
│   │   └── service-worker.js # Message routing + Gemini API calls
│   └── modules/
│       ├── storage.js        # Chrome storage wrapper
│       ├── analyzer.js       # Data analysis & insights
│       ├── spread-analyzer.js # Price spread & arbitrage scoring
│       └── exporter.js       # Excel/CSV/JSON export
├── styles/
│   └── chatbot.css           # Chatbot widget styles (loaded into Shadow DOM)
├── server/                    # Python backend (optional, not required)
│   ├── main.py               # FastAPI entry point (REST API)
│   ├── mcp_server.py         # MCP entry point (Claude Desktop)
│   ├── config.py             # Settings (DB path, API keys, etc.)
│   ├── seed_data.py          # Sample data for testing
│   ├── requirements.txt      # Python dependencies
│   ├── db/
│   │   └── database.py       # SQLite operations
│   ├── models/
│   │   └── product.py        # Pydantic models
│   ├── services/
│   │   └── product_service.py # Shared business logic
│   ├── routers/
│   │   ├── products.py       # Product REST endpoints
│   │   └── chat.py           # Chat REST endpoint
│   └── rag/
│       ├── embeddings.py     # sentence-transformers embeddings
│       ├── vectorstore.py    # ChromaDB vector store
│       └── chain.py          # Gemini RAG chain
├── libs/
│   └── xlsx.full.min.js      # Excel generation library
├── assets/
│   └── icons/                # Extension icons (16, 48, 128)
├── .gitignore
└── CLAUDE.md                  # This file
```

## Key Modules

### Extension (JavaScript)

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
| `service-worker.js`  | Message routing, Gemini API calls, optional server sync   |

### Server (Python)

| Module               | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `product_service.py` | Business logic shared by MCP + REST                            |
| `database.py`        | SQLite with WAL mode, CRUD operations                          |
| `chain.py`           | RAG Q&A: retrieves context from ChromaDB, generates via Gemini |
| `vectorstore.py`     | ChromaDB embed/search operations                               |
| `embeddings.py`      | sentence-transformers (all-MiniLM-L6-v2)                       |

## Data Flow

### Scraping

1. User clicks "Start Scraping" in popup
2. `popup.js` sends `START_SCRAPING` via Chrome runtime
3. `scraper.js` extracts products from Amazon page
4. Results stored in `chrome.storage.local` via `storage.js`
5. Auto-navigates to next page (2s delay) until complete
6. `analyzer.js` generates insights and opportunity scores
7. User exports via `exporter.js` (Excel/CSV/JSON)

### AI Chatbot (client-side, no server)

1. `chatbot.js` injects a floating widget (bottom-right) on Amazon pages with product listings
2. Widget uses Shadow DOM to isolate styles from Amazon's CSS
3. User types a question (e.g. "What's the best deal under $30?")
4. `chatbot.js` reads scraped products from `chrome.storage.local`
5. Sends `CHAT_MESSAGE` to `service-worker.js` with question + product data
6. Service worker calls Gemini API (`gemini-2.0-flash`, free tier) with product context
7. Response displayed in chat bubble

### Server Sync (optional)

1. On `SCRAPING_COMPLETE`, `service-worker.js` POSTs products to `localhost:8000/api/products/sync`
2. Server stores in SQLite + embeds in ChromaDB (fire-and-forget, extension works without server)

## Server

### Dual Entry Points

- **REST API** (`python -m server.main`): FastAPI on port 8000, used by Chrome extension
- **MCP Server** (`python -m server.mcp_server`): stdio transport, used by Claude Desktop/Cursor

Both share `product_service.py` — same business logic, two interfaces.

### MCP Tools

- `get_product_details(asin)` — full product info
- `compare_products(asins)` — side-by-side with best-rated/best-value analysis
- `search_products(query)` — keyword search
- `smart_search(query)` — hybrid keyword + semantic search
- `list_all_products()` — paginated listing
- `get_database_stats()` — product count + RAG status
- `chat_with_product(asin, question)` — RAG Q&A via Gemini

### REST Endpoints

- `POST /api/products/sync` — receive scraped products from extension
- `GET /api/products/{asin}` — product details
- `POST /api/products/compare` — compare products
- `GET /api/products/?query=` — search
- `POST /api/chat` — RAG chat
- `GET /health` — server status

## Setup

### Extension (with AI chatbot)

1. Load unpacked extension in `chrome://extensions`
2. Click the ProScan popup → open Settings → paste your Gemini API key (free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey))
3. Navigate to Amazon seller/search page → scrape → export
4. The AI chatbot button appears in the bottom-right corner on Amazon pages with product listings

### With AI Server (optional)

```bash
cd server
pip install -r requirements.txt
```

Create `.env` in project root (see `.env.example`):

```text
PROSCAN_GEMINI_API_KEY=your-key-here
```

Run the server:

```bash
python -m server.main
```

Seed test data (optional):

```bash
python -m server.seed_data
```

### With Claude Desktop (MCP)

Add `claude_desktop_config.json` contents to Claude Desktop's MCP config.

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
- [x] MCP server with 7 tools
- [x] FastAPI REST backend
- [x] RAG pipeline (ChromaDB + sentence-transformers + Gemini)
- [x] Floating AI chatbot on Amazon pages (Gemini API, no server needed)
- [x] Shadow DOM isolation for chatbot widget
- [x] API key management in popup settings
- [x] Server sync from extension (optional)

## Future

- [ ] Historical data tracking
- [ ] Historical spread tracking (CV over time)
- [ ] BSR (Best Seller Rank) extraction
- [ ] Category detection
