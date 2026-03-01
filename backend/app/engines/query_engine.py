"""RAG Query Engine — query classification, hybrid search, and LLM-powered chat.

Classifies user questions to optimize retrieval, combines vector similarity
search with structured database queries, and assembles prompts for the LLM.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .document_generator import (
    generate_session_document,
    generate_table_document,
    _find_session,
)
from .embedding_engine import EmbeddingEngine
from .vector_store import VectorStore

logger = logging.getLogger("edv.query")


# ── Query Classification ─────────────────────────────────────────────────

class QueryIntent(Enum):
    SESSION_LOOKUP = "session_lookup"
    TABLE_LOOKUP = "table_lookup"
    LINEAGE_TRACE = "lineage_trace"
    IMPACT_ANALYSIS = "impact_analysis"
    COMPLEXITY_QUERY = "complexity_query"
    WAVE_QUERY = "wave_query"
    GROUP_QUERY = "group_query"
    COMPARISON = "comparison"
    ENVIRONMENT = "environment"
    GENERAL = "general"


@dataclass
class ClassifiedQuery:
    intent: QueryIntent
    entities: list[str] = field(default_factory=list)
    doc_types: list[str] = field(default_factory=list)
    structured_filter: dict = field(default_factory=dict)
    augment_with: list[str] = field(default_factory=list)


def classify_query(question: str) -> ClassifiedQuery:
    """Classify user question to optimize retrieval strategy."""
    q = question.lower()

    # Extract potential session/table names (uppercase identifiers)
    entities = re.findall(r'\b[A-Z][A-Z0-9_]{3,}\b', question)

    # Session lookup patterns
    if any(p in q for p in [
        "tell me about session", "what does session", "describe session",
        "show me session", "details for session", "what is session",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.SESSION_LOOKUP,
            entities=entities,
            doc_types=["session"],
            augment_with=["upstream_sessions", "downstream_sessions"],
        )

    # Table lookup patterns
    if any(p in q for p in [
        "who writes to", "who reads from", "what sessions use table",
        "which sessions write", "which sessions read", "tell me about table",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.TABLE_LOOKUP,
            entities=entities,
            doc_types=["table", "session"],
            augment_with=["writers", "readers"],
        )

    # Lineage patterns
    if any(p in q for p in [
        "where does", "data come from", "data flow", "lineage",
        "trace", "path from", "path to", "how does data get",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.LINEAGE_TRACE,
            entities=entities,
            doc_types=["chain", "table", "session"],
            augment_with=["full_lineage_path"],
        )

    # Impact analysis
    if any(p in q for p in [
        "what happens if", "what breaks", "impact", "blast radius",
        "cascade", "downstream effect", "what depends on",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.IMPACT_ANALYSIS,
            entities=entities,
            doc_types=["session", "chain"],
            augment_with=["downstream_cascade"],
        )

    # Complexity
    if any(p in q for p in [
        "most complex", "hardest", "highest complexity", "very complex",
        "complexity score", "how complex",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.COMPLEXITY_QUERY,
            entities=entities,
            doc_types=["session", "environment"],
            augment_with=["complexity_ranking"],
        )

    # Wave queries
    if any(p in q for p in ["wave", "migration wave", "which wave", "wave plan"]):
        return ClassifiedQuery(
            intent=QueryIntent.WAVE_QUERY,
            entities=entities,
            doc_types=["session", "group", "environment"],
            augment_with=["wave_members"],
        )

    # Comparison
    if any(p in q for p in ["compare", "versus", "vs", "difference between"]):
        return ClassifiedQuery(
            intent=QueryIntent.COMPARISON,
            entities=entities,
            doc_types=["session"],
            augment_with=[],
        )

    # Environment-level questions
    if any(p in q for p in [
        "how many", "total", "overview", "summary", "environment",
        "all sessions", "entire", "whole",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.ENVIRONMENT,
            entities=entities,
            doc_types=["environment", "group"],
            augment_with=[],
        )

    # Default: search everything
    return ClassifiedQuery(
        intent=QueryIntent.GENERAL,
        entities=entities,
        doc_types=[],
        augment_with=[],
    )


# ── Hybrid Search ─────────────────────────────────────────────────────────

def _find_session_by_name(name: str, tier_data: dict) -> dict | None:
    """Find a session by partial name match."""
    name_upper = name.upper()
    for s in tier_data.get("sessions", []):
        full = (s.get("full") or "").upper()
        short = (s.get("name") or "").upper()
        if name_upper in full or name_upper in short or full == name_upper:
            return s
    return None


def _find_table_by_name(name: str, tier_data: dict) -> dict | None:
    """Find a table by name."""
    name_upper = name.upper()
    for t in tier_data.get("tables", []):
        if (t.get("name") or "").upper() == name_upper:
            return t
    return None


def _deduplicate_results(results: list[dict]) -> list[dict]:
    """Remove duplicate results by ID."""
    seen = set()
    deduped = []
    for r in results:
        rid = r["id"]
        if rid not in seen:
            seen.add(rid)
            deduped.append(r)
    return deduped


class HybridSearchEngine:
    """Combines vector similarity search with structured database queries."""

    def __init__(self, vector_store: VectorStore, embedding_engine: EmbeddingEngine):
        self.vector_store = vector_store
        self.embedding_engine = embedding_engine

    def search(
        self,
        upload_id: int,
        question: str,
        tier_data: dict,
        classification: ClassifiedQuery,
    ) -> list[dict]:
        """Hybrid search: vector similarity + structured lookups."""
        results = []

        # Vector search
        query_embedding = self.embedding_engine.embed_single(question)

        if classification.doc_types:
            for doc_type in classification.doc_types:
                hits = self.vector_store.search(
                    upload_id, query_embedding, n_results=5, doc_type=doc_type,
                )
                results.extend(hits)
        else:
            results = self.vector_store.search(
                upload_id, query_embedding, n_results=10,
            )

        # Structured augmentation for extracted entity names
        for entity in classification.entities:
            session = _find_session_by_name(entity, tier_data)
            if session:
                results.append({
                    "id": f"direct:session:{entity}",
                    "content": generate_session_document(session, tier_data, None),
                    "metadata": {"type": "session", "source": "direct_lookup"},
                    "distance": 0.0,
                })

            table = _find_table_by_name(entity, tier_data)
            if table:
                results.append({
                    "id": f"direct:table:{entity}",
                    "content": generate_table_document(table, tier_data),
                    "metadata": {"type": "table", "source": "direct_lookup"},
                    "distance": 0.0,
                })

        results = _deduplicate_results(results)
        results.sort(key=lambda r: r["distance"])

        return results[:15]


# ── RAG Chat Engine ───────────────────────────────────────────────────────

class RAGChatEngine:
    """Full RAG pipeline: question -> search -> prompt -> LLM -> response."""

    SYSTEM_PROMPT = """You are an expert ETL migration analyst embedded in the ETL Dependency Visualizer tool. You help users understand their Informatica PowerCenter and NiFi data flows.

