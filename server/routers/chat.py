"""REST API endpoint for RAG chat using Gemini."""

from fastapi import APIRouter
from server.models.product import ChatRequest, ChatResponse
from server.services import product_service

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """RAG-powered chat about a product using Gemini."""
    result = product_service.chat_about_product(request.asin, request.question)
    return ChatResponse(**result)
