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

import asyncio
import logging
import threading
import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.engines.data_populator import reconstruct_tier_data, reconstruct_vector_results
from app.models.database import Upload, get_db

logger = logging.getLogger("edv.chat")

router = APIRouter(prefix="/chat", tags=["AI Chat"])


def _load_tier_data(upload: Upload, db: Session) -> dict | None:
    """Load tier_data from JSON blob, falling back to DB reconstruction.

    After Lakebase migration the tier_data_json blob may be empty while
    the normalized SessionRecord/TableRecord/ConnectionRecord tables
    still contain the data.  This helper transparently reconstructs.
    """
    tier_data = upload.get_tier_data()
    if tier_data and tier_data.get("sessions"):
        return tier_data
    logger.info("tier_data_json empty for upload %d — reconstructing from DB", upload.id)
    return reconstruct_tier_data(db, upload.id)


def _load_vector_results(upload: Upload, db: Session) -> dict | None:
    """Load vector_results from JSON blob, falling back to DB reconstruction."""
    vr = upload.get_vector_results()
    if vr:
        return vr
    logger.info("vector_results_json empty for upload %d — reconstructing from DB", upload.id)
    return reconstruct_vector_results(db, upload.id)

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

        try:
            from app.engines.embedding_engine import EmbeddingEngine
            from app.engines.vector_store import VectorStore
            from app.engines.query_engine import HybridSearchEngine, RAGChatEngine
        except ImportError as e:
            raise HTTPException(
                status_code=503,
                detail={"error": f"AI Chat requires missing dependency: {e}. Install with: pip install -e '.[ai]'", "code": "MISSING_DEPENDENCY"},
            )

        # Auto-detect Databricks mode: override embedding and LLM providers
        embed_mode = settings.embedding_mode
        embed_model = settings.embedding_model
        llm_provider = settings.llm_provider
        llm_model = settings.llm_model
        llm_key = settings.llm_api_key

        if settings.databricks_app:
            embed_mode = "databricks"
            embed_model = settings.databricks_embedding_model
            llm_provider = "databricks"
            llm_model = settings.databricks_llm_model
            llm_key = ""  # Databricks uses OAuth, not API keys

        embedding = EmbeddingEngine(
            mode=embed_mode,
            model=embed_model,
            api_key=llm_key,
        )

        # Use PgVectorStore on Databricks (persistent), ChromaDB locally
        if settings.databricks_app:
            from app.engines.pg_vector_store import PgVectorStore
            store = PgVectorStore()
            logger.info("Using PgVectorStore (Databricks mode)")
        else:
            store = VectorStore(persist_dir=settings.chroma_persist_dir)
            logger.info("Using ChromaDB VectorStore (local mode)")

        search = HybridSearchEngine(store, embedding)
        chat = RAGChatEngine(
            search,
            llm_provider=llm_provider,
            api_key=llm_key,
            model=llm_model,
        )

        _engines = {
            "embedding": embedding,
            "store": store,
            "search": search,
            "chat": chat,
        }
        return _engines


# ── Background Indexing Tracker ────────────────────────────────────────────

# Simple in-memory task status: {upload_id: {status, progress, error, started_at}}
_index_tasks: dict[int, dict] = {}
_index_tasks_lock = threading.Lock()


def _run_indexing_background(upload_id: int, tier_data: dict, vector_results: dict | None):
    """Background thread worker for indexing."""
    with _index_tasks_lock:
        _index_tasks[upload_id] = {
            "status": "running",
            "progress": 0,
            "error": None,
            "started_at": time.monotonic(),
        }
    try:
        from app.engines.indexing_pipeline import IndexingPipeline
        embed_mode = "databricks" if settings.databricks_app else settings.embedding_mode
        embed_model = settings.databricks_embedding_model if settings.databricks_app else settings.embedding_model
        pipeline = IndexingPipeline(
            embedding_mode=embed_mode,
            embedding_model=embed_model,
            chroma_persist_dir=settings.chroma_persist_dir,
            use_pg_store=settings.databricks_app,
        )
        with _index_tasks_lock:
            _index_tasks[upload_id]["progress"] = 10

        stats = pipeline.index_upload(upload_id, tier_data, vector_results)

        with _index_tasks_lock:
            _index_tasks[upload_id].update(
                status="completed", progress=100, stats=stats
            )
    except Exception as exc:
        logger.error("Background indexing failed for upload %d: %s", upload_id, exc)
        with _index_tasks_lock:
            _index_tasks[upload_id].update(status="failed", error=str(exc))


