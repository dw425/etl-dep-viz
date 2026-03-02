"""Document Generator — converts parsed ETL data into structured text documents for vector embedding.

Produces 5 document types at different granularity levels:
  1. Session Profile    — one per session: deps, transforms, complexity, wave, community.
                          Enriched with V11 (complexity), V4 (wave), V1 (community),
                          V10 (gravity), V3 (criticality) when vector_results available.
  2. Table Profile      — one per table: readers, writers, lookups, upstream/downstream lineage.
                          Flags write conflicts when multiple sessions write to same table.
  3. Dependency Chain   — one per significant chain (>=3 sessions), traced via DFS from
                          DAG entry points. Top 200 longest paths kept.
  4. Group Summary      — one per V10 gravity group: shared tables, avg complexity,
                          tier range, migration-together recommendation.
  5. Environment Summary — one global overview: stats, complexity distribution, wave plan,
                          community structure, database platform counts, top 10 complex sessions.

Documents are consumed by the IndexingPipeline, which embeds them into ChromaDB for
semantic search via the RAGChatEngine. Each document has a stable id (e.g.,
"session:{sid}", "table:{name}") so re-indexing replaces previous docs cleanly.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Any

logger = logging.getLogger("edv.docgen")


# ── Helper functions ──────────────────────────────────────────────────────

def _find_session(session_id: str, tier_data: dict) -> dict | None:
    """Find a session by its full ID."""
    for s in tier_data.get("sessions", []):
        if s.get("full") == session_id or s.get("id") == session_id:
            return s
    return None


def _get_upstream_sessions(session_id: str, tier_data: dict) -> list[str]:
    """Get sessions that this session depends on (upstream)."""
    upstream = []
    for conn in tier_data.get("connections", []):
        if conn.get("to") == session_id and conn.get("type") in ("dep", "dependency", None):
            upstream.append(conn["from"])
    return upstream


def _get_downstream_sessions(session_id: str, tier_data: dict) -> list[str]:
    """Get sessions that depend on this session (downstream)."""
    downstream = []
    for conn in tier_data.get("connections", []):
        if conn.get("from") == session_id and conn.get("type") in ("dep", "dependency", None):
            downstream.append(conn["to"])
    return downstream


def _get_write_conflicts(session_id: str, tier_data: dict) -> list[dict]:
    """Find write conflicts involving this session.

    A write conflict occurs when two or more sessions target the same table,
    which can cause race conditions or data overwrites at runtime.
    """
    conflicts = []
    session = _find_session(session_id, tier_data)
    if not session:
        return conflicts

    targets = set(session.get("targets", []))
    for other in tier_data.get("sessions", []):
        other_id = other.get("full") or other.get("id")
        if other_id == session_id:
            # Skip self-comparison
            continue
        other_targets = set(other.get("targets", []))
        # Intersection reveals tables written by both this session and 'other'
        shared = targets & other_targets
        for table in shared:
            # Group multiple co-writers under the same table entry
            existing = next((c for c in conflicts if c["table"] == table), None)
            if existing:
                existing["other_writers"].append(other_id)
            else:
                conflicts.append({"table": table, "other_writers": [other_id]})
    return conflicts


def _get_complexity(session_id: str, vectors: dict | None) -> dict | None:
    """Extract complexity data for a session from vector results."""
    if not vectors or "v11_complexity" not in vectors:
        return None
    for score in vectors["v11_complexity"].get("scores", []):
        if score.get("session_id") == session_id:
            return {
                "score": score.get("overall_score", 0),
                "bucket": score.get("bucket", "Unknown"),
                "hours_min": score.get("hours_min", 0),
                "hours_max": score.get("hours_max", 0),
                "top_drivers": score.get("top_drivers", []),
            }
    return None


def _get_wave(session_id: str, vectors: dict | None) -> int | None:
    """Get wave assignment for a session."""
    if not vectors or "v4_topological" not in vectors:
        return None
    for wave_data in vectors["v4_topological"].get("waves", []):
        if session_id in wave_data.get("sessions", []):
            return wave_data.get("wave")
    return None


def _get_community(session_id: str, vectors: dict | None) -> int | None:
    """Get community assignment from V1 results."""
    if not vectors or "v1_community" not in vectors:
        return None
    assignments = vectors["v1_community"].get("assignments", {})
    return assignments.get(session_id)


def _get_gravity(session_id: str, vectors: dict | None) -> int | None:
    """Get gravity group from V10 results."""
    if not vectors or "v10_concentration" not in vectors:
        return None
    for group in vectors["v10_concentration"].get("groups", []):
        if session_id in group.get("members", []):
            return group.get("id")
    return None


def _get_criticality(session_id: str, vectors: dict | None) -> dict | None:
    """Get criticality data from V3 results."""
    if not vectors or "v3_criticality" not in vectors:
        return None
    for item in vectors["v3_criticality"].get("sessions", []):
        if item.get("session_id") == session_id:
            return {
                "tier": item.get("criticality_tier", 0),
                "blast_radius": item.get("blast_radius", 0),
                "is_amplifier": item.get("is_amplifier", False),
            }
    return None


def _get_writers(table_name: str, tier_data: dict) -> list[str]:
    """Sessions that write to this table."""
    writers = []
    for s in tier_data.get("sessions", []):
        sid = s.get("full") or s.get("id")
        if table_name in s.get("targets", []):
            writers.append(sid)
    return writers


def _get_readers(table_name: str, tier_data: dict) -> list[str]:
    """Sessions that read from this table."""
    readers = []
    for s in tier_data.get("sessions", []):
        sid = s.get("full") or s.get("id")
        if table_name in s.get("sources", []):
            readers.append(sid)
    return readers


def _get_lookup_users(table_name: str, tier_data: dict) -> list[str]:
    """Sessions that use this table as a lookup."""
    users = []
    for s in tier_data.get("sessions", []):
        sid = s.get("full") or s.get("id")
        if table_name in s.get("lookups", []):
            users.append(sid)
    return users


def _get_upstream_tables(table_name: str, tier_data: dict) -> list[str]:
    """Tables that feed data into this table (via sessions)."""
    upstream = set()
    writers = _get_writers(table_name, tier_data)
    for w in writers:
        session = _find_session(w, tier_data)
        if session:
            upstream.update(session.get("sources", []))
    return sorted(upstream)


def _get_downstream_tables(table_name: str, tier_data: dict) -> list[str]:
    """Tables that this table feeds into (via sessions)."""
    downstream = set()
    readers = _get_readers(table_name, tier_data)
    for r in readers:
        session = _find_session(r, tier_data)
        if session:
            downstream.update(session.get("targets", []))
    downstream.discard(table_name)
    return sorted(downstream)


def _extract_longest_chains(tier_data: dict, max_chains: int = 200) -> list[list[str]]:
    """Extract the longest dependency chains from the tier data.

    Builds a directed adjacency list from dependency connections, then runs DFS
    from every entry-point (node with no incoming edges) to collect all paths.
    Only paths of 3+ sessions are kept; the top `max_chains` by length are returned.
    """
    adj: dict[str, list[str]] = defaultdict(list)
    all_ids = set()
    has_incoming = set()

    # Build adjacency list; track which nodes have at least one parent
    for conn in tier_data.get("connections", []):
        if conn.get("type") in ("dep", "dependency", None):
            from_id = conn["from"]
            to_id = conn["to"]
            adj[from_id].append(to_id)
            all_ids.add(from_id)
            all_ids.add(to_id)
            has_incoming.add(to_id)

    # Entry points are nodes with no incoming edges (DAG roots)
    entry_points = all_ids - has_incoming
    if not entry_points:
        # Fallback for cyclic graphs: start from every node
        entry_points = all_ids

    chains: list[list[str]] = []

    def dfs(node: str, path: list[str]) -> None:
        # Hard cap to avoid exponential blowup on dense subgraphs
        if len(path) > 50:
            return
        nexts = adj.get(node, [])
        if not nexts:
            # Leaf node reached — record chain if long enough to be meaningful
            if len(path) >= 3:
                chains.append(path[:])
            return
        for nxt in nexts:
            # Guard against cycles — skip already-visited nodes
            if nxt not in path:
                path.append(nxt)
                dfs(nxt, path)
                path.pop()  # backtrack

    # Limit starting nodes to keep runtime bounded on very large graphs
    for start in sorted(entry_points)[:100]:
        dfs(start, [start])

    # Return the longest chains first, up to the requested cap
    chains.sort(key=len, reverse=True)
    return chains[:max_chains]


def _get_tier(session_id: str, tier_data: dict) -> int:
    """Get tier for a session."""
    s = _find_session(session_id, tier_data)
    return s.get("tier", 0) if s else 0


def _common_tables(members: list[str], field: str, tier_data: dict) -> list[str]:
    """Find tables common to all members by intersecting their source/target sets.

    `field` is either "sources" or "targets". Only inspects the first 20 members
    to keep runtime bounded for large groups.
    """
    if not members:
        return []
    table_sets = []
    for mid in members[:20]:  # Cap to avoid O(n) cost on very large groups
        s = _find_session(mid, tier_data)
        if s:
            table_sets.append(set(s.get(field, [])))
    if not table_sets:
        return []
    # Rolling intersection — start from the first set and narrow down
    common = table_sets[0]
    for ts in table_sets[1:]:
        common &= ts
    return sorted(common)


def _avg_complexity(members: list[str], vectors: dict | None) -> float:
    """Average complexity score across members."""
    if not vectors or "v11_complexity" not in vectors:
        return 0.0
    scores = []
    for m in members:
        c = _get_complexity(m, vectors)
        if c:
            scores.append(c["score"])
    return sum(scores) / len(scores) if scores else 0.0


# ── Document generation functions ─────────────────────────────────────────

def generate_session_document(session: dict, tier_data: dict, vectors: dict | None) -> str:
    """Generate a rich natural-language document for one session."""
    sid = session.get("full") or session.get("id", "")
    short = session.get("name", sid)
    tier = session.get("tier", 0)
    sources = session.get("sources", [])
    targets = session.get("targets", [])
    lookups = session.get("lookups", [])
    transforms = session.get("transforms", 0)
    lookup_count = session.get("lookupCount", 0)
    critical = session.get("critical", False)

    upstream = _get_upstream_sessions(sid, tier_data)
    downstream = _get_downstream_sessions(sid, tier_data)
    write_conflicts = _get_write_conflicts(sid, tier_data)

    complexity = _get_complexity(sid, vectors)
    wave = _get_wave(sid, vectors)
    community = _get_community(sid, vectors)
    gravity = _get_gravity(sid, vectors)
    criticality = _get_criticality(sid, vectors)

    doc = f"""SESSION: {sid}
