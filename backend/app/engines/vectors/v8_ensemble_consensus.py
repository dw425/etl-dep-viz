"""V8 Ensemble Consensus — co-association matrix from V1–V7 results.

Builds a consensus clustering by aggregating cluster assignments
from all available vectors and identifying high-confidence vs contested sessions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None

try:
    from scipy.cluster.hierarchy import fcluster, linkage
    from scipy.spatial.distance import squareform
except ImportError:
    fcluster = None
    linkage = None
    squareform = None


@dataclass
class ConsensusSession:
    session_id: str
    consensus_cluster: int = -1
    consensus_score: float = 0.0  # 0-1 how much vectors agree
    per_vector_assignments: dict[str, int] = field(default_factory=dict)
    is_contested: bool = False


@dataclass
class EnsembleConsensusResult:
    sessions: list[ConsensusSession] = field(default_factory=list)
    consensus_clusters: dict[int, list[str]] = field(default_factory=dict)
    n_clusters: int = 0
    contested_count: int = 0
    high_confidence_count: int = 0
    vectors_used: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "sessions": [
                {
                    "session_id": s.session_id,
                    "consensus_cluster": s.consensus_cluster,
                    "consensus_score": round(s.consensus_score, 3),
                    "per_vector_assignments": s.per_vector_assignments,
                    "is_contested": s.is_contested,
                }
                for s in self.sessions
            ],
            "consensus_clusters": {str(k): v for k, v in self.consensus_clusters.items()},
            "n_clusters": self.n_clusters,
            "contested_count": self.contested_count,
            "high_confidence_count": self.high_confidence_count,
            "vectors_used": self.vectors_used,
        }


class EnsembleConsensusVector:
    """V8: Consensus clustering from multiple vector assignments."""

    # Map vector result keys → how to extract cluster assignments
    VECTOR_EXTRACTORS = {
        "v1_communities": "_extract_v1",
        "v2_hierarchical_lineage": "_extract_v2",
        "v3_dimensionality_reduction": "_extract_v3",
        "v5_affinity_propagation": "_extract_v5",
        "v6_spectral_clustering": "_extract_v6",
        "v7_hdbscan_density": "_extract_v7",
    }

    def run(
        self,
        all_results: dict[str, Any],
        session_ids: list[str],
    ) -> EnsembleConsensusResult:
        if np is None:
            raise ImportError("numpy is required for EnsembleConsensusVector. Install it with: pip install numpy")
        if linkage is None:
            raise ImportError("scipy is required for EnsembleConsensusVector. Install it with: pip install scipy")
        n = len(session_ids)
        if n < 3:
            return EnsembleConsensusResult()

        id_to_idx = {sid: i for i, sid in enumerate(session_ids)}

        # Collect per-vector assignments
        vector_labels: dict[str, dict[str, int]] = {}
        for vec_key, extractor_name in self.VECTOR_EXTRACTORS.items():
            if vec_key not in all_results:
                continue
            extractor = getattr(self, extractor_name, None)
            if extractor is None:
                continue
            labels = extractor(all_results[vec_key], session_ids)
            if labels:
                vector_labels[vec_key] = labels

        if len(vector_labels) < 2:
            return EnsembleConsensusResult(vectors_used=list(vector_labels.keys()))

        # Build co-association matrix
        co_assoc = np.zeros((n, n), dtype=np.float64)
        for vec_name, labels in vector_labels.items():
            for sid_a, label_a in labels.items():
                for sid_b, label_b in labels.items():
                    if sid_a >= sid_b:
                        continue
                    idx_a = id_to_idx.get(sid_a)
                    idx_b = id_to_idx.get(sid_b)
                    if idx_a is not None and idx_b is not None and label_a == label_b:
                        co_assoc[idx_a, idx_b] += 1.0
                        co_assoc[idx_b, idx_a] += 1.0

        # Normalize by number of vectors
        num_vectors = len(vector_labels)
        co_assoc /= num_vectors
        np.fill_diagonal(co_assoc, 1.0)

        # Consensus clustering via agglomerative on co-association distance
        distance = 1.0 - co_assoc
        np.fill_diagonal(distance, 0.0)
        distance = np.clip(distance, 0.0, 1.0)
        distance = (distance + distance.T) / 2.0

        condensed = squareform(distance, checks=False)
        Z = linkage(condensed, method="average")

        # Use average of vector cluster counts as target K
        k_values = []
        for labels in vector_labels.values():
            k_values.append(len(set(labels.values())))
        target_k = max(2, int(np.median(k_values)))

        consensus_labels = fcluster(Z, target_k, criterion="maxclust")

        # Build results
        sessions = []
        clusters: dict[int, list[str]] = {}
        contested = 0
        high_conf = 0

        for i, sid in enumerate(session_ids):
            cid = int(consensus_labels[i])
            clusters.setdefault(cid, []).append(sid)

            # Per-vector assignments
            pva = {}
            for vec_name, labels in vector_labels.items():
                if sid in labels:
                    pva[vec_name] = labels[sid]

            # Consensus score = average co-association with same-cluster members
            same_cluster = [j for j in range(n) if consensus_labels[j] == cid and j != i]
            if same_cluster:
                avg_co = np.mean([co_assoc[i, j] for j in same_cluster])
            else:
                avg_co = 1.0

            is_contested = float(avg_co) < 0.5
            if is_contested:
                contested += 1
            if float(avg_co) > 0.8:
                high_conf += 1

            sessions.append(ConsensusSession(
                session_id=sid,
                consensus_cluster=cid,
                consensus_score=float(avg_co),
                per_vector_assignments=pva,
                is_contested=is_contested,
            ))

        return EnsembleConsensusResult(
            sessions=sessions,
            consensus_clusters=clusters,
            n_clusters=len(clusters),
            contested_count=contested,
            high_confidence_count=high_conf,
            vectors_used=list(vector_labels.keys()),
        )

    # ── Extractors ──

    @staticmethod
    def _extract_v1(data: dict, session_ids: list[str]) -> dict[str, int]:
        """Extract meso-level community assignments from V1."""
        labels = {}
        for a in data.get("assignments", []):
            labels[a["session_id"]] = a.get("meso", -1)
        return labels

    @staticmethod
    def _extract_v2(data: dict, session_ids: list[str]) -> dict[str, int]:
        """Extract domain assignments from V2."""
        labels = {}
        for d in data.get("domains", []):
            for sid in d.get("session_ids", []):
                labels[sid] = d["domain_id"]
        return labels

    @staticmethod
    def _extract_v3(data: dict, session_ids: list[str]) -> dict[str, int]:
        """Extract auto-cluster labels from V3 balanced projection."""
        labels = {}
        projections = data.get("projections", {})
        balanced = projections.get("balanced", {})
        for c in balanced.get("coords", []):
            labels[c["session_id"]] = c.get("cluster", 0)
        return labels

    @staticmethod
    def _extract_v5(data: dict, session_ids: list[str]) -> dict[str, int]:
        """Extract cluster assignments from V5."""
        labels = {}
        for cid_str, members in data.get("clusters", {}).items():
            cid = int(cid_str)
            for sid in members:
                labels[sid] = cid
        return labels

    @staticmethod
    def _extract_v6(data: dict, session_ids: list[str]) -> dict[str, int]:
        """Extract cluster assignments from V6."""
        labels = {}
        for cid_str, members in data.get("clusters", {}).items():
            cid = int(cid_str)
            for sid in members:
                labels[sid] = cid
        return labels

    @staticmethod
    def _extract_v7(data: dict, session_ids: list[str]) -> dict[str, int]:
        """Extract cluster assignments from V7 (noise = -1)."""
        labels = {}
        for cid_str, members in data.get("clusters", {}).items():
            cid = int(cid_str)
            for sid in members:
                labels[sid] = cid
        for sid in data.get("noise_sessions", []):
            labels[sid] = -1
        return labels
