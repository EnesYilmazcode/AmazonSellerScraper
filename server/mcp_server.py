"""ProScan MCP Server -- exposes product analysis tools to Claude Desktop/Cursor.

Provides 7 MCP tools for product analysis via stdio transport.
Shares business logic with the REST API through product_service,
ensuring consistent behavior across both interfaces.

Tools:
    get_product_details   -- Full product info by ASIN
    compare_products      -- Side-by-side comparison (2-10 products)
    search_products       -- Keyword search via SQL LIKE
    smart_search          -- Hybrid keyword + semantic search
    list_all_products     -- Paginated listing with stats
    get_database_stats    -- Product count and RAG availability
    chat_with_product     -- RAG Q&A via Gemini

Run via stdio transport:
    python -m server.mcp_server
"""

import sys
import os

# Ensure the project root is on the path so imports work
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp.server.fastmcp import FastMCP
from server.db.database import init_db
from server.services import product_service

# Initialize database on import
init_db()

# Create MCP server instance
mcp = FastMCP(
    "ProScan",
    version="1.0.0",
    description="Amazon product analysis tools for the ProScan Chrome extension",
)


@mcp.tool()
def get_product_details(asin: str) -> dict:
    """Get full details for a product by its Amazon ASIN.

    Returns product name, price, rating, review count, Prime status,
    and URL for the specified ASIN. Returns error if not found.

    Args:
        asin: Amazon Standard Identification Number (e.g., 'B09V3KXJPB')
    """
    result = product_service.get_product_details(asin)
    if not result:
        return {
            "error": f"Product with ASIN '{asin}' not found in database. "
            "Scrape this seller's page first using the ProScan extension."
        }
    return dict(result)


@mcp.tool()
def compare_products(asins: list[str]) -> dict:
    """Compare multiple Amazon products side-by-side.

    Provides price comparison, rating comparison, and identifies
    the best-rated and best-value products among the given ASINs.

    Args:
        asins: List of ASINs to compare (2-10 products)
    """
    if len(asins) < 2:
        return {"error": "Please provide at least 2 ASINs to compare."}
    if len(asins) > 10:
        return {"error": "Maximum 10 products for comparison."}
    return product_service.compare_products(asins)


@mcp.tool()
def search_products(query: str, limit: int = 20) -> list[dict]:
    """Search through scraped Amazon products by keyword.

    Searches product names and ASINs using text matching.
    Returns matching products sorted by rating and review count.

    Args:
        query: Search keyword or phrase (e.g., 'wireless headphones')
        limit: Maximum number of results to return (default 20)
    """
    results = product_service.search_products(query, limit=limit)
    return [dict(r) for r in results]


@mcp.tool()
def list_all_products(limit: int = 50, offset: int = 0) -> dict:
    """List all scraped products in the database.

    Returns products ordered by most recently scraped.
    Use offset for pagination through large datasets.

    Args:
        limit: Number of products to return (default 50, max 100)
        offset: Number of products to skip for pagination
    """
    limit = min(limit, 100)
    products = product_service.get_all_products(limit=limit, offset=offset)
    stats = product_service.get_stats()
    return {
        "total_in_database": stats["total_products"],
        "returned": len(products),
        "offset": offset,
        "products": [dict(p) for p in products],
    }


@mcp.tool()
def get_database_stats() -> dict:
    """Get summary statistics about the scraped product database.

    Returns total product count and RAG availability status.
    Useful for understanding what data is available before querying.
    """
    return product_service.get_stats()


@mcp.tool()
def chat_with_product(asin: str, question: str) -> dict:
    """Ask a question about a specific Amazon product using RAG.

    Uses product data and semantic search context to generate
    answers via Gemini AI. Requires PROSCAN_GEMINI_API_KEY.

    Args:
        asin: Amazon ASIN of the product to ask about
        question: Natural language question (e.g., 'Is this a good deal?')
    """
    return product_service.chat_about_product(asin, question)


@mcp.tool()
def smart_search(query: str, limit: int = 20) -> list[dict]:
    """Search products using both keyword matching AND semantic similarity.

    More powerful than search_products -- understands meaning, not just keywords.
    For example, 'cheap noise cancelling' will find budget ANC headphones
    even if those exact words aren't in the product name.

    Args:
        query: Natural language search query
        limit: Maximum results to return
    """
    results = product_service.search_products_semantic(query, limit=limit)
    return [dict(r) for r in results]


if __name__ == "__main__":
    mcp.run(transport="stdio")
