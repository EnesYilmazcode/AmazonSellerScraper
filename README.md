<p align="center">
  <img src="logo.png" alt="ProScan Logo" width="128">
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
  <img src="https://img.shields.io/badge/AI-Gemini_2.0_Flash-blue" alt="Gemini AI">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
</p>

---

## Overview

ProScan is a Chrome extension that scrapes Amazon product listings across multiple pages, runs analytics to identify arbitrage opportunities, and includes a floating AI chatbot powered by Google Gemini for real-time product Q&A -- all running client-side with no server required.

An optional Python backend adds persistent storage (SQLite), semantic search (ChromaDB), and MCP integration for use with Claude Desktop.

## Key Features

- **Multi-page scraping** -- Automatically navigates and extracts product data (name, ASIN, price, rating, reviews, Prime status) across paginated Amazon results
- **Opportunity scoring** -- Proprietary formula identifies high-value arbitrage opportunities based on rating, review velocity, and price positioning
- **Price spread analysis** -- Fetches competing seller prices for each product and calculates variability (Coefficient of Variation) to identify pricing disagreement -- a strong arbitrage signal
- **AI chatbot** -- Floating widget on Amazon pages answers questions about scraped products using Gemini 2.0 Flash (e.g., "What's the best deal under $30?")
- **Analytics dashboard** -- Real-time stats, underpriced product detection, and quality distribution analysis
- **Multi-format export** -- Excel (with styled sheets and charts), CSV, and JSON with full analytics
- **Shadow DOM isolation** -- Chatbot widget styles are fully isolated from Amazon's CSS
- **Optional server backend** -- SQLite persistence, ChromaDB vector search, and MCP tools for Claude Desktop

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
 └──────────────┬───────────────────────────────────────────┘
                │  Optional sync (POST /api/products/sync)
                ▼
 ┌──────────────────────────────────────────────────────────┐
 │                 Python Backend (Optional)                 │
 │                                                          │
 │  server/                                                 │
 │  ├── main.py           (FastAPI REST server)             │
 │  ├── mcp_server.py     (MCP server for Claude Desktop)   │
 │  ├── config.py         (Centralized configuration)       │
 │  ├── db/                                                 │
 │  │   └── database.py   (SQLite with WAL mode)            │
 │  ├── models/                                             │
 │  │   └── product.py    (Pydantic schemas)                │
 │  ├── services/                                           │
 │  │   └── product_service.py  (Shared business logic)     │
 │  ├── routers/                                            │
 │  │   ├── products.py   (Product CRUD endpoints)          │
 │  │   └── chat.py       (RAG chat endpoint)               │
 │  └── rag/                                                │
 │      ├── embeddings.py (sentence-transformers)           │
 │      ├── vectorstore.py (ChromaDB operations)            │
 │      └── chain.py      (Gemini RAG generation)           │
 └──────────────────────────────────────────────────────────┘
```

## Data Flow

### Scraping Pipeline

```
User clicks "Start Scraping"
  → popup.js sends START_SCRAPING message
  → scraper.js extracts products from DOM using cascading selectors
  → Results stored in chrome.storage.local
  → Auto-navigates to next page (2s delay for rate limiting)
  → Repeats until no more pages
  → analyzer.js generates insights and opportunity scores
  → User exports via exporter.js (Excel/CSV/JSON)
```

### AI Chatbot Flow

```
User types question in floating widget
  → chatbot.js reads products from chrome.storage.local
  → Sends CHAT_MESSAGE to service-worker.js
  → Service worker calls Gemini 2.0 Flash API with product context
  → Response displayed in chat bubble
```

### Server Sync (Optional)

```
On SCRAPING_COMPLETE event
  → service-worker.js POSTs products to localhost:8000/api/products/sync
  → Server stores in SQLite + embeds in ChromaDB (fire-and-forget)
  → Extension works standalone if server is unavailable
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

### Chrome Extension

