"""End-to-end integration tests: upload → parse → analyze → query (Item 93).

Tests the full pipeline from file upload through vector analysis
and export to verify all components work together.
"""

import io
import json
import zipfile

import pytest


class TestFullPipeline:
    """Upload → parse → constellation → vectors → export."""

    def test_upload_analyze_vectors_export(self, client, small_infa_xml):
        """Full pipeline: upload → vectors → Excel export."""
        # Step 1: Upload and parse
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        assert r.status_code == 200
        tier_data = r.json()
        upload_id = tier_data["upload_id"]
        assert len(tier_data["sessions"]) > 0

        # Step 2: Run vector analysis (phase 1 — core vectors)
        r = client.post(
            f"/api/vectors/analyze?phase=1&upload_id={upload_id}",
            json=tier_data,
        )
        assert r.status_code == 200
        vectors = r.json()
        assert "v1_community" in vectors or "v4_topological" in vectors or "v11_complexity" in vectors

        # Step 3: Retrieve cached vectors
        r = client.get(f"/api/vectors/results/{upload_id}")
        assert r.status_code == 200

        # Step 4: Export snapshot
        r = client.post(
            f"/api/exports/snapshot?upload_id={upload_id}",
            json=tier_data,
        )
        assert r.status_code == 200
        snapshot = r.json()
        assert snapshot.get("version") == "1.0"

    def test_upload_layers(self, client, small_infa_xml):
        """Upload → L1 enterprise layer → retrieve upload."""
        # Step 1: Upload
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        assert r.status_code == 200
        tier_data = r.json()
        upload_id = tier_data["upload_id"]
        assert len(tier_data["sessions"]) > 0

        # Step 2: L1 enterprise overview (multi-Body endpoint needs wrapped keys)
        r = client.post(
            "/api/layers/L1",
            json={"tier_data": tier_data},
        )
        assert r.status_code == 200
        l1 = r.json()
        assert "supernode_graph" in l1 or "groups" in l1

        # Step 3: Retrieve stored upload
        r = client.get(f"/api/tier-map/uploads/{upload_id}")
        assert r.status_code == 200
        stored = r.json()
        assert stored["upload_id"] == upload_id

    def test_upload_zip_full_pipeline(self, client, small_infa_xml):
        """Upload ZIP → parse → tag → query tags."""
        # Create a ZIP with the XML
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("folder/test.xml", small_infa_xml)
        buf.seek(0)

        # Upload ZIP
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("archive.zip", buf.read(), "application/zip"))],
        )
        assert r.status_code == 200
        tier_data = r.json()
        sessions = tier_data["sessions"]
        assert len(sessions) > 0

        # Tag a session
        session_id = sessions[0]["id"]
        r = client.post(
            "/api/active-tags",
            json={
                "object_id": session_id,
                "object_type": "session",
                "tag_type": "status",
                "label": "reviewed",
            },
        )
        assert r.status_code == 200
        tag = r.json()
        assert tag["object_id"] == session_id

        # Query tags
        r = client.get(f"/api/active-tags/{session_id}")
        assert r.status_code == 200
        tags = r.json()
        assert len(tags) >= 1


class TestConstellationStream:
    """SSE streaming endpoint integration."""

    def test_stream_complete(self, client, small_infa_xml):
        """Streaming upload should complete with all phases."""
        r = client.post(
            "/api/tier-map/constellation-stream",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
            params={"algorithm": "louvain"},
        )
        assert r.status_code == 200
        text = r.text
        assert "data:" in text
        # Should have a complete event
        assert '"phase"' in text


class TestHealthEndpoints:
    """Health check and error aggregation."""

    def test_health_expanded(self, client):
        """Health endpoint returns expanded info."""
        r = client.get("/api/health")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] in ("ok", "degraded")
        assert "python" in data

    def test_health_logs(self, client):
        """Log buffer endpoint works."""
        r = client.get("/api/health/logs?limit=10")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_error_aggregation(self, client):
        """Error aggregation endpoint works."""
        r = client.get("/api/health/errors?limit=10")
        assert r.status_code == 200
        data = r.json()
        assert "errors" in data
        assert "total" in data
        assert "by_type" in data

    def test_frontend_error_reporting(self, client):
        """Frontend can report errors."""
        r = client.post(
            "/api/health/report-error",
            json={
                "type": "test_error",
                "message": "Test error from integration test",
                "severity": "warning",
            },
        )
        assert r.status_code == 200
        assert r.json()["accepted"] is True

        # Verify it shows up in aggregation
        r = client.get("/api/health/errors?source=frontend")
        assert r.status_code == 200
        errors = r.json()["errors"]
        assert any(e["message"] == "Test error from integration test" for e in errors)


