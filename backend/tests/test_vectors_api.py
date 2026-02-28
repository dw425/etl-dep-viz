"""Integration tests for the Vectors API endpoints."""

import pytest


class TestVectorsAPI:
    def test_analyze_phase1(self, client, sample_tier_data):
        response = client.post(
            "/api/vectors/analyze",
            json=sample_tier_data,
            params={"phase": 1},
        )
        assert response.status_code == 200
        data = response.json()
        assert "v1_communities" in data
        assert "v4_wave_plan" in data
        assert "v11_complexity" in data

    def test_analyze_phase2(self, client, sample_tier_data):
        response = client.post(
            "/api/vectors/analyze",
            json=sample_tier_data,
            params={"phase": 2},
        )
        assert response.status_code == 200
        data = response.json()
        assert "v1_communities" in data

    def test_analyze_phase3(self, client, sample_tier_data):
        response = client.post(
            "/api/vectors/analyze",
            json=sample_tier_data,
            params={"phase": 3},
        )
        assert response.status_code == 200

    def test_wave_plan(self, client, sample_tier_data):
        response = client.post("/api/vectors/wave-plan", json=sample_tier_data)
        assert response.status_code == 200
        data = response.json()
        assert "waves" in data

    def test_complexity(self, client, sample_tier_data):
        response = client.post("/api/vectors/complexity", json=sample_tier_data)
        assert response.status_code == 200
        data = response.json()
        assert "scores" in data

    def test_what_if(self, client, sample_tier_data):
        sid = sample_tier_data["sessions"][0]["id"]
        response = client.post(
            f"/api/vectors/what-if/{sid}",
            json=sample_tier_data,
        )
        assert response.status_code == 200

    def test_empty_sessions_rejected(self, client):
        response = client.post(
            "/api/vectors/analyze",
            json={"sessions": [], "tables": [], "connections": []},
            params={"phase": 1},
        )
        assert response.status_code == 400
