"""Migration effort estimator — calculates total effort and timeline.

Uses V11 complexity scores, configurable team parameters, and optional
code generation coverage to produce P10/P50/P90 effort estimates with
interactive scenario modeling.

Usage:
    estimator = MigrationEffortEstimator()
    result = estimator.estimate(complexity_scores, team_size=5)
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

logger = logging.getLogger("edv.effort_estimator")


# Hours per session by complexity bucket (low, mid, high)
_BUCKET_HOURS = {
    "Simple": (4.0, 6.0, 8.0),
    "Medium": (16.0, 28.0, 40.0),
    "Complex": (40.0, 60.0, 80.0),
    "Very Complex": (80.0, 140.0, 200.0),
}


@dataclass
class EffortEstimate:
    """Migration effort estimate result."""
    total_sessions: int = 0
    bucket_distribution: dict[str, int] = field(default_factory=dict)

    # Effort estimates (hours)
    total_hours_p10: float = 0.0   # optimistic (10th percentile)
    total_hours_p50: float = 0.0   # median
    total_hours_p90: float = 0.0   # pessimistic (90th percentile)

    # Timeline estimates (weeks)
    timeline_weeks_p10: float = 0.0
    timeline_weeks_p50: float = 0.0
    timeline_weeks_p90: float = 0.0

    # Parameters used
    team_size: int = 1
    hours_per_week: float = 40.0
    parallelism_factor: float = 0.8
    automation_discount: float = 0.0

    # Per-wave breakdown
    wave_estimates: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "total_sessions": self.total_sessions,
            "bucket_distribution": self.bucket_distribution,
            "total_hours": {
                "p10": round(self.total_hours_p10, 1),
                "p50": round(self.total_hours_p50, 1),
                "p90": round(self.total_hours_p90, 1),
            },
            "timeline_weeks": {
                "p10": round(self.timeline_weeks_p10, 1),
                "p50": round(self.timeline_weeks_p50, 1),
                "p90": round(self.timeline_weeks_p90, 1),
            },
            "parameters": {
                "team_size": self.team_size,
                "hours_per_week": self.hours_per_week,
                "parallelism_factor": self.parallelism_factor,
                "automation_discount": self.automation_discount,
            },
            "wave_estimates": self.wave_estimates,
        }


class MigrationEffortEstimator:
    """Estimate migration effort based on complexity scores and team parameters."""

    def estimate(
        self,
        complexity_scores: list[dict],
        team_size: int = 5,
        hours_per_week: float = 40.0,
        parallelism_factor: float = 0.8,
        automation_discount: float = 0.0,
        wave_plan: dict | None = None,
    ) -> EffortEstimate:
        """Calculate effort estimates.

        Args:
            complexity_scores: V11 scores with 'bucket' field per session.
            team_size: Number of engineers on the migration team.
            hours_per_week: Working hours per engineer per week.
            parallelism_factor: Fraction of time usable in parallel (0-1).
                               Accounts for meetings, context switching, dependencies.
            automation_discount: Fraction of effort saved by automation (0-1).
                                 e.g., 0.3 = 30% saved via code generation.
            wave_plan: Optional V4 wave plan for per-wave breakdown.

        Returns:
            EffortEstimate with P10/P50/P90 bounds.
        """
        result = EffortEstimate(
            total_sessions=len(complexity_scores),
            team_size=team_size,
            hours_per_week=hours_per_week,
            parallelism_factor=parallelism_factor,
            automation_discount=automation_discount,
        )

        if not complexity_scores:
            return result

        # Count buckets and accumulate hours
        dist: dict[str, int] = {"Simple": 0, "Medium": 0, "Complex": 0, "Very Complex": 0}
        total_p10 = 0.0
        total_p50 = 0.0
        total_p90 = 0.0

        for score in complexity_scores:
            bucket = score.get("bucket", "Medium")
            dist[bucket] = dist.get(bucket, 0) + 1
            hours = _BUCKET_HOURS.get(bucket, _BUCKET_HOURS["Medium"])
            total_p10 += hours[0]
            total_p50 += hours[1]
            total_p90 += hours[2]

        # Apply automation discount
        discount = 1.0 - automation_discount
        total_p10 *= discount
        total_p50 *= discount
        total_p90 *= discount

        result.bucket_distribution = dist
        result.total_hours_p10 = total_p10
        result.total_hours_p50 = total_p50
        result.total_hours_p90 = total_p90

        # Timeline = total_hours / (team_size * hours_per_week * parallelism)
        effective_capacity = team_size * hours_per_week * parallelism_factor
        if effective_capacity > 0:
            result.timeline_weeks_p10 = total_p10 / effective_capacity
            result.timeline_weeks_p50 = total_p50 / effective_capacity
            result.timeline_weeks_p90 = total_p90 / effective_capacity

        # Per-wave breakdown if wave plan available
        if wave_plan:
            session_buckets = {s.get("session_id"): s.get("bucket", "Medium") for s in complexity_scores}
            for wave in wave_plan.get("waves", []):
                wave_num = wave.get("wave_number", wave.get("wave", 0))
                wave_sids = wave.get("session_ids", [])
                wave_p10 = 0.0
                wave_p50 = 0.0
                wave_p90 = 0.0
                for sid in wave_sids:
                    bucket = session_buckets.get(sid, "Medium")
                    hours = _BUCKET_HOURS.get(bucket, _BUCKET_HOURS["Medium"])
                    wave_p10 += hours[0] * discount
                    wave_p50 += hours[1] * discount
                    wave_p90 += hours[2] * discount

                result.wave_estimates.append({
                    "wave_number": wave_num,
                    "session_count": len(wave_sids),
                    "hours_p10": round(wave_p10, 1),
                    "hours_p50": round(wave_p50, 1),
                    "hours_p90": round(wave_p90, 1),
                    "weeks_p50": round(wave_p50 / max(effective_capacity, 1), 1),
                })

        logger.info("Effort estimate: %d sessions, P50=%.0f hrs (%.1f weeks), team=%d",
                     len(complexity_scores), total_p50,
                     result.timeline_weeks_p50, team_size)
        return result
