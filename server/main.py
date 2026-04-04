"""ProScan API Server -- REST endpoints for the Chrome extension.

FastAPI application serving product CRUD, search, and RAG chat endpoints.
Uses async lifespan for database initialization and CORS middleware for
Chrome extension cross-origin requests.

Start with:
    uvicorn server.main:app --reload
    python -m server.main

The server is optional -- the Chrome extension works standalone.
When running, the extension auto-syncs scraped data on completion.
"""

import sys
import os
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from server.db.database import init_db
from server.routers import products, chat
from server.config import HOST, PORT


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler -- initializes the database on startup."""
    init_db()
    yield


app = FastAPI(
    title="ProScan API",
    description="REST API for the ProScan Chrome Extension -- product scraping, analytics, and AI-powered insights",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS -- allow Chrome extension origins (vary by install, so allow all)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(products.router)
app.include_router(chat.router)


@app.get("/health")
def health():
    """Health check endpoint for monitoring."""
    return {"status": "ok", "version": "1.0.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