Short Name: {short}
Type: ETL Session

STRUCTURE:
- Tier: {tier} (dependency depth in the execution order)
- Transform count: {transforms}
- Lookup count: {lookup_count}
- Source tables ({len(sources)}): {', '.join(sources[:20]) if sources else 'none'}
- Target tables ({len(targets)}): {', '.join(targets[:20]) if targets else 'none'}
- Lookup tables ({len(lookups)}): {', '.join(lookups[:20]) if lookups else 'none'}
- Is critical path: {'Yes' if critical else 'No'}

DEPENDENCIES:
- Upstream sessions ({len(upstream)}): {', '.join(upstream[:20]) if upstream else 'none - this is an entry-point session'}
- Downstream sessions ({len(downstream)}): {', '.join(downstream[:20]) if downstream else 'none - this is a terminal session'}
- Fan-in: {len(upstream)} (number of sessions that must complete before this one)
- Fan-out: {len(downstream)} (number of sessions that depend on this one)
"""

    if write_conflicts:
        doc += "\nWRITE CONFLICTS:\nThis session shares write targets with other sessions:\n"
        for c in write_conflicts[:10]:
            doc += f"- Table {c['table']}: also written by {', '.join(c['other_writers'][:5])}\n"

    if complexity:
        doc += f"""
