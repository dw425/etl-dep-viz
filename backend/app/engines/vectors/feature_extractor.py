"""Shared feature extraction layer for all analysis vectors.

Bridges the tier_data dict format (sessions/tables/connections) into structured
SessionFeatures objects and dense numpy matrices consumed by V1-V11 engines.

Two main components:
  1. extract_session_features() — converts tier_data into list[SessionFeatures]
     by parsing connections to derive upstream/downstream counts, conflict counts,
     chain involvement, and staleness risk per session.

  2. FeatureMatrixBuilder — constructs three matrix types from SessionFeatures:
     - Dense matrix (n x 16): min-max normalized numeric features for ML
     - Adjacency matrix (n x n sparse): directed session-to-session edges with
       type-based weights (chain=1.0, read_after_write=0.8, etc.)
     - Similarity matrix (n x n dense): pairwise Jaccard/cosine/overlap on table
       sets, computed via vectorized binary matrix multiplication for O(n*t + n^2)
       performance instead of O(n^2 * t) Python loops.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None

try:
    from scipy import sparse
except ImportError:
    sparse = None


@dataclass
class SessionFeatures:
    """Feature profile for a single session/processor.

    Used by all vector engines as the canonical representation of a session.
    The __post_init__ method computes derived fields (total_table_footprint,
    unique_table_ratio) automatically from the table lists.
    """

    session_id: str
    name: str
    full_name: str
    tier: int | float

    # Table footprint
    source_tables: list[str] = field(default_factory=list)
    target_tables: list[str] = field(default_factory=list)
    lookup_tables: list[str] = field(default_factory=list)

    # Transform profile
    transform_count: int = 0
    ext_reads: int = 0
    lookup_count: int = 0

    # Structural metrics
    is_critical: bool = False
    upstream_count: int = 0
    downstream_count: int = 0

    # Dependency metrics
    dependency_depth: int = 0
    write_conflict_count: int = 0
    chain_involvement: int = 0
    staleness_risk: int = 0

    # Derived
    total_table_footprint: int = 0
    unique_table_ratio: float = 0.0
    workflow_name: str = ""

    # Phase 7 expansion — 16 additional features
    expression_count: int = 0
    parameter_count: int = 0
    sql_override_count: int = 0
    join_count: int = 0
    filter_count: int = 0
    router_group_count: int = 0
    lookup_cache_potential: int = 0
    field_count: int = 0
    connector_count: int = 0
    mapplet_usage: int = 0
    worklet_nesting_depth: int = 0
    schedule_frequency_code: int = 0
    command_task_count: int = 0
    stored_procedure_count: int = 0
    expression_complexity_score: float = 0.0
    pre_post_sql_count: int = 0

    def __post_init__(self):
        all_tables = set(self.source_tables) | set(self.target_tables) | set(self.lookup_tables)
        total = len(self.source_tables) + len(self.target_tables) + len(self.lookup_tables)
        self.total_table_footprint = len(all_tables)
        self.unique_table_ratio = len(all_tables) / max(total, 1)


class FeatureMatrixBuilder:
    """Build numpy arrays from SessionFeatures for ML algorithms.

    Provides three matrix construction methods used by different vectors:
    - build_dense_matrix()      -> V3, V7 (feature-based projection/clustering)
    - build_adjacency_matrix()  -> V1, V4, V9 (graph-based analysis)
    - build_similarity_matrix() -> V1, V2, V5, V6, V8, V10 (pairwise similarity)
    """

    # Feature columns for the dense matrix (order matters — index = column position)
    FEATURE_NAMES = [
        # Original 16
        "tier", "transform_count", "ext_reads", "lookup_count",
        "source_table_count", "target_table_count", "lookup_table_count",
        "total_table_footprint", "unique_table_ratio",
        "is_critical", "upstream_count", "downstream_count",
        "dependency_depth", "write_conflict_count", "chain_involvement",
        "staleness_risk",
        # Phase 7 expansion (16 more = 32 total)
        "expression_count", "parameter_count", "sql_override_count",
        "join_count", "filter_count", "router_group_count",
        "lookup_cache_potential", "field_count", "connector_count",
        "mapplet_usage", "worklet_nesting_depth", "schedule_frequency_code",
        "command_task_count", "stored_procedure_count",
        "expression_complexity_score", "pre_post_sql_count",
    ]

    def __init__(self, features: list[SessionFeatures]):
        self.features = features
        self.session_ids = [f.session_id for f in features]
        self._id_to_idx = {f.session_id: i for i, f in enumerate(features)}

    def build_dense_matrix(self):
        """Build min-max normalized feature matrix (n_sessions x 32 features).

        Each column is independently scaled to [0, 1]. Constant columns
        (where all sessions have the same value) remain at 0.
        """
        if np is None:
            raise ImportError("numpy is required for FeatureMatrixBuilder. Install it with: pip install numpy")
        n = len(self.features)
        m = len(self.FEATURE_NAMES)
        mat = np.zeros((n, m), dtype=np.float64)

        for i, f in enumerate(self.features):
            mat[i] = [
                # Original 16
                f.tier,
                f.transform_count,
                f.ext_reads,
                f.lookup_count,
                len(f.source_tables),
                len(f.target_tables),
                len(f.lookup_tables),
                f.total_table_footprint,
                f.unique_table_ratio,
                1.0 if f.is_critical else 0.0,
                f.upstream_count,
                f.downstream_count,
                f.dependency_depth,
                f.write_conflict_count,
                f.chain_involvement,
                f.staleness_risk,
                # Phase 7 expansion
                f.expression_count,
                f.parameter_count,
                f.sql_override_count,
                f.join_count,
                f.filter_count,
                f.router_group_count,
                f.lookup_cache_potential,
                f.field_count,
                f.connector_count,
                f.mapplet_usage,
                f.worklet_nesting_depth,
                f.schedule_frequency_code,
                f.command_task_count,
                f.stored_procedure_count,
                f.expression_complexity_score,
                f.pre_post_sql_count,
            ]

        # Min-max normalize each column
        for col in range(m):
            col_min = mat[:, col].min()
            col_max = mat[:, col].max()
            rng = col_max - col_min
            if rng > 0:
                mat[:, col] = (mat[:, col] - col_min) / rng

        return mat

    def build_adjacency_matrix(self, connections: list[dict]):
        """Build directed adjacency matrix from tier_data connections.

        Only session-to-session edges (S->S via chain, read_after_write).
        """
        if sparse is None:
            raise ImportError("scipy is required for build_adjacency_matrix. Install it with: pip install scipy")
        n = len(self.features)
        rows, cols, data = [], [], []
        weight_map = {
            "chain": 1.0,
            "read_after_write": 0.8,
            "write_conflict": 0.6,
            "lookup_stale": 0.3,
            "source_read": 0.5,
            "write_clean": 0.4,
        }

        for conn in connections:
            src = conn.get("from", "")
            dst = conn.get("to", "")
            ctype = conn.get("type", "chain")
            if src in self._id_to_idx and dst in self._id_to_idx:
                rows.append(self._id_to_idx[src])
                cols.append(self._id_to_idx[dst])
                data.append(weight_map.get(ctype, 0.5))

        if not rows:
            return sparse.csr_matrix((n, n))
        return sparse.csr_matrix((data, (rows, cols)), shape=(n, n))

    def build_similarity_matrix(self, metric: str = "jaccard"):
        """Build pairwise similarity matrix from table sets.

        Uses vectorized binary matrix multiplication for O(n*t + n²) performance
        instead of O(n² * t) Python loops. Critical for 10K+ sessions.

        Args:
            metric: 'jaccard', 'cosine', or 'overlap'
        """
        if np is None:
            raise ImportError("numpy is required for build_similarity_matrix. Install it with: pip install numpy")
        n = len(self.features)
        if n < 2:
            sim = np.eye(n, dtype=np.float64)
            return sim

        # Build binary session-table matrix (n_sessions × n_tables)
        all_tables: dict[str, int] = {}
        table_sets = []
        for f in self.features:
            ts = set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables)
            table_sets.append(ts)
            for t in ts:
                if t not in all_tables:
                    all_tables[t] = len(all_tables)

        t_count = len(all_tables)
        if t_count == 0:
            return np.eye(n, dtype=np.float64)

        # Sparse binary matrix: sessions × tables
        binary = np.zeros((n, t_count), dtype=np.float32)
        for i, ts in enumerate(table_sets):
            for t in ts:
                binary[i, all_tables[t]] = 1.0

        # Vectorized intersection: A @ A.T gives pairwise intersection counts
        intersection = binary @ binary.T  # (n, n) — count of shared tables

        # Set sizes per session
        sizes = binary.sum(axis=1)  # (n,)

        if metric == "jaccard":
            # union(i,j) = |A_i| + |A_j| - intersection(i,j)
            union = sizes[:, None] + sizes[None, :] - intersection
            sim = np.divide(intersection, union, out=np.zeros_like(intersection), where=union > 0)
        elif metric == "cosine":
            denom = np.sqrt(sizes[:, None]) * np.sqrt(sizes[None, :])
            sim = np.divide(intersection, denom, out=np.zeros_like(intersection), where=denom > 0)
        elif metric == "overlap":
            min_sizes = np.minimum(sizes[:, None], sizes[None, :])
            sim = np.divide(intersection, min_sizes, out=np.zeros_like(intersection), where=min_sizes > 0)
        else:
            sim = np.zeros((n, n), dtype=np.float64)

        np.fill_diagonal(sim, 1.0)
        return sim.astype(np.float64)


def extract_session_features(tier_data: dict[str, Any]) -> list[SessionFeatures]:
    """Bridge function: convert TierMapResult → list of SessionFeatures.

    Maps our existing format (sessions[], tables[], connections[]) into
    the SessionFeatures objects used by all vectors.
    """
    sessions = tier_data.get("sessions", [])
    tables = tier_data.get("tables", [])
    connections = tier_data.get("connections", [])

    if not sessions:
        return []

    # Build table lookup by ID
    table_by_id = {t["id"]: t for t in tables}
    table_name_by_id = {t["id"]: t.get("name", t["id"]) for t in tables}

    # Build session→table maps from connections
    session_sources: dict[str, list[str]] = defaultdict(list)
    session_targets: dict[str, list[str]] = defaultdict(list)
    session_lookups: dict[str, list[str]] = defaultdict(list)
    session_upstream: dict[str, set[str]] = defaultdict(set)
    session_downstream: dict[str, set[str]] = defaultdict(set)
    session_conflicts: dict[str, int] = defaultdict(int)
    session_chains: dict[str, int] = defaultdict(int)
    session_staleness: dict[str, int] = defaultdict(int)

    session_ids = {s["id"] for s in sessions}
    table_ids = {t["id"] for t in tables}

    for conn in connections:
        src = conn.get("from", "")
        dst = conn.get("to", "")
        ctype = conn.get("type", "")

        # Session → Table connections
        if src in session_ids and dst in table_ids:
            tname = table_name_by_id.get(dst, dst)
            if ctype in ("write_conflict", "write_clean"):
                session_targets[src].append(tname)
            if ctype == "write_conflict":
                session_conflicts[src] += 1

        # Table → Session connections (source reads, lookups)
        if src in table_ids and dst in session_ids:
            tname = table_name_by_id.get(src, src)
            if ctype == "source_read":
                session_sources[dst].append(tname)
            elif ctype == "lookup_stale":
                session_lookups[dst].append(tname)
                session_staleness[dst] += 1

        # Session → Session dependencies
        if src in session_ids and dst in session_ids:
            session_downstream[src].add(dst)
            session_upstream[dst].add(src)
            if ctype == "chain":
                session_chains[src] += 1
                session_chains[dst] += 1

    # Also extract source/target/lookup from session objects if present
    features = []
    for s in sessions:
        sid = s["id"]
        sources = s.get("sources", session_sources.get(sid, []))
        targets = s.get("targets", session_targets.get(sid, []))
        lookups = s.get("lookups", session_lookups.get(sid, []))

        # Determine workflow from full name
        full_name = s.get("full", s.get("name", sid))
        workflow = ""
        if full_name:
            parts = full_name.split(".")
            if len(parts) > 1:
                workflow = parts[0]

        # Extract Phase 7 features from mapping_detail if available
        md = s.get("mapping_detail") or {}
        instances = md.get("instances", [])
        connectors = md.get("connectors", [])
        expressions = md.get("expressions", [])
        expr_count = len(expressions)
        param_count = len(s.get("mapping_variables", []))
        sql_count = sum(1 for inst in instances if inst.get("sql_override"))
        join_count = sum(1 for inst in instances if "joiner" in (inst.get("type", "")).lower())
        filter_count = sum(1 for inst in instances if "filter" in (inst.get("type", "")).lower())
        router_count = sum(1 for inst in instances if "router" in (inst.get("type", "")).lower())
        lkp_cache = sum(1 for inst in instances if "lookup" in (inst.get("type", "")).lower())
        field_count = sum(len(c.get("fields", [])) for c in connectors)
        mapplet_use = sum(1 for inst in instances if "mapplet" in (inst.get("type", "")).lower())
        sp_count = sum(1 for inst in instances if "stored" in (inst.get("type", "")).lower())
        expr_complexity = sum(e.get("expression", "").count("(") for e in expressions) / max(expr_count, 1)

        feat = SessionFeatures(
            session_id=sid,
            name=s.get("name", sid),
            full_name=full_name,
            tier=s.get("tier", 0),
            source_tables=list(sources) if isinstance(sources, (list, set)) else [],
            target_tables=list(targets) if isinstance(targets, (list, set)) else [],
            lookup_tables=list(lookups) if isinstance(lookups, (list, set)) else [],
            transform_count=s.get("transforms", 0),
            ext_reads=s.get("extReads", 0),
            lookup_count=s.get("lookupCount", 0),
            is_critical=s.get("critical", False),
            upstream_count=len(session_upstream.get(sid, set())),
            downstream_count=len(session_downstream.get(sid, set())),
            dependency_depth=int(s.get("tier", 0)),
            write_conflict_count=session_conflicts.get(sid, 0),
            chain_involvement=session_chains.get(sid, 0),
            staleness_risk=session_staleness.get(sid, 0),
            workflow_name=workflow,
            # Phase 7 features
            expression_count=expr_count,
            parameter_count=param_count,
            sql_override_count=sql_count,
            join_count=join_count,
            filter_count=filter_count,
            router_group_count=router_count,
            lookup_cache_potential=lkp_cache,
            field_count=field_count,
            connector_count=len(connectors),
            mapplet_usage=mapplet_use,
            stored_procedure_count=sp_count,
            expression_complexity_score=expr_complexity,
        )
        features.append(feat)

    return features
