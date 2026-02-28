"""Drill-Through Engine — cross-variable filtering across all vector dimensions.

Supports slicing by ANY combination of V1–V11 dimensions simultaneously,
with aggregation (count, avg, sum, distribution).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class FilteredResult:
    matching_session_ids: list[str] = field(default_factory=list)
    total_matches: int = 0
    aggregates: dict[str, Any] = field(default_factory=dict)
    dimension_distributions: dict[str, dict[str, int]] = field(default_factory=dict)


class DrillThroughEngine:
    """Cross-dimension filtering engine for vector analysis results."""

    def filter(
        self,
        vector_results: dict[str, Any],
        dimensions: dict[str, Any],
    ) -> dict[str, Any]:
        """Filter sessions by any combination of vector dimensions.

        Args:
            vector_results: Full output from VectorOrchestrator.run_all()
            dimensions: Filter criteria, e.g.:
                {
                    "community_macro": 2,
                    "complexity_bucket": "Very Complex",
                    "wave_number": [3, 4],
                    "criticality_tier_min": 3,
                    "domain_id": 1,
                    "is_independent": True,
                }

        Returns:
            FilteredResult with matching sessions + aggregates.
        """
        session_ids = vector_results.get("session_ids", [])
        if not session_ids:
            return {"matching_session_ids": [], "total_matches": 0}

        # Build session-level index
        index = self._build_index(vector_results, session_ids)

        # Apply filters
        matching = set(session_ids)

        for dim, value in dimensions.items():
            filtered = set()
            for sid in matching:
                props = index.get(sid, {})
                if self._matches(props, dim, value):
                    filtered.add(sid)
            matching = filtered

        matching_list = sorted(matching)

        # Compute aggregates
        aggregates = self._compute_aggregates(index, matching_list)

        # Dimension distributions for filtered set
        distributions = self._compute_distributions(index, matching_list)

        return {
            "matching_session_ids": matching_list,
            "total_matches": len(matching_list),
            "aggregates": aggregates,
            "dimension_distributions": distributions,
        }

    def _build_index(
        self,
        results: dict[str, Any],
        session_ids: list[str],
    ) -> dict[str, dict[str, Any]]:
        """Build per-session property index from all vector results."""
        index: dict[str, dict[str, Any]] = {sid: {} for sid in session_ids}

        # V1: Community assignments
        v1 = results.get("v1_communities", {})
        for a in v1.get("assignments", []):
            sid = a.get("session_id")
            if sid in index:
                index[sid]["community_macro"] = a.get("macro", -1)
                index[sid]["community_meso"] = a.get("meso", -1)
                index[sid]["community_micro"] = a.get("micro", -1)

        # V2: Domain assignments
        v2 = results.get("v2_hierarchical_lineage", {})
        for d in v2.get("domains", []):
            for sid in d.get("session_ids", []):
                if sid in index:
                    index[sid]["domain_id"] = d["domain_id"]
                    index[sid]["domain_label"] = d.get("label", "")

        # V4: Wave assignments
        v4 = results.get("v4_wave_plan", {})
        for w in v4.get("waves", []):
            for sid in w.get("session_ids", []):
                if sid in index:
                    index[sid]["wave_number"] = w["wave_number"]

        # V9: Criticality
        v9 = results.get("v9_wave_function", {})
        for s in v9.get("sessions", []):
            sid = s.get("session_id")
            if sid in index:
                index[sid]["criticality_tier"] = s.get("criticality_tier", 0)
                index[sid]["blast_radius"] = s.get("blast_radius", 0)
                index[sid]["criticality_score"] = s.get("criticality_score", 0.0)

        # V10: Independence
        v10 = results.get("v10_concentration", {})
        independent_ids = set()
        for s in v10.get("independent_sessions", []):
            independent_ids.add(s["session_id"])
            if s["session_id"] in index:
                index[s["session_id"]]["is_independent"] = True
                index[s["session_id"]]["independence_type"] = s.get("independence_type", "")
        for g in v10.get("gravity_groups", []):
            for sid in g.get("session_ids", []):
                if sid in index:
                    index[sid]["gravity_group"] = g["group_id"]
                    index[sid]["is_independent"] = sid in independent_ids

        # V11: Complexity
        v11 = results.get("v11_complexity", {})
        for s in v11.get("scores", []):
            sid = s.get("session_id")
            if sid in index:
                index[sid]["complexity_score"] = s.get("overall_score", 0.0)
                index[sid]["complexity_bucket"] = s.get("bucket", "")

        return index

    @staticmethod
    def _matches(props: dict, dim: str, value: Any) -> bool:
        """Check if a session's properties match the filter criterion."""
        if dim not in props and not dim.endswith("_min") and not dim.endswith("_max"):
            return True  # dimension not available, don't filter

        if dim.endswith("_min"):
            base = dim[:-4]
            return props.get(base, 0) >= value

        if dim.endswith("_max"):
            base = dim[:-4]
            return props.get(base, 0) <= value

        actual = props.get(dim)

        if isinstance(value, list):
            return actual in value
        if isinstance(value, bool):
            return bool(actual) == value
        return actual == value

    @staticmethod
    def _compute_aggregates(
        index: dict[str, dict[str, Any]],
        session_ids: list[str],
    ) -> dict[str, Any]:
        """Compute aggregate stats for the filtered set."""
        if not session_ids:
            return {}

        complexities = [index[s].get("complexity_score", 0.0) for s in session_ids]
        criticalities = [index[s].get("criticality_score", 0.0) for s in session_ids]
        blast = [index[s].get("blast_radius", 0) for s in session_ids]

        return {
            "count": len(session_ids),
            "avg_complexity": round(sum(complexities) / len(complexities), 1) if complexities else 0,
            "avg_criticality": round(sum(criticalities) / len(criticalities), 1) if criticalities else 0,
            "max_blast_radius": max(blast) if blast else 0,
            "independent_count": sum(1 for s in session_ids if index[s].get("is_independent")),
        }

    @staticmethod
    def _compute_distributions(
        index: dict[str, dict[str, Any]],
        session_ids: list[str],
    ) -> dict[str, dict[str, int]]:
        """Compute distributions for categorical dimensions."""
        dims_to_count = ["complexity_bucket", "criticality_tier", "wave_number", "community_macro", "domain_id"]
        distributions: dict[str, dict[str, int]] = {}

        for dim in dims_to_count:
            dist: dict[str, int] = {}
            for sid in session_ids:
                val = index[sid].get(dim)
                if val is not None:
                    key = str(val)
                    dist[key] = dist.get(key, 0) + 1
            if dist:
                distributions[dim] = dist

        return distributions