COMPLEXITY ANALYSIS:
- Overall score: {complexity['score']:.1f} / 100
- Bucket: {complexity['bucket']}
- Estimated migration hours: {complexity['hours_min']:.0f} - {complexity['hours_max']:.0f}
- Top complexity drivers: {', '.join(str(d) for d in complexity.get('top_drivers', [])[:5])}
"""

    if wave is not None:
        doc += f"\nWAVE ASSIGNMENT:\n- Migration wave: {wave}\n"

    if community is not None:
        doc += f"COMMUNITY: Belongs to community cluster {community}.\n"

    if gravity is not None:
        doc += f"GRAVITY GROUP: Assigned to gravity group {gravity}.\n"

    if criticality:
        doc += f"""
CRITICALITY:
- Criticality tier: {criticality['tier']}
- Blast radius: {criticality['blast_radius']}
- Is amplifier: {'Yes - failure here cascades widely' if criticality.get('is_amplifier') else 'No'}
"""
    return doc


def generate_table_document(table: dict, tier_data: dict) -> str:
    """Generate a document for a single table."""
    name = table.get("name", "")
    ttype = table.get("type", "unknown")
    tier = table.get("tier", 0)

    writers = _get_writers(name, tier_data)
    readers = _get_readers(name, tier_data)
    lookup_users = _get_lookup_users(name, tier_data)

    doc = f"""TABLE: {name}
