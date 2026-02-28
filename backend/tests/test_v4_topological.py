"""Tests for V4 Topological SCC + Wave Plan vector."""

import pytest
from scipy import sparse


class TestV4Topological:
    def test_wave_plan(self, sample_tier_data):
        from app.engines.vectors.feature_extractor import (
            extract_session_features, FeatureMatrixBuilder,
        )
        from app.engines.vectors.v4_topological_scc import TopologicalSCCVector

        features = extract_session_features(sample_tier_data)
        builder = FeatureMatrixBuilder(features)
        connections = sample_tier_data.get("connections", [])
        adjacency = builder.build_adjacency_matrix(connections)

        v4 = TopologicalSCCVector()
        result = v4.run(adjacency, builder.session_ids, {})
        d = result.to_dict()
        assert "waves" in d
        assert "scc_groups" in d
        assert len(d["waves"]) >= 1

    def test_single_session_wave(self):
        from app.engines.vectors.v4_topological_scc import TopologicalSCCVector
        adj = sparse.csr_matrix((1, 1))
        v4 = TopologicalSCCVector()
        result = v4.run(adj, ["S1"], {})
        d = result.to_dict()
        assert len(d["waves"]) >= 1

    def test_empty_adjacency(self):
        from app.engines.vectors.v4_topological_scc import TopologicalSCCVector
        adj = sparse.csr_matrix((3, 3))
        v4 = TopologicalSCCVector()
        result = v4.run(adj, ["S1", "S2", "S3"], {})
        d = result.to_dict()
        assert isinstance(d["waves"], list)
