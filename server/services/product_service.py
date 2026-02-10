"""Shared business logic for ProScan.

Called by both the MCP server (stdio) and the REST API (HTTP).
This is the single source of truth for product operations.
"""

import re
from server.db import database

# RAG imports - optional, fail gracefully if not installed
_rag_available = False
try:
    from server.rag import vectorstore, chain
    _rag_available = True
except ImportError:
    pass


def parse_price(price_str):
    """Parse price string like '$19.99' to float."""
    if not price_str or price_str == "N/A":
        return 0.0
    cleaned = re.sub(r"[^0-9.]", "", str(price_str))
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def parse_rating(rating):
    """Parse rating which might be a number or 'N/A'."""
    if rating == "N/A" or rating is None:
        return 0.0
    try:
        return float(rating)
    except (ValueError, TypeError):
        return 0.0


def sync_products(products, seller_name=None, seller_url=None):
    """Sync products from Chrome extension into SQLite.

    Parses raw price/rating strings into numeric values.
    Returns (synced_count, scrape_run_id).
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

    # Embed into ChromaDB if RAG is available
    embedded = 0
    if _rag_available:
        try:
            embedded = vectorstore.embed_products_batch(products)
        except Exception as e:
            print(f"[ProScan] Warning: RAG embedding failed: {e}")

    return len(products), scrape_run_id


def get_product_details(asin):
    """Get full product details by ASIN."""
    return database.get_product_by_asin(asin)


def compare_products(asins):
    """Side-by-side comparison of multiple products with analysis."""
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
        # Best rated
        by_rating = sorted(products, key=lambda x: x["rating_numeric"], reverse=True)
        analysis["best_rated"] = {
            "asin": by_rating[0]["asin"],
            "name": by_rating[0]["name"],
            "rating": by_rating[0]["rating_numeric"],
        }

        # Best value = highest (rating * log(reviews+1)) / price
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
    """Search products by name or ASIN."""
    return database.search_products(query, limit)


def get_all_products(limit=100, offset=0):
    """List all products, paginated."""
    return database.get_all_products(limit, offset)


def chat_about_product(asin, question):
    """RAG Q&A about a product. Requires Gemini API key."""
    if not _rag_available:
        return {
            "answer": "RAG dependencies not installed. Run: pip install chromadb sentence-transformers google-generativeai",
            "sources": [],
            "asin": asin,
        }
    return chain.chat_with_product(asin, question)


def search_products_semantic(query, limit=20):
    """Search products using both SQL and semantic search."""
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
    """Get database statistics."""
    return {
        "total_products": database.get_product_count(),
        "rag_available": _rag_available,
    }
