"""V6 Spectral Clustering — eigengap heuristic for optimal K.

Uses spectral embedding as an alternative 2D layout and sklearn's
SpectralClustering on the similarity matrix.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None

try:
    from sklearn.cluster import SpectralClustering
except ImportError:
    SpectralClustering = None


@dataclass
class SpectralResult:
    clusters: dict[int, list[str]] = field(default_factory=dict)
    optimal_k: int = 0
    eigengap_scores: list[float] = field(default_factory=list)
    embedding_2d: list[dict[str, float]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "clusters": {str(k): v for k, v in self.clusters.items()},
            "optimal_k": self.optimal_k,
            "eigengap_scores": [round(s, 4) for s in self.eigengap_scores[:20]],
            "embedding_2d": self.embedding_2d,
        }


class SpectralClusteringVector:
    """V6: Spectral clustering with eigengap-based optimal K."""

    def run(
        self,
        similarity_matrix,
        session_ids: list[str],
    ) -> SpectralResult:
        if np is None:
            raise ImportError("numpy is required for SpectralClusteringVector. Install it with: pip install numpy")
        if SpectralClustering is None:
            raise ImportError("scikit-learn is required for SpectralClusteringVector. Install it with: pip install scikit-learn")
        n = len(session_ids)
        if n < 3:
            return SpectralResult()

        # Ensure non-negative similarity for spectral
        sim = np.clip(similarity_matrix, 0.0, None)
        np.fill_diagonal(sim, 0.0)

        # Eigengap heuristic: compute Laplacian eigenvalues
        degree = sim.sum(axis=1)
        D = np.diag(degree)
        L = D - sim  # unnormalized Laplacian

        try:
            eigenvalues = np.sort(np.real(np.linalg.eigvalsh(L)))
        except np.linalg.LinAlgError:
            eigenvalues = np.zeros(n)

        # Compute gaps between consecutive eigenvalues
        gaps = np.diff(eigenvalues[:min(20, n)])
        eigengap_scores = gaps.tolist()

        # Optimal K = position of largest gap (skip first near-zero eigenvalue)
        if len(gaps) > 1:
            optimal_k = int(np.argmax(gaps[1:]) + 2)  # +2: skip first, 1-indexed
            optimal_k = max(2, min(optimal_k, n // 2, 15))
        else:
            optimal_k = 2

        # Run spectral clustering
        try:
            sc = SpectralClustering(
                n_clusters=optimal_k,
                affinity="precomputed",
                assign_labels="kmeans",
                random_state=42,
                n_init=10,
            )
            labels = sc.fit_predict(sim)
        except Exception:
            # Fallback to simple K=2
            sc = SpectralClustering(
                n_clusters=2,
                affinity="precomputed",
                assign_labels="kmeans",
                random_state=42,
            )
            labels = sc.fit_predict(sim)
            optimal_k = 2

        clusters: dict[int, list[str]] = {}
        for i, label in enumerate(labels):
            clusters.setdefault(int(label), []).append(session_ids[i])

        # Spectral embedding for 2D layout
        embedding_2d = self._spectral_embedding(sim, session_ids)

        return SpectralResult(
            clusters=clusters,
            optimal_k=optimal_k,
            eigengap_scores=eigengap_scores,
            embedding_2d=embedding_2d,
        )

    @staticmethod
    def _spectral_embedding(
        similarity,
        session_ids: list[str],
    ) -> list[dict[str, float]]:
        """Compute 2D spectral embedding for layout."""
        n = len(session_ids)
        degree = similarity.sum(axis=1)
        D_inv_sqrt = np.diag(1.0 / np.sqrt(np.maximum(degree, 1e-10)))
        L_norm = np.eye(n) - D_inv_sqrt @ similarity @ D_inv_sqrt

        try:
            eigenvalues, eigenvectors = np.linalg.eigh(L_norm)
            # Use 2nd and 3rd smallest eigenvectors (skip constant 1st)
            coords = eigenvectors[:, 1:3] if n > 2 else eigenvectors[:, :2]
        except np.linalg.LinAlgError:
            coords = np.random.rand(n, 2)

        # Normalize to [0, 1]
        for dim in range(min(2, coords.shape[1])):
            col = coords[:, dim]
            cmin, cmax = col.min(), col.max()
            rng = cmax - cmin
            coords[:, dim] = (col - cmin) / rng if rng > 0 else 0.5

        return [
            {"session_id": session_ids[i], "x": round(float(coords[i, 0]), 4), "y": round(float(coords[i, 1]), 4)}
            for i in range(n)
        ]
