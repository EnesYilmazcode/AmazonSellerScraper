"""RAG chain for product Q&A using Gemini.

Retrieves product context from ChromaDB and generates
answers using Google Gemini API.
"""

import google.generativeai as genai
from server.config import GEMINI_API_KEY, GEMINI_MODEL, RAG_TOP_K
from server.rag.vectorstore import search_similar
from server.db.database import get_product_by_asin


def _configure_gemini():
    """Configure the Gemini API client."""
    if not GEMINI_API_KEY:
        return None
    genai.configure(api_key=GEMINI_API_KEY)
    return genai.GenerativeModel(GEMINI_MODEL)


def chat_with_product(asin, question):
    """RAG-powered Q&A about a specific product.

    1. Retrieve product from SQLite for structured data
    2. Search ChromaDB for semantically relevant context
    3. Build prompt with context + question
    4. Call Gemini API for generation

    Returns dict with answer, sources, and asin.
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

    # Semantic search for relevant context
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

    # Build prompt
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

    # Call Gemini
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
