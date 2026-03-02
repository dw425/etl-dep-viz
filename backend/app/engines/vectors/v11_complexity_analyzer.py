"""V11 Complexity Analyzer — 8-dimension weighted complexity scoring.

Scores each session across 8 dimensions using percentile-based normalization
and assigns complexity buckets (Simple/Medium/Complex/Very Complex) with
hours estimates.

Dimension Definitions:
  D1: Transform Volume  — number of transform operations
  D2: Table Diversity    — count of unique tables touched (source ∪ target ∪ lookup)
  D3: Risk               — write conflicts + staleness risks
  D4: IO Volume          — total table references (sources + targets + lookups, non-unique)
  D5: Lookup Intensity   — number of lookup operations
  D6: Coupling           — how many other sessions share tables with this session
  D7: Structural Depth   — tier (position in dependency chain)
  D8: External Reads     — external read operations

Normalization: Percentile-based (outlier-resistant). For dimensions where 0
means "no complexity" (D1, D3, D4, D5, D6, D8), zero values map to 0 and
non-zero values are percentile-ranked within the non-zero subset.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from .feature_extractor import SessionFeatures


@dataclass
class ComplexityConfig:
    """Tunable thresholds for complexity scoring."""

    # Dimension weights (must sum to 1.0)
    weights: dict[str, float] = field(default_factory=lambda: {
        "D1_transform_volume": 0.15,
        "D2_diversity": 0.10,
        "D3_risk": 0.20,
        "D4_io_volume": 0.10,
        "D5_lookup_intensity": 0.10,
        "D6_coupling": 0.15,
        "D7_structural_depth": 0.10,
        "D8_external_reads": 0.10,
    })

    # Bucket boundaries (0-100 scale)
    bucket_thresholds: dict[str, tuple[int, int]] = field(default_factory=lambda: {
        "Simple": (0, 30),
        "Medium": (31, 55),
        "Complex": (56, 75),
        "Very Complex": (76, 100),
    })

    # Hours estimates per bucket (low, high)
    hours_per_bucket: dict[str, tuple[float, float]] = field(default_factory=lambda: {
        "Simple": (4.0, 8.0),
        "Medium": (16.0, 40.0),
        "Complex": (40.0, 80.0),
        "Very Complex": (80.0, 200.0),
    })

    # Accelerator factor (e.g., for automated migration tools)
    accelerator_factor: float = 0.7

    # Dimensions where raw value 0 means "no complexity contribution"
    zero_floor_dims: set[str] = field(default_factory=lambda: {
        "D1_transform_volume", "D3_risk", "D4_io_volume",
        "D5_lookup_intensity", "D6_coupling", "D8_external_reads",
    })


@dataclass
class DimensionScore:
    name: str
    raw_value: float
    normalized: float  # 0-100
    weight: float
    weighted_score: float  # normalized * weight


@dataclass
class SessionComplexityScore:
    session_id: str
    name: str
    overall_score: float  # 0-100
    bucket: str
    dimensions: list[DimensionScore] = field(default_factory=list)
    hours_estimate_low: float = 0.0
    hours_estimate_high: float = 0.0
    top_drivers: list[str] = field(default_factory=list)


@dataclass
class ComplexityAnalysisResult:
    scores: list[SessionComplexityScore] = field(default_factory=list)
    bucket_distribution: dict[str, int] = field(default_factory=dict)
    aggregate_stats: dict[str, float] = field(default_factory=dict)
    total_hours_low: float = 0.0
    total_hours_high: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "scores": [
                {
                    "session_id": s.session_id,
                    "name": s.name,
                    "overall_score": round(s.overall_score, 1),
                    "bucket": s.bucket,
                    "dimensions": [
                        {
                            "name": d.name,
                            "raw_value": round(d.raw_value, 2),
                            "normalized": round(d.normalized, 1),
                            "weight": d.weight,
                            "weighted_score": round(d.weighted_score, 2),
                        }
                        for d in s.dimensions
                    ],
                    "hours_estimate_low": round(s.hours_estimate_low, 1),
                    "hours_estimate_high": round(s.hours_estimate_high, 1),
                    "top_drivers": s.top_drivers,
                }
                for s in self.scores
            ],
            "bucket_distribution": self.bucket_distribution,
            "aggregate_stats": self.aggregate_stats,
            "total_hours_low": round(self.total_hours_low, 1),
            "total_hours_high": round(self.total_hours_high, 1),
        }


class ComplexityAnalyzer:
    """V11: 8-dimension complexity analysis for ETL sessions."""

    def __init__(self, config: ComplexityConfig | None = None):
        self.config = config or ComplexityConfig()

    def run(self, features: list[SessionFeatures]) -> ComplexityAnalysisResult:
        if not features:
            return ComplexityAnalysisResult()

        # Compute shared-table coupling across the population
        coupling_map = self._compute_coupling(features)

        # Collect raw dimension values for every session
        dim_names = list(self.config.weights.keys())
        raw_by_dim: dict[str, list[float]] = {d: [] for d in dim_names}

        for feat in features:
            raws = self._raw_values(feat, coupling_map)
            for d in dim_names:
                raw_by_dim[d].append(raws[d])

        # Percentile-normalize each dimension across the population
        norm_by_dim: dict[str, list[float]] = {}
        for d in dim_names:
            zero_floor = d in self.config.zero_floor_dims
            norm_by_dim[d] = self._percentile_normalize(raw_by_dim[d], zero_floor)

        # Build per-session scores
        scores: list[SessionComplexityScore] = []
        for i, feat in enumerate(features):
            dimensions: list[DimensionScore] = []
            for d in dim_names:
                w = self.config.weights[d]
                dimensions.append(DimensionScore(
                    name=d,
                    raw_value=raw_by_dim[d][i],
                    normalized=norm_by_dim[d][i],
                    weight=w,
                    weighted_score=norm_by_dim[d][i] * w,
                ))

            overall = sum(dim.weighted_score for dim in dimensions)
            overall = max(0.0, min(100.0, overall))

            bucket = self._assign_bucket(overall)
            hours = self.config.hours_per_bucket.get(bucket, (16, 40))
            factor = self.config.accelerator_factor

            # Top 3 drivers
            sorted_dims = sorted(dimensions, key=lambda d: d.weighted_score, reverse=True)
            top_drivers = [d.name.replace("_", " ").title() for d in sorted_dims[:3]]

            scores.append(SessionComplexityScore(
                session_id=feat.session_id,
                name=feat.name,
                overall_score=overall,
                bucket=bucket,
                dimensions=dimensions,
                hours_estimate_low=hours[0] * factor,
                hours_estimate_high=hours[1] * factor,
                top_drivers=top_drivers,
            ))

        # Bucket distribution
        dist: dict[str, int] = {"Simple": 0, "Medium": 0, "Complex": 0, "Very Complex": 0}
        for s in scores:
            dist[s.bucket] = dist.get(s.bucket, 0) + 1

        # Aggregate stats
        all_scores = [s.overall_score for s in scores]
        agg = {
            "mean_score": round(sum(all_scores) / len(all_scores), 1) if all_scores else 0.0,
            "median_score": round(sorted(all_scores)[len(all_scores) // 2], 1) if all_scores else 0.0,
            "max_score": round(max(all_scores), 1) if all_scores else 0.0,
            "min_score": round(min(all_scores), 1) if all_scores else 0.0,
            "std_dev": round(self._std(all_scores), 1),
        }

        total_low = sum(s.hours_estimate_low for s in scores)
        total_high = sum(s.hours_estimate_high for s in scores)

        return ComplexityAnalysisResult(
            scores=scores,
            bucket_distribution=dist,
            aggregate_stats=agg,
            total_hours_low=total_low,
            total_hours_high=total_high,
        )

    # ------------------------------------------------------------------
    # Raw dimension extraction
    # ------------------------------------------------------------------

    def _raw_values(self, feat: SessionFeatures, coupling: dict[str, int]) -> dict[str, float]:
        """Compute raw dimension values for a single session."""
        return {
            "D1_transform_volume": feat.transform_count,
            "D2_diversity": len(
                set(feat.source_tables) | set(feat.target_tables) | set(feat.lookup_tables)
            ),
            "D3_risk": feat.write_conflict_count + feat.staleness_risk,
            "D4_io_volume": (
                len(feat.source_tables) + len(feat.target_tables) + len(feat.lookup_tables)
            ),
            "D5_lookup_intensity": feat.lookup_count,
            "D6_coupling": coupling.get(feat.session_id, 0),
            "D7_structural_depth": feat.dependency_depth,
            "D8_external_reads": feat.ext_reads,
        }

    # ------------------------------------------------------------------
    # Coupling: shared-table overlap across the population
    # ------------------------------------------------------------------

    def _compute_coupling(self, features: list[SessionFeatures]) -> dict[str, int]:
        """Count how many *other* sessions share at least one table with each session."""
        table_to_sessions: dict[str, set[str]] = defaultdict(set)
        for f in features:
            all_tables = set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables)
            for t in all_tables:
                table_to_sessions[t].add(f.session_id)

        coupling: dict[str, int] = {}
        for f in features:
            all_tables = set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables)
            shared: set[str] = set()
            for t in all_tables:
                shared |= table_to_sessions[t]
            shared.discard(f.session_id)
            coupling[f.session_id] = len(shared)

        return coupling

    # ------------------------------------------------------------------
    # Percentile normalization (outlier-resistant)
    # ------------------------------------------------------------------

    def _percentile_normalize(
        self, values: list[float], zero_floor: bool = False
    ) -> list[float]:
        """Normalize values to 0-100 using percentile rank.

        If zero_floor=True, raw value 0 always maps to normalized 0 and
        non-zero values are percentile-ranked within the non-zero subset
        (scaled to 1-100).
        """
        n = len(values)
        if n == 0:
            return []
        if n == 1:
            return [50.0]

        if zero_floor:
            nz_indices = [i for i in range(n) if values[i] > 0]
            if not nz_indices:
                return [0.0] * n  # all zeros → no complexity
            result = [0.0] * n
            nz_values = [values[i] for i in nz_indices]
            nz_norms = self._rank_to_percentile(nz_values)
            for idx, norm in zip(nz_indices, nz_norms):
                result[idx] = max(1.0, norm)  # non-zero always ≥ 1
            return result
        else:
            return self._rank_to_percentile(values)

    @staticmethod
    def _rank_to_percentile(values: list[float]) -> list[float]:
        """Pure percentile rank: sorted position → 0-100 scale.

        Handles ties by assigning the average rank of the tie group.
        """
        n = len(values)
        if n <= 1:
            return [50.0] * n

        sorted_idx = sorted(range(n), key=lambda i: values[i])
        result = [0.0] * n

        i = 0
        while i < n:
            j = i
            while j < n and values[sorted_idx[j]] == values[sorted_idx[i]]:
                j += 1
            avg_rank = (i + j - 1) / 2.0
            pct = avg_rank / (n - 1) * 100.0
            for k in range(i, j):
                result[sorted_idx[k]] = pct
            i = j

        return result

    # ------------------------------------------------------------------
    # Bucket assignment
    # ------------------------------------------------------------------

    def _assign_bucket(self, score: float) -> str:
        for name, (low, high) in self.config.bucket_thresholds.items():
            if low <= score <= high:
                return name
        return "Very Complex" if score > 75 else "Simple"

    @staticmethod
    def _std(values: list[float]) -> float:
        if len(values) < 2:
            return 0.0
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        return math.sqrt(variance)
