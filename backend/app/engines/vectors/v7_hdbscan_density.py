"""V7 HDBSCAN Density — density-based clustering with noise detection.

Runs HDBSCAN on UMAP projection (from V3) or falls back to feature matrix.
Identifies noise points and reports cluster stability scores.

Unlike partitioning methods (K-Means, Spectral), HDBSCAN does not force
every point into a cluster. Sessions in low-density regions are labeled
as noise (cluster = -1), which helps identify genuinely isolated sessions.

Input Preference:
  - If V3 UMAP coords are available (2D "balanced" projection), use those.
    HDBSCAN on UMAP coordinates is faster and often more meaningful than
    on raw 16-dimensional features.
  - Otherwise, fall back to the raw feature matrix.

Library Fallback:
  If `hdbscan` package is not installed, falls back to sklearn's DBSCAN
  with StandardScaler normalization and eps=0.5.

Output: HDBSCANResult with cluster assignments, noise session list, noise ratio,
and per-cluster persistence (stability) scores.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None


@dataclass
class HDBSCANResult:
    clusters: dict[int, list[str]] = field(default_factory=dict)
    noise_sessions: list[str] = field(default_factory=list)
    n_clusters: int = 0
    noise_ratio: float = 0.0
    cluster_persistence: list[float] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "clusters": {str(k): v for k, v in self.clusters.items()},
            "noise_sessions": self.noise_sessions,
            "n_clusters": self.n_clusters,
            "noise_ratio": round(self.noise_ratio, 4),
            "cluster_persistence": [round(p, 4) for p in self.cluster_persistence],
        }


class HDBSCANDensityVector:
    """V7: Density-based clustering with noise identification."""

    def run(
        self,
        feature_matrix,
        session_ids: list[str],
        umap_coords: dict[str, Any] | None = None,
    ) -> HDBSCANResult:
        """Run density-based clustering.

        Args:
            feature_matrix: Dense normalized features (n x 16). Used as fallback.
            session_ids: Session ID list matching matrix indices.
            umap_coords: Optional V3 projection dict with 'coords' list of {x, y} dicts.
                         Preferred over feature_matrix when available.
        """
        if np is None:
            raise ImportError("numpy is required for HDBSCANDensityVector. Install it with: pip install numpy")
        n = len(session_ids)
        if n < 5:
            return HDBSCANResult()

        # Use UMAP coords if available, otherwise raw features
        if umap_coords and "coords" in umap_coords:
            coords = umap_coords["coords"]
            X = np.array([[c["x"], c["y"]] for c in coords])
        else:
            X = feature_matrix

        try:
            import hdbscan
            clusterer = hdbscan.HDBSCAN(
                min_cluster_size=max(2, n // 20),
                min_samples=max(1, n // 50),
                metric="euclidean",
            )
            labels = clusterer.fit_predict(X)
            persistence = clusterer.cluster_persistence_.tolist() if hasattr(clusterer, "cluster_persistence_") else []
        except ImportError:
            # Fallback: DBSCAN from sklearn
            from sklearn.cluster import DBSCAN
            from sklearn.preprocessing import StandardScaler

            X_scaled = StandardScaler().fit_transform(X)
            db = DBSCAN(eps=0.5, min_samples=max(2, n // 20))
            labels = db.fit_predict(X_scaled)
            persistence = []

        clusters: dict[int, list[str]] = {}
        noise = []
        for i, label in enumerate(labels):
            if label == -1:
                noise.append(session_ids[i])
            else:
                clusters.setdefault(int(label), []).append(session_ids[i])

        return HDBSCANResult(
            clusters=clusters,
            noise_sessions=noise,
            n_clusters=len(clusters),
            noise_ratio=len(noise) / n if n > 0 else 0.0,
            cluster_persistence=persistence,
        )
