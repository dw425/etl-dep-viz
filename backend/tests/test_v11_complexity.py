"""Tests for V11 Complexity Analyzer vector."""

import pytest


class TestV11Complexity:
    def test_complexity_scoring(self, sample_tier_data):
        from app.engines.vectors.feature_extractor import extract_session_features
        from app.engines.vectors.v11_complexity_analyzer import ComplexityAnalyzer

        features = extract_session_features(sample_tier_data)
        v11 = ComplexityAnalyzer()
        result = v11.run(features)
        d = result.to_dict()
        assert "scores" in d
        assert len(d["scores"]) == len(features)
        assert "bucket_distribution" in d
        assert "aggregate_stats" in d

    def test_score_range(self, sample_tier_data):
        from app.engines.vectors.feature_extractor import extract_session_features
        from app.engines.vectors.v11_complexity_analyzer import ComplexityAnalyzer

        features = extract_session_features(sample_tier_data)
        v11 = ComplexityAnalyzer()
        result = v11.run(features)
        for score in result.scores:
            assert 0.0 <= score.overall_score <= 100.0

    def test_bucket_distribution(self, sample_tier_data):
        from app.engines.vectors.feature_extractor import extract_session_features
        from app.engines.vectors.v11_complexity_analyzer import ComplexityAnalyzer

        features = extract_session_features(sample_tier_data)
        v11 = ComplexityAnalyzer()
        result = v11.run(features)
        d = result.to_dict()
        dist = d["bucket_distribution"]
        total = sum(dist.values())
        assert total == len(features)
