"""Pydantic models for ProScan product data."""

from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class ProductBase(BaseModel):
    """Matches the Chrome extension's scraped data shape.

    Accepts both camelCase (from JS) and snake_case field names.
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
    """Product as stored in and retrieved from SQLite."""
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
    """Request body when Chrome extension syncs scraped products."""
    products: list[dict]
    seller_name: Optional[str] = None
    seller_url: Optional[str] = None


class ProductSyncResponse(BaseModel):
    """Response after syncing products."""
    synced: int
    scrape_run_id: int


class ChatRequest(BaseModel):
    """Request body for RAG chat."""
    asin: str
    question: str


class ChatResponse(BaseModel):
    """Response from RAG chat."""
    answer: str
    sources: list[dict] = []
    asin: str
