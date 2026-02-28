"""Vector Orchestrator — runs analysis vectors in dependency order.

Phases:
  Phase 1: Feature extraction + V1 (community) + V4 (SCC/waves) + V11 (complexity)
  Phase 2: V2 (hierarchical) + V3 (UMAP) + V9 (wave function) + V10 (concentration)
  Phase 3: V5 (affinity) + V6 (spectral) + V7 (HDBSCAN) + V8 (ensemble)
"""

from __future__ import annotations

import logging
import time
from typing import Any

from .feature_extractor import FeatureMatrixBuilder, extract_session_features
from .v1_community_detection import CommunityDetectionVector
from .v4_topological_scc import TopologicalSCCVector
from .v11_complexity_analyzer import ComplexityAnalyzer

logger = logging.getLogger(__name__)


class VectorOrchestrator:
    """Orchestrate analysis vector execution with timing instrumentation."""

    def __init__(self):
        self._timings: dict[str, float] = {}

    def run_phase1(self, tier_data: dict[str, Any]) -> dict[str, Any]:
        """Run Phase 1: feature extraction + V1 + V4 + V11.

        Returns:
            Dict with keys: features, feature_matrix, v1_communities,
            v4_wave_plan, v11_complexity, timings
        """
        results: dict[str, Any] = {}

        # Step 1: Extract features
        t0 = time.monotonic()
        features = extract_session_features(tier_data)
        self._timings["feature_extraction"] = time.monotonic() - t0
        logger.info("Feature extraction: %d sessions in %.2fs", len(features), self._timings["feature_extraction"])

        if not features:
            return {"error": "No sessions found in tier_data", "timings": self._timings}

        results["session_count"] = len(features)
        results["session_ids"] = [f.session_id for f in features]

        # Step 2: Build matrices
        t0 = time.monotonic()
        builder = FeatureMatrixBuilder(features)
        dense = builder.build_dense_matrix()
        connections = tier_data.get("connections", [])
        adjacency = builder.build_adjacency_matrix(connections)
        similarity = builder.build_similarity_matrix("jaccard")
        self._timings["matrix_build"] = time.monotonic() - t0
        logger.info("Matrix build: dense=%s adjacency=%s in %.2fs",
                     dense.shape, adjacency.shape, self._timings["matrix_build"])

        # Step 3: V11 Complexity (independent — run first so V4 can use scores)
        t0 = time.monotonic()
        v11 = ComplexityAnalyzer()
        complexity_result = v11.run(features)
        self._timings["v11_complexity"] = time.monotonic() - t0
        results["v11_complexity"] = complexity_result.to_dict()
        logger.info("V11 Complexity: %.2fs", self._timings["v11_complexity"])

        # Build complexity score map for V4
        complexity_scores = {
            s.session_id: s.overall_score for s in complexity_result.scores
        }

        # Step 4: V1 Community Detection
        t0 = time.monotonic()
        v1 = CommunityDetectionVector()
        community_result = v1.run(similarity, builder.session_ids, adjacency)
        self._timings["v1_community"] = time.monotonic() - t0
        results["v1_communities"] = community_result.to_dict()
        logger.info("V1 Community: %.2fs", self._timings["v1_community"])

        # Step 5: V4 Topological SCC + Wave Plan
        t0 = time.monotonic()
        v4 = TopologicalSCCVector()
        wave_plan = v4.run(adjacency, builder.session_ids, complexity_scores)
        self._timings["v4_wave_plan"] = time.monotonic() - t0
        results["v4_wave_plan"] = wave_plan.to_dict()
        logger.info("V4 Wave Plan: %d waves, %d SCCs in %.2fs",
                     len(wave_plan.waves), len(wave_plan.scc_groups),
                     self._timings["v4_wave_plan"])

        results["timings"] = {k: round(v, 3) for k, v in self._timings.items()}
        return results

    def run_phase2(self, tier_data: dict[str, Any], phase1_results: dict[str, Any]) -> dict[str, Any]:
        """Run Phase 2: V2 + V3 + V9 + V10. Depends on Phase 1 feature matrix."""
        results = dict(phase1_results)

        features = extract_session_features(tier_data)
        if not features:
            return results

        builder = FeatureMatrixBuilder(features)
        connections = tier_data.get("connections", [])
        adjacency = builder.build_adjacency_matrix(connections)
        similarity = builder.build_similarity_matrix("jaccard")
        dense = builder.build_dense_matrix()

        # V2: Hierarchical Lineage
        try:
            from .v2_hierarchical_lineage import HierarchicalLineageVector
            t0 = time.monotonic()
            v2 = HierarchicalLineageVector()
            v2_result = v2.run(features, similarity)
            self._timings["v2_hierarchical"] = time.monotonic() - t0
            results["v2_hierarchical_lineage"] = v2_result.to_dict()
            logger.info("V2 Hierarchical: %.2fs", self._timings["v2_hierarchical"])
        except ImportError:
            logger.warning("V2 not available — skipping")

        # V3: Dimensionality Reduction
        try:
            from .v3_dimensionality_reduction import DimensionalityReductionVector
            t0 = time.monotonic()
            v3 = DimensionalityReductionVector()
            v3_result = v3.run(dense, builder.session_ids)
            self._timings["v3_umap"] = time.monotonic() - t0
            results["v3_dimensionality_reduction"] = v3_result.to_dict()
            logger.info("V3 UMAP: %.2fs", self._timings["v3_umap"])
        except ImportError:
            logger.warning("V3 not available (umap-learn not installed) — skipping")

        # V9: Wave Function
        try:
            from .v9_wave_function import WaveFunctionVector
            t0 = time.monotonic()
            complexity_scores = {}
            if "v11_complexity" in results:
                for s in results["v11_complexity"].get("scores", []):
                    complexity_scores[s["session_id"]] = s["overall_score"]
            v9 = WaveFunctionVector()
            v9_result = v9.run(adjacency, builder.session_ids, complexity_scores)
            self._timings["v9_wave_function"] = time.monotonic() - t0
            results["v9_wave_function"] = v9_result.to_dict()
            logger.info("V9 Wave Function: %.2fs", self._timings["v9_wave_function"])
        except ImportError:
            logger.warning("V9 not available — skipping")

        # V10: Concentration
        try:
            from .v10_concentration import ConcentrationVector
            t0 = time.monotonic()
            v10 = ConcentrationVector()
            v10_result = v10.run(features, similarity)
            self._timings["v10_concentration"] = time.monotonic() - t0
            results["v10_concentration"] = v10_result.to_dict()
            logger.info("V10 Concentration: %.2fs", self._timings["v10_concentration"])
        except ImportError:
            logger.warning("V10 not available — skipping")

        results["timings"] = {k: round(v, 3) for k, v in self._timings.items()}
        return results

    def run_phase3(self, tier_data: dict[str, Any], phase2_results: dict[str, Any]) -> dict[str, Any]:
        """Run Phase 3: V5 + V6 + V7 + V8. V7 needs V3 coords, V8 needs V1-V7."""
        results = dict(phase2_results)

        features = extract_session_features(tier_data)
        if not features:
            return results

        builder = FeatureMatrixBuilder(features)
        similarity = builder.build_similarity_matrix("jaccard")
        dense = builder.build_dense_matrix()

        # V5: Affinity Propagation
        try:
            from .v5_affinity_propagation import AffinityPropagationVector
            t0 = time.monotonic()
            v5 = AffinityPropagationVector()
            v5_result = v5.run(similarity, builder.session_ids)
            self._timings["v5_affinity"] = time.monotonic() - t0
            results["v5_affinity_propagation"] = v5_result.to_dict()
            logger.info("V5 Affinity: %.2fs", self._timings["v5_affinity"])
        except ImportError:
            logger.warning("V5 not available — skipping")

        # V6: Spectral Clustering
        try:
            from .v6_spectral_clustering import SpectralClusteringVector
            t0 = time.monotonic()
            v6 = SpectralClusteringVector()
            v6_result = v6.run(similarity, builder.session_ids)
            self._timings["v6_spectral"] = time.monotonic() - t0
            results["v6_spectral_clustering"] = v6_result.to_dict()
            logger.info("V6 Spectral: %.2fs", self._timings["v6_spectral"])
        except ImportError:
            logger.warning("V6 not available — skipping")

        # V7: HDBSCAN (needs V3 coordinates)
        try:
            from .v7_hdbscan_density import HDBSCANDensityVector
            t0 = time.monotonic()
            v3_coords = None
            if "v3_dimensionality_reduction" in results:
                projections = results["v3_dimensionality_reduction"].get("projections", {})
                if "balanced" in projections:
                    v3_coords = projections["balanced"]
            v7 = HDBSCANDensityVector()
            v7_result = v7.run(dense, builder.session_ids, umap_coords=v3_coords)
            self._timings["v7_hdbscan"] = time.monotonic() - t0
            results["v7_hdbscan_density"] = v7_result.to_dict()
            logger.info("V7 HDBSCAN: %.2fs", self._timings["v7_hdbscan"])
        except ImportError:
            logger.warning("V7 not available (hdbscan not installed) — skipping")

        # V8: Ensemble Consensus (needs V1-V7)
        try:
            from .v8_ensemble_consensus import EnsembleConsensusVector
            t0 = time.monotonic()
            v8 = EnsembleConsensusVector()
            v8_result = v8.run(results, builder.session_ids)
            self._timings["v8_ensemble"] = time.monotonic() - t0
            results["v8_ensemble_consensus"] = v8_result.to_dict()
            logger.info("V8 Ensemble: %.2fs", self._timings["v8_ensemble"])
        except ImportError:
            logger.warning("V8 not available — skipping")

        results["timings"] = {k: round(v, 3) for k, v in self._timings.items()}
        return results

    def run_all(self, tier_data: dict[str, Any]) -> dict[str, Any]:
        """Run all phases sequentially."""
        t_total = time.monotonic()
        r1 = self.run_phase1(tier_data)
        r2 = self.run_phase2(tier_data, r1)
        r3 = self.run_phase3(tier_data, r2)
        r3["total_time"] = round(time.monotonic() - t_total, 3)
        return r3
