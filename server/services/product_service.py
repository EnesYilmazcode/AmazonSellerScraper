"""Shared business logic for ProScan.

Called by both the MCP server (stdio) and the REST API (HTTP).
This is the single source of truth for product operations --
no business logic lives in routers or MCP tool handlers.

Key responsibilities:
    - Product ingestion: parsing raw JS data, storing in SQLite, embedding in ChromaDB
    - Product comparison: side-by-side analysis with best-rated/best-value detection
    - Search: keyword (SQL LIKE) and hybrid (keyword + semantic via ChromaDB)
    - RAG chat: product Q&A powered by Gemini + ChromaDB context
    - Database statistics for monitoring
"""

import re
from server.db import database

# RAG imports -- optional, fail gracefully if dependencies not installed
_rag_available = False
try:
    from server.rag import vectorstore, chain
    _rag_available = True
except ImportError:
    pass


def parse_price(price_str):
    """Parse a price string (e.g., '$19.99') to a float.

    Strips all non-numeric characters except the decimal point.

    Args:
        price_str: Raw price string from scraper (may include $, commas)

    Returns:
        float: Numeric price, or 0.0 if unparseable
    """
    if not price_str or price_str == "N/A":
        return 0.0
    cleaned = re.sub(r"[^0-9.]", "", str(price_str))
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def parse_rating(rating):
    """Parse a rating value which may be a number, string, or 'N/A'.

    Args:
        rating: Raw rating from scraper

    Returns:
        float: Numeric rating (0-5), or 0.0 if invalid
    """
    if rating == "N/A" or rating is None:
        return 0.0
    try:
        return float(rating)
    except (ValueError, TypeError):
        return 0.0


def sync_products(products, seller_name=None, seller_url=None):
    """Ingest scraped products from the Chrome extension into the backend.

    Pipeline:
        1. Parse raw price/rating strings into numeric fields
        2. Insert a scrape_run record for batch tracking
        3. Batch insert all products linked to that run
        4. Embed products into ChromaDB for semantic search (if available)

    Args:
        products: List of product dicts (camelCase from JS)
        seller_name: Amazon seller name (optional)
        seller_url: Seller page URL (optional)

    Returns:
        tuple[int, int]: (synced_count, scrape_run_id)
    """
    # Parse numeric fields from JS camelCase format
    for p in products:
        p["price_numeric"] = parse_price(p.get("price", ""))
        p["rating_numeric"] = parse_rating(p.get("rating", 0))
        p["review_count"] = int(p.get("reviewCount", 0) or p.get("review_count", 0) or 0)
        p["is_prime"] = bool(p.get("isPrime", False) or p.get("is_prime", False))

    # Insert into SQLite
    scrape_run_id = database.insert_scrape_run(
        seller_name, seller_url, len(products)
    )
    database.insert_products(products, scrape_run_id)

    # Embed into ChromaDB if RAG is available (fire-and-forget)
    embedded = 0
    if _rag_available:
        try:
            embedded = vectorstore.embed_products_batch(products)
        except Exception as e:
            print(f"[ProScan] Warning: RAG embedding failed: {e}")

    return len(products), scrape_run_id


def get_product_details(asin):
    """Get full product details by ASIN.

    Args:
        asin: Amazon Standard Identification Number

    Returns:
        dict or None: Most recent product record, or None if not found
    """
    return database.get_product_by_asin(asin)


