# Price Spread Analysis — Feature Specification

## Problem Statement

When evaluating products for Amazon arbitrage, the current opportunity score considers a product's own price, rating, and reviews. But it misses a critical signal: **how other sellers price the same product**.

If multiple sellers list the same ASIN at wildly different prices, that's a strong arbitrage indicator:
- Sellers pricing high believe the market will bear it
- Sellers pricing low are either liquidating or undervaluing
- The spread between them is your potential margin

Getting approved to sell on Amazon takes time, and price changes aren't instant. So sellers who've set a high price are committed to that position — they've done the math. High price variability means the market hasn't settled, which means there's room to capture margin.

## Core Metric: Coefficient of Variation (CV)

The best single metric for "relative price variability" is the **Coefficient of Variation**:

```
CV = (standardDeviation / mean) * 100
```

Why CV and not just the range (max - min)?
- A $50 spread on a $20 item is massive (250% CV)
- A $50 spread on a $500 item is noise (10% CV)
- CV normalizes for price level, making it comparable across products

### Interpreting CV

| CV Range | Signal | Meaning |
|----------|--------|---------|
| 0-5% | Very Low | Tight consensus, commodity pricing |
| 5-15% | Low | Normal variance, limited opportunity |
| 15-30% | Moderate | Some disagreement, worth investigating |
| 30-50% | High | Significant spread, likely opportunity |
| 50%+ | Very High | Major pricing disagreement, strong signal |

## Arbitrage Score Formula

The spread-based arbitrage score combines three factors:

```
rawScore = (CV / 15) * log10(sellerCount + 1) * min(1, absoluteSpread / 20)
arbitrageScore = clamp(rawScore * 2.5, 1, 10)
```

### Factor Breakdown

1. **CV / 15**: Normalizes the coefficient of variation. A CV of 30% produces a factor of 2.0. This is the primary signal — higher variability = more opportunity.

2. **log10(sellerCount + 1)**: Rewards confidence from more data points. 2 sellers → 0.48, 5 sellers → 0.78, 10 sellers → 1.04, 50 sellers → 1.71. Logarithmic scale prevents outlier seller counts from dominating.

3. **min(1, absoluteSpread / 20)**: Caps the absolute dollar spread factor. A $20+ spread gets full weight (1.0), but a $5 spread only gets 0.25. This ensures we don't score a high-CV product as a great opportunity if the actual dollar amount is trivial.

### Multiplier and Clamping

- **× 2.5**: Scale factor to map typical scores into the 1-10 range
- **clamp(1, 10)**: Floor at 1 (no negative scores), ceiling at 10

### Example Calculations

| Product | Mean Price | Std Dev | CV | Sellers | Spread | Raw Score | Final Score |
|---------|-----------|---------|-----|---------|--------|-----------|-------------|
| Wireless Earbuds | $45 | $22.50 | 50% | 8 | $55 | 3.33 × 0.95 × 1.0 = 3.16 | 7.9 |
| USB Cable | $8 | $1.20 | 15% | 12 | $4 | 1.0 × 1.11 × 0.2 = 0.22 | 1.0 |
| Kitchen Scale | $25 | $8.75 | 35% | 4 | $28 | 2.33 × 0.70 × 1.0 = 1.63 | 4.1 |
| Premium Headphones | $300 | $15 | 5% | 20 | $60 | 0.33 × 1.32 × 1.0 = 0.44 | 1.1 |

## Data Source: Amazon Offer Listing Pages

For each ASIN, the offer listing page shows all sellers and their prices:

```
URL: https://www.amazon.com/gp/offer-listing/{ASIN}/ref=dp_olp_all_mbc?ie=UTF8&condition=new
```

Alternative (AJAX endpoint for All Offers Display):
```
URL: https://www.amazon.com/gp/aod/ajax?asin={ASIN}&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp
```

### What We Extract

From each offer on the page:
- **Price** (primary data point for spread calculation)
- **Seller count** (number of offers = data point confidence)
- **Condition** (filter to "New" only for fair comparison)

### Parsing Strategy

Offer listing pages use standard Amazon price elements:

```javascript
// Primary: AOD (All Offers Display) price elements
'.aod-information-block .a-price .a-offscreen'

// Fallback: Classic offer listing page
'#olpOfferList .a-price .a-offscreen'
'.olpOfferPrice'

// General fallback
'.a-price .a-offscreen'
```

