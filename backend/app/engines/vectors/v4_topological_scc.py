"""V4 Topological SCC — Strongly Connected Components + Wave Plan.

Uses Tarjan's algorithm (via NetworkX) to find SCCs, then builds a
condensation DAG for migration wave planning with topological ordering.

Algorithm:
  1. Build directed graph from adjacency matrix.
  2. Find all Strongly Connected Components (SCCs) — groups of sessions with
     mutual dependencies (cycles). These must be migrated as atomic units.
  3. Build condensation DAG: each SCC becomes a single node, acyclic by definition.
  4. Compute topological generations on the condensation DAG — each generation
     becomes a migration wave (can execute in parallel within a wave).
  5. Estimate migration hours per wave using V11 complexity scores:
     avg_complexity 0-25 -> 0.5x base, 26-50 -> 1.0x, 51-75 -> 1.5x, 76-100 -> 2.5x.

Output: WavePlan with waves (ordered execution batches), SCC groups (cycle detection),
critical path length (= number of waves), and per-wave hour estimates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import networkx as nx

try:
    from scipy import sparse
except ImportError:
    sparse = None


@dataclass
class SCCGroup:
    group_id: int
    session_ids: list[str] = field(default_factory=list)
    is_cycle: bool = False
    internal_edge_count: int = 0


@dataclass
class MigrationWave:
    wave_number: int
    session_ids: list[str] = field(default_factory=list)
    scc_groups: list[int] = field(default_factory=list)
    prerequisite_waves: list[int] = field(default_factory=list)
    estimated_hours_low: float = 0.0
    estimated_hours_high: float = 0.0
    session_count: int = 0

    def __post_init__(self):
        self.session_count = len(self.session_ids)


@dataclass
class WavePlan:
    waves: list[MigrationWave] = field(default_factory=list)
    scc_groups: list[SCCGroup] = field(default_factory=list)
    critical_path_length: int = 0
    total_sessions: int = 0
    cyclic_session_count: int = 0
    acyclic_session_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "waves": [
                {
                    "wave_number": w.wave_number,
                    "session_ids": w.session_ids,
                    "scc_groups": w.scc_groups,
                    "prerequisite_waves": w.prerequisite_waves,
                    "estimated_hours_low": w.estimated_hours_low,
                    "estimated_hours_high": w.estimated_hours_high,
                    "session_count": w.session_count,
                }
                for w in self.waves
            ],
            "scc_groups": [
                {
                    "group_id": g.group_id,
                    "session_ids": g.session_ids,
                    "is_cycle": g.is_cycle,
                    "internal_edge_count": g.internal_edge_count,
                }
                for g in self.scc_groups
            ],
            "critical_path_length": self.critical_path_length,
            "total_sessions": self.total_sessions,
            "cyclic_session_count": self.cyclic_session_count,
            "acyclic_session_count": self.acyclic_session_count,
        }


# Hours estimation per complexity bucket
_HOURS_PER_SESSION = {"low": 8.0, "high": 24.0}


class TopologicalSCCVector:
    """V4: Find SCCs and build migration wave plan."""

    def run(
        self,
        adjacency,
        session_ids: list[str],
        complexity_scores: dict[str, float] | None = None,
    ) -> WavePlan:
        """Build migration wave plan from dependency graph.

        Args:
            adjacency: Sparse CSR adjacency matrix from FeatureMatrixBuilder.
            session_ids: Session ID list matching matrix indices.
            complexity_scores: Optional V11 scores {session_id: 0-100} for hour scaling.
        """
        if sparse is None:
            raise ImportError("scipy is required for TopologicalSCCVector. Install it with: pip install scipy")
        n = len(session_ids)
        if n == 0:
            return WavePlan()

        # Build directed graph from adjacency
        G = nx.DiGraph()
        G.add_nodes_from(range(n))
        cx = adjacency.tocoo()
        for i, j, w in zip(cx.row, cx.col, cx.data):
            if i != j:
                G.add_edge(i, j, weight=float(w))

        # Find SCCs
        sccs = list(nx.strongly_connected_components(G))
        scc_groups = []
        for gid, scc in enumerate(sccs):
            members = sorted(scc)
            is_cycle = len(scc) > 1
            internal_edges = sum(
                1 for u in scc for v in G.successors(u) if v in scc and u != v
            )
            scc_groups.append(SCCGroup(
                group_id=gid,
                session_ids=[session_ids[i] for i in members],
                is_cycle=is_cycle,
                internal_edge_count=internal_edges,
            ))

        # Build condensation DAG
        condensation = nx.condensation(G)

        # Map condensation nodes → SCC group IDs
        # nx.condensation assigns its own mapping; remap to our scc_groups
        cond_to_scc: dict[int, int] = {}
        scc_node_map: dict[int, int] = {}
        for cond_node in condensation.nodes():
            members = condensation.nodes[cond_node]["members"]
            # Find matching SCC group
            member_set = set(members)
            for gid, sg in enumerate(scc_groups):
                sg_indices = {session_ids.index(sid) for sid in sg.session_ids}
                if sg_indices == member_set:
                    cond_to_scc[cond_node] = gid
                    break

        # Topological generations for wave assignment
        try:
            generations = list(nx.topological_generations(condensation))
        except nx.NetworkXUnfeasible:
            # Fallback: single wave with all sessions
            generations = [set(condensation.nodes())]

        waves = []
        for wave_num, gen in enumerate(generations):
            wave_sessions = []
            wave_scc_ids = []
            for cond_node in gen:
                members = condensation.nodes[cond_node]["members"]
                for idx in members:
                    wave_sessions.append(session_ids[idx])
                scc_id = cond_to_scc.get(cond_node, -1)
                if scc_id >= 0:
                    wave_scc_ids.append(scc_id)

            # Prerequisites: all previous waves
            prereqs = list(range(wave_num)) if wave_num > 0 else []

            # Hours estimation
            num = len(wave_sessions)
            hours_low = num * _HOURS_PER_SESSION["low"]
            hours_high = num * _HOURS_PER_SESSION["high"]

            # Adjust by complexity if available
            if complexity_scores:
                avg_complexity = 0.0
                count = 0
                for sid in wave_sessions:
                    if sid in complexity_scores:
                        avg_complexity += complexity_scores[sid]
                        count += 1
                if count > 0:
                    avg_complexity /= count
                    # Scale: 0-25 → 0.5x, 26-50 → 1.0x, 51-75 → 1.5x, 76-100 → 2.5x
                    if avg_complexity <= 25:
                        multiplier = 0.5
                    elif avg_complexity <= 50:
                        multiplier = 1.0
                    elif avg_complexity <= 75:
                        multiplier = 1.5
                    else:
                        multiplier = 2.5
                    hours_low *= multiplier
                    hours_high *= multiplier

            waves.append(MigrationWave(
                wave_number=wave_num,
                session_ids=wave_sessions,
                scc_groups=wave_scc_ids,
                prerequisite_waves=prereqs,
                estimated_hours_low=round(hours_low, 1),
                estimated_hours_high=round(hours_high, 1),
            ))

        # Critical path = number of waves
        critical_path = len(waves)

        cyclic = sum(len(sg.session_ids) for sg in scc_groups if sg.is_cycle)

        return WavePlan(
            waves=waves,
            scc_groups=scc_groups,
            critical_path_length=critical_path,
            total_sessions=n,
            cyclic_session_count=cyclic,
            acyclic_session_count=n - cyclic,
        )
