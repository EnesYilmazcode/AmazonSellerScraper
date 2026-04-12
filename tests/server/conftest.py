"""Pytest fixtures for ProScan server tests.

Provides isolated temp database and FastAPI test client for each test.
"""

import sys
import os
import pytest
import importlib
from pathlib import Path
from unittest.mock import patch

# Ensure project root is on sys.path
project_root = Path(__file__).parent.parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))


@pytest.fixture
def temp_db(tmp_path):
    """Provide a fresh temporary SQLite database for each test.

    Patches server.config.DB_PATH to point at a temp directory,
    then reinitializes the database module.
    """
    db_path = tmp_path / "test_proscan.db"

    # Patch at the config level AND at the database module level
    with patch("server.config.DB_PATH", db_path):
        import server.db.database as db_module
        # Patch DB_PATH directly in the database module (it was imported at module load)
        original_db_path = db_module.DB_PATH
        db_module.DB_PATH = db_path

        db_module.init_db()
        yield db_module

        # Restore
        db_module.DB_PATH = original_db_path


@pytest.fixture
def sample_products():
    """Sample product data matching Chrome extension output format."""
    return [
        {
            "name": "Widget Pro",
            "asin": "B001",
            "price": "$29.99",
            "rating": 4.5,
            "reviewCount": 1200,
            "url": "https://www.amazon.com/dp/B001",
            "isPrime": True,
            "scrapedAt": "2026-04-12T10:00:00.000Z",
        },
        {
            "name": "Widget Basic",
            "asin": "B002",
            "price": "$12.99",
            "rating": 4.2,
            "reviewCount": 350,
            "url": "https://www.amazon.com/dp/B002",
            "isPrime": False,
            "scrapedAt": "2026-04-12T10:00:00.000Z",
        },
        {
            "name": "Widget Ultra",
            "asin": "B003",
            "price": "$89.99",
            "rating": 4.8,
            "reviewCount": 5600,
            "url": "https://www.amazon.com/dp/B003",
            "isPrime": True,
            "scrapedAt": "2026-04-12T10:00:00.000Z",
        },
        {
            "name": "No Price Item",
            "asin": "B004",
            "price": "N/A",
            "rating": 4.0,
            "reviewCount": 100,
            "url": "https://www.amazon.com/dp/B004",
            "isPrime": False,
            "scrapedAt": "2026-04-12T10:00:00.000Z",
        },
    ]