Type: {ttype}
Tier: {tier}

WRITERS ({len(writers)}): {', '.join(writers[:20]) if writers else 'none - this is a source-only table'}
READERS ({len(readers)}): {', '.join(readers[:20]) if readers else 'none - this is a terminal target'}
LOOKUP USERS ({len(lookup_users)}): {', '.join(lookup_users[:20]) if lookup_users else 'none'}
"""
    if len(writers) > 1:
        doc += f"\nWRITE CONFLICT: Multiple sessions write to this table: {', '.join(writers)}\n"

    upstream = _get_upstream_tables(name, tier_data)
    downstream = _get_downstream_tables(name, tier_data)
    doc += f"""
LINEAGE:
- Data flows INTO this table from: {', '.join(upstream[:20]) or 'external sources'}
- Data flows OUT of this table to: {', '.join(downstream[:20]) or 'no downstream tables'}
"""
    return doc


def generate_chain_document(chain: list[str], tier_data: dict) -> str:
    """Document a dependency chain for lineage queries."""
    steps = []
    for i, sid in enumerate(chain):
        session = _find_session(sid, tier_data)
        if session:
            sources = session.get("sources", [])
            targets = session.get("targets", [])
            steps.append(f"  Step {i+1}: {sid} - reads {', '.join(sources[:5])}, writes {', '.join(targets[:5])}")
        else:
            steps.append(f"  Step {i+1}: {sid}")

    doc = f"""DEPENDENCY CHAIN ({len(chain)} sessions):
Path: {' -> '.join(chain)}

Steps:
{chr(10).join(steps)}

This chain represents a complete data flow spanning {len(chain)} processing steps.
Tier range: {_get_tier(chain[0], tier_data)} -> {_get_tier(chain[-1], tier_data)}
"""
    return doc


def generate_group_document(
    group_id: int, members: list[str], tier_data: dict, vectors: dict | None,
) -> str:
    """Summarize a group of related sessions."""
    common_src = _common_tables(members, "sources", tier_data)
    common_tgt = _common_tables(members, "targets", tier_data)
    avg_cx = _avg_complexity(members, vectors)

    tiers = []
    for m in members[:50]:
        s = _find_session(m, tier_data)
        if s:
            tiers.append(s.get("tier", 0))

    doc = f"""SESSION GROUP: Group {group_id}
Member count: {len(members)}
Members: {', '.join(members[:50])}

