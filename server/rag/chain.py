"""RAG chain for product Q&A using Gemini.

Implements a Retrieval-Augmented Generation pipeline that:
1. Fetches structured product data from SQLite
2. Retrieves semantically similar products from ChromaDB
3. Builds a context-rich prompt combining both data sources
4. Generates an answer via Google Gemini API

The chain is designed to give factual, data-backed answers
about specific products while leveraging context from the
broader product database for comparative insights.

Pipeline:
    User Question + ASIN
      → SQLite lookup (structured product data)
      → ChromaDB semantic search (similar products for context)
      → Prompt construction (product info + context + question)
      → Gemini API (generation)
      → Answer + sources
"""

import google.generativeai as genai
from server.config import GEMINI_API_KEY, GEMINI_MODEL, RAG_TOP_K
from server.rag.vectorstore import search_similar
from server.db.database import get_product_by_asin


def _configure_gemini():
    """Configure and return the Gemini generative model client.

    Returns:
        GenerativeModel or None: Configured model, or None if API key is missing
    """
    if not GEMINI_API_KEY:
        return None
    genai.configure(api_key=GEMINI_API_KEY)
    return genai.GenerativeModel(GEMINI_MODEL)


def chat_with_product(asin, question):
    """RAG-powered Q&A about a specific product.

    Steps:
        1. Validate Gemini API key is configured
        2. Fetch product details from SQLite by ASIN
        3. Run semantic search in ChromaDB for related products
        4. Build prompt with structured data + semantic context
        5. Call Gemini API for generation
        6. Return answer with source attribution

    Args:
        asin: Amazon ASIN of the target product
        question: Natural language question about the product

    Returns:
        dict: {
            'answer': str -- generated response text,
            'sources': list[dict] -- ChromaDB documents used as context,
            'asin': str -- the queried ASIN
        }
    """
    # Check if Gemini is configured
    model = _configure_gemini()
    if model is None:
        return {
            "answer": "Gemini API key not configured. "
            "Set PROSCAN_GEMINI_API_KEY in your .env file.",
            "sources": [],
            "asin": asin,
        }

    # Get structured product data from SQLite
    product = get_product_by_asin(asin)
    if not product:
        return {
            "answer": f"No product found with ASIN {asin}. "
            "Scrape this product first using the ProScan extension.",
            "sources": [],
            "asin": asin,
        }

    # Semantic search for relevant context from similar products
    search_results = search_similar(
        query=f"{product['name']} {question}",
        n_results=RAG_TOP_K,
    )

    # Build context from retrieved documents
    context_parts = []
    sources = []
    if search_results and search_results["documents"]:
        for i, doc in enumerate(search_results["documents"][0]):
            context_parts.append(doc)
            sources.append(
                {
                    "document": doc,
                    "metadata": search_results["metadatas"][0][i],
                    "distance": search_results["distances"][0][i],
                }
            )

    context = "\n---\n".join(context_parts) if context_parts else "No additional context available."

    # Build generation prompt with product data and context
    prompt = f"""You are a helpful product analysis assistant for Amazon products.
Use the provided product data and context to answer the question.
Be specific, cite data points, and be honest if information is limited.

## Product Information
- Name: {product['name']}
- ASIN: {product['asin']}
- Price: {product['price']}
- Rating: {product['rating_numeric']}/5 ({product['review_count']} reviews)
- Prime: {'Yes' if product.get('is_prime') else 'Unknown'}
- URL: {product.get('url', 'N/A')}

## Additional Context (similar products in database)
{context}

## Question
{question}

Provide a concise, helpful answer:"""

    # Call Gemini API for generation
    try:
        response = model.generate_content(prompt)
        answer = response.text
    except Exception as e:
        answer = f"Error generating response: {str(e)}"

    return {
        "answer": answer,
        "sources": sources,
        "asin": asin,
    }