# ── Request/Response Models ───────────────────────────────────────────────

class ChatRequest(BaseModel):
    """Incoming chat message with optional conversation history for multi-turn context."""
    question: str
    conversation_history: list[dict] = []


class ChatResponse(BaseModel):
    """Structured LLM response with grounding references and follow-up suggestions."""
    answer: str
    intent: str                         # Classified intent (e.g. 'search', 'explain', 'compare')
    referenced_sessions: list[dict]     # Sessions cited in the answer
    referenced_tables: list[dict]       # Tables cited in the answer
    search_results_used: int            # Number of retrieved docs fed to the LLM
    suggested_questions: list[str]      # LLM-generated follow-up questions


class SearchRequest(BaseModel):
    """Retrieval-only search request (no LLM call)."""
    query: str
    doc_type: str | None = None         # Filter by document type ('session', 'table', etc.)
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

    tier_data = await asyncio.to_thread(_load_tier_data, upload, db)
    if not tier_data:
        raise HTTPException(400, "No tier data available. Parse an upload first.")
    vector_results = await asyncio.to_thread(_load_vector_results, upload, db)

    from app.engines.indexing_pipeline import IndexingPipeline
    embed_mode = "databricks" if settings.databricks_app else settings.embedding_mode
    embed_model = settings.databricks_embedding_model if settings.databricks_app else settings.embedding_model
    pipeline = IndexingPipeline(
        embedding_mode=embed_mode,
        embedding_model=embed_model,
        chroma_persist_dir=settings.chroma_persist_dir,
        use_pg_store=settings.databricks_app,
    )
    stats = await asyncio.to_thread(pipeline.index_upload, upload_id, tier_data, vector_results)

    response = {"status": "indexed", **stats}
    if pipeline.embedding_engine and pipeline.embedding_engine.using_zero_vectors:
        response["warning"] = (
            "Indexed with zero-vectors (embedding model not available). "
            "Search will rely on keyword matching only."
        )
    return response


# ── Re-index with vectors ────────────────────────────────────────────────

@router.post("/reindex/{upload_id}")
async def reindex_upload(upload_id: int, db: Session = Depends(get_db)):
    """Re-index after vector analysis to enrich documents with V1-V11 data.

    Should be called after running vector analysis on an already-indexed upload.
    The enriched index includes vector insights (complexity scores, community
    membership, wave assignments) as additional document chunks, improving
    retrieval quality for vector-related questions.

    Args:
        upload_id: DB primary key of the upload to re-index.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with status='reindexed' and indexing stats.

    Raises:
        HTTPException(404): Upload not found.
        HTTPException(400): No vector results available yet.
    """
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")

    tier_data = await asyncio.to_thread(_load_tier_data, upload, db)
    if not tier_data:
        raise HTTPException(400, "No tier data available. Parse an upload first.")
    vector_results = await asyncio.to_thread(_load_vector_results, upload, db)
    if not vector_results:
        raise HTTPException(400, "No vector results available. Run vector analysis first.")

    from app.engines.indexing_pipeline import IndexingPipeline
    embed_mode = "databricks" if settings.databricks_app else settings.embedding_mode
    embed_model = settings.databricks_embedding_model if settings.databricks_app else settings.embedding_model
    pipeline = IndexingPipeline(
        embedding_mode=embed_mode,
        embedding_model=embed_model,
        chroma_persist_dir=settings.chroma_persist_dir,
        use_pg_store=settings.databricks_app,
    )
    stats = await asyncio.to_thread(pipeline.reindex_with_vectors, upload_id, tier_data, vector_results)
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

    engines = await asyncio.to_thread(_get_engines)
    store = engines["store"]
    chat_engine = engines["chat"]

    # tier_data provides session/table metadata for grounding the LLM response
    tier_data = await asyncio.to_thread(_load_tier_data, upload, db)

    # Auto-index on first chat if no index exists
    if not await asyncio.to_thread(store.collection_exists, upload_id):
        if not tier_data:
            raise HTTPException(400, "No tier data available. Parse an upload first.")
        logger.info("Auto-indexing upload %d on first chat request", upload_id)
        vector_results = await asyncio.to_thread(_load_vector_results, upload, db)
        from app.engines.indexing_pipeline import IndexingPipeline
        embed_mode = "databricks" if settings.databricks_app else settings.embedding_mode
        embed_model = settings.databricks_embedding_model if settings.databricks_app else settings.embedding_model
        pipeline = IndexingPipeline(
            embedding_mode=embed_mode,
            embedding_model=embed_model,
            chroma_persist_dir=settings.chroma_persist_dir,
            use_pg_store=settings.databricks_app,
        )
        await asyncio.to_thread(pipeline.index_upload, upload_id, tier_data, vector_results)

    result = await chat_engine.chat(
        upload_id=upload_id,
        question=request.question,
        tier_data=tier_data,
        conversation_history=request.conversation_history,
    )

    return result


