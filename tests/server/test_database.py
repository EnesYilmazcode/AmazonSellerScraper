"""Tests for server.db.database — SQLite CRUD operations."""

import pytest


class TestInitDB:
    def test_init_creates_tables(self, temp_db):
        with temp_db.get_connection() as conn:
            # Check products table exists
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='products'"
            ).fetchone()
            assert row is not None

            # Check scrape_runs table exists
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='scrape_runs'"
            ).fetchone()
            assert row is not None


class TestInsertAndGet:
    def test_insert_scrape_run_returns_id(self, temp_db):
        run_id = temp_db.insert_scrape_run("TestSeller", "https://test.com", 5)
        assert run_id > 0

    def test_insert_and_get_product_by_asin(self, temp_db):
        run_id = temp_db.insert_scrape_run("Seller", None, 1)
        temp_db.insert_products([{
            "asin": "B0TEST",
            "name": "Test Product",
            "price": "$25.00",
            "price_numeric": 25.0,
            "rating": "4.5",
            "rating_numeric": 4.5,
            "review_count": 100,
            "url": "https://amazon.com/dp/B0TEST",
            "is_prime": True,
            "scraped_at": "2026-04-12T10:00:00Z",
        }], run_id)

        product = temp_db.get_product_by_asin("B0TEST")
        assert product is not None
        assert product["asin"] == "B0TEST"
        assert product["name"] == "Test Product"
        assert product["price_numeric"] == 25.0

    def test_get_product_not_found(self, temp_db):
        result = temp_db.get_product_by_asin("NONEXISTENT")
        assert result is None


class TestSearch:
    def test_search_by_name(self, temp_db):
        run_id = temp_db.insert_scrape_run("Seller", None, 2)
        temp_db.insert_products([
            {"asin": "A1", "name": "Wireless Mouse", "price_numeric": 20, "rating_numeric": 4.5, "review_count": 50},
            {"asin": "A2", "name": "Wired Keyboard", "price_numeric": 30, "rating_numeric": 4.0, "review_count": 30},
        ], run_id)

        results = temp_db.search_products("Mouse")
        assert len(results) == 1
        assert results[0]["asin"] == "A1"

    def test_search_by_asin(self, temp_db):
        run_id = temp_db.insert_scrape_run("Seller", None, 1)
        temp_db.insert_products([
            {"asin": "B0UNIQUE", "name": "Unique Widget", "price_numeric": 10, "rating_numeric": 4.0, "review_count": 10},
        ], run_id)

        results = temp_db.search_products("B0UNIQUE")
        assert len(results) == 1

    def test_search_no_results(self, temp_db):
        results = temp_db.search_products("NonexistentProduct")
        assert results == []


class TestPagination:
    def test_get_all_products(self, temp_db):
        run_id = temp_db.insert_scrape_run("Seller", None, 3)
        temp_db.insert_products([
            {"asin": f"P{i}", "name": f"Product {i}", "price_numeric": 10 * i, "rating_numeric": 4.0, "review_count": 10}
            for i in range(1, 4)
        ], run_id)

        all_products = temp_db.get_all_products(limit=100)
        assert len(all_products) == 3

    def test_get_all_products_with_limit(self, temp_db):
        run_id = temp_db.insert_scrape_run("Seller", None, 5)
        temp_db.insert_products([
            {"asin": f"P{i}", "name": f"Product {i}", "price_numeric": 10, "rating_numeric": 4.0, "review_count": 10}
            for i in range(5)
        ], run_id)

        page = temp_db.get_all_products(limit=2)
        assert len(page) == 2

    def test_get_product_count(self, temp_db):
        run_id = temp_db.insert_scrape_run("Seller", None, 3)
        temp_db.insert_products([
            {"asin": f"C{i}", "name": f"Count {i}", "price_numeric": 10, "rating_numeric": 4.0, "review_count": 10}
            for i in range(3)
        ], run_id)

        count = temp_db.get_product_count()
        assert count == 3


class TestDeduplication:
    def test_get_products_by_asins_deduplicates(self, temp_db):
        # Insert same ASIN twice across different runs
        run1 = temp_db.insert_scrape_run("Seller1", None, 1)
        temp_db.insert_products([
            {"asin": "DUP1", "name": "Old Version", "price_numeric": 20, "rating_numeric": 4.0, "review_count": 10}
        ], run1)

        run2 = temp_db.insert_scrape_run("Seller2", None, 1)
        temp_db.insert_products([
            {"asin": "DUP1", "name": "New Version", "price_numeric": 25, "rating_numeric": 4.5, "review_count": 20}
        ], run2)

        results = temp_db.get_products_by_asins(["DUP1"])
        assert len(results) == 1
        # Should return the most recent (highest id)
        assert results[0]["name"] == "New Version"
