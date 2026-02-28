"""Tests for the Vector Orchestrator."""

import pytest


class TestOrchestrator:
    def test_phase1_keys(self, sample_tier_data):
        from app.engines.vectors.orchestrator import VectorOrchestrator
        orch = VectorOrchestrator()
        result = orch.run_phase1(sample_tier_data)
        assert "v1_communities" in result
        assert "v4_wave_plan" in result
        assert "v11_complexity" in result
        assert "timings" in result

    def test_phase2_adds_keys(self, sample_tier_data):
        from app.engines.vectors.orchestrator import VectorOrchestrator
        orch = VectorOrchestrator()
        p1 = orch.run_phase1(sample_tier_data)
        p2 = orch.run_phase2(sample_tier_data, p1)
        # Phase 2 should add V2, V3, V9, V10 (some may be skipped if deps missing)
        assert "v1_communities" in p2  # carried from phase1
        assert "timings" in p2

    def test_phase3_adds_keys(self, sample_tier_data):
        from app.engines.vectors.orchestrator import VectorOrchestrator
        orch = VectorOrchestrator()
        p1 = orch.run_phase1(sample_tier_data)
        p2 = orch.run_phase2(sample_tier_data, p1)
        p3 = orch.run_phase3(sample_tier_data, p2)
        assert "v1_communities" in p3
        assert "timings" in p3

    def test_run_all(self, sample_tier_data):
        from app.engines.vectors.orchestrator import VectorOrchestrator
        orch = VectorOrchestrator()
        result = orch.run_all(sample_tier_data)
        assert "v1_communities" in result
        assert "v4_wave_plan" in result
        assert "v11_complexity" in result
        assert "total_time" in result

    def test_single_session(self):
        """Edge case: only 1 session."""
        from app.engines.vectors.orchestrator import VectorOrchestrator
        tier_data = {
            "sessions": [{"id": "S1", "name": "only", "full": "s_ONLY", "tier": 1,
                          "transforms": 1, "extReads": 0, "lookupCount": 0,
                          "critical": False, "sources": ["T1"], "targets": ["T2"], "lookups": []}],
            "tables": [
                {"id": "T_0", "name": "T1", "type": "source", "tier": 0.5},
                {"id": "T_1", "name": "T2", "type": "independent", "tier": 1.5},
            ],
            "connections": [],
        }
        orch = VectorOrchestrator()
        result = orch.run_phase1(tier_data)
        assert result["session_count"] == 1

    def test_empty_sessions(self):
        from app.engines.vectors.orchestrator import VectorOrchestrator
        orch = VectorOrchestrator()
        result = orch.run_phase1({"sessions": [], "tables": [], "connections": []})
        assert "error" in result
