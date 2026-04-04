"""REST API endpoint for RAG-powered product chat.

Provides a single endpoint for asking natural language questions
about specific products using the Gemini-powered RAG pipeline.
"""

from fastapi import APIRouter
from server.models.product import ChatRequest, ChatResponse
from server.services import product_service

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Ask a question about a product using RAG.

    Retrieves product data from SQLite, finds similar products
    via ChromaDB semantic search, and generates an answer using
    the Gemini API with the combined context.

    The response includes the generated answer, source documents
    used for context, and the queried ASIN.
    """
    result = product_service.chat_about_product(request.asin, request.question)
    return ChatResponse(**result)
