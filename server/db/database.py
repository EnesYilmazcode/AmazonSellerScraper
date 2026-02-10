"""SQLite database layer for ProScan product storage."""

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
    """Create database and tables if they don't exist."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_connection() as conn:
        conn.executescript(SCHEMA)
        # Enable WAL mode for better concurrent read/write
        conn.execute("PRAGMA journal_mode=WAL")


@contextmanager
def get_connection():
    """Context manager for database connections."""
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
    """Insert a new scrape run and return its ID."""
    with get_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO scrape_runs (seller_name, seller_url, product_count) VALUES (?, ?, ?)",
            (seller_name, seller_url, product_count)
        )
        return cursor.lastrowid


def insert_products(products, scrape_run_id):
    """Batch insert products linked to a scrape run."""
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
    """Get the most recent product record for an ASIN."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM products WHERE asin = ? ORDER BY created_at DESC LIMIT 1",
            (asin,)
        ).fetchone()
        return dict(row) if row else None


def get_products_by_asins(asins):
    """Get the most recent record for each of the given ASINs."""
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
    """Search products by name or ASIN using SQL LIKE."""
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
    """Get all products (most recent per ASIN), paginated."""
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
    """Get total unique product count."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT asin) as count FROM products"
        ).fetchone()
        return row["count"] if row else 0
