"""V6 Spectral Clustering — eigengap heuristic for optimal K.

Uses spectral embedding as an alternative 2D layout and sklearn's
SpectralClustering on the similarity matrix.

Algorithm:
  1. Build unnormalized graph Laplacian L = D - W (degree matrix minus similarity).
  2. Compute eigenvalues of L; the largest gap between consecutive eigenvalues
     (eigengap heuristic) indicates the optimal number of clusters K.
  3. Run sklearn SpectralClustering with that K on the similarity matrix.
  4. Compute 2D spectral embedding from the 2nd and 3rd smallest eigenvectors
     of the normalized Laplacian for visualization.

Scaling Strategy:
  - Below LARGE_N_THRESHOLD (5000): full dense eigendecomposition.
  - Above: sparse eigensolver (scipy.sparse.linalg.eigsh) for eigengap,
    sampled spectral embedding, and KMeans on the sample with nearest-neighbor
    assignment for unsampled sessions (Nystrom approximation).

Output: SpectralResult with cluster assignments, optimal K, eigengap scores,
and 2D spectral embedding coordinates.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

try:
    import numpy as np
except ImportError:
    np = None

try:
    from sklearn.cluster import SpectralClustering, KMeans
except ImportError:
    SpectralClustering = None
    KMeans = None

try:
    from scipy.sparse.linalg import eigsh
    from scipy.sparse import csr_matrix as sp_csr
except ImportError:
    eigsh = None
    sp_csr = None


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
    """V6: Spectral clustering with eigengap-based optimal K.

    For large datasets (>5000), uses sparse eigensolvers and sampling
    to avoid O(n³) dense eigendecomposition.
    """

    LARGE_N_THRESHOLD = 5000  # Switch to sparse/sampled approach above this

    def run(
        self,
        similarity_matrix,
        session_ids: list[str],
    ) -> SpectralResult:
        """Run spectral clustering with eigengap-based K selection.

        Args:
            similarity_matrix: Non-negative pairwise similarity (n x n numpy array).
            session_ids: Session ID list matching matrix indices.
        """
        if np is None:
            raise ImportError("numpy is required for SpectralClusteringVector. Install it with: pip install numpy")
        if SpectralClustering is None:
            raise ImportError("scikit-learn is required for SpectralClusteringVector. Install it with: pip install scikit-learn")
        n = len(session_ids)
        if n < 3:
            return SpectralResult()

        if n > self.LARGE_N_THRESHOLD:
            return self._run_large(similarity_matrix, session_ids)

        # Ensure non-negative similarity for spectral
        sim = np.clip(similarity_matrix, 0.0, None)
        np.fill_diagonal(sim, 0.0)

        optimal_k, eigengap_scores = self._eigengap_heuristic(sim, n)

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
        except Exception as exc:
            logger.warning("SpectralClustering failed with k=%d, falling back to k=2: %s", optimal_k, exc)
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

        embedding_2d = self._spectral_embedding(sim, session_ids)

        return SpectralResult(
            clusters=clusters,
            optimal_k=optimal_k,
            eigengap_scores=eigengap_scores,
            embedding_2d=embedding_2d,
        )

    def _run_large(
        self,
        similarity_matrix,
        session_ids: list[str],
    ) -> SpectralResult:
        """Optimized spectral clustering for large datasets.

        Uses sparse eigensolver for eigengap and sampled spectral embedding.
        """
        import logging
        logger = logging.getLogger(__name__)
        n = len(session_ids)
        logger.info("V6 large-N mode: %d sessions (threshold %d)", n, self.LARGE_N_THRESHOLD)

        sim = np.clip(similarity_matrix, 0.0, None)
        np.fill_diagonal(sim, 0.0)

        # Sparse eigengap using scipy.sparse.linalg.eigsh (much faster than dense)
        optimal_k = 5  # default
        eigengap_scores = []
        try:
            if eigsh is not None:
                degree = sim.sum(axis=1)
                D = np.diag(degree)
                L = D - sim
                # Request only the 20 smallest eigenvalues
                k_eig = min(20, n - 2)
                eigenvalues, _ = eigsh(L, k=k_eig, which='SM', sigma=0)
                eigenvalues = np.sort(np.real(eigenvalues))
                gaps = np.diff(eigenvalues)
                eigengap_scores = gaps.tolist()
                if len(gaps) > 1:
                    optimal_k = int(np.argmax(gaps[1:]) + 2)
                    optimal_k = max(2, min(optimal_k, n // 2, 15))
        except Exception as exc:
            logger.warning("Sparse eigengap failed, using default k=5: %s", exc)
            optimal_k = 5

        # For large N, use KMeans on a sampled spectral embedding instead of full SpectralClustering
        # Sample approach: compute spectral embedding on a sample, then assign remaining
        sample_size = min(self.LARGE_N_THRESHOLD, n)
        rng = np.random.RandomState(42)
        sample_idx = rng.choice(n, sample_size, replace=False)
        sub_sim = sim[np.ix_(sample_idx, sample_idx)]

        # Spectral embedding on sample
        try:
            degree_s = sub_sim.sum(axis=1)
            D_inv_sqrt = np.diag(1.0 / np.sqrt(np.maximum(degree_s, 1e-10)))
            L_norm = np.eye(sample_size) - D_inv_sqrt @ sub_sim @ D_inv_sqrt
            eigenvalues_s, eigenvectors_s = np.linalg.eigh(L_norm)
            embedding = eigenvectors_s[:, 1:optimal_k + 1]
        except Exception as exc:
            logger.warning("Spectral embedding failed, using random coordinates: %s", exc)
            embedding = rng.rand(sample_size, optimal_k)

        # KMeans on embedding
        if KMeans is not None:
            km = KMeans(n_clusters=optimal_k, random_state=42, n_init=10)
            sample_labels = km.fit_predict(embedding)
        else:
            sample_labels = np.zeros(sample_size, dtype=int)

        # Assign remaining sessions to nearest cluster centroid by similarity
        all_labels = np.full(n, -1, dtype=int)
        for i, si in enumerate(sample_idx):
            all_labels[si] = int(sample_labels[i])

        # For unassigned: find nearest sampled session by similarity
        unassigned = np.where(all_labels < 0)[0]
        if len(unassigned) > 0:
            # Batch similarity lookup: unassigned × sample
            sims_to_sample = sim[np.ix_(unassigned, sample_idx)]  # (unassigned, sample_size)
            nearest = np.argmax(sims_to_sample, axis=1)
            for idx, ui in enumerate(unassigned):
                all_labels[ui] = int(sample_labels[nearest[idx]])

        clusters: dict[int, list[str]] = {}
        for i, label in enumerate(all_labels):
            clusters.setdefault(int(label), []).append(session_ids[i])

        # Sampled 2D embedding for visualization
        embedding_2d = self._spectral_embedding_sampled(sim, session_ids, sample_idx, sample_size)

        return SpectralResult(
            clusters=clusters,
            optimal_k=optimal_k,
            eigengap_scores=eigengap_scores,
            embedding_2d=embedding_2d,
        )

    @staticmethod
    def _eigengap_heuristic(sim, n: int) -> tuple[int, list[float]]:
        """Compute optimal K via eigengap on unnormalized Laplacian."""
        degree = sim.sum(axis=1)
        D = np.diag(degree)
        L = D - sim

        try:
            eigenvalues = np.sort(np.real(np.linalg.eigvalsh(L)))
        except np.linalg.LinAlgError:
            eigenvalues = np.zeros(n)

        gaps = np.diff(eigenvalues[:min(20, n)])
        eigengap_scores = gaps.tolist()

        if len(gaps) > 1:
            optimal_k = int(np.argmax(gaps[1:]) + 2)
            optimal_k = max(2, min(optimal_k, n // 2, 15))
        else:
            optimal_k = 2

        return optimal_k, eigengap_scores

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
            coords = eigenvectors[:, 1:3] if n > 2 else eigenvectors[:, :2]
        except np.linalg.LinAlgError:
            coords = np.random.rand(n, 2)

        for dim in range(min(2, coords.shape[1])):
            col = coords[:, dim]
            cmin, cmax = col.min(), col.max()
            rng = cmax - cmin
            coords[:, dim] = (col - cmin) / rng if rng > 0 else 0.5

        return [
            {"session_id": session_ids[i], "x": round(float(coords[i, 0]), 4), "y": round(float(coords[i, 1]), 4)}
            for i in range(n)
        ]

    @staticmethod
    def _spectral_embedding_sampled(
        similarity,
        session_ids: list[str],
        sample_idx,
        sample_size: int,
    ) -> list[dict[str, float]]:
        """Compute 2D spectral embedding using Nystrom approximation."""
        n = len(session_ids)
        rng = np.random.RandomState(42)

        sub_sim = similarity[np.ix_(sample_idx, sample_idx)]
        degree_s = sub_sim.sum(axis=1)
        D_inv_sqrt = np.diag(1.0 / np.sqrt(np.maximum(degree_s, 1e-10)))
        L_norm = np.eye(sample_size) - D_inv_sqrt @ sub_sim @ D_inv_sqrt

        try:
            eigenvalues, eigenvectors = np.linalg.eigh(L_norm)
            sample_coords = eigenvectors[:, 1:3]
        except np.linalg.LinAlgError:
            sample_coords = rng.rand(sample_size, 2)

        # Extend to full set: assign each point the coords of its nearest sampled neighbor
        coords = np.zeros((n, 2))
        for i, si in enumerate(sample_idx):
            coords[si] = sample_coords[i]

        unassigned = [i for i in range(n) if i not in set(sample_idx)]
        if unassigned:
            sims_to_sample = similarity[np.ix_(unassigned, sample_idx)]
            nearest = np.argmax(sims_to_sample, axis=1)
            for idx, ui in enumerate(unassigned):
                coords[ui] = sample_coords[nearest[idx]] + rng.normal(0, 0.01, 2)

        for dim in range(2):
            col = coords[:, dim]
            cmin, cmax = col.min(), col.max()
            rng_val = cmax - cmin
            if rng_val > 0:
                coords[:, dim] = (col - cmin) / rng_val
            else:
                coords[:, dim] = 0.5

        return [
            {"session_id": session_ids[i], "x": round(float(coords[i, 0]), 4), "y": round(float(coords[i, 1]), 4)}
            for i in range(n)
        ]
