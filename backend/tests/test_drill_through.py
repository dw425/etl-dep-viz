"""Tests for drill-through query engine."""

import pytest

from app.engines.vectors.drill_through import DrillThroughEngine


class TestDrillThrough:
    @pytest.fixture
    def engine(self):
        return DrillThroughEngine()

    @pytest.fixture
    def vector_results(self, sample_tier_data):
        """Run phase 1 to get real vector results for drill-through."""
        from app.engines.vectors.orchestrator import VectorOrchestrator

        orch = VectorOrchestrator()
        return orch.run_phase1(sample_tier_data)

    def test_filter_no_dimensions_returns_all(self, engine, vector_results):
        """Empty filter returns every session."""
        result = engine.filter(vector_results, {})
        session_ids = vector_results.get("session_ids", [])
        assert result["total_matches"] == len(session_ids)
        assert sorted(result["matching_session_ids"]) == sorted(session_ids)

    def test_filter_by_complexity_bucket(self, engine, vector_results):
        """Filtering by complexity bucket narrows results."""
        result_all = engine.filter(vector_results, {})
        result_simple = engine.filter(vector_results, {"complexity_bucket": "Simple"})
        # Simple subset should be <= total
        assert result_simple["total_matches"] <= result_all["total_matches"]
        # Every returned session should be in the full set
        for sid in result_simple["matching_session_ids"]:
            assert sid in result_all["matching_session_ids"]

    def test_filter_by_wave_list(self, engine, vector_results):
        """Filtering by wave_number with a list matches sessions in those waves."""
        result = engine.filter(vector_results, {"wave_number": [1, 2]})
        assert result["total_matches"] >= 0
        # If we have matches, aggregates should be populated
        if result["total_matches"] > 0:
            assert "count" in result["aggregates"]
            assert result["aggregates"]["count"] == result["total_matches"]

    def test_filter_by_complexity_range(self, engine, vector_results):
        """Min/max suffix filters work for complexity score ranges."""
        result = engine.filter(
            vector_results,
            {"complexity_score_min": 0, "complexity_score_max": 50},
        )
        assert isinstance(result["matching_session_ids"], list)
        assert result["total_matches"] == len(result["matching_session_ids"])

    def test_aggregates_present(self, engine, vector_results):
        """Filtered result contains expected aggregate keys."""
        result = engine.filter(vector_results, {})
        if result["total_matches"] > 0:
            agg = result["aggregates"]
            assert "count" in agg
            assert "avg_complexity" in agg
            assert "avg_criticality" in agg
            assert "max_blast_radius" in agg
            assert "independent_count" in agg

    def test_distributions_present(self, engine, vector_results):
        """Filtered result includes dimension distributions."""
        result = engine.filter(vector_results, {})
        if result["total_matches"] > 0:
            # At least complexity_bucket should have a distribution
            assert "dimension_distributions" in result
            dists = result["dimension_distributions"]
            assert isinstance(dists, dict)

    def test_empty_vector_results(self, engine):
        """Empty input returns zero matches."""
        result = engine.filter(
            {"session_ids": [], "v1_communities": {}, "v11_complexity": {}},
            {},
        )
        assert result["total_matches"] == 0
        assert result["matching_session_ids"] == []