You have access to detailed parsed data about the user's ETL environment. When answering questions:

1. ALWAYS ground your answers in the retrieved context documents. Never fabricate session names, table names, or statistics.
2. Include specific numbers: complexity scores, transform counts, tier levels, wave assignments.
3. When mentioning sessions or tables, use their full names so the user can find them in the visualization.
4. If the context doesn't contain enough information to answer, say so clearly.
5. When relevant, suggest what the user should look at next in the tool.
6. Flag risks: write conflicts, high blast radius, circular dependencies, very complex sessions.
7. For migration questions, reference wave assignments and estimated hours.
8. Use markdown formatting for readability."""

    def __init__(
        self,
        search_engine: HybridSearchEngine,
        llm_provider: str = "anthropic",
        api_key: str | None = None,
        model: str | None = None,
    ):
        self.search_engine = search_engine
        self.llm_provider = llm_provider
        self.api_key = api_key
        self.model = model or "claude-sonnet-4-20250514"

    async def chat(
        self,
        upload_id: int,
        question: str,
        tier_data: dict,
        conversation_history: list[dict] | None = None,
    ) -> dict:
        """Full RAG chat: question -> search -> LLM -> structured response."""
        # Step 1: Classify the question
        classification = classify_query(question)
        logger.info("Query classified: intent=%s entities=%s", classification.intent.value, classification.entities)

        # Step 2: Hybrid search
        search_results = self.search_engine.search(
            upload_id, question, tier_data, classification,
        )

        # Step 3: Build context block
        context = self._build_context(search_results)

        # Step 4: Build messages
        messages = []
        if conversation_history:
            messages.extend(conversation_history[-10:])

        messages.append({
            "role": "user",
            "content": f"""Based on the following ETL pipeline data, answer this question:

<retrieved_context>
{context}
</retrieved_context>

