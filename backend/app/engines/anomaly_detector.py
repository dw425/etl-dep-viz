"""Anomaly detection for ETL sessions using statistical methods.

Uses Z-score analysis on the 32-feature vector to identify sessions that
deviate significantly from population norms. Flags specific anomaly types
(no transforms, orphaned sessions, extreme lookups, etc.) with explanations.

Falls back to simple heuristic rules when numpy/scipy are unavailable.

Usage:
    from app.engines.anomaly_detector import AnomalyDetector
    detector = AnomalyDetector()
    anomalies = detector.detect(features)
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

logger = logging.getLogger("edv.anomaly_detector")

try:
    import numpy as np
except ImportError:
    np = None


@dataclass
class Anomaly:
    """A detected anomaly in a session."""
    session_id: str
    session_name: str
    anomaly_score: float  # 0-1, higher = more anomalous
    anomaly_types: list[str] = field(default_factory=list)
    explanations: list[str] = field(default_factory=list)


@dataclass
class AnomalyResult:
    """Result from anomaly detection analysis."""
    anomalies: list[Anomaly] = field(default_factory=list)
    total_sessions: int = 0
    anomaly_count: int = 0
    threshold: float = 0.5

    def to_dict(self) -> dict:
        return {
            "anomalies": [
                {
                    "session_id": a.session_id,
                    "session_name": a.session_name,
                    "anomaly_score": round(a.anomaly_score, 3),
                    "anomaly_types": a.anomaly_types,
                    "explanations": a.explanations,
                }
                for a in self.anomalies
            ],
            "total_sessions": self.total_sessions,
            "anomaly_count": self.anomaly_count,
            "threshold": self.threshold,
        }


class AnomalyDetector:
    """Detect anomalous ETL sessions via statistical and rule-based analysis."""

    def __init__(self, z_threshold: float = 2.5, score_threshold: float = 0.5):
        self.z_threshold = z_threshold
        self.score_threshold = score_threshold

    def detect(self, features: list) -> AnomalyResult:
        """Run anomaly detection on SessionFeatures.

        Combines statistical (Z-score) and rule-based detection:
          1. Z-score on numeric features — flags sessions > z_threshold std devs
          2. Heuristic rules — specific domain knowledge patterns
          3. Combined score normalized to 0-1

        Args:
            features: list of SessionFeatures objects.

        Returns:
            AnomalyResult with flagged anomalous sessions.
        """
        if not features:
            return AnomalyResult()

        result = AnomalyResult(total_sessions=len(features))

        for feat in features:
            types = []
            explanations = []
            scores = []

            # Rule 1: Zero transforms (likely parse failure)
            if feat.transform_count == 0:
                types.append("zero_transforms")
                explanations.append("Session has 0 transforms — possible parse failure")
                scores.append(0.8)

            # Rule 2: Orphaned (no sources AND no targets)
            if not feat.source_tables and not feat.target_tables:
                types.append("orphaned")
                explanations.append("Session has no source or target tables")
                scores.append(0.7)

            # Rule 3: Extreme lookup count (>20)
            if feat.lookup_count > 20:
                types.append("extreme_lookups")
                explanations.append(f"Session has {feat.lookup_count} lookups (extremely high)")
                scores.append(0.6)

            # Rule 4: No workflow association
            if not feat.workflow_name:
                types.append("no_workflow")
                explanations.append("Session not associated with any workflow")
                scores.append(0.3)

            # Rule 5: Extreme write conflicts
            if feat.write_conflict_count > 5:
                types.append("high_write_conflicts")
                explanations.append(f"Session has {feat.write_conflict_count} write conflicts")
                scores.append(0.5)

            # Rule 6: Very high expression complexity
            if feat.expression_complexity_score > 10:
                types.append("complex_expressions")
                explanations.append(f"Expression complexity score {feat.expression_complexity_score:.1f} (very high nesting)")
                scores.append(0.4)

            # Rule 7: Extreme table footprint (>50 unique tables)
            if feat.total_table_footprint > 50:
                types.append("extreme_table_footprint")
                explanations.append(f"Session touches {feat.total_table_footprint} unique tables")
                scores.append(0.5)

            if scores:
                anomaly_score = min(1.0, max(scores) * 0.7 + sum(scores) / len(scores) * 0.3)
            else:
                anomaly_score = 0.0

            if anomaly_score >= self.score_threshold:
                result.anomalies.append(Anomaly(
                    session_id=feat.session_id,
                    session_name=feat.name,
                    anomaly_score=anomaly_score,
                    anomaly_types=types,
                    explanations=explanations,
                ))

        # Statistical Z-score analysis if numpy available
        if np is not None and len(features) >= 10:
            self._add_zscore_anomalies(features, result)

        # Sort by score descending
        result.anomalies.sort(key=lambda a: a.anomaly_score, reverse=True)
        result.anomaly_count = len(result.anomalies)
        logger.info("Anomaly detection: %d anomalies in %d sessions (threshold=%.2f)",
                     result.anomaly_count, result.total_sessions, self.score_threshold)
        return result

    def _add_zscore_anomalies(self, features: list, result: AnomalyResult) -> None:
        """Add Z-score based anomalies using numpy."""
        n = len(features)
        # Extract numeric feature vectors
        vectors = []
        for f in features:
            vectors.append([
                f.transform_count, len(f.source_tables), len(f.target_tables),
                f.lookup_count, f.ext_reads, f.upstream_count, f.downstream_count,
                f.write_conflict_count, f.expression_count, f.field_count,
            ])
        mat = np.array(vectors, dtype=np.float64)
        means = mat.mean(axis=0)
        stds = mat.std(axis=0)
        stds[stds == 0] = 1.0  # avoid division by zero

        # Find sessions where any feature exceeds z_threshold
        existing_ids = {a.session_id for a in result.anomalies}
        feature_names = [
            "transform_count", "source_tables", "target_tables",
            "lookup_count", "ext_reads", "upstream_count", "downstream_count",
            "write_conflicts", "expression_count", "field_count",
        ]

        for i, f in enumerate(features):
            if f.session_id in existing_ids:
                continue
            z_scores = np.abs((mat[i] - means) / stds)
            max_z = z_scores.max()
            if max_z > self.z_threshold:
                outlier_dims = []
                for j, z in enumerate(z_scores):
                    if z > self.z_threshold:
                        outlier_dims.append(f"{feature_names[j]}={mat[i][j]:.0f} (z={z:.1f})")
                score = min(1.0, max_z / (self.z_threshold * 2))
                if score >= self.score_threshold:
                    result.anomalies.append(Anomaly(
                        session_id=f.session_id,
                        session_name=f.name,
                        anomaly_score=score,
                        anomaly_types=["statistical_outlier"],
                        explanations=[f"Statistical outlier: {', '.join(outlier_dims)}"],
                    ))
