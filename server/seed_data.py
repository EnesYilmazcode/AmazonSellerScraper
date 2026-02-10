"""Seed the database with sample product data for testing.

Run from project root: python -m server.seed_data
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.db.database import init_db
from server.services.product_service import sync_products

SAMPLE_PRODUCTS = [
    {
        "name": "Sony WH-1000XM5 Wireless Noise Canceling Headphones",
        "asin": "B09XS7JWHH",
        "price": "$328.00",
        "rating": 4.6,
        "reviewCount": 12847,
        "isPrime": True,
        "url": "https://www.amazon.com/dp/B09XS7JWHH",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
    {
        "name": "Apple AirPods Pro (2nd Generation)",
        "asin": "B0D1XD1ZV3",
        "price": "$189.99",
        "rating": 4.7,
        "reviewCount": 89432,
        "isPrime": True,
        "url": "https://www.amazon.com/dp/B0D1XD1ZV3",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
    {
        "name": "JBL Tune 510BT Wireless On-Ear Headphones",
        "asin": "B08WM3GQGP",
        "price": "$24.95",
        "rating": 4.5,
        "reviewCount": 54231,
        "isPrime": True,
        "url": "https://www.amazon.com/dp/B08WM3GQGP",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
    {
        "name": "Anker Soundcore Life Q20 Noise Cancelling Headphones",
        "asin": "B07NM3RSRQ",
        "price": "$49.99",
        "rating": 4.4,
        "reviewCount": 78923,
        "isPrime": True,
        "url": "https://www.amazon.com/dp/B07NM3RSRQ",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
    {
        "name": "Samsung Galaxy Buds2 Pro Wireless Earbuds",
        "asin": "B0B2SH4CN6",
        "price": "$159.99",
        "rating": 4.3,
        "reviewCount": 15672,
        "isPrime": True,
        "url": "https://www.amazon.com/dp/B0B2SH4CN6",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
    {
        "name": "Instant Pot Duo 7-in-1 Electric Pressure Cooker",
        "asin": "B00FLYWNYQ",
        "price": "$79.95",
        "rating": 4.7,
        "reviewCount": 234567,
        "isPrime": True,
        "url": "https://www.amazon.com/dp/B00FLYWNYQ",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
    {
        "name": "Ninja AF101 Air Fryer 4 Quart",
        "asin": "B07FDJMC9Q",
        "price": "$69.99",
        "rating": 4.6,
        "reviewCount": 45678,
        "isPrime": True,
        "url": "https://www.amazon.com/dp/B07FDJMC9Q",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
    {
        "name": "Lodge Cast Iron Skillet 10.25 Inch",
        "asin": "B00006JSUA",
        "price": "$19.90",
        "rating": 4.7,
        "reviewCount": 98765,
        "isPrime": True,
        "url": "https://www.amazon.com/dp/B00006JSUA",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
    {
        "name": "Cheap Generic USB Cable 3-Pack",
        "asin": "B09FAKE001",
        "price": "$4.99",
        "rating": 2.8,
        "reviewCount": 123,
        "isPrime": False,
        "url": "https://www.amazon.com/dp/B09FAKE001",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
    {
        "name": "Premium Bluetooth Speaker Waterproof",
        "asin": "B09FAKE002",
        "price": "$34.99",
        "rating": 4.2,
        "reviewCount": 8,
        "isPrime": False,
        "url": "https://www.amazon.com/dp/B09FAKE002",
        "scrapedAt": "2025-01-15T10:30:00Z",
    },
]


def main():
    print("Initializing database...")
    init_db()

    print(f"Seeding {len(SAMPLE_PRODUCTS)} sample products...")
    synced, run_id = sync_products(
        SAMPLE_PRODUCTS,
        seller_name="Test Seller",
        seller_url="https://www.amazon.com/s?me=TEST123",
    )

    print(f"Done! Synced {synced} products (scrape_run_id: {run_id})")
    print("\nYou can now test the MCP server:")
    print("  python -m server.mcp_server")
    print("\nOr configure Claude Desktop with claude_desktop_config.json")


if __name__ == "__main__":
    main()
