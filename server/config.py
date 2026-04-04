"""ProScan Server Configuration.

Centralized configuration for all server components. Environment
variables override defaults where applicable.

Configuration groups:
    - Database: SQLite path and settings
    - Server: Host/port for FastAPI
    - Embeddings: Model selection for vector search
    - Gemini: API key and model for RAG generation
    - RAG: Retrieval parameters (top-K, etc.)
"""

import os
from pathlib import Path

# Base directory for the server package
BASE_DIR = Path(__file__).parent

# Database -- SQLite with WAL mode, stored alongside server code
DB_PATH = BASE_DIR / "db" / "proscan.db"

# ChromaDB persistent storage for vector embeddings
CHROMA_PATH = BASE_DIR / "chroma_data"

# FastAPI server bind settings
HOST = "127.0.0.1"
PORT = 8000

# Embedding model for semantic search (sentence-transformers)
# all-MiniLM-L6-v2: ~80MB, good quality, runs on CPU
EMBEDDING_MODEL = "all-MiniLM-L6-v2"

# Gemini API configuration for RAG generation
# Set PROSCAN_GEMINI_API_KEY in environment or .env file
GEMINI_API_KEY = os.environ.get("PROSCAN_GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-2.0-flash"

# RAG retrieval settings
# Number of similar documents to retrieve for context
RAG_TOP_K = 5
