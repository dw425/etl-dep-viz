"""Databricks Foundation Model embedding client.

Calls Databricks serving endpoints for text embeddings using the workspace's
OAuth token (service principal). No external API keys required.

Produces 1024-dimensional vectors with databricks-bge-large-en by default.

Usage:
    engine = DatabricksEmbeddingEngine(model="databricks-bge-large-en")
    vectors = engine.embed_batch(["text1", "text2"])
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request

logger = logging.getLogger("edv.databricks_embeddings")


class DatabricksEmbeddingEngine:
    """Databricks Foundation Model embedding endpoint client.

    Compatible with the EmbeddingEngine interface used by VectorStore
    and HybridSearchEngine.
    """

    def __init__(self, model: str = "databricks-bge-large-en"):
        self.model = model
        self.dimension: int = 1024  # BGE-large-en output dimension
        self.using_zero_vectors: bool = False

    def _get_token(self) -> tuple[str, str]:
        """Get Databricks host and OAuth token."""
        host = os.environ.get("DATABRICKS_HOST", "")
        client_id = os.environ.get("DATABRICKS_CLIENT_ID", "")
        client_secret = os.environ.get("DATABRICKS_CLIENT_SECRET", "")

        if not host:
            raise RuntimeError("DATABRICKS_HOST not set")
        if not host.startswith("https://"):
            host = f"https://{host}"

        if client_id and client_secret:
            token_url = f"{host}/oidc/v1/token"
            data = f"grant_type=client_credentials&client_id={client_id}&client_secret={client_secret}&scope=all-apis"
            req = urllib.request.Request(
                token_url, data=data.encode(), method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            resp = urllib.request.urlopen(req)
            token = json.loads(resp.read())["access_token"]
            return host, token

        token = os.environ.get("DATABRICKS_TOKEN", "")
        if token:
            return host, token

        raise RuntimeError("No Databricks credentials found")

    def embed_batch(self, texts: list[str], batch_size: int = 64) -> list[list[float]]:
        """Embed a batch of texts via Databricks serving endpoint.

        Processes in batches to respect API limits. Returns vectors
        in the same order as input texts.
        """
        if not texts:
            return []

        try:
            host, token = self._get_token()
        except RuntimeError as e:
            logger.warning("Databricks embeddings unavailable: %s — returning zero vectors", e)
            self.using_zero_vectors = True
            return [[0.0] * self.dimension for _ in texts]

        url = f"{host}/serving-endpoints/{self.model}/invocations"
        all_embeddings: list[list[float]] = []

        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]

            payload = json.dumps({"input": batch}).encode()
            req = urllib.request.Request(
                url, data=payload, method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {token}",
                },
            )

            try:
                resp = urllib.request.urlopen(req)
                result = json.loads(resp.read())
                # Response format: {"data": [{"embedding": [...], "index": 0}, ...]}
                sorted_data = sorted(result["data"], key=lambda d: d["index"])
                all_embeddings.extend([d["embedding"] for d in sorted_data])
            except Exception as exc:
                logger.error("Databricks embedding call failed: %s", exc)
                # Fall back to zero vectors for this batch
                self.using_zero_vectors = True
                all_embeddings.extend([[0.0] * self.dimension for _ in batch])

        return all_embeddings

    def embed_single(self, text: str) -> list[float]:
        """Embed a single text (used at query time)."""
        return self.embed_batch([text])[0]
