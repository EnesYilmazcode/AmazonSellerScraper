"""ChromaDB vector store for product embeddings.

Stores embedded product documents for semantic search.
Uses persistent storage so data survives restarts.
"""

import chromadb
from server.config import CHROMA_PATH
from server.rag.embeddings import embed_texts, embed_single

COLLECTION_NAME = "proscan_products"

_client = None
_collection = None


def get_collection():
    """Get or create the ChromaDB collection."""
    global _client, _collection
    if _collection is None:
        CHROMA_PATH.mkdir(parents=True, exist_ok=True)
        _client = chromadb.PersistentClient(path=str(CHROMA_PATH))
        _collection = _client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    return _collection


def build_product_text(product):
    """Build a rich text document from product data for embedding.

    This text is what gets embedded and searched against.
    Richer text = better semantic matching.
    """
    parts = [
        f"Product: {product.get('name', 'Unknown')}",
        f"ASIN: {product.get('asin', '')}",
        f"Price: {product.get('price', 'N/A')}",
        f"Rating: {product.get('rating_numeric', 0)} out of 5 stars",
        f"Reviews: {product.get('review_count', 0)} customer reviews",
    ]

    if product.get("is_prime"):
        parts.append("Amazon Prime eligible")

    if product.get("url"):
        parts.append(f"URL: {product['url']}")

    return "\n".join(parts)


def embed_products_batch(products):
    """Batch embed and upsert multiple products into ChromaDB.

    Returns the number of products embedded.
    """
    if not products:
        return 0

    texts = [build_product_text(p) for p in products]
    embeddings = embed_texts(texts)
    ids = [f"product_{p['asin']}" for p in products]
    metadatas = [
        {
            "asin": p.get("asin", ""),
            "name": p.get("name", ""),
            "price": str(p.get("price", "")),
            "rating": str(p.get("rating_numeric", 0)),
            "review_count": str(p.get("review_count", 0)),
        }
        for p in products
    ]

    collection = get_collection()
    collection.upsert(
        ids=ids,
        embeddings=embeddings,
        documents=texts,
        metadatas=metadatas,
    )
    return len(products)


def search_similar(query, n_results=5):
    """Semantic search across product embeddings.

    Returns ChromaDB results with documents, metadatas, distances.
    """
    query_embedding = embed_single(query)
    collection = get_collection()

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=n_results,
        include=["documents", "metadatas", "distances"],
    )
    return results
