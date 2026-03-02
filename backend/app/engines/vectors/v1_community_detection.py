"""V1 Community Detection — Louvain multi-resolution clustering.

Uses NetworkX's built-in Louvain implementation with configurable resolution
to detect communities at macro (0.3), meso (1.0), and micro (3.0) scales.
Builds a supernode graph for the L1 enterprise constellation view.

Algorithm:
  1. Build undirected weighted graph from the pairwise similarity matrix
     (edges where Jaccard > 0.05; sparse adjacency edges added if graph is too sparse).
  2. Run Louvain community detection at three resolution scales:
     - Macro (0.3): few large communities — enterprise-level grouping
     - Meso (1.0): moderate communities — default Louvain behavior
     - Micro (3.0): many small communities — fine-grained clusters
  3. Assign each session a (macro, meso, micro) community triple.
  4. Build a supernode graph: each macro community becomes a node, with edges
     weighted by average inter-community similarity.

Output: CommunityResult with assignments, per-scale community dicts, modularity
scores, and the supernode graph for L1 rendering.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import networkx as nx

try:
    import numpy as np
except ImportError:
    np = None


@dataclass
class CommunityAssignment:
    session_id: str
    macro: int = -1
    meso: int = -1
    micro: int = -1


@dataclass
class CommunityResult:
    assignments: list[CommunityAssignment] = field(default_factory=list)
    macro_communities: dict[int, list[str]] = field(default_factory=dict)
    meso_communities: dict[int, list[str]] = field(default_factory=dict)
    micro_communities: dict[int, list[str]] = field(default_factory=dict)
    modularity: dict[str, float] = field(default_factory=dict)
    supernode_graph: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "assignments": [
                {"session_id": a.session_id, "macro": a.macro, "meso": a.meso, "micro": a.micro}
                for a in self.assignments
            ],
            "macro_communities": {str(k): v for k, v in self.macro_communities.items()},
            "meso_communities": {str(k): v for k, v in self.meso_communities.items()},
            "micro_communities": {str(k): v for k, v in self.micro_communities.items()},
            "modularity": self.modularity,
            "supernode_graph": self.supernode_graph,
        }


class CommunityDetectionVector:
    """V1: Multi-resolution community detection using Louvain algorithm."""

    RESOLUTIONS = {"macro": 0.3, "meso": 1.0, "micro": 3.0}

    def run(
        self,
        similarity_matrix,
        session_ids: list[str],
        adjacency: Any | None = None,
    ) -> CommunityResult:
        """Run multi-resolution Louvain community detection.

        Args:
            similarity_matrix: Pairwise Jaccard similarity (n x n numpy array).
            session_ids: Session ID list matching matrix indices.
            adjacency: Optional sparse adjacency matrix to supplement graph edges
                       when the similarity graph is too sparse (< n edges).
        """
        if np is None:
            raise ImportError("numpy is required for CommunityDetectionVector. Install it with: pip install numpy")
        n = len(session_ids)
        if n == 0:
            return CommunityResult()

        # Build undirected weighted graph from similarity matrix
        G = nx.Graph()
        G.add_nodes_from(range(n))
        for i in range(n):
            for j in range(i + 1, n):
                w = float(similarity_matrix[i, j])
                if w > 0.05:  # filter noise
                    G.add_edge(i, j, weight=w)

        # If graph is too sparse, add edges from adjacency
        if adjacency is not None and G.number_of_edges() < n:
            from scipy import sparse
            if sparse.issparse(adjacency):
                cx = adjacency.tocoo()
                for i, j, w in zip(cx.row, cx.col, cx.data):
                    if i != j and not G.has_edge(i, j):
                        G.add_edge(i, j, weight=float(w))

        result = CommunityResult()
        all_partitions: dict[str, dict[int, int]] = {}

        for scale, resolution in self.RESOLUTIONS.items():
            if G.number_of_edges() == 0:
                partition = {i: i for i in range(n)}
            else:
                communities = nx.community.louvain_communities(
                    G, weight="weight", resolution=resolution, seed=42
                )
                partition = {}
                for cid, members in enumerate(communities):
                    for node in members:
                        partition[node] = cid

            all_partitions[scale] = partition

            # Group by community
            comm_groups: dict[int, list[str]] = {}
            for idx, cid in partition.items():
                comm_groups.setdefault(cid, []).append(session_ids[idx])

            if scale == "macro":
                result.macro_communities = comm_groups
            elif scale == "meso":
                result.meso_communities = comm_groups
            else:
                result.micro_communities = comm_groups

            # Compute modularity
            if G.number_of_edges() > 0:
                comm_sets = []
                inv: dict[int, set[int]] = {}
                for node, cid in partition.items():
                    inv.setdefault(cid, set()).add(node)
                comm_sets = list(inv.values())
                try:
                    mod = nx.community.modularity(G, comm_sets, weight="weight")
                except (ZeroDivisionError, nx.NetworkXError):
                    mod = 0.0
                result.modularity[scale] = round(mod, 4)
            else:
                result.modularity[scale] = 0.0

        # Build assignments
        for idx in range(n):
            result.assignments.append(CommunityAssignment(
                session_id=session_ids[idx],
                macro=all_partitions["macro"].get(idx, -1),
                meso=all_partitions["meso"].get(idx, -1),
                micro=all_partitions["micro"].get(idx, -1),
            ))

        # Build supernode graph from macro communities
        result.supernode_graph = self._build_supernode_graph(
            result.macro_communities, similarity_matrix, session_ids
        )

        return result

    def _build_supernode_graph(
        self,
        communities: dict[int, list[str]],
        similarity,
        session_ids: list[str],
    ) -> dict[str, Any]:
        """Build contracted graph where each community becomes a supernode."""
        id_to_idx = {sid: i for i, sid in enumerate(session_ids)}

        supernodes = []
        for cid, members in sorted(communities.items()):
            supernodes.append({
                "id": f"community_{cid}",
                "session_count": len(members),
                "session_ids": members,
            })

        superedges = []
        comm_keys = sorted(communities.keys())
        for a_pos, a_key in enumerate(comm_keys):
            for b_pos in range(a_pos + 1, len(comm_keys)):
                b_key = comm_keys[b_pos]
                a_members = communities[a_key]
                b_members = communities[b_key]

                # Average inter-community similarity
                total_sim = 0.0
                count = 0
                for sid_a in a_members:
                    idx_a = id_to_idx.get(sid_a)
                    if idx_a is None:
                        continue
                    for sid_b in b_members:
                        idx_b = id_to_idx.get(sid_b)
                        if idx_b is None:
                            continue
                        total_sim += float(similarity[idx_a, idx_b])
                        count += 1

                avg_sim = total_sim / count if count > 0 else 0.0
                if avg_sim > 0.01:
                    superedges.append({
                        "from": f"community_{a_key}",
                        "to": f"community_{b_key}",
                        "weight": round(avg_sim, 4),
                        "pair_count": count,
                    })

        return {"supernodes": supernodes, "superedges": superedges}
