"""Embedding Engine — generate vector embeddings for ETL documents.

Supports two modes:
  1. LOCAL  — sentence-transformers (default, no API key, CPU-friendly).
              Uses all-MiniLM-L6-v2 (384-dim) unless overridden.
              Falls back to zero-vectors if the library is not installed.
  2. OPENAI — text-embedding-3-small via OpenAI API (1536-dim, higher quality).
              Requires EDV_LLM_API_KEY and the `openai` package.

Vectors produced here are consumed by VectorStore for ChromaDB ingestion
(during indexing) and by HybridSearchEngine for query-time lookup.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("edv.embedding")


class EmbeddingEngine:
    """Generate vector embeddings for documents.

    The `dimension` attribute reflects the actual output size of the chosen model
    and is stored in indexing stats so callers can verify ChromaDB collection geometry.
    """

    def __init__(self, mode: str = "local", model: str | None = None, api_key: str | None = None):
        self.mode = mode
        self._model: Any = None
        self.dimension: int = 384  # default for MiniLM; updated after model loads
        self.using_zero_vectors: bool = False

        # ── Local mode (sentence-transformers) ──────────────────────────────
        if mode == "local":
            try:
                from sentence_transformers import SentenceTransformer
                # Load model weights; defaults to a lightweight 384-dim model
                self._model = SentenceTransformer(model or "all-MiniLM-L6-v2")
                # Query the actual output dimension in case a custom model is used
                self.dimension = self._model.get_sentence_embedding_dimension()
                logger.info("Local embedding model loaded: dim=%d", self.dimension)
            except ImportError:
                logger.warning(
                    "sentence-transformers not installed. Install with: "
                    "pip install sentence-transformers"
                )
                # Engine remains usable but returns zero-vectors (see embed_batch)
                self._model = None

        # ── OpenAI mode ─────────────────────────────────────────────────────
        elif mode == "openai":
            self._api_key = api_key
            self._model_name = model or "text-embedding-3-small"
            self.dimension = 1536  # fixed output size for text-embedding-3-small

    def embed_batch(self, texts: list[str], batch_size: int = 64) -> list[list[float]]:
        """Embed a batch of text documents into L2-normalised float vectors.

        `batch_size` controls how many texts are sent to the model in one call.
        Larger batches are more GPU-efficient; smaller batches reduce peak memory.
        Returns a list of vectors in the same order as the input `texts`.
        """
        if self.mode == "local":
            if self._model is None:
                # Graceful degradation: ChromaDB still indexes, but search quality
                # is zero because all vectors are identical (zero-norm).
                logger.warning("Embedding model not available, returning zero vectors")
                self.using_zero_vectors = True
                return [[0.0] * self.dimension for _ in texts]
            embeddings = self._model.encode(
                texts,
                batch_size=batch_size,
                show_progress_bar=False,
                # Normalise to unit length so cosine distance == euclidean distance
                normalize_embeddings=True,
            )
            # SentenceTransformer returns a numpy ndarray; convert for JSON/ChromaDB
            return embeddings.tolist()

        elif self.mode == "openai":
            import openai
            client = openai.OpenAI(api_key=self._api_key)
            all_embeddings: list[list[float]] = []
            # OpenAI API has a per-request token limit, so process in batches
            for i in range(0, len(texts), batch_size):
                batch = texts[i:i + batch_size]
                response = client.embeddings.create(
                    input=batch, model=self._model_name,
                )
                # response.data is ordered to match input batch order
                all_embeddings.extend([d.embedding for d in response.data])
            return all_embeddings

        # Safety fallback for unknown mode values
        return [[0.0] * self.dimension for _ in texts]

    def embed_single(self, text: str) -> list[float]:
        """Embed a single text (used at query time by HybridSearchEngine)."""
        return self.embed_batch([text])[0]
