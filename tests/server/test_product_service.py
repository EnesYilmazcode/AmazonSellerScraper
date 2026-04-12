"""Tests for server.services.product_service — business logic layer."""

import pytest
from unittest.mock import patch


class TestParsePrice:
    def test_parse_dollar_amount(self):
        from server.services.product_service import parse_price
        assert parse_price("$19.99") == 19.99

    def test_parse_with_commas(self):
        from server.services.product_service import parse_price
        assert parse_price("$1,299.99") == 1299.99

    def test_parse_na(self):
        from server.services.product_service import parse_price
        assert parse_price("N/A") == 0.0

    def test_parse_none(self):
        from server.services.product_service import parse_price
        assert parse_price(None) == 0.0

    def test_parse_empty_string(self):
        from server.services.product_service import parse_price
        assert parse_price("") == 0.0


class TestParseRating:
    def test_parse_float_rating(self):
        from server.services.product_service import parse_rating
        assert parse_rating(4.5) == 4.5

    def test_parse_string_rating(self):
        from server.services.product_service import parse_rating
        assert parse_rating("4.5") == 4.5

    def test_parse_na_rating(self):
        from server.services.product_service import parse_rating
        assert parse_rating("N/A") == 0.0

    def test_parse_none_rating(self):
        from server.services.product_service import parse_rating
        assert parse_rating(None) == 0.0


class TestSyncProducts:
    def test_sync_inserts_products(self, temp_db, sample_products):
        from server.services.product_service import sync_products
        count, run_id = sync_products(sample_products, "TestSeller", "https://amazon.com/seller")
        assert count == 4
        assert run_id > 0

    def test_sync_parses_numeric_fields(self, temp_db, sample_products):
        from server.services.product_service import sync_products
        sync_products(sample_products)

        product = temp_db.get_product_by_asin("B001")
        assert product is not None
        assert product["price_numeric"] == 29.99
        assert product["rating_numeric"] == 4.5
        assert product["review_count"] == 1200

    def test_sync_handles_na_price(self, temp_db, sample_products):
        from server.services.product_service import sync_products
        sync_products(sample_products)

        product = temp_db.get_product_by_asin("B004")
        assert product is not None
        assert product["price_numeric"] == 0.0


class TestCompareProducts:
    def test_compare_returns_analysis(self, temp_db, sample_products):
        from server.services.product_service import sync_products, compare_products
        sync_products(sample_products)

        result = compare_products(["B001", "B002", "B003"])
        assert "products" in result
        assert "analysis" in result
        assert result["analysis"]["product_count"] == 3
        assert result["analysis"]["best_rated"] is not None
        assert result["analysis"]["best_value"] is not None

    def test_compare_best_rated(self, temp_db, sample_products):
        from server.services.product_service import sync_products, compare_products
        sync_products(sample_products)

        result = compare_products(["B001", "B002", "B003"])
        # B003 has highest rating (4.8)
        assert result["analysis"]["best_rated"]["asin"] == "B003"

    def test_compare_empty_asins(self, temp_db):
        from server.services.product_service import compare_products
        result = compare_products([])
        assert "error" in result
