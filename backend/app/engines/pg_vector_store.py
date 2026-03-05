"""PostgreSQL-backed vector store for RAG document embeddings.

Replaces ChromaDB for Databricks deployment where ephemeral filesystems
wipe ChromaDB collections on every restart.  Documents and embeddings
are stored in the ``document_embeddings`` table and loaded into an
LRU cache for fast cosine similarity search.

At ~50K documents with 1024-dim embeddings, the in-memory footprint is
~200MB and cosine similarity search takes <50ms on cached data.
"""

from __future__ import annotations

import json
import logging
import struct
import threading
from functools import lru_cache
from typing import Any

import numpy as np
from sqlalchemy.orm import Session

from app.models.database import DocumentEmbedding, SessionLocal

logger = logging.getLogger("edv.pg_vector_store")


def _serialize_embedding(vec: list[float]) -> bytes:
    """Pack a float list into raw bytes (float32 little-endian)."""
    return struct.pack(f"<{len(vec)}f", *vec)


def _deserialize_embedding(blob: bytes, dim: int) -> np.ndarray:
    """Unpack raw bytes back into a numpy float32 array."""
    return np.frombuffer(blob, dtype=np.float32).copy()


class PgVectorStore:
    """PostgreSQL-backed vector store with LRU-cached cosine similarity search.

    Public API matches VectorStore (ChromaDB wrapper) so they can be
    swapped transparently via the ``settings.databricks_app`` flag.
    """

    def __init__(self) -> None:
        self._cache_lock = threading.Lock()
        # Invalidation version — bump to force cache reload
        self._cache_versions: dict[int, int] = {}

    # ── Collection management ──────────────────────────────────────────

    def create_collection(self, upload_id: int) -> None:
        """Delete existing embeddings for this upload (clean re-index)."""
        db = SessionLocal()
        try:
            db.query(DocumentEmbedding).filter(
                DocumentEmbedding.upload_id == upload_id
            ).delete()
            db.commit()
            self._invalidate_cache(upload_id)
            logger.info("Cleared PG embeddings for upload %d", upload_id)
        finally:
            db.close()

    def index_documents(
        self,
        upload_id: int,
        documents: list[dict],
        embeddings: list[list[float]],
    ) -> int:
        """Batch insert documents + embeddings into PostgreSQL.

        Args:
            upload_id: Upload primary key.
            documents: List of dicts with keys: id, type, content, metadata.
            embeddings: Parallel list of float vectors.

        Returns:
            Number of documents indexed.
        """
        self.create_collection(upload_id)

        db = SessionLocal()
        try:
            batch: list[DocumentEmbedding] = []
            for doc, emb in zip(documents, embeddings):
                # Sanitize metadata: convert non-scalar values to strings
                meta = doc.get("metadata", {})
                safe_meta = {}
                for k, v in (meta or {}).items():
                    if isinstance(v, (str, int, float)):
                        safe_meta[k] = v
                    elif isinstance(v, bool):
                        safe_meta[k] = str(v)
                    elif v is not None:
                        safe_meta[k] = str(v)

                row = DocumentEmbedding(
                    upload_id=upload_id,
                    doc_id=doc["id"],
                    doc_type=doc["type"],
                    content=doc["content"],
                    embedding_blob=_serialize_embedding(emb),
                    metadata_json=json.dumps(safe_meta) if safe_meta else None,
                    chunk_index=doc.get("chunk_index", 0),
                )
                batch.append(row)

                # Flush in batches of 2000 to limit memory
                if len(batch) >= 2000:
                    db.bulk_save_objects(batch)
                    db.flush()
                    batch.clear()

            if batch:
                db.bulk_save_objects(batch)
            db.commit()

            self._invalidate_cache(upload_id)
            count = len(documents)
            logger.info("Indexed %d documents into PG for upload %d", count, upload_id)
            return count
        finally:
            db.close()

    def search(
        self,
        upload_id: int,
        query_embedding: list[float],
        n_results: int = 10,
        doc_type: str | None = None,
    ) -> list[dict]:
        """Cosine similarity search using cached embeddings.

        Returns list of dicts: {id, content, metadata, distance}.
        """
        cache_data = self._get_cached_embeddings(upload_id)
        if not cache_data:
            return []

        ids, types, contents, metadatas, matrix = cache_data

        # Optional type filter
        if doc_type:
            mask = np.array([t == doc_type for t in types])
            if not mask.any():
                return []
            filtered_idx = np.where(mask)[0]
            sub_matrix = matrix[filtered_idx]
        else:
            filtered_idx = np.arange(len(ids))
            sub_matrix = matrix

        # Cosine similarity: dot product of L2-normalized vectors
        query_vec = np.array(query_embedding, dtype=np.float32)
        norm = np.linalg.norm(query_vec)
        if norm > 0:
            query_vec /= norm

        similarities = sub_matrix @ query_vec  # shape: (N,)
        # Convert to cosine distance (0 = identical, 2 = opposite)
        distances = 1.0 - similarities

        # Top-K by smallest distance
        top_k = min(n_results, len(distances))
        top_indices = np.argpartition(distances, top_k)[:top_k]
        top_indices = top_indices[np.argsort(distances[top_indices])]

        results = []
        for idx in top_indices:
            orig_idx = filtered_idx[idx]
            results.append({
                "id": ids[orig_idx],
                "content": contents[orig_idx],
                "metadata": metadatas[orig_idx],
                "distance": float(distances[idx]),
            })
        return results

    def delete_collection(self, upload_id: int) -> None:
        """Remove all embeddings for an upload."""
        db = SessionLocal()
        try:
            db.query(DocumentEmbedding).filter(
                DocumentEmbedding.upload_id == upload_id
            ).delete()
            db.commit()
            self._invalidate_cache(upload_id)
        finally:
            db.close()

    def collection_exists(self, upload_id: int) -> bool:
        """Check if any embeddings exist for this upload."""
        db = SessionLocal()
        try:
            return db.query(DocumentEmbedding.id).filter(
                DocumentEmbedding.upload_id == upload_id
            ).first() is not None
        finally:
            db.close()

    def get_collection_count(self, upload_id: int) -> int:
        """Count documents in the collection."""
        db = SessionLocal()
        try:
            return db.query(DocumentEmbedding).filter(
                DocumentEmbedding.upload_id == upload_id
            ).count()
        finally:
            db.close()

    # ── Cache management ───────────────────────────────────────────────

    def _invalidate_cache(self, upload_id: int) -> None:
        """Bump version to force next search to reload from DB."""
        with self._cache_lock:
            self._cache_versions[upload_id] = (
                self._cache_versions.get(upload_id, 0) + 1
            )
            # Clear the LRU cache entirely — simple and correct
            self._load_embeddings.cache_clear()

    def _get_cached_embeddings(self, upload_id: int):
        """Load embeddings, using LRU cache for repeated searches."""
        version = self._cache_versions.get(upload_id, 0)
        return self._load_embeddings(upload_id, version)

    @staticmethod
    @lru_cache(maxsize=8)
    def _load_embeddings(upload_id: int, _version: int):
        """Load all embeddings for an upload into numpy matrix.

        Returns (ids, types, contents, metadatas, matrix) or None.
        The _version param ensures cache invalidation on index changes.
        """
        db = SessionLocal()
        try:
            rows = db.query(DocumentEmbedding).filter(
                DocumentEmbedding.upload_id == upload_id
            ).all()
            if not rows:
                return None

            ids = []
            types = []
            contents = []
            metadatas = []
            vectors = []

            for r in rows:
                ids.append(r.doc_id)
                types.append(r.doc_type)
                contents.append(r.content)
                meta = json.loads(r.metadata_json) if r.metadata_json else {}
                metadatas.append(meta)
                if r.embedding_blob:
                    vec = _deserialize_embedding(r.embedding_blob, 0)
                    # L2-normalize for cosine similarity
                    norm = np.linalg.norm(vec)
                    if norm > 0:
                        vec = vec / norm
                    vectors.append(vec)
                else:
                    # Zero vector fallback
                    vectors.append(np.zeros(1, dtype=np.float32))

            # Stack into matrix; handle dimension mismatches
            dim = max(len(v) for v in vectors)
            padded = []
            for v in vectors:
                if len(v) < dim:
                    padded.append(np.pad(v, (0, dim - len(v))))
                else:
                    padded.append(v)

            matrix = np.vstack(padded)
            logger.info(
                "Loaded %d embeddings (%d-dim) for upload %d into cache",
                len(ids), dim, upload_id,
            )
            return ids, types, contents, metadatas, matrix
        finally:
            db.close()
