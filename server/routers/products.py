"""REST API endpoints for product operations.

Used by the Chrome extension to sync scraped data to the server.
"""

from fastapi import APIRouter, HTTPException
from server.models.product import ProductSyncRequest, ProductSyncResponse
from server.services import product_service

router = APIRouter(prefix="/api/products", tags=["products"])


@router.post("/sync", response_model=ProductSyncResponse)
async def sync_products(request: ProductSyncRequest):
    """Receive scraped products from the Chrome extension."""
    if not request.products:
        raise HTTPException(400, "No products provided")

    synced, run_id = product_service.sync_products(
        request.products, request.seller_name, request.seller_url
    )
    return ProductSyncResponse(synced=synced, scrape_run_id=run_id)


@router.get("/{asin}")
async def get_product(asin: str):
    """Get product details by ASIN."""
    result = product_service.get_product_details(asin)
    if not result:
        raise HTTPException(404, f"Product {asin} not found")
    return dict(result)


@router.post("/compare")
async def compare(asins: list[str]):
    """Compare multiple products by ASIN."""
    if len(asins) < 2:
        raise HTTPException(400, "Provide at least 2 ASINs")
    return product_service.compare_products(asins)


@router.get("/")
async def search(query: str = "", limit: int = 20):
    """Search products or list all."""
    if query:
        return product_service.search_products(query, limit=limit)
    return product_service.get_all_products(limit=limit)
