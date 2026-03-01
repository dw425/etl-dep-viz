"""Embedding Engine — generate vector embeddings for ETL documents.

Supports two modes:
  1. LOCAL: sentence-transformers (default, no API key, CPU-friendly)
  2. OPENAI: OpenAI text-embedding-3-small (higher quality, needs key)
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("edv.embedding")


class EmbeddingEngine:
    """Generate vector embeddings for documents."""

    def __init__(self, mode: str = "local", model: str | None = None, api_key: str | None = None):
        self.mode = mode
        self._model: Any = None
        self.dimension: int = 384  # default for MiniLM

        if mode == "local":
            try:
                from sentence_transformers import SentenceTransformer
                self._model = SentenceTransformer(model or "all-MiniLM-L6-v2")
                self.dimension = self._model.get_sentence_embedding_dimension()
                logger.info("Local embedding model loaded: dim=%d", self.dimension)
            except ImportError:
                logger.warning(
                    "sentence-transformers not installed. Install with: "
                    "pip install sentence-transformers"
                )
                self._model = None

        elif mode == "openai":
            self._api_key = api_key
            self._model_name = model or "text-embedding-3-small"
            self.dimension = 1536

    def embed_batch(self, texts: list[str], batch_size: int = 64) -> list[list[float]]:
        """Embed a batch of text documents into vectors."""
        if self.mode == "local":
            if self._model is None:
                # Fallback: return zero vectors if model not available
                logger.warning("Embedding model not available, returning zero vectors")
                return [[0.0] * self.dimension for _ in texts]
            embeddings = self._model.encode(
                texts, batch_size=batch_size, show_progress_bar=False,
                normalize_embeddings=True,
            )
            return embeddings.tolist()

        elif self.mode == "openai":
            import openai
            client = openai.OpenAI(api_key=self._api_key)
            all_embeddings: list[list[float]] = []
            for i in range(0, len(texts), batch_size):
                batch = texts[i:i + batch_size]
                response = client.embeddings.create(
                    input=batch, model=self._model_name,
                )
                all_embeddings.extend([d.embedding for d in response.data])
            return all_embeddings

        # Fallback
        return [[0.0] * self.dimension for _ in texts]

    def embed_single(self, text: str) -> list[float]:
        """Embed a single text (for queries)."""
        return self.embed_batch([text])[0]
