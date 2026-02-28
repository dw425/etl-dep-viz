"""V11 Complexity Analyzer — 8-dimension weighted complexity scoring.

Scores each session across 8 dimensions and assigns complexity buckets
(Simple/Medium/Complex/Very Complex) with hours estimates.
"""

from __future__ import annotations

import math
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
        "D4_table_footprint": 0.10,
        "D5_lookup_intensity": 0.15,
        "D6_coupling": 0.10,
        "D7_structural_depth": 0.10,
        "D8_volume_proxy": 0.10,
    })

    # Bucket boundaries (0-100 scale)
    bucket_thresholds: dict[str, tuple[int, int]] = field(default_factory=lambda: {
        "Simple": (0, 25),
        "Medium": (26, 50),
        "Complex": (51, 75),
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

        # Compute population stats for normalization
        stats = self._compute_population_stats(features)

        scores = []
        for feat in features:
            score = self._score_session(feat, stats)
            scores.append(score)

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

    def _compute_population_stats(self, features: list[SessionFeatures]) -> dict[str, dict[str, float]]:
        """Compute min/max/mean for each raw dimension across the population."""
        dims = {
            "D1_transform_volume": [f.transform_count for f in features],
            "D2_diversity": [len(set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables)) for f in features],
            "D3_risk": [f.write_conflict_count + f.staleness_risk for f in features],
            "D4_table_footprint": [f.total_table_footprint for f in features],
            "D5_lookup_intensity": [f.lookup_count for f in features],
            "D6_coupling": [f.upstream_count + f.downstream_count for f in features],
            "D7_structural_depth": [f.dependency_depth for f in features],
            "D8_volume_proxy": [f.ext_reads + f.transform_count for f in features],
        }

        stats = {}
        for name, values in dims.items():
            vmin = min(values) if values else 0
            vmax = max(values) if values else 0
            vmean = sum(values) / len(values) if values else 0
            stats[name] = {"min": vmin, "max": vmax, "mean": vmean}
        return stats

    def _score_session(
        self,
        feat: SessionFeatures,
        stats: dict[str, dict[str, float]],
    ) -> SessionComplexityScore:
        """Score a single session across all 8 dimensions."""
        raw_values = {
            "D1_transform_volume": feat.transform_count,
            "D2_diversity": len(set(feat.source_tables) | set(feat.target_tables) | set(feat.lookup_tables)),
            "D3_risk": feat.write_conflict_count + feat.staleness_risk,
            "D4_table_footprint": feat.total_table_footprint,
            "D5_lookup_intensity": feat.lookup_count,
            "D6_coupling": feat.upstream_count + feat.downstream_count,
            "D7_structural_depth": feat.dependency_depth,
            "D8_volume_proxy": feat.ext_reads + feat.transform_count,
        }

        dimensions = []
        for dim_name, raw in raw_values.items():
            s = stats[dim_name]
            rng = s["max"] - s["min"]
            normalized = ((raw - s["min"]) / rng * 100.0) if rng > 0 else 50.0
            normalized = max(0.0, min(100.0, normalized))
            weight = self.config.weights.get(dim_name, 0.1)
            dimensions.append(DimensionScore(
                name=dim_name,
                raw_value=raw,
                normalized=normalized,
                weight=weight,
                weighted_score=normalized * weight,
            ))

        overall = sum(d.weighted_score for d in dimensions)
        overall = max(0.0, min(100.0, overall))

        bucket = self._assign_bucket(overall)
        hours = self.config.hours_per_bucket.get(bucket, (16, 40))
        factor = self.config.accelerator_factor

        # Top 3 drivers
        sorted_dims = sorted(dimensions, key=lambda d: d.weighted_score, reverse=True)
        top_drivers = [d.name.replace("_", " ").title() for d in sorted_dims[:3]]

        return SessionComplexityScore(
            session_id=feat.session_id,
            name=feat.name,
            overall_score=overall,
            bucket=bucket,
            dimensions=dimensions,
            hours_estimate_low=hours[0] * factor,
            hours_estimate_high=hours[1] * factor,
            top_drivers=top_drivers,
        )

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
