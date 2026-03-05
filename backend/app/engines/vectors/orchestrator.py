"""Vector Orchestrator — runs analysis vectors in dependency order.

Coordinates the execution of 11 analysis vectors (V1-V11) across three phases,
respecting inter-vector dependencies and sharing precomputed feature matrices.

Phase Architecture (dependency-ordered):
  Phase 1 (Core):     Feature extraction + V11 (complexity) + V1 (community) + V4 (SCC/waves)
                      V11 runs first because V4 wave plan uses complexity scores for hour estimates.
  Phase 2 (Advanced): V2 (hierarchical) + V3 (UMAP) + V9 (wave function) + V10 (concentration)
                      V9 depends on V11 complexity scores. V3 produces UMAP coords for V7.
  Phase 3 (Ensemble): V5 (affinity) + V6 (spectral) + V7 (HDBSCAN) + V8 (ensemble consensus)
                      V8 aggregates cluster assignments from V1, V5, V6, V7.

Shared State:
  - Feature matrices (dense, adjacency, similarity) are built once in Phase 1
    and cached in results['_matrices'] for reuse across phases.
  - The _matrices key is removed before serialization in run_all().

Incremental Mode:
  - run_incremental() runs only specified vectors plus their transitive dependencies,
    reusing cached results from a previous run.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any

from .feature_extractor import FeatureMatrixBuilder, extract_session_features
from .v1_community_detection import CommunityDetectionVector
from .v4_topological_scc import TopologicalSCCVector
from .v11_complexity_analyzer import ComplexityAnalyzer

logger = logging.getLogger(__name__)

# Vector dependency graph: vector -> set of prerequisite vectors
_VECTOR_DEPS: dict[str, set[str]] = {
    'v1_community': set(),
    'v4_wave_plan': {'v11_complexity'},
    'v11_complexity': set(),
    'v2_hierarchical': set(),
    'v3_umap': set(),
    'v9_wave_function': {'v11_complexity'},
    'v10_concentration': set(),
    'v5_affinity': set(),
    'v6_spectral': set(),
    'v7_hdbscan': {'v3_umap'},
    'v8_ensemble': {'v1_community', 'v5_affinity', 'v6_spectral', 'v7_hdbscan'},
    'v12_expression_complexity': set(),
    'v13_data_flow': set(),
    'v14_schema_drift': set(),
    'v15_transform_centrality': set(),
    'v16_table_gravity': set(),
}

# Map vector key -> result key in output dict
_VECTOR_RESULT_KEYS: dict[str, str] = {
    'v1_community': 'v1_communities',
    'v4_wave_plan': 'v4_wave_plan',
    'v11_complexity': 'v11_complexity',
    'v2_hierarchical': 'v2_hierarchical_lineage',
    'v3_umap': 'v3_dimensionality_reduction',
    'v9_wave_function': 'v9_wave_function',
    'v10_concentration': 'v10_concentration',
    'v5_affinity': 'v5_affinity_propagation',
    'v6_spectral': 'v6_spectral_clustering',
    'v7_hdbscan': 'v7_hdbscan_density',
    'v8_ensemble': 'v8_ensemble_consensus',
    'v12_expression_complexity': 'v12_expression_complexity',
    'v13_data_flow': 'v13_data_flow',
    'v14_schema_drift': 'v14_schema_drift',
    'v15_transform_centrality': 'v15_transform_centrality',
    'v16_table_gravity': 'v16_table_gravity',
}


class VectorOrchestrator:
    """Orchestrate analysis vector execution with timing instrumentation.

    Usage:
        orch = VectorOrchestrator()
        results = orch.run_all(tier_data)  # Full 3-phase run
        # or
        r1 = orch.run_phase1(tier_data)
        r2 = orch.run_phase2(tier_data, r1)  # SSE can stream between phases
        r3 = orch.run_phase3(tier_data, r2)
    """

    def __init__(self):
        self._timings: dict[str, float] = {}
        self._computed: set[str] = set()
        self._cached_results: dict[str, Any] = {}

    def _build_matrices(self, tier_data: dict[str, Any], results: dict[str, Any] | None = None):
        """Build or retrieve cached feature matrices.

        Returns:
            (features, builder, dense, adjacency, similarity) tuple where:
            - features: list[SessionFeatures] — per-session feature profiles
            - builder: FeatureMatrixBuilder — matrix construction helper
            - dense: np.ndarray (n x 16) — min-max normalized feature matrix
            - adjacency: scipy.sparse — directed session-to-session edge weights
            - similarity: np.ndarray (n x n) — pairwise Jaccard similarity on table sets

        Caches matrices in results['_matrices'] to avoid redundant rebuilds across phases.
        """
        # Reuse cached matrices if available
        if results and '_matrices' in results:
            cached = results['_matrices']
            return cached['features'], cached['builder'], cached['dense'], cached['adjacency'], cached['similarity']

        t0 = time.monotonic()
        features = extract_session_features(tier_data)
        self._timings["feature_extraction"] = time.monotonic() - t0
        logger.info("Feature extraction: %d sessions in %.2fs", len(features), self._timings["feature_extraction"])

        if not features:
            return features, None, None, None, None

        t0 = time.monotonic()
        builder = FeatureMatrixBuilder(features)
        dense = builder.build_dense_matrix()
        connections = tier_data.get("connections", [])
        adjacency = builder.build_adjacency_matrix(connections)
        similarity = builder.build_similarity_matrix("jaccard")
        self._timings["matrix_build"] = time.monotonic() - t0
        logger.info("Matrix build: dense=%s adjacency=%s similarity=%s in %.2fs",
                     dense.shape, adjacency.shape, similarity.shape, self._timings["matrix_build"])

        return features, builder, dense, adjacency, similarity

    def run_phase1(self, tier_data: dict[str, Any]) -> dict[str, Any]:
        """Run Phase 1: feature extraction + V1 + V4 + V11.

        Returns:
            Dict with keys: features, feature_matrix, v1_communities,
            v4_wave_plan, v11_complexity, timings
        """
        results: dict[str, Any] = {}

        features, builder, dense, adjacency, similarity = self._build_matrices(tier_data, results)

        if not features:
            return {"error": "No sessions found in tier_data", "timings": self._timings}

        # Cache matrices for reuse in Phase 2/3
        results["_matrices"] = {
            'features': features, 'builder': builder,
            'dense': dense, 'adjacency': adjacency, 'similarity': similarity,
        }
        results["session_count"] = len(features)
        results["session_ids"] = [f.session_id for f in features]

        # Step 1: V11 Complexity (independent — run first so V4 can use scores)
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

        # Step 2: V1 Community Detection
        t0 = time.monotonic()
        v1 = CommunityDetectionVector()
        community_result = v1.run(similarity, builder.session_ids, adjacency)
        self._timings["v1_community"] = time.monotonic() - t0
        results["v1_communities"] = community_result.to_dict()
        logger.info("V1 Community: %.2fs", self._timings["v1_community"])

        # Step 3: V4 Topological SCC + Wave Plan
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

        features, builder, dense, adjacency, similarity = self._build_matrices(tier_data, results)
        if not features:
            return results

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

        # V12: Expression Complexity
        try:
            from .v12_expression_complexity import ExpressionComplexityVector
            t0 = time.monotonic()
            v12 = ExpressionComplexityVector()
            v12_result = v12.run(features, tier_data)
            self._timings["v12_expression_complexity"] = time.monotonic() - t0
            results["v12_expression_complexity"] = v12_result.to_dict()
            logger.info("V12 Expression Complexity: %.2fs", self._timings["v12_expression_complexity"])
        except ImportError:
            logger.warning("V12 not available — skipping")

        # V13: Data Flow Volume
        try:
            from .v13_data_flow import DataFlowVector
            t0 = time.monotonic()
            v13 = DataFlowVector()
            v13_result = v13.run(features, tier_data)
            self._timings["v13_data_flow"] = time.monotonic() - t0
            results["v13_data_flow"] = v13_result.to_dict()
            logger.info("V13 Data Flow: %.2fs", self._timings["v13_data_flow"])
        except ImportError:
            logger.warning("V13 not available — skipping")

        # V14: Schema Drift
        try:
            from .v14_schema_drift import SchemaDriftVector
            t0 = time.monotonic()
            v14 = SchemaDriftVector()
            v14_result = v14.run(features, tier_data)
            self._timings["v14_schema_drift"] = time.monotonic() - t0
            results["v14_schema_drift"] = v14_result.to_dict()
            logger.info("V14 Schema Drift: %.2fs", self._timings["v14_schema_drift"])
        except ImportError:
            logger.warning("V14 not available — skipping")

        # V15: Transform Centrality
        try:
            from .v15_transform_centrality import TransformCentralityVector
            t0 = time.monotonic()
            v15 = TransformCentralityVector()
            v15_result = v15.run(features, tier_data)
            self._timings["v15_transform_centrality"] = time.monotonic() - t0
            results["v15_transform_centrality"] = v15_result.to_dict()
            logger.info("V15 Transform Centrality: %.2fs", self._timings["v15_transform_centrality"])
        except ImportError:
            logger.warning("V15 not available — skipping")

        # V16: Table Gravity
        try:
            from .v16_table_gravity import TableGravityVector
            t0 = time.monotonic()
            v16 = TableGravityVector()
            v16_result = v16.run(features, tier_data)
            self._timings["v16_table_gravity"] = time.monotonic() - t0
            results["v16_table_gravity"] = v16_result.to_dict()
            logger.info("V16 Table Gravity: %.2fs", self._timings["v16_table_gravity"])
        except ImportError:
            logger.warning("V16 not available — skipping")

        results["timings"] = {k: round(v, 3) for k, v in self._timings.items()}
        return results

    def run_phase3(self, tier_data: dict[str, Any], phase2_results: dict[str, Any]) -> dict[str, Any]:
        """Run Phase 3: V5 + V6 + V7 + V8. V7 needs V3 coords, V8 needs V1-V7."""
        results = dict(phase2_results)

        features, builder, dense, adjacency, similarity = self._build_matrices(tier_data, results)
        if not features:
            return results

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
        r3.pop('_matrices', None)  # Remove cached numpy arrays before serialization
        r3["total_time"] = round(time.monotonic() - t_total, 3)
        return r3

    # ── Incremental re-computation (Item 33) ─────────────────────────────

    def run_incremental(
        self,
        tier_data: dict[str, Any],
        vectors: list[str],
        previous_results: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Run only the specified vectors (plus transitive dependencies), reusing cached results.

        Args:
            tier_data: Parse output (sessions, tables, connections).
            vectors: List of vector keys to run (e.g., ['v1_community', 'v8_ensemble']).
            previous_results: Results from a prior run to reuse.

        Dependency resolution expands the requested set to include prerequisite
        vectors not already present in previous_results. Execution follows
        phase ordering (Phase 1 -> 2 -> 3) regardless of request order.
        """
        results = dict(previous_results or {})

        # Resolve dependencies: expand to include prerequisite vectors
        to_run = set(vectors)
        expanded = True
        while expanded:
            expanded = False
            for v in list(to_run):
                for dep in _VECTOR_DEPS.get(v, set()):
                    result_key = _VECTOR_RESULT_KEYS.get(dep, '')
                    if dep not in to_run and result_key not in results:
                        to_run.add(dep)
                        expanded = True

        # Determine execution order (phase-based)
        phase_order = {
            'v1_community': 1, 'v4_wave_plan': 1, 'v11_complexity': 1,
            'v2_hierarchical': 2, 'v3_umap': 2, 'v9_wave_function': 2, 'v10_concentration': 2,
            'v12_expression_complexity': 2, 'v13_data_flow': 2, 'v14_schema_drift': 2,
            'v15_transform_centrality': 2, 'v16_table_gravity': 2,
            'v5_affinity': 3, 'v6_spectral': 3, 'v7_hdbscan': 3, 'v8_ensemble': 3,
        }
        ordered = sorted(to_run, key=lambda v: phase_order.get(v, 99))

        # Build feature data once
        features = extract_session_features(tier_data)
        if not features:
            return {"error": "No sessions found", "timings": self._timings}

        builder = FeatureMatrixBuilder(features)
        connections = tier_data.get("connections", [])
        adjacency = builder.build_adjacency_matrix(connections)
        similarity = builder.build_similarity_matrix("jaccard")
        dense = builder.build_dense_matrix()

        results["session_count"] = len(features)
        results["session_ids"] = [f.session_id for f in features]

        for vec_key in ordered:
            result_key = _VECTOR_RESULT_KEYS.get(vec_key, '')
            # Skip if already have results and not explicitly requested
            if result_key in results and vec_key not in vectors:
                continue

            t0 = time.monotonic()
            try:
                self._run_single_vector(
                    vec_key, results, features, builder,
                    adjacency, similarity, dense, tier_data,
                )
            except Exception as exc:
                logger.warning("Vector %s failed: %s", vec_key, exc)
            self._timings[vec_key] = time.monotonic() - t0

        results.pop('_matrices', None)  # Remove cached numpy arrays before serialization
        results["timings"] = {k: round(v, 3) for k, v in self._timings.items()}
        results["_incremental"] = True
        results["_vectors_run"] = sorted(to_run)
        return results

    def _run_single_vector(
        self,
        vec_key: str,
        results: dict,
        features: list,
        builder: FeatureMatrixBuilder,
        adjacency: Any,
        similarity: Any,
        dense: Any,
        tier_data: dict,
    ) -> None:
        """Execute a single vector and store result in results dict.

        Dispatches to the correct vector engine based on vec_key string.
        Some vectors require outputs from earlier vectors (e.g., V4 needs V11 scores).
        """
        if vec_key == 'v11_complexity':
            v11 = ComplexityAnalyzer()
            r = v11.run(features)
            results["v11_complexity"] = r.to_dict()

        elif vec_key == 'v1_community':
            v1 = CommunityDetectionVector()
            r = v1.run(similarity, builder.session_ids, adjacency)
            results["v1_communities"] = r.to_dict()

        elif vec_key == 'v4_wave_plan':
            complexity_scores = {}
            if "v11_complexity" in results:
                for s in results["v11_complexity"].get("scores", []):
                    complexity_scores[s["session_id"]] = s["overall_score"]
            v4 = TopologicalSCCVector()
            r = v4.run(adjacency, builder.session_ids, complexity_scores)
            results["v4_wave_plan"] = r.to_dict()

        elif vec_key == 'v2_hierarchical':
            from .v2_hierarchical_lineage import HierarchicalLineageVector
            v2 = HierarchicalLineageVector()
            r = v2.run(features, similarity)
            results["v2_hierarchical_lineage"] = r.to_dict()

        elif vec_key == 'v3_umap':
            from .v3_dimensionality_reduction import DimensionalityReductionVector
            v3 = DimensionalityReductionVector()
            r = v3.run(dense, builder.session_ids)
            results["v3_dimensionality_reduction"] = r.to_dict()

        elif vec_key == 'v9_wave_function':
            from .v9_wave_function import WaveFunctionVector
            complexity_scores = {}
            if "v11_complexity" in results:
                for s in results["v11_complexity"].get("scores", []):
                    complexity_scores[s["session_id"]] = s["overall_score"]
            v9 = WaveFunctionVector()
            r = v9.run(adjacency, builder.session_ids, complexity_scores)
            results["v9_wave_function"] = r.to_dict()

        elif vec_key == 'v10_concentration':
            from .v10_concentration import ConcentrationVector
            v10 = ConcentrationVector()
            r = v10.run(features, similarity)
            results["v10_concentration"] = r.to_dict()

        elif vec_key == 'v5_affinity':
            from .v5_affinity_propagation import AffinityPropagationVector
            v5 = AffinityPropagationVector()
            r = v5.run(similarity, builder.session_ids)
            results["v5_affinity_propagation"] = r.to_dict()

        elif vec_key == 'v6_spectral':
            from .v6_spectral_clustering import SpectralClusteringVector
            v6 = SpectralClusteringVector()
            r = v6.run(similarity, builder.session_ids)
            results["v6_spectral_clustering"] = r.to_dict()

        elif vec_key == 'v7_hdbscan':
            from .v7_hdbscan_density import HDBSCANDensityVector
            v3_coords = None
            if "v3_dimensionality_reduction" in results:
                projections = results["v3_dimensionality_reduction"].get("projections", {})
                if "balanced" in projections:
                    v3_coords = projections["balanced"]
            v7 = HDBSCANDensityVector()
            r = v7.run(dense, builder.session_ids, umap_coords=v3_coords)
            results["v7_hdbscan_density"] = r.to_dict()

        elif vec_key == 'v8_ensemble':
            from .v8_ensemble_consensus import EnsembleConsensusVector
            v8 = EnsembleConsensusVector()
            r = v8.run(results, builder.session_ids)
            results["v8_ensemble_consensus"] = r.to_dict()

        elif vec_key == 'v12_expression_complexity':
            from .v12_expression_complexity import ExpressionComplexityVector
            v12 = ExpressionComplexityVector()
            r = v12.run(features, tier_data)
            results["v12_expression_complexity"] = r.to_dict()

        elif vec_key == 'v13_data_flow':
            from .v13_data_flow import DataFlowVector
            v13 = DataFlowVector()
            r = v13.run(features, tier_data)
            results["v13_data_flow"] = r.to_dict()

        elif vec_key == 'v14_schema_drift':
            from .v14_schema_drift import SchemaDriftVector
            v14 = SchemaDriftVector()
            r = v14.run(features, tier_data)
            results["v14_schema_drift"] = r.to_dict()

        elif vec_key == 'v15_transform_centrality':
            from .v15_transform_centrality import TransformCentralityVector
            v15 = TransformCentralityVector()
            r = v15.run(features, tier_data)
            results["v15_transform_centrality"] = r.to_dict()

        elif vec_key == 'v16_table_gravity':
            from .v16_table_gravity import TableGravityVector
            v16 = TableGravityVector()
            r = v16.run(features, tier_data)
            results["v16_table_gravity"] = r.to_dict()

    # ── Parameter sensitivity sweep (Item 32) ────────────────────────────

    def sweep_resolution(
        self,
        tier_data: dict[str, Any],
        resolutions: list[float] | None = None,
    ) -> dict[str, Any]:
        """Sweep V1 Louvain resolution parameter to visualize sensitivity.

        Runs community detection at each resolution value and reports
        community count + modularity, letting users find the resolution
        that best balances granularity vs cohesion for their data.

        Returns:
            Dict with 'resolutions' (list of per-resolution stats) and 'session_count'.
        """
        if resolutions is None:
            resolutions = [0.1, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0, 5.0]

        features = extract_session_features(tier_data)
        if not features:
            return {"error": "No sessions found"}

        builder = FeatureMatrixBuilder(features)
        connections = tier_data.get("connections", [])
        adjacency = builder.build_adjacency_matrix(connections)
        similarity = builder.build_similarity_matrix("jaccard")

        sweep_results = []
        for res in resolutions:
            t0 = time.monotonic()
            v1 = CommunityDetectionVector()
            # Override all three scales to the same resolution for comparison
            v1.RESOLUTIONS = {"macro": res, "meso": res, "micro": res}
            result = v1.run(similarity, builder.session_ids, adjacency)
            elapsed = time.monotonic() - t0
            # Use macro partition as the single-resolution result
            sweep_results.append({
                'resolution': res,
                'community_count': len(result.macro_communities),
                'modularity': result.modularity.get('macro', 0.0),
                'largest_community': max((len(m) for m in result.macro_communities.values()), default=0),
                'smallest_community': min((len(m) for m in result.macro_communities.values()), default=0),
                'elapsed_ms': round(elapsed * 1000),
            })
            logger.info("Sweep res=%.1f: communities=%d modularity=%.3f (%.2fs)",
                         res, len(result.macro_communities),
                         result.modularity.get('macro', 0.0), elapsed)

        return {
            'resolutions': sweep_results,
            'session_count': len(features),
        }
