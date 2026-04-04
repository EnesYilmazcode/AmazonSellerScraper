"""REST API endpoints for product operations.

Provides CRUD and search endpoints used by the Chrome extension
to sync scraped data and retrieve product information. All business
logic is delegated to product_service -- routers handle only HTTP
concerns (validation, status codes, serialization).

Endpoints:
    POST /api/products/sync       -- Ingest scraped products from extension
    GET  /api/products/{asin}     -- Product details by ASIN
    POST /api/products/compare    -- Compare multiple products
    GET  /api/products/?query=    -- Search or list all products
"""

from fastapi import APIRouter, HTTPException
from server.models.product import ProductSyncRequest, ProductSyncResponse
from server.services import product_service

router = APIRouter(prefix="/api/products", tags=["products"])


@router.post("/sync", response_model=ProductSyncResponse)
async def sync_products(request: ProductSyncRequest):
    """Receive and ingest scraped products from the Chrome extension.

    Called automatically by the service worker after scraping completes.
    Creates a scrape run, inserts products, and optionally embeds in ChromaDB.

    Raises:
        HTTPException(400): If no products are provided
    """
    if not request.products:
        raise HTTPException(400, "No products provided")

    synced, run_id = product_service.sync_products(
        request.products, request.seller_name, request.seller_url
    )
    return ProductSyncResponse(synced=synced, scrape_run_id=run_id)


@router.get("/{asin}")
async def get_product(asin: str):
    """Get full product details by Amazon ASIN.

    Returns the most recent record if the product has been scraped
    multiple times across different runs.

    Raises:
        HTTPException(404): If no product with that ASIN exists
    """
    result = product_service.get_product_details(asin)
    if not result:
        raise HTTPException(404, f"Product {asin} not found")
    return dict(result)


@router.post("/compare")
async def compare(asins: list[str]):
    """Compare multiple products side-by-side with analysis.

    Identifies best-rated and best-value products among the given ASINs.
    Requires at least 2 ASINs.

    Raises:
        HTTPException(400): If fewer than 2 ASINs are provided
    """
    if len(asins) < 2:
        raise HTTPException(400, "Provide at least 2 ASINs")
    return product_service.compare_products(asins)


@router.get("/")
async def search(query: str = "", limit: int = 20):
    """Search products by keyword or list all products.

    If query is provided, searches product names and ASINs.
    If empty, returns all products (paginated by limit).
    """
    if query:
        return product_service.search_products(query, limit=limit)
    return product_service.get_all_products(limit=limit)
