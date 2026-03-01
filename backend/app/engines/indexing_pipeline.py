"""Indexing Pipeline — orchestrates document generation, embedding, and vector storage.

End-to-end: tier_data -> documents -> embeddings -> vector DB.
Called after parsing completes. Can be re-run after vector analysis
to enrich documents with complexity/wave/community data.
"""

from __future__ import annotations

import logging
import time

from .document_generator import DocumentGenerator
from .embedding_engine import EmbeddingEngine
from .vector_store import VectorStore

logger = logging.getLogger("edv.indexing")


class IndexingPipeline:
    """End-to-end: tier_data -> documents -> embeddings -> vector DB."""

    def __init__(
        self,
        embedding_mode: str = "local",
        embedding_model: str | None = None,
        chroma_persist_dir: str = "./chroma_data",
    ):
        self.embedding_engine = EmbeddingEngine(mode=embedding_mode, model=embedding_model)
        self.vector_store = VectorStore(persist_dir=chroma_persist_dir)

    def index_upload(
        self,
        upload_id: int,
        tier_data: dict,
        vector_results: dict | None = None,
        progress_fn=None,
    ) -> dict:
        """Full indexing pipeline. Returns stats."""
        t0 = time.monotonic()

        # Step 1: Generate documents
        if progress_fn:
            progress_fn("indexing", 0, "Generating documents...")
        generator = DocumentGenerator(tier_data, vector_results)
        documents = generator.generate_all()

        if not documents:
            return {
                "documents_generated": 0,
                "documents_indexed": 0,
                "embedding_dimension": self.embedding_engine.dimension,
                "elapsed_seconds": 0.0,
                "by_type": {},
            }

        # Step 2: Generate embeddings
        if progress_fn:
            progress_fn("indexing", 30, f"Embedding {len(documents)} documents...")
        texts = [d["content"] for d in documents]
        embeddings = self.embedding_engine.embed_batch(texts)

        # Step 3: Store in vector DB
        if progress_fn:
            progress_fn("indexing", 80, "Indexing into vector database...")
        count = self.vector_store.index_documents(upload_id, documents, embeddings)

        elapsed = time.monotonic() - t0
        if progress_fn:
            progress_fn("indexing", 100, f"Indexed {count} documents in {elapsed:.1f}s")

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
        """Re-index after vector analysis to enrich documents with V1-V11 data."""
        return self.index_upload(upload_id, tier_data, vector_results)
