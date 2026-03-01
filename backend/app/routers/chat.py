"""AI Chat router — natural language questions about ETL data via RAG.

RAG pipeline flow:
  1. index/{upload_id}  — run IndexingPipeline: chunk tier_data + vector_results into
                          documents, embed with EmbeddingEngine, store in ChromaDB.
  2. /{upload_id}       — receive a question, run HybridSearchEngine to retrieve the
                          most relevant documents, pass them as context to RAGChatEngine
                          (LLM), return a structured ChatResponse.
  3. /{upload_id}/search — retrieval only (no LLM call), useful for debugging what
                           documents are being found for a query.
  4. /{upload_id}/status — lightweight check whether the ChromaDB collection exists.

Engine instances are lazy-initialised once per process and shared across requests.
A threading.Lock guards the double-checked initialisation pattern.
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

# Module-level singletons: initialised once, reused for every request.
# None before first call; replaced atomically inside the lock.
_engines: dict | None = None
_engines_lock = threading.Lock()


def _get_engines() -> dict:
    """Lazy-initialize embedding engine, vector store, and chat engine.

    Uses a double-checked locking pattern:
      - First check (no lock) avoids lock overhead on the hot path after init.
      - Second check (inside lock) prevents duplicate initialisation if two
        threads race to the first check simultaneously.
    Imports are deferred so the heavy ML libraries only load when the chat
    feature is first used, keeping cold start time low.
    """
    global _engines
    # Fast path: already initialised
    if _engines is not None:
        return _engines
    with _engines_lock:
        # Slow path: re-check inside lock in case another thread initialised first
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
    # HybridSearchEngine combines dense (embedding) and sparse (BM25-style) retrieval
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
    """Build vector index for an upload. Call after parsing + optional vector analysis.

    The IndexingPipeline chunks tier_data sessions, tables, and (if available)
    vector_results into text documents, embeds them, and persists the ChromaDB
    collection keyed by upload_id.  Subsequent chat calls will retrieve from this
    collection.  Re-indexing an already-indexed upload overwrites the collection.
    """
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")

    tier_data = upload.get_tier_data()
    vector_results = upload.get_vector_results()  # None if vector analysis hasn't run

    from app.engines.indexing_pipeline import IndexingPipeline
    pipeline = IndexingPipeline(
        embedding_mode=settings.embedding_mode,
        embedding_model=settings.embedding_model,
        chroma_persist_dir=settings.chroma_persist_dir,
    )
    stats = pipeline.index_upload(upload_id, tier_data, vector_results)

    response = {"status": "indexed", **stats}
    if pipeline.embedding_engine and pipeline.embedding_engine.using_zero_vectors:
        response["warning"] = (
            "Indexed with zero-vectors (sentence-transformers not installed). "
            "Search will rely on keyword matching only. Install with: "
            "pip install sentence-transformers"
        )
    return response


# ── Re-index with vectors ────────────────────────────────────────────────

@router.post("/reindex/{upload_id}")
async def reindex_upload(upload_id: int, db: Session = Depends(get_db)):
    """Re-index after vector analysis to enrich documents with V1-V11 data."""
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")

    tier_data = upload.get_tier_data()
    vector_results = upload.get_vector_results()
    if not vector_results:
        raise HTTPException(400, "No vector results available. Run vector analysis first.")

    from app.engines.indexing_pipeline import IndexingPipeline
    pipeline = IndexingPipeline(
        embedding_mode=settings.embedding_mode,
        embedding_model=settings.embedding_model,
        chroma_persist_dir=settings.chroma_persist_dir,
    )
    stats = pipeline.reindex_with_vectors(upload_id, tier_data, vector_results)
    return {"status": "reindexed", **stats}


# ── Chat endpoint ─────────────────────────────────────────────────────────

@router.post("/{upload_id}", response_model=ChatResponse)
async def chat(upload_id: int, request: ChatRequest, db: Session = Depends(get_db)):
    """Ask a natural language question about the ETL environment.

    RAG flow:
      1. Verify the ChromaDB collection for this upload exists.
      2. Pass the question + conversation history to RAGChatEngine.
      3. The engine retrieves relevant documents, builds a prompt, calls the LLM,
         and returns a structured response including cited sessions/tables and
         suggested follow-up questions.
    """
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")

    engines = _get_engines()
    store = engines["store"]
    chat_engine = engines["chat"]

    # Guard: the index must be built first via POST /chat/index/{upload_id}
    if not store.collection_exists(upload_id):
        raise HTTPException(
            400,
            "Upload not indexed. Call POST /api/chat/index/{upload_id} first.",
        )

    # tier_data provides session/table metadata for grounding the LLM response
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
    """Semantic search without LLM — returns raw matched documents.

    Useful for debugging retrieval quality: call this to see exactly which
    indexed document chunks would be fed to the LLM for a given question.
    doc_type can be 'session', 'table', 'vector_insight', etc. to narrow results.
    """
    engines = _get_engines()
    embedding = engines["embedding"]
    store = engines["store"]

    if not store.collection_exists(upload_id):
        raise HTTPException(400, "Upload not indexed.")

    # Embed the query text into a dense vector before searching ChromaDB
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