Question: {question}""",
        })

        # Step 5: Call LLM
        response_text = await self._call_llm(messages)

        # Step 6: Extract referenced entities
        referenced = self._extract_references(response_text, search_results, tier_data)

        return {
            "answer": response_text,
            "intent": classification.intent.value,
            "referenced_sessions": referenced.get("sessions", []),
            "referenced_tables": referenced.get("tables", []),
            "search_results_used": len(search_results),
            "suggested_questions": self._generate_suggestions(classification, search_results),
        }

    def _build_context(self, results: list[dict]) -> str:
        """Assemble retrieved documents into a context block for the LLM."""
        sections = []
        for i, result in enumerate(results):
            doc_type = result.get("metadata", {}).get("type", "unknown")
            sections.append(
                f"--- Document {i+1} ({doc_type}) ---\n{result['content']}"
            )
        return "\n\n".join(sections)

    async def _call_llm(self, messages: list[dict]) -> str:
        """Call the LLM with assembled messages."""
        if not self.api_key:
            # No API key — return context-only response
            return (
                "LLM not configured. Set the EDV_LLM_API_KEY environment variable "
                "with your Anthropic API key. Raw search results are shown in the "
                "context panel to the right."
            )

        if self.llm_provider == "anthropic":
            try:
                import anthropic
                client = anthropic.AsyncAnthropic(api_key=self.api_key)
                response = await client.messages.create(
                    model=self.model,
                    max_tokens=2048,
                    system=self.SYSTEM_PROMPT,
                    messages=messages,
                )
                return response.content[0].text
            except Exception as exc:
                logger.error("LLM call failed: %s", exc)
                return f"LLM call failed: {exc}. Check your API key and model settings."

        elif self.llm_provider == "openai":
            try:
                import openai
                client = openai.AsyncOpenAI(api_key=self.api_key)
                response = await client.chat.completions.create(
                    model=self.model,
                    messages=[{"role": "system", "content": self.SYSTEM_PROMPT}] + messages,
                    max_tokens=2048,
                )
                return response.choices[0].message.content or ""
            except Exception as exc:
                logger.error("LLM call failed: %s", exc)
                return f"LLM call failed: {exc}."

        return "Unsupported LLM provider."

    def _extract_references(
        self, response: str, results: list[dict], tier_data: dict,
    ) -> dict:
        """Extract session/table names from response for the context sidebar."""
        sessions = []
        tables = []

        for session in tier_data.get("sessions", []):
            full = session.get("full", "")
            name = session.get("name", "")
            if full and (full in response or name in response):
                sessions.append({
                    "name": full,
                    "short_name": name,
                    "tier": session.get("tier", 0),
                    "complexity": session.get("complexity_score"),
                })

        for table in tier_data.get("tables", []):
            tname = table.get("name", "")
            if tname and tname in response:
                tables.append({
                    "name": tname,
                    "type": table.get("type", ""),
                })

        return {"sessions": sessions[:10], "tables": tables[:10]}

    def _generate_suggestions(
        self, classification: ClassifiedQuery, results: list[dict],
    ) -> list[str]:
        """Generate follow-up question suggestions based on the current query."""
        suggestions: list[str] = []

        if classification.intent == QueryIntent.SESSION_LOOKUP:
            suggestions = [
                "What are the upstream dependencies?",
                "Show me the complexity breakdown",
                "What tables does this session write to?",
                "What happens if this session fails?",
            ]
        elif classification.intent == QueryIntent.TABLE_LOOKUP:
            suggestions = [
                "Where does this table's data come from?",
                "What downstream tables depend on this?",
                "Are there any write conflicts?",
                "Show me the full lineage for this table",
            ]
        elif classification.intent == QueryIntent.LINEAGE_TRACE:
            suggestions = [
                "What's the critical path in this lineage?",
                "Which sessions in this chain are most complex?",
                "What's the total migration effort for this chain?",
            ]
        elif classification.intent == QueryIntent.IMPACT_ANALYSIS:
            suggestions = [
                "What sessions have the highest blast radius?",
                "Show me the write conflicts in this area",
                "Which wave should this be migrated in?",
            ]
        elif classification.intent == QueryIntent.COMPLEXITY_QUERY:
            suggestions = [
                "What makes this session so complex?",
                "Which sessions are in the same community?",
                "What wave are the complex sessions in?",
            ]
        elif classification.intent == QueryIntent.ENVIRONMENT:
            suggestions = [
                "What are the most complex sessions?",
                "Which tables have write conflicts?",
                "Show me the wave plan summary",
                "What's the critical path?",
            ]
        else:
            suggestions = [
                "What are the most complex sessions?",
                "Which tables have write conflicts?",
                "How many sessions are in each wave?",
            ]

        return suggestions[:4]
