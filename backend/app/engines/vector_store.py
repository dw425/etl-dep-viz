"""Vector Store — ChromaDB-backed vector database for ETL document search.

One ChromaDB collection per upload (named "upload_{upload_id}").
Each document is stored with its embedding and a flat metadata dict so the
RAG engine can filter by document type (session/table/chain/group/environment)
at query time without loading all documents into memory.

ChromaDB is initialized lazily on first use (see `client` property) so the
import error surfaces only when the feature is actually needed, not at startup.
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
        """Lazy-initialize ChromaDB client on first access.

        Using PersistentClient means data survives process restarts without
        needing a separate ChromaDB server process.
        """
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
        """Create or replace a collection for an upload.

        Always deletes any existing collection first so a re-index starts clean.
        Collections use cosine similarity ("hnsw:space": "cosine") to match the
        L2-normalised embeddings produced by EmbeddingEngine.
        """
        name = f"upload_{upload_id}"
        try:
            # Silently ignore errors if the collection doesn't exist yet
            self.client.delete_collection(name)
        except Exception:
            pass
        collection = self.client.create_collection(
            name=name,
            # HNSW cosine space is correct for unit-norm sentence-transformer vectors
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
        """Index all documents with their embeddings into ChromaDB.

        Processes documents in batches of 5000 to stay within ChromaDB's
        recommended per-call limits. Returns the final document count
        as reported by ChromaDB (a useful sanity-check after indexing).
        """
        collection = self.create_collection(upload_id)

        # 5000 docs per batch is a safe upper limit for ChromaDB's batch API
        batch_size = 5000
        for i in range(0, len(documents), batch_size):
            batch_docs = documents[i:i + batch_size]
            batch_embs = embeddings[i:i + batch_size]

            # ChromaDB metadata values must be scalar — flatten complex types
            metadatas = []
            for d in batch_docs:
                # Always include the document type for post-retrieval filtering
                meta = {"type": d["type"]}
                for k, v in d.get("metadata", {}).items():
                    if isinstance(v, (str, int, float)):
                        meta[k] = v
                    elif isinstance(v, bool):
                        # ChromaDB does not natively support bool; store as string
                        meta[k] = str(v)
                    # Lists, dicts, and None are silently dropped
                metadatas.append(meta)

            collection.add(
                ids=[d["id"] for d in batch_docs],
                documents=[d["content"] for d in batch_docs],
                embeddings=batch_embs,
                metadatas=metadatas,
            )

        # Verify the final count from ChromaDB (not just len(documents))
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
        """Search for similar documents using cosine similarity.

        Returns a list of hits sorted by ascending distance (0 = identical).
        If the collection does not exist (e.g., not yet indexed), returns [].
        `doc_type` restricts results to a single document category, which
        improves precision for intent-specific queries (e.g., lineage -> chain).
        """
        try:
            collection = self.client.get_collection(f"upload_{upload_id}")
        except Exception:
            # Collection missing — indexing may not have run yet
            return []

        # Build a ChromaDB `where` clause only when filtering by type
        where_filter = {"type": doc_type} if doc_type else None

        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            where=where_filter,
            include=["documents", "metadatas", "distances"],
        )

        # ChromaDB wraps results in an extra list dimension per query embedding;
        # we always send exactly one query, so index [0] to get the flat lists.
        hits = []
        for i in range(len(results["ids"][0])):
            hits.append({
                "id": results["ids"][0][i],
                "content": results["documents"][0][i],
                "metadata": results["metadatas"][0][i],
                "distance": results["distances"][0][i],  # cosine distance [0, 2]
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
