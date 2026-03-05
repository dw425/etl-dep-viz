"""RAG Query Engine — query classification, hybrid search, and LLM-powered chat.

Pipeline for each user question (RAGChatEngine.chat):
  1. classify_query       — keyword-based intent detection + entity extraction.
                            10 intents (session_lookup, table_lookup, lineage_trace,
                            impact_analysis, complexity_query, wave_query, group_query,
                            comparison, environment, general). First pattern match wins.
  2. HybridSearchEngine   — dual retrieval: vector similarity (ChromaDB) + direct
                            entity name lookup in tier_data. Per-type search (5 hits
                            per doc_type) ensures no single type dominates context.
  3. _build_context       — format top-N retrieved docs into numbered XML blocks.
  4. _call_llm            — send system prompt + context + history to Anthropic/OpenAI.
                            Max 2048 tokens output, last 10 conversation turns retained.
  5. _extract_references  — scan response text for session/table names (sidebar links).
  6. _generate_suggestions — intent-specific follow-up question prompts for the UI.

Intent classification uses deterministic keyword matching (no ML) so it
remains fast and predictable regardless of embedding availability.
Entities are extracted as uppercase identifiers (4+ chars) from the raw question.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
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
    """Enumerated intents used to steer document-type selection during retrieval.

    The intent determines which ChromaDB document types are searched and which
    structured augmentations are fetched (upstream/downstream sessions, lineage, etc.).
    """
    SESSION_LOOKUP = "session_lookup"       # Ask about a specific session
    TABLE_LOOKUP = "table_lookup"           # Ask about a specific table's readers/writers
    LINEAGE_TRACE = "lineage_trace"         # Trace data flow from source to destination
    IMPACT_ANALYSIS = "impact_analysis"     # What breaks if X fails?
    COMPLEXITY_QUERY = "complexity_query"   # Complexity scores and migration effort
    WAVE_QUERY = "wave_query"              # Migration wave planning questions
    GROUP_QUERY = "group_query"            # Community/gravity group questions
    COMPARISON = "comparison"              # Compare two sessions or tables
    ENVIRONMENT = "environment"            # Overview/count/summary questions
    CONFLICT_ANALYSIS = "conflict_analysis" # Write conflict / race condition analysis
    RISK_QUERY = "risk_query"              # Cascade risk / failure impact assessment
    LOOKUP_ANALYSIS = "lookup_analysis"    # Lookup table usage and optimization
    MIGRATION_QUERY = "migration_query"    # Migration effort, timeline, recommendations
    PATTERN_QUERY = "pattern_query"        # ETL patterns, anti-patterns, best practices
    TIER_QUERY = "tier_query"              # Tier-specific questions (dependency depth)
    GENERAL = "general"                    # Fallback — search all document types


@dataclass
class ClassifiedQuery:
    """Result of classify_query, carrying all retrieval strategy parameters.

    Attributes:
        intent: Detected user intent (drives doc_types selection).
        entities: Uppercase identifiers extracted from the question (session/table names).
        doc_types: ChromaDB document types to search; empty means search all types.
        structured_filter: Reserved for future metadata-level filtering in ChromaDB.
        augment_with: Labels for structured lookups to run alongside vector search
                      (e.g., "upstream_sessions", "full_lineage_path").
    """
    intent: QueryIntent
    entities: list[str] = field(default_factory=list)
    doc_types: list[str] = field(default_factory=list)
    structured_filter: dict = field(default_factory=dict)
    augment_with: list[str] = field(default_factory=list)


def classify_query(question: str) -> ClassifiedQuery:
    """Classify user question into an intent + entity list to guide retrieval.

    Classification uses deterministic keyword matching on the lowercased question
    so there is no dependency on an LLM or additional model at this step.
    Patterns are evaluated in priority order; the first match wins.
    """
    q = question.lower()

    # Capture uppercase identifiers (4+ chars) as probable session or table names.
    # Example: "SQ_CUSTOMER" or "STG_ORDERS" in "Tell me about SQ_CUSTOMER".
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

    # Write conflict / race condition analysis
    if any(p in q for p in [
        "write conflict", "race condition", "multiple writers", "shared target",
        "who else writes", "conflict", "concurrent write",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.CONFLICT_ANALYSIS,
            entities=entities,
            doc_types=["session", "table"],
            augment_with=["writers", "conflict_details"],
        )

    # Risk / cascade / failure propagation
    if any(p in q for p in [
        "risk", "failure", "criticality", "critical path", "amplifier",
        "propagat", "domino", "chain reaction",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.RISK_QUERY,
            entities=entities,
            doc_types=["session", "chain"],
            augment_with=["downstream_cascade"],
        )

    # Lookup table analysis
    if any(p in q for p in [
        "lookup", "cache", "lkp", "reference table", "dimension table",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.LOOKUP_ANALYSIS,
            entities=entities,
            doc_types=["session", "table"],
            augment_with=["lookup_details"],
        )

    # Migration effort / timeline / recommendations
    if any(p in q for p in [
        "migrat", "effort", "timeline", "how long", "estimate",
        "priorit", "recommend", "should we start",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.MIGRATION_QUERY,
            entities=entities,
            doc_types=["session", "group", "environment"],
            augment_with=["complexity_ranking", "wave_members"],
        )

    # ETL patterns
    if any(p in q for p in [
        "pattern", "anti-pattern", "best practice", "common", "typical",
        "similar to", "sessions like",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.PATTERN_QUERY,
            entities=entities,
            doc_types=["session", "group"],
            augment_with=[],
        )

    # Tier-specific questions
    if any(p in q for p in [
        "tier ", "tier 1", "tier 2", "tier 3", "tier 4",
        "depth", "dependency level", "execution order",
    ]):
        return ClassifiedQuery(
            intent=QueryIntent.TIER_QUERY,
            entities=entities,
            doc_types=["session", "environment"],
            augment_with=[],
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

    # No pattern matched — fall back to unfiltered search across all document types
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
    """Combines vector similarity search with structured database queries.

    The "hybrid" approach has two phases per query:
      1. Vector search — embed the question and query ChromaDB by cosine similarity.
         When the classification specifies doc_types, each type is searched separately
         (5 results each) so no single type dominates the context window.
      2. Entity augmentation — for each uppercase identifier extracted by classify_query,
         attempt an exact name match against tier_data and inject those documents with
         distance=0.0 (highest priority) so they always appear in the context.
    """

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
        """Hybrid search: vector similarity + structured lookups.

        Returns up to 15 deduplicated results sorted by ascending distance.
        Direct entity matches (distance=0.0) always sort first.
        """
        results = []

        # Embed the full question text for semantic similarity matching
        query_embedding = self.embedding_engine.embed_single(question)

        if classification.doc_types:
            # Search each targeted type separately to ensure coverage across types
            for doc_type in classification.doc_types:
                hits = self.vector_store.search(
                    upload_id, query_embedding, n_results=5, doc_type=doc_type,
                )
                results.extend(hits)
        else:
            # GENERAL intent — unfiltered search returns a broader set
            results = self.vector_store.search(
                upload_id, query_embedding, n_results=10,
            )

        # Direct entity augmentation — bypass vector search for named entities
        # so that explicitly mentioned sessions/tables are always in context.
        for entity in classification.entities:
            session = _find_session_by_name(entity, tier_data)
            if session:
                results.append({
                    "id": f"direct:session:{entity}",
                    "content": generate_session_document(session, tier_data, None),
                    "metadata": {"type": "session", "source": "direct_lookup"},
                    "distance": 0.0,  # distance=0 ensures this sorts to the top
                })

            table = _find_table_by_name(entity, tier_data)
            if table:
                results.append({
                    "id": f"direct:table:{entity}",
                    "content": generate_table_document(table, tier_data),
                    "metadata": {"type": "table", "source": "direct_lookup"},
                    "distance": 0.0,
                })

        # Remove duplicate doc IDs, then rank by distance ascending
        results = _deduplicate_results(results)
        results.sort(key=lambda r: r["distance"])

        # Cap at 15 to keep the LLM context window manageable
        return results[:15]


# ── RAG Chat Engine ───────────────────────────────────────────────────────

class RAGChatEngine:
    """Full RAG pipeline: question -> search -> prompt -> LLM -> response."""

    SYSTEM_PROMPT = """You are an expert ETL migration analyst embedded in the Pipeline Analyzer tool. You help users understand their Informatica PowerCenter and NiFi data flows.

