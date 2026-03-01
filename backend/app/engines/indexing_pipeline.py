"""Indexing Pipeline — orchestrates document generation, embedding, and vector storage.

Three-stage pipeline:
  Stage 1 (0-30% progress)  — DocumentGenerator converts tier_data into structured
                               text documents (sessions, tables, chains, groups, env).
  Stage 2 (30-80% progress) — EmbeddingEngine converts document text into float vectors.
  Stage 3 (80-100% progress)— VectorStore writes vectors + metadata to ChromaDB.

The optional `progress_fn(stage, pct, message)` callback is wired to SSE events
so the frontend can show a live progress bar during indexing.

Call `reindex_with_vectors` after the V1-V11 vector engines have run to regenerate
documents enriched with complexity scores, wave assignments, and community labels.
"""

from __future__ import annotations

import logging
import time

from .document_generator import DocumentGenerator
from .embedding_engine import EmbeddingEngine
from .vector_store import VectorStore

logger = logging.getLogger("edv.indexing")


class IndexingPipeline:
    """End-to-end: tier_data -> documents -> embeddings -> vector DB.

    Owns both the EmbeddingEngine and VectorStore so callers only need to
    provide tier_data and an upload_id — all internal stages are coordinated here.
    """

    def __init__(
        self,
        embedding_mode: str = "local",
        embedding_model: str | None = None,
        chroma_persist_dir: str = "./chroma_data",
    ):
        # EmbeddingEngine wraps sentence-transformers or OpenAI depending on mode
        self.embedding_engine = EmbeddingEngine(mode=embedding_mode, model=embedding_model)
        # VectorStore manages one ChromaDB collection per upload_id
        self.vector_store = VectorStore(persist_dir=chroma_persist_dir)

    def index_upload(
        self,
        upload_id: int,
        tier_data: dict,
        vector_results: dict | None = None,
        progress_fn=None,
    ) -> dict:
        """Full indexing pipeline. Returns stats dict with document counts and timing.

        `vector_results` is optional — pass it when re-indexing after V1-V11
        analysis so that session documents are enriched with complexity/wave/community.
        `progress_fn(stage, pct, message)` fires at stage boundaries for SSE streaming.
        """
        t0 = time.monotonic()

        # ── Stage 1: Document generation (0%) ────────────────────────────────
        if progress_fn:
            progress_fn("indexing", 0, "Generating documents...")
        generator = DocumentGenerator(tier_data, vector_results)
        documents = generator.generate_all()

        # Short-circuit if there is nothing to index (e.g., empty parse result)
        if not documents:
            return {
                "documents_generated": 0,
                "documents_indexed": 0,
                "embedding_dimension": self.embedding_engine.dimension,
                "elapsed_seconds": 0.0,
                "by_type": {},
            }

        # ── Stage 2: Embedding (30%) ──────────────────────────────────────────
        if progress_fn:
            progress_fn("indexing", 30, f"Embedding {len(documents)} documents...")
        # Extract raw text content in the same order as `documents`
        texts = [d["content"] for d in documents]
        embeddings = self.embedding_engine.embed_batch(texts)

        # ── Stage 3: ChromaDB ingestion (80%) ─────────────────────────────────
        if progress_fn:
            progress_fn("indexing", 80, "Indexing into vector database...")
        count = self.vector_store.index_documents(upload_id, documents, embeddings)

        elapsed = time.monotonic() - t0
        if progress_fn:
            progress_fn("indexing", 100, f"Indexed {count} documents in {elapsed:.1f}s")

        # Build per-type breakdown for the stats response (skip zero-count types)
        by_type = {}
        for doc_type in ("session", "table", "chain", "group", "environment"):
            c = sum(1 for d in documents if d["type"] == doc_type)
            if c > 0:
                by_type[doc_type] = c

        stats = {
            "documents_generated": len(documents),
            "documents_indexed": count,
            "embedding_dimension": self.embedding_engine.dimension,
            "elapsed_seconds": round(elapsed, 2),
            "by_type": by_type,
        }

        logger.info("Indexing complete: %s", stats)
        return stats

    def reindex_with_vectors(
        self, upload_id: int, tier_data: dict, vector_results: dict,
    ) -> dict:
        """Re-index after vector analysis to enrich documents with V1-V11 data.

        Runs the full pipeline a second time. The old ChromaDB collection is
        deleted and rebuilt so documents contain up-to-date complexity scores,
        wave assignments, community labels, and gravity groups.
        """
        return self.index_upload(upload_id, tier_data, vector_results)