SHARED CHARACTERISTICS:
- Common source tables: {', '.join(common_src[:10]) or 'none shared'}
- Common target tables: {', '.join(common_tgt[:10]) or 'none shared'}
- Average complexity: {avg_cx:.1f}
- Tier range: {min(tiers) if tiers else 0} - {max(tiers) if tiers else 0}

MIGRATION RECOMMENDATION:
These {len(members)} sessions are tightly coupled and should be migrated together as a unit.
"""
    return doc


def generate_environment_document(tier_data: dict, vectors: dict | None) -> str:
    """Global environment summary for high-level questions.

    This is always a single document (id="environment:summary") per upload.
    It aggregates stats, complexity distribution from V11, and the wave plan
    from V4 so the RAG system can answer overview-level questions without
    scanning every session document.
    """
    stats = tier_data.get("stats", {})

    # Build bucket histogram from V11 complexity scores (e.g., Low/Medium/High/Critical)
    complexity_dist = ""
    if vectors and "v11_complexity" in vectors:
        buckets: dict[str, int] = defaultdict(int)
        for score in vectors["v11_complexity"].get("scores", []):
            buckets[score.get("bucket", "Unknown")] += 1
        complexity_dist = "\n".join(
            f"  {bucket}: {count}" for bucket, count in sorted(buckets.items())
        )

    # Summarise V4 topological wave plan — each wave is a migration execution batch
    wave_summary = ""
    if vectors and "v4_topological" in vectors:
        for wave_data in vectors["v4_topological"].get("waves", []):
            wave_num = wave_data.get("wave", "?")
            count = len(wave_data.get("sessions", []))
            wave_summary += f"  Wave {wave_num}: {count} sessions\n"

    # Top 10 most complex sessions (descending overall_score) for quick triage
    top_complex = ""
    if vectors and "v11_complexity" in vectors:
        scores = sorted(
            vectors["v11_complexity"].get("scores", []),
            key=lambda s: s.get("overall_score", 0),
            reverse=True,
        )[:10]
        for s in scores:
            top_complex += f"  {s.get('session_id', '?')}: {s.get('overall_score', 0):.1f} ({s.get('bucket', '?')})\n"

    # Connection profiles from Informatica DBCONNECTION elements
    conn_profiles = ""
    profiles = tier_data.get("connection_profiles", [])
    if profiles:
        platform_counts: dict[str, int] = defaultdict(int)
        for p in profiles:
            platform_counts[p.get("dbtype", "Unknown")] += 1
        conn_profiles = "\n".join(
            f"  {dbtype}: {count} connections" for dbtype, count in sorted(platform_counts.items())
        )

    # Community summary from V1
    community_summary = ""
    if vectors and "v1_community" in vectors:
        assignments = vectors["v1_community"].get("assignments", {})
        community_counts: dict[int, int] = defaultdict(int)
        for c in assignments.values():
            community_counts[c] += 1
        if community_counts:
            community_summary = f"  {len(community_counts)} communities detected\n"
            for cid, count in sorted(community_counts.items(), key=lambda x: -x[1])[:10]:
                community_summary += f"  Community {cid}: {count} sessions\n"

    doc = f"""ENVIRONMENT SUMMARY
Total sessions: {stats.get('session_count', 0)}
Total tables: {len(tier_data.get('tables', []))}
Total connections: {len(tier_data.get('connections', []))}
Write conflicts: {stats.get('write_conflicts', 0)}
Dependency chains: {stats.get('dep_chains', 0)}
Staleness risks: {stats.get('staleness_risks', 0)}
Maximum tier depth: {stats.get('max_tier', 0)}
Source-only tables: {stats.get('source_tables', 0)}

DATABASE PLATFORMS:
{conn_profiles or '  No connection profiles detected'}

COMPLEXITY DISTRIBUTION:
{complexity_dist or '  Not yet analyzed'}

WAVE PLAN:
{wave_summary or '  Not yet analyzed'}