You have access to detailed parsed data about the user's ETL environment. When answering questions:

1. ALWAYS ground your answers in the retrieved context documents. Never fabricate session names, table names, or statistics.
2. Include specific numbers: complexity scores, transform counts, tier levels, wave assignments.
3. When mentioning sessions or tables, use their full names so the user can find them in the visualization.
4. If the context doesn't contain enough information to answer, say so clearly.
5. When relevant, suggest what the user should look at next in the tool.
6. Flag risks: write conflicts, high blast radius, circular dependencies, very complex sessions.
7. For migration questions, reference wave assignments and estimated hours.
8. Use markdown formatting for readability."""

    # LLM response cache: {query_hash: (response_text, expire_time)}
    _llm_cache: dict[str, tuple[str, float]] = {}
    _LLM_CACHE_TTL = 3600  # 1 hour

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

    @staticmethod
    def _cache_key(upload_id: int, question: str, context: str) -> str:
        """Generate a cache key from upload_id + question + context hash."""
        h = hashlib.sha256()
        h.update(str(upload_id).encode())
        h.update(question.lower().strip().encode())
        h.update(context[:2000].encode())  # first 2K chars of context for stability
        return h.hexdigest()[:32]

    async def chat(
        self,
        upload_id: int,
        question: str,
        tier_data: dict,
        conversation_history: list[dict] | None = None,
    ) -> dict:
        """Full RAG chat: question -> classify -> search -> LLM -> structured response.

        Returns a dict with the LLM answer, intent label, referenced entity lists
        (for the context sidebar), and follow-up question suggestions.
        """
        # ── Step 1: Intent classification ────────────────────────────────────
        classification = classify_query(question)
        logger.info("Query classified: intent=%s entities=%s", classification.intent.value, classification.entities)

        # ── Step 2: Hybrid vector + entity search ────────────────────────────
        search_results = await asyncio.to_thread(
            self.search_engine.search,
            upload_id, question, tier_data, classification,
        )

        # ── Step 3: Assemble retrieved documents into a single context block ─
        context = self._build_context(search_results)

        # ── Step 3.5: Check LLM response cache ──────────────────────────────
        cache_key = self._cache_key(upload_id, question, context)
        cached = self._llm_cache.get(cache_key)
        if cached and not conversation_history and cached[1] > time.monotonic():
            logger.info("LLM cache hit for upload %d question=%s", upload_id, question[:50])
            response_text = cached[0]
        else:
            # ── Step 4: Build message list for the LLM ───────────────────────
            messages = []
            if conversation_history:
                # Include only the last 10 turns to avoid exceeding the context window
                messages.extend(conversation_history[-10:])

            # Inject retrieved context as XML-tagged block within the user message
            messages.append({
                "role": "user",
                "content": f"""Based on the following ETL pipeline data, answer this question:

