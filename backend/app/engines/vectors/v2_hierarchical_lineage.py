"""V2 Hierarchical Lineage — Ward linkage clustering on table Jaccard distances.

Groups sessions into data domains based on shared table usage,
with silhouette-guided optimal cut and auto-generated domain labels.
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

try:
    from sklearn.metrics import silhouette_score
except ImportError:
    silhouette_score = None

from .feature_extractor import SessionFeatures


@dataclass
class DomainProfile:
    domain_id: int
    label: str
    session_ids: list[str] = field(default_factory=list)
    core_tables: list[str] = field(default_factory=list)
    peripheral_tables: list[str] = field(default_factory=list)
    cross_domain_tables: list[str] = field(default_factory=list)
    session_count: int = 0


@dataclass
class HierarchicalLineageResult:
    domains: list[DomainProfile] = field(default_factory=list)
    optimal_k: int = 0
    silhouette: float = 0.0
    dendrogram_data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "domains": [
                {
                    "domain_id": d.domain_id,
                    "label": d.label,
                    "session_ids": d.session_ids,
                    "core_tables": d.core_tables,
                    "peripheral_tables": d.peripheral_tables,
                    "cross_domain_tables": d.cross_domain_tables,
                    "session_count": d.session_count,
                }
                for d in self.domains
            ],
            "optimal_k": self.optimal_k,
            "silhouette": round(self.silhouette, 4),
        }


class HierarchicalLineageVector:
    """V2: Hierarchical clustering on table-set Jaccard distances."""

    def run(
        self,
        features: list[SessionFeatures],
        similarity_matrix,
    ) -> HierarchicalLineageResult:
        if np is None:
            raise ImportError("numpy is required for HierarchicalLineageVector. Install it with: pip install numpy")
        if linkage is None:
            raise ImportError("scipy is required for HierarchicalLineageVector. Install it with: pip install scipy")
        if silhouette_score is None:
            raise ImportError("scikit-learn is required for HierarchicalLineageVector. Install it with: pip install scikit-learn")
        n = len(features)
        if n < 3:
            # Too few sessions for meaningful clustering
            domains = [DomainProfile(
                domain_id=0,
                label="All Sessions",
                session_ids=[f.session_id for f in features],
                session_count=n,
            )]
            return HierarchicalLineageResult(domains=domains, optimal_k=1)

        # Convert similarity → distance
        distance = 1.0 - similarity_matrix
        np.fill_diagonal(distance, 0.0)
        distance = np.clip(distance, 0.0, 1.0)

        # Make symmetric
        distance = (distance + distance.T) / 2.0

        # Condensed distance for scipy
        condensed = squareform(distance, checks=False)

        # Ward linkage
        Z = linkage(condensed, method="ward")

        # Find optimal K via silhouette score
        best_k = 2
        best_sil = -1.0
        max_k = min(n // 2, 20)

        for k in range(2, max_k + 1):
            labels = fcluster(Z, k, criterion="maxclust")
            if len(set(labels)) < 2:
                continue
            try:
                sil = silhouette_score(distance, labels, metric="precomputed")
            except ValueError:
                continue
            if sil > best_sil:
                best_sil = sil
                best_k = k

        # Apply optimal cut
        labels = fcluster(Z, best_k, criterion="maxclust")

        # Build domain profiles
        clusters: dict[int, list[int]] = {}
        for idx, label in enumerate(labels):
            clusters.setdefault(int(label), []).append(idx)

        # Count table usage across all domains for cross-domain detection
        global_table_domains: dict[str, set[int]] = {}
        for cid, members in clusters.items():
            for idx in members:
                f = features[idx]
                for t in set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables):
                    global_table_domains.setdefault(t, set()).add(cid)

        cross_domain_tables = {t for t, doms in global_table_domains.items() if len(doms) > 1}

        domains = []
        for cid, members in sorted(clusters.items()):
            sids = [features[i].session_id for i in members]

            # Collect all tables in this domain
            all_tables: dict[str, int] = {}
            for idx in members:
                f = features[idx]
                for t in set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables):
                    all_tables[t] = all_tables.get(t, 0) + 1

            # Core tables = used by >50% of domain members
            threshold = len(members) / 2
            core = [t for t, c in all_tables.items() if c > threshold]
            peripheral = [t for t, c in all_tables.items() if c <= threshold and t not in cross_domain_tables]
            cross = [t for t in all_tables if t in cross_domain_tables]

            # Auto-label from most-shared core table
            label = core[0] if core else (list(all_tables.keys())[0] if all_tables else f"Domain_{cid}")

            domains.append(DomainProfile(
                domain_id=cid,
                label=f"Domain: {label}",
                session_ids=sids,
                core_tables=sorted(core),
                peripheral_tables=sorted(peripheral),
                cross_domain_tables=sorted(cross),
                session_count=len(sids),
            ))

        return HierarchicalLineageResult(
            domains=domains,
            optimal_k=best_k,
            silhouette=best_sil,
        )
