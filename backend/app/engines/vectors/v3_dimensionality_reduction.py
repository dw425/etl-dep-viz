"""V3 Dimensionality Reduction — UMAP multi-scale projections.

Projects high-dimensional feature space to 2D for visualization,
with auto-cluster detection via KMeans on the projected space.
Falls back to PCA if umap-learn is not installed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None

try:
    from sklearn.cluster import KMeans
    from sklearn.decomposition import PCA
    from sklearn.preprocessing import StandardScaler
except ImportError:
    KMeans = None
    PCA = None
    StandardScaler = None


@dataclass
class ProjectionResult:
    coords: list[dict[str, float]] = field(default_factory=list)  # [{x, y, session_id}]
    cluster_labels: list[int] = field(default_factory=list)
    n_clusters: int = 0


@dataclass
class DimensionalityReductionResult:
    projections: dict[str, Any] = field(default_factory=dict)  # scale → coords list
    method: str = "pca"  # "umap" or "pca"

    def to_dict(self) -> dict[str, Any]:
        return {
            "projections": self.projections,
            "method": self.method,
        }


class DimensionalityReductionVector:
    """V3: Multi-scale 2D projections with auto-clustering."""

    SCALES = {
        "local": 10,
        "balanced": 30,
        "global": 100,
    }

    def run(
        self,
        feature_matrix,
        session_ids: list[str],
    ) -> DimensionalityReductionResult:
        if np is None:
            raise ImportError("numpy is required for DimensionalityReductionVector. Install it with: pip install numpy")
        if StandardScaler is None:
            raise ImportError("scikit-learn is required for DimensionalityReductionVector. Install it with: pip install scikit-learn")
        n = len(session_ids)
        if n < 3:
            return DimensionalityReductionResult()

        # Standardize features
        scaler = StandardScaler()
        X = scaler.fit_transform(feature_matrix)

        result = DimensionalityReductionResult()

        # Try UMAP first, fall back to PCA
        try:
            import umap
            result.method = "umap"
            for scale_name, n_neighbors in self.SCALES.items():
                nn = min(n_neighbors, n - 1)
                if nn < 2:
                    nn = 2
                reducer = umap.UMAP(
                    n_components=2,
                    n_neighbors=nn,
                    min_dist=0.1,
                    metric="euclidean",
                    random_state=42,
                )
                embedding = reducer.fit_transform(X)
                proj = self._build_projection(embedding, session_ids)
                result.projections[scale_name] = proj
        except ImportError:
            # Fallback: PCA
            result.method = "pca"
            pca = PCA(n_components=min(2, n, X.shape[1]))
            embedding = pca.fit_transform(X)
            if embedding.shape[1] == 1:
                embedding = np.column_stack([embedding, np.zeros(n)])
            proj = self._build_projection(embedding, session_ids)
            result.projections["balanced"] = proj

        return result

    def _build_projection(
        self,
        embedding,
        session_ids: list[str],
    ) -> dict[str, Any]:
        """Build projection dict with auto-clustering."""
        n = len(session_ids)

        # Normalize to [0, 1]
        for dim in range(2):
            col = embedding[:, dim]
            cmin, cmax = col.min(), col.max()
            rng = cmax - cmin
            if rng > 0:
                embedding[:, dim] = (col - cmin) / rng
            else:
                embedding[:, dim] = 0.5

        # Auto-cluster via KMeans (elbow heuristic: sqrt(n/2))
        max_k = max(2, min(int(np.sqrt(n / 2)), 15))
        best_k = 2
        best_inertia_drop = 0.0
        prev_inertia = None

        for k in range(2, max_k + 1):
            km = KMeans(n_clusters=k, random_state=42, n_init=5)
            km.fit(embedding)
            if prev_inertia is not None:
                drop = prev_inertia - km.inertia_
                if drop > best_inertia_drop:
                    best_inertia_drop = drop
                    best_k = k
            prev_inertia = km.inertia_

        km = KMeans(n_clusters=best_k, random_state=42, n_init=10)
        labels = km.fit_predict(embedding)

        coords = [
            {
                "session_id": session_ids[i],
                "x": round(float(embedding[i, 0]), 4),
                "y": round(float(embedding[i, 1]), 4),
                "cluster": int(labels[i]),
            }
            for i in range(n)
        ]

        return {
            "coords": coords,
            "n_clusters": best_k,
            "cluster_labels": [int(l) for l in labels],
        }

    def export_for_orb_map(
        self,
        projection: dict[str, Any],
        width: int = 1200,
        height: int = 800,
    ) -> list[dict[str, Any]]:
        """Convert normalized coords to pixel positions for constellation canvas."""
        margin = 50
        w = width - 2 * margin
        h = height - 2 * margin
        return [
            {
                "session_id": c["session_id"],
                "px": margin + c["x"] * w,
                "py": margin + c["y"] * h,
                "cluster": c.get("cluster", 0),
            }
            for c in projection.get("coords", [])
        ]
