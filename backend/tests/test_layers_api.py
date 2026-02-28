"""Integration tests for the Layers API endpoints."""

import pytest


class TestLayersAPI:
    """Test L1-L6 layer endpoints via the API."""

    def _get_tier_data_and_vectors(self, client, small_infa_xml):
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = {k: v for k, v in r.json().items() if k != "upload_id"}
        vr = client.post("/api/vectors/analyze", json=tier_data, params={"phase": 1})
        return tier_data, vr.json()

    def test_l1_enterprise(self, client, small_infa_xml):
        tier_data, vectors = self._get_tier_data_and_vectors(client, small_infa_xml)
        response = client.post("/api/layers/L1", json={
            "tier_data": tier_data,
            "vector_results": vectors,
        })
        assert response.status_code == 200

    def test_l2_domain(self, client, small_infa_xml):
        tier_data, vectors = self._get_tier_data_and_vectors(client, small_infa_xml)
        # L2 endpoint: /L2/{group_id}
        response = client.post("/api/layers/L2/0", json={
            "tier_data": tier_data,
            "vector_results": vectors,
        })
        assert response.status_code == 200

    def test_l3_workflow(self, client, small_infa_xml):
        tier_data, vectors = self._get_tier_data_and_vectors(client, small_infa_xml)
        # L3 endpoint: /L3/{group_id}/{scope_type}/{scope_id}
        response = client.post("/api/layers/L3/0/workflow/wf_CUSTOMER_ETL", json={
            "tier_data": tier_data,
            "vector_results": vectors,
        })
        assert response.status_code == 200

    def test_l4_session(self, client, small_infa_xml):
        tier_data, vectors = self._get_tier_data_and_vectors(client, small_infa_xml)
        sid = tier_data["sessions"][0]["id"]
        # L4 endpoint: /L4/{session_id}
        response = client.post(f"/api/layers/L4/{sid}", json={
            "tier_data": tier_data,
            "vector_results": vectors,
        })
        assert response.status_code == 200