TOP MOST COMPLEX SESSIONS:
{top_complex or '  Not yet analyzed'}

COMMUNITY STRUCTURE:
{community_summary or '  Not yet analyzed'}
"""
    return doc


# ── Main generator class ──────────────────────────────────────────────────

class DocumentGenerator:
    """Generate structured text documents from parsed ETL data for vector embedding.

    Called automatically after parsing completes.
    Produces documents at 5 granularity levels.
    """

    def __init__(self, tier_data: dict, vector_results: dict | None = None):
        self.tier_data = tier_data
        self.vectors = vector_results
        self.documents: list[dict] = []

    def generate_all(self) -> list[dict]:
        """Generate all document types. Returns list of {id, type, content, metadata}.

        Each document dict has a stable `id` (prefixed by type) used as the
        ChromaDB primary key, allowing a full re-index to replace previous docs.
        """
        t0 = time.monotonic()

        # ── Type 1: Session profiles (one per session) ──────────────────────
        for session in self.tier_data.get("sessions", []):
            sid = session.get("full") or session.get("id", "")
            doc = generate_session_document(session, self.tier_data, self.vectors)
            self.documents.append({
                "id": f"session:{sid}",
                "type": "session",
                "content": doc,
                # Metadata fields are stored in ChromaDB for post-retrieval filtering
                "metadata": {
                    "session_id": sid,
                    "session_name": session.get("name", ""),
                    "tier": session.get("tier", 0),
                    "transforms": session.get("transforms", 0),
                    "lookup_count": session.get("lookupCount", 0),
                    "critical": session.get("critical", False),
                },
            })

        # ── Type 2: Table profiles (one per table) ───────────────────────────
        for table in self.tier_data.get("tables", []):
            name = table.get("name", "")
            doc = generate_table_document(table, self.tier_data)
            self.documents.append({
                "id": f"table:{name}",
                "type": "table",
                "content": doc,
                "metadata": {
                    "table_name": name,
                    "table_type": table.get("type", ""),
                    "tier": table.get("tier", 0),
                },
            })

        # ── Type 3: Dependency chains (top 200 longest paths) ───────────────
        chains = _extract_longest_chains(self.tier_data, max_chains=200)
        for i, chain in enumerate(chains):
            doc = generate_chain_document(chain, self.tier_data)
            self.documents.append({
                "id": f"chain:{i}",
                "type": "chain",
                "content": doc,
                "metadata": {
                    "chain_length": len(chain),
                    "start_session": chain[0],
                    "end_session": chain[-1],
                },
            })

        # ── Type 4: Group summaries (sourced from V10 gravity groups) ────────
        # V10 groups are preferred over V1 communities for group docs because
        # they capture spatial/gravity clustering rather than graph topology alone.
        if self.vectors and "v10_concentration" in self.vectors:
            for group in self.vectors["v10_concentration"].get("groups", []):
                doc = generate_group_document(
                    group["id"], group["members"], self.tier_data, self.vectors,
                )
                self.documents.append({
                    "id": f"group:{group['id']}",
                    "type": "group",
                    "content": doc,
                    "metadata": {
                        "group_id": group["id"],
                        "member_count": len(group["members"]),
                    },
                })

        # ── Type 5: Environment summary (always exactly 1 document) ─────────
        env_doc = generate_environment_document(self.tier_data, self.vectors)
        self.documents.append({
            "id": "environment:summary",
            "type": "environment",
            "content": env_doc,
            "metadata": {"type": "environment_summary"},
        })

        elapsed = time.monotonic() - t0
        logger.info(
            "Document generation complete: %d documents in %.2fs "
            "(sessions=%d, tables=%d, chains=%d, groups=%d)",
            len(self.documents), elapsed,
            sum(1 for d in self.documents if d["type"] == "session"),
            sum(1 for d in self.documents if d["type"] == "table"),
            sum(1 for d in self.documents if d["type"] == "chain"),
            sum(1 for d in self.documents if d["type"] == "group"),
        )

        return self.documents
