"""Tests for V1 Community Detection vector."""

import pytest
import numpy as np


class TestV1Community:
    def test_community_detection(self, sample_tier_data):
        from app.engines.vectors.feature_extractor import (
            extract_session_features, FeatureMatrixBuilder,
        )
        from app.engines.vectors.v1_community_detection import CommunityDetectionVector

        features = extract_session_features(sample_tier_data)
        builder = FeatureMatrixBuilder(features)
        similarity = builder.build_similarity_matrix("jaccard")
        connections = sample_tier_data.get("connections", [])
        adjacency = builder.build_adjacency_matrix(connections)

        v1 = CommunityDetectionVector()
        result = v1.run(similarity, builder.session_ids, adjacency)
        d = result.to_dict()
        assert "assignments" in d
        assert len(d["assignments"]) == len(features)

    def test_single_session(self):
        from app.engines.vectors.v1_community_detection import CommunityDetectionVector
        from scipy import sparse

        sim = np.array([[1.0]])
        adj = sparse.csr_matrix((1, 1))
        v1 = CommunityDetectionVector()
        result = v1.run(sim, ["S1"], adj)
        d = result.to_dict()
        assert len(d["assignments"]) == 1
