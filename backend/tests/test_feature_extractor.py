"""Tests for the shared feature extraction pipeline."""

import pytest


class TestFeatureExtraction:
    def test_extract_session_features(self, sample_tier_data):
        from app.engines.vectors.feature_extractor import extract_session_features
        features = extract_session_features(sample_tier_data)
        n = len(sample_tier_data["sessions"])
        assert len(features) == n
        for f in features:
            assert f.session_id.startswith("S")
            assert f.tier >= 0

    def test_dense_matrix_shape(self, sample_tier_data):
        from app.engines.vectors.feature_extractor import (
            extract_session_features, FeatureMatrixBuilder,
        )
        features = extract_session_features(sample_tier_data)
        builder = FeatureMatrixBuilder(features)
        dense = builder.build_dense_matrix()
        assert dense.shape == (len(features), 32)

    def test_adjacency_matrix(self, sample_tier_data):
        from app.engines.vectors.feature_extractor import (
            extract_session_features, FeatureMatrixBuilder,
        )
        features = extract_session_features(sample_tier_data)
        builder = FeatureMatrixBuilder(features)
        connections = sample_tier_data.get("connections", [])
        adj = builder.build_adjacency_matrix(connections)
        assert adj.shape == (len(features), len(features))

    def test_similarity_matrix_properties(self, sample_tier_data):
        import numpy as np
        from app.engines.vectors.feature_extractor import (
            extract_session_features, FeatureMatrixBuilder,
        )
        features = extract_session_features(sample_tier_data)
        builder = FeatureMatrixBuilder(features)
        sim = builder.build_similarity_matrix("jaccard")
        n = len(features)
        assert sim.shape == (n, n)
        # Diagonal should be 1.0
        for i in range(n):
            assert sim[i, i] == pytest.approx(1.0)
        # Should be symmetric
        assert np.allclose(sim, sim.T)
        # Values in [0, 1]
        assert sim.min() >= 0.0
        assert sim.max() <= 1.0

    def test_empty_tier_data(self):
        from app.engines.vectors.feature_extractor import extract_session_features
        features = extract_session_features({"sessions": [], "tables": [], "connections": []})
        assert features == []
