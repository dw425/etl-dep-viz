"""Shared feature extraction layer for all analysis vectors.

Bridges our TierMapResult format → dense numpy matrices for ML algorithms.
"""

from __future__ import annotations

import math
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
    """Feature profile for a single session/processor."""

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

    def __post_init__(self):
        all_tables = set(self.source_tables) | set(self.target_tables) | set(self.lookup_tables)
        total = len(self.source_tables) + len(self.target_tables) + len(self.lookup_tables)
        self.total_table_footprint = len(all_tables)
        self.unique_table_ratio = len(all_tables) / max(total, 1)


class FeatureMatrixBuilder:
    """Build numpy arrays from SessionFeatures for ML algorithms."""

    # Feature columns for the dense matrix
    FEATURE_NAMES = [
        "tier", "transform_count", "ext_reads", "lookup_count",
        "source_table_count", "target_table_count", "lookup_table_count",
        "total_table_footprint", "unique_table_ratio",
        "is_critical", "upstream_count", "downstream_count",
        "dependency_depth", "write_conflict_count", "chain_involvement",
        "staleness_risk",
    ]

    def __init__(self, features: list[SessionFeatures]):
        self.features = features
        self.session_ids = [f.session_id for f in features]
        self._id_to_idx = {f.session_id: i for i, f in enumerate(features)}

    def build_dense_matrix(self):
        """Build normalized feature matrix (n_sessions x n_features)."""
        if np is None:
            raise ImportError("numpy is required for FeatureMatrixBuilder. Install it with: pip install numpy")
        n = len(self.features)
        m = len(self.FEATURE_NAMES)
        mat = np.zeros((n, m), dtype=np.float64)

        for i, f in enumerate(self.features):
            mat[i] = [
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

        Args:
            metric: 'jaccard', 'cosine', or 'overlap'
        """
        if np is None:
            raise ImportError("numpy is required for build_similarity_matrix. Install it with: pip install numpy")
        n = len(self.features)
        sim = np.zeros((n, n), dtype=np.float64)

        table_sets = []
        for f in self.features:
            ts = set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables)
            table_sets.append(ts)

        for i in range(n):
            sim[i, i] = 1.0
            for j in range(i + 1, n):
                si, sj = table_sets[i], table_sets[j]
                if metric == "jaccard":
                    union = len(si | sj)
                    score = len(si & sj) / union if union > 0 else 0.0
                elif metric == "cosine":
                    inter = len(si & sj)
                    denom = math.sqrt(len(si)) * math.sqrt(len(sj))
                    score = inter / denom if denom > 0 else 0.0
                elif metric == "overlap":
                    minlen = min(len(si), len(sj))
                    score = len(si & sj) / minlen if minlen > 0 else 0.0
                else:
                    score = 0.0
                sim[i, j] = score
                sim[j, i] = score

        return sim


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
            tobj = table_by_id.get(src, {})
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
        )
        features.append(feat)

    return features
