"""Databricks Foundation Model embedding client.

Calls Databricks serving endpoints for text embeddings using the workspace's
OAuth token (service principal). No external API keys required.

Produces 1024-dimensional vectors with databricks-bge-large-en by default.
Supports concurrent batch processing (4 parallel requests) for faster indexing.

Usage:
    engine = DatabricksEmbeddingEngine(model="databricks-bge-large-en")
    vectors = engine.embed_batch(["text1", "text2"])
"""

from __future__ import annotations

import json
import logging
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from app.engines.databricks_auth import get_databricks_token

logger = logging.getLogger("edv.databricks_embeddings")


class DatabricksEmbeddingEngine:
    """Databricks Foundation Model embedding endpoint client.

    Compatible with the EmbeddingEngine interface used by VectorStore
    and HybridSearchEngine. Uses concurrent requests for batch embedding.
    """

    def __init__(self, model: str = "databricks-bge-large-en", max_workers: int = 4):
        self.model = model
        self.dimension: int = 1024  # BGE-large-en output dimension
        self.using_zero_vectors: bool = False
        self.max_workers = max_workers
        self._total_tokens_in: int = 0

    def _embed_one_batch(self, batch: list[str], url: str, token: str) -> list[list[float]]:
        """Embed a single batch via HTTP. Returns list of embedding vectors."""
        payload = json.dumps({"input": batch}).encode()
        req = urllib.request.Request(
            url, data=payload, method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
        )
        try:
            resp = urllib.request.urlopen(req, timeout=60)
            result = json.loads(resp.read())
            sorted_data = sorted(result["data"], key=lambda d: d["index"])
            usage = result.get("usage", {})
            self._total_tokens_in += usage.get("prompt_tokens", 0)
            return [d["embedding"] for d in sorted_data]
        except Exception as exc:
            logger.error("Databricks embedding call failed: %s", exc)
            self.using_zero_vectors = True
            return [[0.0] * self.dimension for _ in batch]

    def embed_batch(self, texts: list[str], batch_size: int = 64) -> list[list[float]]:
        """Embed a batch of texts via Databricks serving endpoint.

        Uses concurrent requests (max_workers parallel) to speed up bulk embedding.
        At 50K documents: ~12 min vs ~50 min sequential.
        """
        if not texts:
            return []

        try:
            host, token = get_databricks_token()
        except RuntimeError as e:
            logger.warning("Databricks embeddings unavailable: %s — returning zero vectors", e)
            self.using_zero_vectors = True
            return [[0.0] * self.dimension for _ in texts]

        url = f"{host}/serving-endpoints/{self.model}/invocations"

        # Split into batches
        batches = []
        for i in range(0, len(texts), batch_size):
            batches.append((i, texts[i:i + batch_size]))

        # Single batch — no threading overhead
        if len(batches) <= 1:
            if not batches:
                return []
            return self._embed_one_batch(batches[0][1], url, token)

        # Multiple batches — concurrent execution
        all_embeddings: list[list[float]] = [None] * len(texts)  # type: ignore[list-item]
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {}
            for start_idx, batch in batches:
                future = executor.submit(self._embed_one_batch, batch, url, token)
                futures[future] = (start_idx, len(batch))

            for future in as_completed(futures):
                start_idx, count = futures[future]
                try:
                    result = future.result()
                    for j, emb in enumerate(result):
                        all_embeddings[start_idx + j] = emb
                except Exception as exc:
                    logger.error("Embedding batch at %d failed: %s", start_idx, exc)
                    self.using_zero_vectors = True
                    for j in range(count):
                        all_embeddings[start_idx + j] = [0.0] * self.dimension

        # Fill any remaining None slots (shouldn't happen but safety)
        for i in range(len(all_embeddings)):
            if all_embeddings[i] is None:
                all_embeddings[i] = [0.0] * self.dimension

        logger.info("Embedded %d texts in %d batches (%d workers), tokens_in=%d",
                     len(texts), len(batches), self.max_workers, self._total_tokens_in)
        return all_embeddings

    def embed_single(self, text: str) -> list[float]:
        """Embed a single text (used at query time)."""
        return self.embed_batch([text])[0]
