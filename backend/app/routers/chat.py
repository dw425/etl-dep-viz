"""AI Chat router — natural language questions about ETL data via RAG.

Endpoints:
  POST /chat/index/{upload_id}  — build vector index for an upload
  POST /chat/{upload_id}        — ask a question (RAG pipeline)
  POST /chat/{upload_id}/search — semantic search without LLM
  GET  /chat/{upload_id}/status — check if upload is indexed
"""

from __future__ import annotations

import logging
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.models.database import Upload, get_db

logger = logging.getLogger("edv.chat")

router = APIRouter(prefix="/chat", tags=["AI Chat"])

# Shared engine instances (lazy-initialized, thread-safe)
_engines: dict | None = None
_engines_lock = threading.Lock()


def _get_engines() -> dict:
    """Lazy-initialize embedding engine, vector store, and chat engine."""
    global _engines
    if _engines is not None:
        return _engines
    with _engines_lock:
        if _engines is not None:
            return _engines

    from app.engines.embedding_engine import EmbeddingEngine
    from app.engines.vector_store import VectorStore
    from app.engines.query_engine import HybridSearchEngine, RAGChatEngine

    embedding = EmbeddingEngine(
        mode=settings.embedding_mode,
        model=settings.embedding_model,
    )
    store = VectorStore(persist_dir=settings.chroma_persist_dir)
    search = HybridSearchEngine(store, embedding)
    chat = RAGChatEngine(
        search,
        llm_provider=settings.llm_provider,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
    )

    _engines = {
        "embedding": embedding,
        "store": store,
        "search": search,
        "chat": chat,
    }
    return _engines


# ── Request/Response Models ───────────────────────────────────────────────

class ChatRequest(BaseModel):
    question: str
    conversation_history: list[dict] = []


class ChatResponse(BaseModel):
    answer: str
    intent: str
    referenced_sessions: list[dict]
    referenced_tables: list[dict]
    search_results_used: int
    suggested_questions: list[str]


class SearchRequest(BaseModel):
    query: str
    doc_type: str | None = None
    n_results: int = 10


# ── Index an upload ───────────────────────────────────────────────────────

@router.post("/index/{upload_id}")
async def index_upload(upload_id: int, db: Session = Depends(get_db)):
    """Build vector index for an upload. Call after parsing + optional vector analysis."""
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")

    tier_data = upload.get_tier_data()
    vector_results = upload.get_vector_results()

    from app.engines.indexing_pipeline import IndexingPipeline
    pipeline = IndexingPipeline(
        embedding_mode=settings.embedding_mode,
        embedding_model=settings.embedding_model,
        chroma_persist_dir=settings.chroma_persist_dir,
    )
    stats = pipeline.index_upload(upload_id, tier_data, vector_results)

    return {"status": "indexed", **stats}


# ── Chat endpoint ─────────────────────────────────────────────────────────

@router.post("/{upload_id}", response_model=ChatResponse)
async def chat(upload_id: int, request: ChatRequest, db: Session = Depends(get_db)):
    """Ask a natural language question about the ETL environment."""
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")

    engines = _get_engines()
    store = engines["store"]
    chat_engine = engines["chat"]

    # Verify index exists
    if not store.collection_exists(upload_id):
        raise HTTPException(
            400,
            "Upload not indexed. Call POST /api/chat/index/{upload_id} first.",
        )

    tier_data = upload.get_tier_data()

    result = await chat_engine.chat(
        upload_id=upload_id,
        question=request.question,
        tier_data=tier_data,
        conversation_history=request.conversation_history,
    )

    return result


# ── Search endpoint (non-LLM) ────────────────────────────────────────────

@router.post("/{upload_id}/search")
async def search(upload_id: int, request: SearchRequest):
    """Semantic search without LLM — returns raw matched documents."""
    engines = _get_engines()
    embedding = engines["embedding"]
    store = engines["store"]

    if not store.collection_exists(upload_id):
        raise HTTPException(400, "Upload not indexed.")

    query_embedding = embedding.embed_single(request.query)
    results = store.search(
        upload_id, query_embedding,
        n_results=request.n_results,
        doc_type=request.doc_type,
    )

    return {"query": request.query, "results": results}


# ── Index status ──────────────────────────────────────────────────────────

@router.get("/{upload_id}/status")
async def index_status(upload_id: int):
    """Check if an upload is indexed and get stats."""
    engines = _get_engines()
    store = engines["store"]

    if store.collection_exists(upload_id):
        return {
            "indexed": True,
            "document_count": store.get_collection_count(upload_id),
        }
    return {"indexed": False, "document_count": 0}