Multiple selectors with cascading fallback, same pattern as the existing scraper.

## Architecture

### Data Flow

```
User clicks "Analyze Spreads" in popup
  → popup.js sends START_SPREAD_ANALYSIS to content script
  → offer-fetcher.js reads product ASINs from chrome.storage
  → For each ASIN (with 2-second delay between requests):
      → Fetch offer listing page (same-origin, no CORS)
      → Parse HTML with DOMParser
      → Extract all seller prices
      → Calculate spread metrics via SpreadAnalyzer
      → Store results in chrome.storage
      → Send SPREAD_PROGRESS to popup
  → When all ASINs processed:
      → Send SPREAD_ANALYSIS_COMPLETE to popup
      → Popup displays results and updated scores
```

### Rate Limiting

Amazon will throttle or block rapid requests. The fetcher uses:
- **2-second delay** between offer page requests
- **Sequential processing** (one ASIN at a time, not parallel)
- **Stoppable**: user can cancel mid-analysis
- For 50 products, total analysis time ≈ 100 seconds (1:40)

### New Files

| File | Purpose |
|------|---------|
| `scripts/modules/spread-analyzer.js` | Pure math: CV, std dev, arbitrage score |
| `scripts/content/offer-fetcher.js` | Fetch offer pages, parse prices, orchestrate analysis |

### Modified Files

| File | Changes |
|------|---------|
| `manifest.json` | Register offer-fetcher.js as content script |
| `scripts/modules/storage.js` | Add SPREAD_RESULTS key |
| `popup/popup.html` | Add "Analyze Spreads" button and results display |
| `popup/popup.js` | Handle spread analysis trigger, progress, and results |
| `popup/popup.css` | Styles for spread analysis UI |
| `scripts/modules/analyzer.js` | Integrate spread data into opportunity scoring |
| `scripts/modules/exporter.js` | Include spread data in exports |

### Storage Schema for Spread Data

```javascript
// New key in Storage.KEYS
SPREAD_RESULTS: 'spreadResults'

// Structure: Map of ASIN → spread data
{
    "B09XS7JWHH": {
        asin: "B09XS7JWHH",
        sellerPrices: [328.00, 299.99, 345.00, 310.50, 289.99],
        sellerCount: 5,
        minPrice: 289.99,
        maxPrice: 345.00,
        meanPrice: 314.70,
        medianPrice: 310.50,
        stdDev: 21.34,
        coefficientOfVariation: 6.78,
        absoluteSpread: 55.01,
        arbitrageScore: 2.1,
        fetchedAt: "2026-04-03T10:30:00Z"
    },
    ...
}
```

## Enhanced Opportunity Score

The existing opportunity score can be combined with the spread-based arbitrage score:

```
combinedScore = (originalScore * 0.6) + (arbitrageScore * 0.4)
```

This weights the original signal (rating × reviews / price) at 60% and the new spread signal at 40%. Products that score high on BOTH metrics are the strongest opportunities.

## UI Design

### Popup Changes

1. **"Analyze Spreads" button** — appears after scraping completes, below the export buttons
2. **Progress indicator** — "Analyzing 12/50 products..." with a progress bar
3. **Spread stats card** — shows average CV, number of high-spread products
4. **Enhanced insights** — "5 products have high price spread (CV > 30%)"

### Export Changes

Excel/CSV/JSON exports gain new columns:
- Seller Count
- Min Offer Price
- Max Offer Price
- Price Spread ($)
- CV (%)
- Arbitrage Score (1-10)

## Edge Cases

1. **Product has only 1 seller**: CV = 0, arbitrage score = 1 (minimum). Not enough data.
2. **Product page returns no offers**: Store as null, skip in analysis.
3. **Amazon rate limits**: If a fetch returns non-200, retry once after 5 seconds, then skip.
4. **Used vs New prices**: Filter to "New" condition only for fair comparison.
5. **Price includes shipping**: Use total price where possible.
6. **Very large scrape sets (100+ products)**: Analysis could take 3+ minutes. Show progress and allow cancellation.

## Future Enhancements

- Historical spread tracking (how does CV change over time?)
- Seller reputation weighting (FBA vs FBM)
- Buy Box price vs offer spread analysis
- Automatic re-analysis on a schedule
- Shipping cost inclusion in spread calculation
