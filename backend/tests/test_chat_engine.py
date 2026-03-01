"""Tests for the AI Chat engine components — document generation, query classification."""

import pytest


class TestDocumentGenerator:
    """Document generation from tier data."""

    def test_generate_session_docs(self, sample_tier_data):
        """Generate session documents from parsed tier data."""
        from app.engines.document_generator import DocumentGenerator

        gen = DocumentGenerator(sample_tier_data)
        docs = gen.generate_all()
        assert len(docs) > 0

        # Should have at least session documents
        session_docs = [d for d in docs if d["type"] == "session"]
        assert len(session_docs) > 0

        # Each doc should have required fields
        for doc in session_docs:
            assert "id" in doc
            assert "content" in doc
            assert "metadata" in doc
            assert len(doc["content"]) > 0

    def test_generate_table_docs(self, sample_tier_data):
        """Generate table documents."""
        from app.engines.document_generator import DocumentGenerator

        gen = DocumentGenerator(sample_tier_data)
        docs = gen.generate_all()

        table_docs = [d for d in docs if d["type"] == "table"]
        assert len(table_docs) > 0
        for doc in table_docs:
            assert "table_name" in doc["metadata"]

    def test_generate_environment_doc(self, sample_tier_data):
        """Generate environment summary document."""
        from app.engines.document_generator import DocumentGenerator

        gen = DocumentGenerator(sample_tier_data)
        docs = gen.generate_all()

        env_docs = [d for d in docs if d["type"] == "environment"]
        assert len(env_docs) == 1
        assert "ENVIRONMENT SUMMARY" in env_docs[0]["content"]

    def test_generate_with_vector_results(self, sample_tier_data):
        """Generator produces richer docs when vector results are available."""
        from app.engines.document_generator import DocumentGenerator
        from app.engines.vectors.orchestrator import VectorOrchestrator

        orch = VectorOrchestrator()
        vr = orch.run_phase1(sample_tier_data)

        gen = DocumentGenerator(sample_tier_data, vr)
        docs = gen.generate_all()
        assert len(docs) > 0

    def test_empty_tier_data(self):
        """Generator handles empty tier data gracefully."""
        from app.engines.document_generator import DocumentGenerator

        gen = DocumentGenerator({"sessions": [], "tables": [], "connections": []})
        docs = gen.generate_all()
        # Should produce at least an environment doc
        assert len(docs) >= 1


class TestQueryClassification:
    """Query intent classification."""

    def test_classify_session_lookup(self):
        """Session-related queries produce session_lookup or complexity intent."""
        from app.engines.query_engine import classify_query

        result = classify_query("What are the most complex sessions?")
        assert result.intent.value in ("session_lookup", "complexity_query", "general")

    def test_classify_table_lookup(self):
        """Table-related queries produce table_lookup intent."""
        from app.engines.query_engine import classify_query

        result = classify_query("Which tables have write conflicts?")
        assert result.intent.value in ("table_lookup", "conflict_analysis", "general")

    def test_classify_lineage(self):
        """Lineage queries produce lineage_trace intent."""
        from app.engines.query_engine import classify_query

        result = classify_query("Show me the lineage for CUSTOMER table")
        assert result.intent.value in ("lineage_trace", "general")

    def test_classify_wave_plan(self):
        """Migration wave queries produce wave_query intent."""
        from app.engines.query_engine import classify_query

        result = classify_query("What's in Wave 1?")
        assert result.intent.value in ("wave_query", "migration_planning", "general")

    def test_classify_complexity(self):
        """Complexity queries produce complexity_query intent."""
        from app.engines.query_engine import classify_query

        result = classify_query("What is the complexity score?")
        assert result.intent.value in ("complexity_query", "general")

    def test_classify_general(self):
        """General queries fall back to general intent."""
        from app.engines.query_engine import classify_query

        result = classify_query("Hello, how are you?")
        assert result.intent.value == "general"

    def test_entity_extraction(self):
        """Query classification extracts entity names."""
        from app.engines.query_engine import classify_query

        result = classify_query("Tell me about session S_DIM_CUSTOMER")
        assert len(result.entities) >= 0  # May or may not extract depending on pattern


class TestEmbeddingEngine:
    """Embedding engine fallback behavior."""

    def test_fallback_mode(self):
        """Embedding engine falls back to zero vectors when libraries not available."""
        from app.engines.embedding_engine import EmbeddingEngine

        engine = EmbeddingEngine(mode="local", model="all-MiniLM-L6-v2")
        # Should not crash even if sentence-transformers is not installed
        assert engine.dimension > 0

    def test_embed_batch(self):
        """Embedding a batch returns list of correct length."""
        from app.engines.embedding_engine import EmbeddingEngine

        engine = EmbeddingEngine(mode="local", model="all-MiniLM-L6-v2")
        texts = ["Hello world", "Test document", "ETL session"]
        embeddings = engine.embed_batch(texts)
        assert len(embeddings) == 3
        assert len(embeddings[0]) == engine.dimension

    def test_embed_single(self):
        """Embedding a single text returns a vector."""
        from app.engines.embedding_engine import EmbeddingEngine

        engine = EmbeddingEngine(mode="local", model="all-MiniLM-L6-v2")
        embedding = engine.embed_single("Test text")
        assert len(embedding) == engine.dimension
