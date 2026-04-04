"""SQLite database layer for ProScan product storage.

Provides all CRUD operations for the products and scrape_runs tables.
Uses WAL (Write-Ahead Logging) mode for better concurrent read/write
performance, and context-managed connections with automatic rollback.

Schema:
    scrape_runs: Tracks bulk import batches (seller, timestamp, count)
    products: Main product table with both raw and parsed numeric fields,
              indexed on ASIN and scrape_run_id for fast lookups

Design decisions:
    - No unique constraint on ASIN: allows re-scrapes of the same product
      across different scrape runs for historical tracking
    - Most-recent-per-ASIN queries use MAX(id) subqueries rather than
      DISTINCT ON (not supported in SQLite)
    - Row factory set to sqlite3.Row for dict-like access
"""

import sqlite3
from contextlib import contextmanager
from server.config import DB_PATH


SCHEMA = """
CREATE TABLE IF NOT EXISTS scrape_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_name TEXT,
    seller_url TEXT,
    product_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asin TEXT NOT NULL,
    name TEXT NOT NULL,
    price TEXT DEFAULT 'N/A',
    price_numeric REAL DEFAULT 0.0,
    rating TEXT DEFAULT '0',
    rating_numeric REAL DEFAULT 0.0,
    review_count INTEGER DEFAULT 0,
    url TEXT DEFAULT '',
    is_prime INTEGER DEFAULT 0,
    scraped_at TEXT,
    scrape_run_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scrape_run_id) REFERENCES scrape_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_products_asin ON products(asin);
CREATE INDEX IF NOT EXISTS idx_products_scrape_run ON products(scrape_run_id);
"""


def init_db():
    """Initialize the database: create tables, indexes, and enable WAL mode.

    Creates the database file and parent directories if they don't exist.
    Safe to call multiple times (uses IF NOT EXISTS).
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_connection() as conn:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode=WAL")


@contextmanager
def get_connection():
    """Context manager for safe database connections.

    Automatically commits on success, rolls back on exception,
    and closes the connection in all cases.

    Yields:
        sqlite3.Connection: Connection with Row factory enabled
    """
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def insert_scrape_run(seller_name=None, seller_url=None, product_count=0):
    """Create a new scrape run record to group imported products.

    Args:
        seller_name: Amazon seller name (optional)
        seller_url: Seller page URL (optional)
        product_count: Number of products in this batch

    Returns:
        int: The auto-generated scrape_run_id
    """
    with get_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO scrape_runs (seller_name, seller_url, product_count) VALUES (?, ?, ?)",
            (seller_name, seller_url, product_count)
        )
        return cursor.lastrowid


def insert_products(products, scrape_run_id):
    """Batch insert products linked to a scrape run.

    Handles both camelCase (from JS extension) and snake_case field names.
    All inserts happen within a single transaction for atomicity.

    Args:
        products: List of product dicts with parsed numeric fields
        scrape_run_id: ID linking these products to their scrape run
    """
    with get_connection() as conn:
        for p in products:
            conn.execute(
                """INSERT INTO products
                   (asin, name, price, price_numeric, rating, rating_numeric,
                    review_count, url, is_prime, scraped_at, scrape_run_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    p.get("asin", ""),
                    p.get("name", ""),
                    p.get("price", "N/A"),
                    p.get("price_numeric", 0.0),
                    str(p.get("rating", "0")),
                    p.get("rating_numeric", 0.0),
                    p.get("review_count", 0),
                    p.get("url", ""),
                    1 if p.get("is_prime") else 0,
                    p.get("scraped_at") or p.get("scrapedAt"),
                    scrape_run_id,
                )
            )


def get_product_by_asin(asin):
    """Get the most recent product record for an ASIN.

    If the same ASIN has been scraped multiple times, returns the
    latest entry (highest created_at).

    Args:
        asin: Amazon Standard Identification Number

    Returns:
        dict or None: Product data as a dict, or None if not found
    """
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM products WHERE asin = ? ORDER BY created_at DESC LIMIT 1",
            (asin,)
        ).fetchone()
        return dict(row) if row else None


def get_products_by_asins(asins):
    """Get the most recent record for each of the given ASINs.

    Uses a MAX(id) subquery to deduplicate products that have been
    scraped multiple times across different runs.

    Args:
        asins: List of ASIN strings

    Returns:
        list[dict]: Product dicts ordered by ASIN
    """
    if not asins:
        return []
    placeholders = ",".join("?" for _ in asins)
    with get_connection() as conn:
        rows = conn.execute(
            f"""SELECT * FROM products
                WHERE asin IN ({placeholders})
                AND id IN (
                    SELECT MAX(id) FROM products
                    WHERE asin IN ({placeholders})
                    GROUP BY asin
                )
                ORDER BY asin""",
            asins + asins
        ).fetchall()
        return [dict(r) for r in rows]


def search_products(query, limit=20):
    """Search products by name or ASIN using SQL LIKE matching.

    Returns the most recent version of each matching product,
    sorted by rating (desc) then review count (desc).

    Args:
        query: Search string (matched with %query% pattern)
        limit: Maximum number of results

    Returns:
        list[dict]: Matching products
    """
    with get_connection() as conn:
        like_query = f"%{query}%"
        rows = conn.execute(
            """SELECT * FROM products
               WHERE (name LIKE ? OR asin LIKE ?)
               AND id IN (
                   SELECT MAX(id) FROM products GROUP BY asin
               )
               ORDER BY rating_numeric DESC, review_count DESC
               LIMIT ?""",
            (like_query, like_query, limit)
        ).fetchall()
        return [dict(r) for r in rows]


def get_all_products(limit=100, offset=0):
    """Get all products (most recent per ASIN) with pagination.

    Args:
        limit: Maximum products to return
        offset: Number of products to skip (for pagination)

    Returns:
        list[dict]: Products ordered by most recently created
    """
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT * FROM products
               WHERE id IN (
                   SELECT MAX(id) FROM products GROUP BY asin
               )
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?""",
            (limit, offset)
        ).fetchall()
        return [dict(r) for r in rows]


def get_product_count():
    """Get the total count of unique ASINs in the database.

    Returns:
        int: Number of distinct products
    """
    with get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT asin) as count FROM products"
        ).fetchone()
        return row["count"] if row else 0