1. Clone the repository:
   ```bash
   git clone https://github.com/enesyilmaz7/AmazonSellerScraper.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Click the ProScan extension icon → **Settings** → paste your [Gemini API key](https://aistudio.google.com/apikey) (free)

### Python Backend (Optional)

```bash
cd server
pip install -r requirements.txt
```

Create a `.env` file in the project root:
```
PROSCAN_GEMINI_API_KEY=your-gemini-api-key
```

Start the server:
```bash
python -m server.main
```

Seed sample data for testing:
```bash
python -m server.seed_data
```

### Claude Desktop (MCP Integration)

Add the following to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "proscan": {
      "command": "python",
      "args": ["-m", "server.mcp_server"],
      "cwd": "/path/to/AmazonSellerScraper"
    }
  }
}
```

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
| AI | Google Gemini 2.0 Flash | Chatbot and RAG generation |
| Backend | FastAPI + Uvicorn | REST API server |
| Backend | SQLite (WAL mode) | Product persistence |
| Backend | ChromaDB | Vector embeddings storage |
| Backend | sentence-transformers | Text embeddings (all-MiniLM-L6-v2) |
| Backend | FastMCP | Claude Desktop integration |
| Backend | Pydantic | Data validation |

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/products/sync` | Sync scraped products from extension |
| `GET` | `/api/products/{asin}` | Get product details by ASIN |
| `POST` | `/api/products/compare` | Compare multiple products |
| `GET` | `/api/products/?query=` | Search or list products |
| `POST` | `/api/chat` | RAG-powered product Q&A |
| `GET` | `/health` | Server health check |

### MCP Tools

| Tool | Description |
|------|-------------|
| `get_product_details(asin)` | Full product info by ASIN |
| `compare_products(asins)` | Side-by-side comparison with best-value analysis |
| `search_products(query)` | Keyword search across products |
| `smart_search(query)` | Hybrid keyword + semantic search |
| `list_all_products()` | Paginated product listing |
| `get_database_stats()` | Database metrics and RAG status |
| `chat_with_product(asin, question)` | RAG Q&A via Gemini |

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
│   │   ├── scraper.js            # DOM scraping with cascading selectors
│   │   ├── chatbot.js            # Floating AI chatbot (Shadow DOM)
│   │   └── offer-fetcher.js      # Seller offer page fetching for spread analysis
│   ├── background/
│   │   └── service-worker.js     # Message routing + Gemini API
│   └── modules/
│       ├── storage.js            # Chrome storage abstraction layer
│       ├── analyzer.js           # Analytics engine + opportunity scoring
│       ├── spread-analyzer.js    # Price spread statistics (CV, arbitrage score)
│       └── exporter.js           # Multi-format export (Excel/CSV/JSON)
├── styles/
│   └── chatbot.css               # Chatbot widget styles (Shadow DOM)
├── server/
│   ├── main.py                   # FastAPI server entry point
│   ├── mcp_server.py             # MCP server for Claude Desktop
│   ├── config.py                 # Server configuration
│   ├── seed_data.py              # Sample data for testing
│   ├── requirements.txt          # Python dependencies
│   ├── db/
│   │   └── database.py           # SQLite operations (WAL mode)
│   ├── models/
│   │   └── product.py            # Pydantic data models
│   ├── services/
│   │   └── product_service.py    # Shared business logic
│   ├── routers/
│   │   ├── products.py           # Product REST endpoints
│   │   └── chat.py               # Chat REST endpoint
│   └── rag/
│       ├── embeddings.py         # sentence-transformers embeddings
│       ├── vectorstore.py        # ChromaDB vector store
│       └── chain.py              # Gemini RAG chain
├── libs/
│   └── xlsx.full.min.js          # Excel generation library
└── assets/
    └── icons/                    # Extension icons (16, 48, 128px)
```

## Developer

- **Enes Yilmaz**

## License

This project is licensed under the MIT License.
