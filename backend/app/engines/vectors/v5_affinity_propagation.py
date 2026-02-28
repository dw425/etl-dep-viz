"""V5 Affinity Propagation — message-passing clustering with exemplar identification.

Uses sklearn's AffinityPropagation on the similarity matrix with
sampling for large datasets (15K+ sessions).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None

try:
    from sklearn.cluster import AffinityPropagation
except ImportError:
    AffinityPropagation = None


@dataclass
class AffinityResult:
    clusters: dict[int, list[str]] = field(default_factory=dict)
    exemplars: list[str] = field(default_factory=list)
    n_clusters: int = 0
    convergence_iterations: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "clusters": {str(k): v for k, v in self.clusters.items()},
            "exemplars": self.exemplars,
            "n_clusters": self.n_clusters,
            "convergence_iterations": self.convergence_iterations,
        }


class AffinityPropagationVector:
    """V5: Affinity Propagation clustering with exemplar identification."""

    MAX_DIRECT = 5000  # Run directly below this size

    def run(
        self,
        similarity_matrix,
        session_ids: list[str],
    ) -> AffinityResult:
        if np is None:
            raise ImportError("numpy is required for AffinityPropagationVector. Install it with: pip install numpy")
        if AffinityPropagation is None:
            raise ImportError("scikit-learn is required for AffinityPropagationVector. Install it with: pip install scikit-learn")
        n = len(session_ids)
        if n < 2:
            return AffinityResult()

        if n > self.MAX_DIRECT:
            return self._run_at_scale(similarity_matrix, session_ids)

        # Scale similarity for AP (prefers negative values for distance)
        preference = np.median(similarity_matrix)
        ap = AffinityPropagation(
            affinity="precomputed",
            preference=float(preference),
            max_iter=300,
            random_state=42,
        )
        labels = ap.fit_predict(similarity_matrix)
        exemplar_indices = ap.cluster_centers_indices_

        clusters: dict[int, list[str]] = {}
        for i, label in enumerate(labels):
            clusters.setdefault(int(label), []).append(session_ids[i])

        exemplars = [session_ids[i] for i in exemplar_indices] if exemplar_indices is not None else []

        return AffinityResult(
            clusters=clusters,
            exemplars=exemplars,
            n_clusters=len(clusters),
            convergence_iterations=ap.n_iter_,
        )

    def _run_at_scale(
        self,
        similarity_matrix,
        session_ids: list[str],
    ) -> AffinityResult:
        """Sample-based AP for large datasets."""
        n = len(session_ids)
        sample_size = min(self.MAX_DIRECT, n)
        rng = np.random.RandomState(42)
        sample_idx = rng.choice(n, sample_size, replace=False)

        sub_sim = similarity_matrix[np.ix_(sample_idx, sample_idx)]
        preference = np.median(sub_sim)

        ap = AffinityPropagation(
            affinity="precomputed",
            preference=float(preference),
            max_iter=200,
            random_state=42,
        )
        sample_labels = ap.fit_predict(sub_sim)
        exemplar_local = ap.cluster_centers_indices_

        # Assign remaining points to nearest exemplar
        all_labels = np.full(n, -1, dtype=int)
        for i, si in enumerate(sample_idx):
            all_labels[si] = int(sample_labels[i])

        if exemplar_local is not None:
            exemplar_global = sample_idx[exemplar_local]
            for i in range(n):
                if all_labels[i] < 0:
                    sims = similarity_matrix[i, exemplar_global]
                    all_labels[i] = int(sample_labels[exemplar_local[np.argmax(sims)]])

        clusters: dict[int, list[str]] = {}
        for i, label in enumerate(all_labels):
            clusters.setdefault(int(label), []).append(session_ids[i])

        exemplars = [session_ids[i] for i in exemplar_global] if exemplar_local is not None else []

        return AffinityResult(
            clusters=clusters,
            exemplars=exemplars,
            n_clusters=len(clusters),
            convergence_iterations=ap.n_iter_,
        )
