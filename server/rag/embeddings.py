"""Embedding layer using sentence-transformers (local, free).

Provides text-to-vector conversion for semantic search using the
all-MiniLM-L6-v2 model. The model runs entirely on CPU and produces
384-dimensional embeddings optimized for cosine similarity.

The model is lazy-loaded on first use to avoid startup overhead
when RAG features aren't being used. First load downloads ~80MB.

Model characteristics:
    - Dimensions: 384
    - Max sequence length: 256 tokens
    - Speed: ~1000 sentences/sec on CPU
    - Quality: Strong performance on STS benchmarks for its size
"""

from sentence_transformers import SentenceTransformer
from server.config import EMBEDDING_MODEL

_model = None


def get_embedding_model():
    """Lazy-load the sentence-transformers embedding model.

    Downloads the model on first invocation (~80MB). Subsequent calls
    return the cached instance.

    Returns:
        SentenceTransformer: Loaded embedding model
    """
    global _model
    if _model is None:
        print(f"[ProScan] Loading embedding model: {EMBEDDING_MODEL}")
        _model = SentenceTransformer(EMBEDDING_MODEL)
        print("[ProScan] Embedding model loaded")
    return _model


def embed_texts(texts):
    """Embed a batch of texts into dense vectors.

    Args:
        texts: List of strings to embed

    Returns:
        list[list[float]]: List of 384-dimensional embedding vectors
    """
    model = get_embedding_model()
    embeddings = model.encode(texts, show_progress_bar=False)
    return embeddings.tolist()


def embed_single(text):
    """Embed a single text string into a dense vector.

    Convenience wrapper around embed_texts for single queries.

    Args:
        text: String to embed

    Returns:
        list[float]: 384-dimensional embedding vector
    """
    return embed_texts([text])[0]
