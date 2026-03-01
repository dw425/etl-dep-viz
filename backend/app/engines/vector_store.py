"""Vector Store — ChromaDB-backed vector database for ETL document search.

One collection per upload. Each document stored with full metadata for filtering.
Supports semantic search with optional document type filtering.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("edv.vectordb")


class VectorStore:
    """ChromaDB-backed vector store for ETL document search."""

    def __init__(self, persist_dir: str = "./chroma_data"):
        self.persist_dir = persist_dir
        self._client: Any = None

    @property
    def client(self) -> Any:
        """Lazy-initialize ChromaDB client."""
        if self._client is None:
            try:
                import chromadb
                self._client = chromadb.PersistentClient(path=self.persist_dir)
                logger.info("ChromaDB initialized at %s", self.persist_dir)
            except ImportError:
                raise ImportError(
                    "chromadb not installed. Install with: pip install chromadb"
                )
        return self._client

    def create_collection(self, upload_id: int) -> Any:
        """Create or replace a collection for an upload."""
        name = f"upload_{upload_id}"
        try:
            self.client.delete_collection(name)
        except Exception:
            pass
        collection = self.client.create_collection(
            name=name,
            metadata={"hnsw:space": "cosine"},
        )
        logger.info("Created collection: %s", name)
        return collection

    def index_documents(
        self,
        upload_id: int,
        documents: list[dict],
        embeddings: list[list[float]],
    ) -> int:
        """Index all documents with their embeddings into ChromaDB."""
        collection = self.create_collection(upload_id)

        batch_size = 5000
        for i in range(0, len(documents), batch_size):
            batch_docs = documents[i:i + batch_size]
            batch_embs = embeddings[i:i + batch_size]

            # Prepare metadata — ChromaDB only accepts str/int/float/bool values
            metadatas = []
            for d in batch_docs:
                meta = {"type": d["type"]}
                for k, v in d.get("metadata", {}).items():
                    if isinstance(v, (str, int, float)):
                        meta[k] = v
                    elif isinstance(v, bool):
                        meta[k] = str(v)
                metadatas.append(meta)

            collection.add(
                ids=[d["id"] for d in batch_docs],
                documents=[d["content"] for d in batch_docs],
                embeddings=batch_embs,
                metadatas=metadatas,
            )

        count = collection.count()
        logger.info("Indexed %d documents for upload %d", count, upload_id)
        return count

    def search(
        self,
        upload_id: int,
        query_embedding: list[float],
        n_results: int = 10,
        doc_type: str | None = None,
    ) -> list[dict]:
        """Search for similar documents. Returns [{id, content, metadata, distance}]."""
        try:
            collection = self.client.get_collection(f"upload_{upload_id}")
        except Exception:
            return []

        where_filter = {"type": doc_type} if doc_type else None

        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            where=where_filter,
            include=["documents", "metadatas", "distances"],
        )

        hits = []
        for i in range(len(results["ids"][0])):
            hits.append({
                "id": results["ids"][0][i],
                "content": results["documents"][0][i],
                "metadata": results["metadatas"][0][i],
                "distance": results["distances"][0][i],
            })

        return hits

    def delete_collection(self, upload_id: int) -> None:
        """Remove all indexed data for an upload."""
        try:
            self.client.delete_collection(f"upload_{upload_id}")
            logger.info("Deleted collection for upload %d", upload_id)
        except Exception:
            pass

    def collection_exists(self, upload_id: int) -> bool:
        """Check if a collection exists for an upload."""
        try:
            self.client.get_collection(f"upload_{upload_id}")
            return True
        except Exception:
            return False

    def get_collection_count(self, upload_id: int) -> int:
        """Get document count for an upload's collection."""
        try:
            collection = self.client.get_collection(f"upload_{upload_id}")
            return collection.count()
        except Exception:
            return 0