class TestExportPipeline:
    """Export endpoints integration."""

    def test_jira_csv_export(self, client, small_infa_xml):
        """Upload → JIRA CSV export."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/jira/csv", json=tier_data)
        assert r.status_code == 200
        csv_text = r.text
        assert "Summary" in csv_text
        assert "Migrate ETL" in csv_text

    def test_jira_json_export(self, client, small_infa_xml):
        """Upload → JIRA JSON export."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/jira/json", json=tier_data)
        assert r.status_code == 200
        data = r.json()
        assert "tickets" in data
        assert data["count"] >= 0

    def test_databricks_export(self, client, small_infa_xml):
        """Upload → Databricks scaffold."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/databricks", json=tier_data)
        assert r.status_code == 200
        text = r.text
        assert "Databricks" in text or "spark" in text.lower() or "dbutils" in text.lower()

    def test_lineage_export_dot(self, client, small_infa_xml):
        """Upload → DOT lineage export."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/lineage/dot", json=tier_data)
        assert r.status_code == 200
        assert "digraph" in r.text

    def test_lineage_export_mermaid(self, client, small_infa_xml):
        """Upload → Mermaid lineage export."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/lineage/mermaid", json=tier_data)
        assert r.status_code == 200
        assert "graph" in r.text or "flowchart" in r.text

    def test_multi_upload_merge(self, client, small_infa_xml):
        """Upload twice → merge."""
        # Upload twice
        r1 = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("a.xml", small_infa_xml, "application/xml"))],
        )
        r2 = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("b.xml", small_infa_xml, "application/xml"))],
        )
        id1 = r1.json()["upload_id"]
        id2 = r2.json()["upload_id"]

        # Merge
        r = client.post("/api/exports/merge", json=[id1, id2])
        assert r.status_code == 200
        merged = r.json()
        assert "tier_data" in merged
        assert merged["tier_data"]["stats"]["session_count"] > 0


class TestPaginatedSessions:
    """Paginated session API."""

    def test_paginated_sessions(self, client, small_infa_xml):
        """Upload → paginated session list."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        upload_id = r.json()["upload_id"]

        r = client.get(f"/api/tier-map/uploads/{upload_id}/sessions?limit=5")
        assert r.status_code == 200
        data = r.json()
        assert "sessions" in data
        assert "total" in data
        assert data["limit"] == 5

    def test_paginated_sessions_search(self, client, small_infa_xml):
        """Paginated sessions with search filter."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        upload_id = r.json()["upload_id"]

        r = client.get(f"/api/tier-map/uploads/{upload_id}/sessions?search=nonexistent_xyz")
        assert r.status_code == 200
        data = r.json()
        assert data["total"] == 0


class TestLineageEndpoints:
    """Lineage graph and trace integration."""

    def test_lineage_graph(self, client, small_infa_xml):
        """Upload → lineage graph."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/lineage/graph", json=tier_data)
        assert r.status_code == 200
        data = r.json()
        assert "nodes" in data
        assert "edges" in data

    def test_lineage_trace_forward(self, client, small_infa_xml):
        """Upload → forward lineage trace."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()
        sessions = tier_data["sessions"]
        if not sessions:
            pytest.skip("No sessions in test data")

        session_id = sessions[0]["id"]
        r = client.post(f"/api/lineage/trace/forward/{session_id}?max_hops=5", json=tier_data)
        assert r.status_code == 200


class TestUserWorkflow:
    """User profile and activity tracking."""

    def test_user_activity_flow(self, client, small_infa_xml):
        """Create user → upload → log activity → check history."""
        # Create user
        r = client.post(
            "/api/users",
            json={"user_id": "test-user-123", "display_name": "Test User"},
        )
        assert r.status_code == 200

        # Upload with user ID
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
            headers={"X-User-Id": "test-user-123"},
        )
        assert r.status_code == 200

        # Log activity
        r = client.post(
            "/api/users/test-user-123/activity",
            json={"action": "upload", "target_filename": "test.xml"},
        )
        assert r.status_code == 200

        # Check activity
        r = client.get("/api/users/test-user-123/activity?limit=10")
        assert r.status_code == 200
        activity = r.json()
        assert len(activity) >= 1
