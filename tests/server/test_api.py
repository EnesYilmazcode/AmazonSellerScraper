"""Tests for REST API endpoints via Starlette TestClient (synchronous)."""

import pytest
from starlette.testclient import TestClient


@pytest.fixture
def api_client(temp_db):
    """Synchronous test client wrapping the FastAPI app."""
    import server.main as main_module
    import server.services.product_service as svc_module

    # Ensure product_service uses the temp database module
    svc_module.database = temp_db

    with TestClient(main_module.app) as client:
        yield client


class TestHealthEndpoint:
    def test_health(self, api_client):
        response = api_client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"


class TestSyncEndpoint:
    def test_sync_products_success(self, api_client, sample_products):
        response = api_client.post(
            "/api/products/sync",
            json={"products": sample_products, "seller_name": "TestSeller"}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["synced"] == len(sample_products)
        assert data["scrape_run_id"] > 0

    def test_sync_products_empty_400(self, api_client):
        response = api_client.post(
            "/api/products/sync",
            json={"products": []}
        )
        assert response.status_code == 400


class TestGetProductEndpoint:
    def test_get_product_found(self, api_client, sample_products):
        api_client.post(
            "/api/products/sync",
            json={"products": sample_products}
        )
        response = api_client.get("/api/products/B001")
        assert response.status_code == 200
        data = response.json()
        assert data["asin"] == "B001"
        assert data["name"] == "Widget Pro"

    def test_get_product_not_found_404(self, api_client):
        response = api_client.get("/api/products/NONEXISTENT")
        assert response.status_code == 404


class TestCompareEndpoint:
    def test_compare_products_success(self, api_client, sample_products):
        api_client.post(
            "/api/products/sync",
            json={"products": sample_products}
        )
        response = api_client.post(
            "/api/products/compare",
            json=["B001", "B002", "B003"]
        )
        assert response.status_code == 200
        data = response.json()
        assert "products" in data
        assert "analysis" in data

    def test_compare_too_few_400(self, api_client):
        response = api_client.post(
            "/api/products/compare",
            json=["B001"]
        )
        assert response.status_code == 400


class TestSearchEndpoint:
    def test_search_products(self, api_client, sample_products):
        api_client.post(
            "/api/products/sync",
            json={"products": sample_products}
        )
        response = api_client.get("/api/products/?query=Widget")
        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 1

    def test_list_all_products(self, api_client, sample_products):
        api_client.post(
            "/api/products/sync",
            json={"products": sample_products}
        )
        response = api_client.get("/api/products/")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == len(sample_products)
