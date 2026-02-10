"""Embedding layer using sentence-transformers (local, free).

Lazy-loads the model on first use (~80MB download on first run).
"""

from sentence_transformers import SentenceTransformer
from server.config import EMBEDDING_MODEL

_model = None


def get_embedding_model():
    """Lazy-load the embedding model."""
    global _model
    if _model is None:
        print(f"[ProScan] Loading embedding model: {EMBEDDING_MODEL}")
        _model = SentenceTransformer(EMBEDDING_MODEL)
        print("[ProScan] Embedding model loaded")
    return _model


def embed_texts(texts):
    """Embed a list of texts. Returns list of float lists."""
    model = get_embedding_model()
    embeddings = model.encode(texts, show_progress_bar=False)
    return embeddings.tolist()


def embed_single(text):
    """Embed a single text. Returns a float list."""
    return embed_texts([text])[0]
