"""Pydantic data models for ProScan product data.

Defines the data contracts between the Chrome extension, REST API,
and internal services. Uses Pydantic v2 model_config for flexibility.

Key design decisions:
    - ProductBase accepts both camelCase (from JS) and snake_case via Field aliases
    - populate_by_name=True allows both alias and field name for input
    - Separate models for input (ProductBase) vs. database (ProductInDB)
      to decouple extension schema from storage schema
"""

from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class ProductBase(BaseModel):
    """Product data as received from the Chrome extension.

    Accepts both camelCase (from JavaScript) and snake_case field names
    thanks to Field aliases and populate_by_name configuration.

    Attributes:
        name: Product title from Amazon listing
        asin: Amazon Standard Identification Number
        price: Raw price string (e.g., "$19.99")
        rating: Star rating (0-5), may be string or float
        reviewCount: Total number of customer reviews
        url: Full Amazon product URL
        isPrime: Whether the product has Prime badge
        scrapedAt: ISO timestamp of when the product was scraped
    """
    name: str
    asin: str
    price: str = "N/A"
    rating: float | str = 0
    reviewCount: int = Field(default=0, alias="review_count")
    url: str = ""
    isPrime: Optional[bool] = Field(default=None, alias="is_prime")
    scrapedAt: Optional[str] = Field(default=None, alias="scraped_at")

    model_config = {"populate_by_name": True}


class ProductInDB(BaseModel):
    """Product as stored in and retrieved from SQLite.

    Contains both raw string fields (price, rating) and parsed
    numeric fields (price_numeric, rating_numeric) for flexible
    querying and display.

    Attributes:
        id: Auto-incremented primary key
        asin: Amazon Standard Identification Number
        name: Product title
        price: Raw price string for display
        price_numeric: Parsed float price for calculations
        rating: Raw rating string for display
        rating_numeric: Parsed float rating for sorting/filtering
        review_count: Total customer reviews
        url: Full Amazon product URL
        is_prime: Prime eligibility flag
        scraped_at: Original scrape timestamp from extension
        scrape_run_id: Foreign key linking to the scrape_runs table
        created_at: Database insertion timestamp
    """
    id: Optional[int] = None
    asin: str
    name: str
    price: str = "N/A"
    price_numeric: float = 0.0
    rating: str = "0"
    rating_numeric: float = 0.0
    review_count: int = 0
    url: str = ""
    is_prime: bool = False
    scraped_at: Optional[str] = None
    scrape_run_id: Optional[int] = None
    created_at: Optional[str] = None


class ProductSyncRequest(BaseModel):
    """Request body when the Chrome extension syncs scraped products.

    Attributes:
        products: List of product dicts (camelCase fields from JS)
        seller_name: Amazon seller name (optional)
        seller_url: Seller storefront URL (optional)
    """
    products: list[dict]
    seller_name: Optional[str] = None
    seller_url: Optional[str] = None


class ProductSyncResponse(BaseModel):
    """Response after a successful product sync.

    Attributes:
        synced: Number of products successfully ingested
        scrape_run_id: ID of the created scrape run record
    """
    synced: int
    scrape_run_id: int


class ChatRequest(BaseModel):
    """Request body for RAG-powered product chat.

    Attributes:
        asin: ASIN of the product to ask about
        question: Natural language question
    """
    asin: str
    question: str


class ChatResponse(BaseModel):
    """Response from RAG-powered product chat.

    Attributes:
        answer: Generated answer text from Gemini
        sources: List of ChromaDB documents used as context
        asin: ASIN of the queried product
    """
    answer: str
    sources: list[dict] = []
    asin: str
