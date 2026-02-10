"""ProScan Server Configuration."""

import os
from pathlib import Path

# Base directory for the server
BASE_DIR = Path(__file__).parent

# Database
DB_PATH = BASE_DIR / "db" / "proscan.db"

# ChromaDB storage (Phase 3)
CHROMA_PATH = BASE_DIR / "chroma_data"

# Server settings
HOST = "127.0.0.1"
PORT = 8000

# Embedding model (Phase 3)
EMBEDDING_MODEL = "all-MiniLM-L6-v2"

# Gemini API (Phase 3 - RAG generation)
GEMINI_API_KEY = os.environ.get("PROSCAN_GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-2.0-flash"

# RAG settings (Phase 3)
RAG_TOP_K = 5
