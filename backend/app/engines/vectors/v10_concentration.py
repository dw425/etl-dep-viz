"""V10 Concentration — K-Medoids clustering with independence detection.

Groups sessions into gravity groups based on composite weighted similarity,
identifies independent sessions that can be migrated without coordination.
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
    from sklearn.metrics import silhouette_score
except ImportError:
    KMeans = None
    silhouette_score = None

from .feature_extractor import SessionFeatures


@dataclass
class GravityGroup:
    group_id: int
    medoid_session_id: str
    session_ids: list[str] = field(default_factory=list)
    core_tables: list[str] = field(default_factory=list)
    signature_transforms: list[str] = field(default_factory=list)
    cohesion: float = 0.0
    coupling: float = 0.0
    session_count: int = 0


@dataclass
class IndependentSession:
    session_id: str
    independence_type: str  # "full" or "near"
    confidence: float = 0.0
    reason: str = ""


@dataclass
class ConcentrationResult:
    gravity_groups: list[GravityGroup] = field(default_factory=list)
    independent_sessions: list[IndependentSession] = field(default_factory=list)
    optimal_k: int = 0
    silhouette: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "gravity_groups": [
                {
                    "group_id": g.group_id,
                    "medoid_session_id": g.medoid_session_id,
                    "session_ids": g.session_ids,
                    "core_tables": g.core_tables,
                    "signature_transforms": g.signature_transforms,
                    "cohesion": round(g.cohesion, 4),
                    "coupling": round(g.coupling, 4),
                    "session_count": g.session_count,
                }
                for g in self.gravity_groups
            ],
            "independent_sessions": [
                {
                    "session_id": s.session_id,
                    "independence_type": s.independence_type,
                    "confidence": round(s.confidence, 3),
                    "reason": s.reason,
                }
                for s in self.independent_sessions
            ],
            "optimal_k": self.optimal_k,
            "silhouette": round(self.silhouette, 4),
        }


class ConcentrationVector:
    """V10: K-Medoids clustering with independence detection."""

    # Independence criteria thresholds
    INDEPENDENCE_CRITERIA = {
        "max_upstream": 0,
        "max_downstream": 0,
        "max_write_conflicts": 0,
        "max_chain_involvement": 0,
        "max_shared_tables": 1,
        "max_staleness": 0,
    }

    def run(
        self,
        features: list[SessionFeatures],
        similarity_matrix,
    ) -> ConcentrationResult:
        if np is None:
            raise ImportError("numpy is required for ConcentrationVector. Install it with: pip install numpy")
        if KMeans is None:
            raise ImportError("scikit-learn is required for ConcentrationVector. Install it with: pip install scikit-learn")
        n = len(features)
        if n < 2:
            return ConcentrationResult()

        # Step 1: Identify independent sessions
        independents = self._detect_independents(features, similarity_matrix)
        independent_ids = {s.session_id for s in independents}

        # Step 2: Cluster remaining sessions
        clusterable_idx = [i for i, f in enumerate(features) if f.session_id not in independent_ids]

        if len(clusterable_idx) < 2:
            return ConcentrationResult(
                independent_sessions=independents,
                optimal_k=0,
            )

        # Build sub-matrix for clusterable sessions
        sub_sim = similarity_matrix[np.ix_(clusterable_idx, clusterable_idx)]
        sub_features = [features[i] for i in clusterable_idx]

        # Find optimal K (target ~10 but silhouette-guided)
        target_k = min(10, len(clusterable_idx) // 2)
        best_k = max(2, target_k)
        best_sil = -1.0

        distance = 1.0 - sub_sim
        np.fill_diagonal(distance, 0.0)
        distance = np.clip(distance, 0.0, 1.0)

        for k in range(2, min(target_k + 5, len(clusterable_idx))):
            try:
                # Use KMeans on distance matrix as approximate K-Medoids
                km = KMeans(n_clusters=k, random_state=42, n_init=10)
                labels = km.fit_predict(distance)
                if len(set(labels)) < 2:
                    continue
                sil = silhouette_score(distance, labels, metric="precomputed")
                if sil > best_sil:
                    best_sil = sil
                    best_k = k
            except Exception:
                continue

        # Final clustering
        km = KMeans(n_clusters=best_k, random_state=42, n_init=10)
        labels = km.fit_predict(distance)

        # Build gravity groups
        groups: dict[int, list[int]] = {}
        for idx, label in enumerate(labels):
            groups.setdefault(int(label), []).append(idx)

        gravity_groups = []
        for gid, members in sorted(groups.items()):
            member_features = [sub_features[i] for i in members]
            sids = [f.session_id for f in member_features]

            # Find medoid (most central member)
            medoid_idx = self._find_medoid(members, sub_sim)
            medoid_sid = sub_features[medoid_idx].session_id

            # Core tables = tables shared by >50% of group
            table_counts: dict[str, int] = {}
            for f in member_features:
                for t in set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables):
                    table_counts[t] = table_counts.get(t, 0) + 1
            threshold = len(members) / 2
            core = sorted([t for t, c in table_counts.items() if c > threshold])

            # Cohesion = average intra-group similarity
            intra_sims = []
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    intra_sims.append(float(sub_sim[members[i], members[j]]))
            cohesion = sum(intra_sims) / len(intra_sims) if intra_sims else 0.0

            # Coupling = average inter-group similarity
            other_idx = [i for i in range(len(sub_features)) if i not in members]
            inter_sims = []
            for mi in members:
                for oi in other_idx:
                    inter_sims.append(float(sub_sim[mi, oi]))
            coupling = sum(inter_sims) / len(inter_sims) if inter_sims else 0.0

            gravity_groups.append(GravityGroup(
                group_id=gid,
                medoid_session_id=medoid_sid,
                session_ids=sids,
                core_tables=core[:10],
                session_count=len(sids),
                cohesion=cohesion,
                coupling=coupling,
            ))

        return ConcentrationResult(
            gravity_groups=gravity_groups,
            independent_sessions=independents,
            optimal_k=best_k,
            silhouette=best_sil,
        )

    def _detect_independents(
        self,
        features: list[SessionFeatures],
        similarity,
    ) -> list[IndependentSession]:
        """Detect sessions that are independent (can migrate without coordination)."""
        independents = []
        n = len(features)

        for i, f in enumerate(features):
            reasons = []
            full = True
            confidence = 1.0

            # Check 6 strict criteria
            if f.upstream_count > self.INDEPENDENCE_CRITERIA["max_upstream"]:
                full = False
            else:
                reasons.append("no upstream deps")

            if f.downstream_count > self.INDEPENDENCE_CRITERIA["max_downstream"]:
                full = False
            else:
                reasons.append("no downstream deps")

            if f.write_conflict_count > self.INDEPENDENCE_CRITERIA["max_write_conflicts"]:
                full = False
            else:
                reasons.append("no write conflicts")

            if f.chain_involvement > self.INDEPENDENCE_CRITERIA["max_chain_involvement"]:
                full = False
            else:
                reasons.append("no chain involvement")

            if f.staleness_risk > self.INDEPENDENCE_CRITERIA["max_staleness"]:
                full = False
            else:
                reasons.append("no staleness risk")

            # Check shared tables with other sessions
            my_tables = set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables)
            shared_count = 0
            for j, f2 in enumerate(features):
                if i == j:
                    continue
                other_tables = set(f2.source_tables) | set(f2.target_tables) | set(f2.lookup_tables)
                if my_tables & other_tables:
                    shared_count += 1

            if shared_count > self.INDEPENDENCE_CRITERIA["max_shared_tables"]:
                full = False
            else:
                reasons.append("minimal shared tables")

            # Max similarity to any other session
            max_sim = 0.0
            for j in range(n):
                if i != j:
                    max_sim = max(max_sim, float(similarity[i, j]))

            if max_sim < 0.1:
                reasons.append("low similarity to all")
                confidence = min(confidence, 1.0 - max_sim)

            if full:
                independents.append(IndependentSession(
                    session_id=f.session_id,
                    independence_type="full",
                    confidence=confidence,
                    reason="; ".join(reasons),
                ))
            elif len(reasons) >= 4 and max_sim < 0.2:
                independents.append(IndependentSession(
                    session_id=f.session_id,
                    independence_type="near",
                    confidence=confidence * 0.7,
                    reason="; ".join(reasons),
                ))

        return independents

    @staticmethod
    def _find_medoid(members: list[int], similarity) -> int:
        """Find the member with highest average similarity to other members."""
        best_idx = members[0]
        best_avg = -1.0
        for i in members:
            avg = sum(float(similarity[i, j]) for j in members if j != i) / max(len(members) - 1, 1)
            if avg > best_avg:
                best_avg = avg
                best_idx = i
        return best_idx