def compare_products(asins):
    """Side-by-side comparison of multiple products with analysis.

    Calculates price/rating ranges and identifies:
        - best_rated: highest rating among compared products
        - best_value: highest value score using the formula
          (rating * log10(reviews + 1)) / sqrt(price)

    Args:
        asins: List of ASIN strings to compare

    Returns:
        dict: Contains 'products' list and 'analysis' with ranges and picks
    """
    products = database.get_products_by_asins(asins)
    if not products:
        return {"error": "No products found for the given ASINs"}

    prices = [p["price_numeric"] for p in products if p["price_numeric"] > 0]
    ratings = [p["rating_numeric"] for p in products if p["rating_numeric"] > 0]

    analysis = {
        "product_count": len(products),
        "price_range": {
            "min": min(prices) if prices else 0,
            "max": max(prices) if prices else 0,
            "avg": round(sum(prices) / len(prices), 2) if prices else 0,
        },
        "rating_range": {
            "min": min(ratings) if ratings else 0,
            "max": max(ratings) if ratings else 0,
            "avg": round(sum(ratings) / len(ratings), 2) if ratings else 0,
        },
        "best_rated": None,
        "best_value": None,
    }

    if products:
        # Best rated -- highest rating_numeric
        by_rating = sorted(products, key=lambda x: x["rating_numeric"], reverse=True)
        analysis["best_rated"] = {
            "asin": by_rating[0]["asin"],
            "name": by_rating[0]["name"],
            "rating": by_rating[0]["rating_numeric"],
        }

        # Best value -- highest (rating * log(reviews+1)) / sqrt(price)
        import math

        def value_score(p):
            if p["price_numeric"] <= 0:
                return 0
            return (p["rating_numeric"] * math.log10(p["review_count"] + 1)) / math.sqrt(p["price_numeric"])

        by_value = sorted(products, key=value_score, reverse=True)
        analysis["best_value"] = {
            "asin": by_value[0]["asin"],
            "name": by_value[0]["name"],
            "score": round(value_score(by_value[0]), 2),
        }

    return {"products": products, "analysis": analysis}


def search_products(query, limit=20):
    """Search products by name or ASIN using SQL LIKE matching.

    Args:
        query: Search keyword or ASIN
        limit: Maximum results to return

    Returns:
        list[dict]: Matching products sorted by rating and review count
    """
    return database.search_products(query, limit)


def get_all_products(limit=100, offset=0):
    """List all products with pagination.

    Args:
        limit: Maximum products to return
        offset: Number of products to skip

    Returns:
        list[dict]: Products ordered by most recently scraped
    """
    return database.get_all_products(limit, offset)


def chat_about_product(asin, question):
    """RAG-powered Q&A about a specific product.

    Requires RAG dependencies (chromadb, sentence-transformers,
    google-generativeai) and a configured Gemini API key.

    Args:
        asin: Product ASIN to query about
        question: Natural language question

    Returns:
        dict: Contains 'answer', 'sources', and 'asin'
    """
    if not _rag_available:
        return {
            "answer": "RAG dependencies not installed. Run: pip install chromadb sentence-transformers google-generativeai",
            "sources": [],
            "asin": asin,
        }
    return chain.chat_with_product(asin, question)


def search_products_semantic(query, limit=20):
    """Hybrid search combining SQL keyword matching and ChromaDB semantic similarity.

    First runs a SQL LIKE search, then augments results with semantically
    similar products from ChromaDB that weren't already in the SQL results.
    Falls back to SQL-only if RAG is unavailable.

    Args:
        query: Natural language search query
        limit: Maximum results per search method

    Returns:
        list[dict]: Combined results (SQL matches first, then semantic additions)
    """
    sql_results = database.search_products(query, limit)

    if _rag_available:
        try:
            semantic_results = vectorstore.search_similar(query, n_results=limit)
            seen_asins = {r["asin"] for r in sql_results}
            if semantic_results and semantic_results["metadatas"]:
                for meta in semantic_results["metadatas"][0]:
                    if meta["asin"] not in seen_asins:
                        product = database.get_product_by_asin(meta["asin"])
                        if product:
                            sql_results.append(product)
                            seen_asins.add(meta["asin"])
        except Exception as e:
            print(f"[ProScan] Warning: Semantic search failed: {e}")

    return sql_results


def get_stats():
    """Get database statistics for monitoring.

    Returns:
        dict: Contains 'total_products' count and 'rag_available' boolean
    """
    return {
        "total_products": database.get_product_count(),
        "rag_available": _rag_available,
    }
