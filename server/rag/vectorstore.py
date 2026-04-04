"""ChromaDB vector store for product embeddings.

Manages the lifecycle of product document embeddings for semantic search.
Uses ChromaDB's persistent client so embeddings survive server restarts.

Architecture:
    - One collection ('proscan_products') stores all product embeddings
    - Documents are rich text representations built from product fields
    - Metadata stores structured fields for post-retrieval filtering
    - Cosine similarity metric for nearest-neighbor search
    - Upsert pattern: re-scraping a product updates its embedding

Document format (what gets embedded and searched):
    Product: {name}
    ASIN: {asin}
    Price: {price}
    Rating: {rating} out of 5 stars
    Reviews: {review_count} customer reviews
    [Amazon Prime eligible]
    URL: {url}
"""

import chromadb
from server.config import CHROMA_PATH
from server.rag.embeddings import embed_texts, embed_single

COLLECTION_NAME = "proscan_products"

_client = None
_collection = None


def get_collection():
    """Get or create the ChromaDB collection.

    Lazy-initializes the persistent client and collection on first call.
    Creates the storage directory if it doesn't exist.

    Returns:
        chromadb.Collection: The proscan_products collection
    """
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

    The quality of semantic search depends on how much useful information
    is encoded in this text. Richer text = better semantic matching.

    Args:
        product: Product dict with standard fields

    Returns:
        str: Multi-line text document for embedding
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
    """Batch embed and upsert products into ChromaDB.

    Uses upsert so re-scraped products update their existing embeddings
    rather than creating duplicates. Document IDs follow the pattern
    'product_{asin}' for deterministic deduplication.

    Args:
        products: List of product dicts with parsed numeric fields

    Returns:
        int: Number of products embedded
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
    """Semantic search across product embeddings using cosine similarity.

    Embeds the query text and finds the nearest neighbors in the
    vector space. Returns documents, metadata, and distance scores.

    Args:
        query: Natural language search query
        n_results: Maximum number of results to return

    Returns:
        dict: ChromaDB results with 'documents', 'metadatas', 'distances'
    """
    query_embedding = embed_single(query)
    collection = get_collection()

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=n_results,
        include=["documents", "metadatas", "distances"],
    )
    return results