<retrieved_context>
{context}
</retrieved_context>

Question: {question}""",
            })

            # ── Step 5: LLM inference ────────────────────────────────────────
            response_text = await self._call_llm(messages)

            # Cache the response (only for non-conversation queries)
            if not conversation_history:
                self._llm_cache[cache_key] = (response_text, time.monotonic() + self._LLM_CACHE_TTL)
                # Evict expired entries periodically
                if len(self._llm_cache) > 100:
                    now = time.monotonic()
                    expired = [k for k, v in self._llm_cache.items() if v[1] < now]
                    for k in expired:
                        del self._llm_cache[k]

        # ── Step 6: Post-process — find entity names mentioned in the response ─
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
        """Assemble retrieved documents into a numbered context block for the LLM.

        Each document is separated by a typed header so the LLM can attribute
        answers to specific documents if needed.
        """
        sections = []
        for i, result in enumerate(results):
            doc_type = result.get("metadata", {}).get("type", "unknown")
            sections.append(
                f"--- Document {i+1} ({doc_type}) ---\n{result['content']}"
            )
        return "\n\n".join(sections)

    async def _call_llm(self, messages: list[dict]) -> str:
        """Call the configured LLM provider with the assembled message list.

        Returns the raw response text, or a user-facing error string on failure.
        The system prompt is always injected but handled differently per provider:
          - Anthropic: system prompt is a top-level parameter (not a message)
          - OpenAI: system prompt is prepended as a {"role": "system"} message
        """
        if self.llm_provider == "databricks":
            try:
                from app.engines.databricks_llm import DatabricksLLM
                client = DatabricksLLM(model=self.model)
                return await client.generate(self.SYSTEM_PROMPT, messages)
            except Exception as exc:
                logger.error("Databricks LLM call failed: %s", exc)
                return f"Databricks LLM call failed: {exc}. Check your serving endpoint configuration."

        if not self.api_key:
            # Degrade gracefully: the frontend still shows raw search hits in the sidebar
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
                    system=self.SYSTEM_PROMPT,  # Anthropic uses top-level system param
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
                    # OpenAI requires system prompt as the first message in the list
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
        """Extract session/table names mentioned in the LLM response for the context sidebar.

        Performs a simple substring scan of the response against all known session
        and table names. Matches are surfaced in the frontend sidebar so the user
        can click through to the relevant node in the visualization. Results are
        capped at 10 each to keep the sidebar readable.
        """
        sessions = []
        tables = []

        # Scan all sessions — match on either full ID or short display name
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

        # Scan all tables — match on exact table name
        for table in tier_data.get("tables", []):
            tname = table.get("name", "")
            if tname and tname in response:
                tables.append({
                    "name": tname,
                    "type": table.get("type", ""),
                })

        # Cap to avoid sending oversized payloads to the frontend
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
        elif classification.intent == QueryIntent.CONFLICT_ANALYSIS:
            suggestions = [
                "Which tables have the most writers?",
                "How do we resolve this conflict?",
                "Show me the full lineage for this table",
                "What wave should conflicting sessions be in?",
            ]
        elif classification.intent == QueryIntent.RISK_QUERY:
            suggestions = [
                "What sessions have the highest blast radius?",
                "Which sessions are amplifiers?",
                "What's the criticality tier distribution?",
                "Show me sessions on the critical path",
            ]
        elif classification.intent == QueryIntent.LOOKUP_ANALYSIS:
            suggestions = [
                "Which lookups could benefit from caching?",
                "Show me sessions with the most lookups",
                "What tables are used as lookups?",
            ]
        elif classification.intent == QueryIntent.MIGRATION_QUERY:
            suggestions = [
                "What should we migrate first?",
                "Show me the wave plan",
                "What's the total estimated effort?",
                "Which sessions are best candidates for automation?",
            ]
        elif classification.intent == QueryIntent.PATTERN_QUERY:
            suggestions = [
                "What are the most common ETL patterns?",
                "Show me sessions with similar structure",
                "Which sessions use stored procedures?",
            ]
        elif classification.intent == QueryIntent.TIER_QUERY:
            suggestions = [
                "Show me all Tier 1 sessions",
                "What's the deepest dependency chain?",
                "How many sessions are in each tier?",
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