# ── Background Index ──────────────────────────────────────────────────────

@router.post("/index/{upload_id}/background")
async def index_upload_background(upload_id: int, db: Session = Depends(get_db)):
    """Start indexing in the background. Returns immediately.

    Use GET /chat/index/{upload_id}/progress for SSE progress updates.
    """
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")

    # Check if already running
    with _index_tasks_lock:
        existing = _index_tasks.get(upload_id)
        if existing and existing.get("status") == "running":
            return {"status": "already_running", "progress": existing.get("progress", 0)}

    tier_data = await asyncio.to_thread(_load_tier_data, upload, db)
    if not tier_data:
        raise HTTPException(400, "No tier data available. Parse an upload first.")
    vector_results = await asyncio.to_thread(_load_vector_results, upload, db)

    thread = threading.Thread(
        target=_run_indexing_background,
        args=(upload_id, tier_data, vector_results),
        daemon=True,
    )
    thread.start()
    return {"status": "started", "upload_id": upload_id}


@router.get("/index/{upload_id}/progress")
async def index_progress(upload_id: int):
    """SSE endpoint for indexing progress updates."""

    async def event_stream():
        while True:
            with _index_tasks_lock:
                task = _index_tasks.get(upload_id, {})
            status = task.get("status", "unknown")
            progress = task.get("progress", 0)

            yield f"data: {{\"status\": \"{status}\", \"progress\": {progress}}}\n\n"

            if status in ("completed", "failed", "unknown"):
                break
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Search endpoint (non-LLM) ────────────────────────────────────────────

@router.post("/{upload_id}/search")
async def search(upload_id: int, request: SearchRequest):
    """Semantic search without LLM — returns raw matched documents.

    Useful for debugging retrieval quality: call this to see exactly which
    indexed document chunks would be fed to the LLM for a given question.
    doc_type can be 'session', 'table', 'vector_insight', etc. to narrow results.
    """
    engines = await asyncio.to_thread(_get_engines)
    embedding = engines["embedding"]
    store = engines["store"]

    if not await asyncio.to_thread(store.collection_exists, upload_id):
        raise HTTPException(400, "Upload not indexed.")

    # Embed the query text into a dense vector before searching ChromaDB
    query_embedding = await asyncio.to_thread(embedding.embed_single, request.query)
    results = await asyncio.to_thread(
        store.search,
        upload_id, query_embedding,
        n_results=request.n_results,
        doc_type=request.doc_type,
    )

    return {"query": request.query, "results": results}


# ── Index status ──────────────────────────────────────────────────────────

@router.get("/{upload_id}/status")
async def index_status(upload_id: int):
    """Check if an upload is indexed and get document count.

    Lightweight endpoint for the frontend to show index status badges
    without triggering any heavy computation.

    Args:
        upload_id: DB primary key of the upload.

    Returns:
        Dict with indexed (bool) and document_count (int).
    """
    engines = await asyncio.to_thread(_get_engines)
    store = engines["store"]

    if await asyncio.to_thread(store.collection_exists, upload_id):
        return {
            "indexed": True,
            "document_count": await asyncio.to_thread(store.get_collection_count, upload_id),
        }
    return {"indexed": False, "document_count": 0}
