"""Tests for the exports router — all export formats and multi-upload merge."""

import json


class TestLineageExports:
    """DOT, Mermaid, and JSON lineage exports."""

    def test_dot_export(self, client, small_infa_xml):
        """DOT export contains digraph header."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/lineage/dot", json=tier_data)
        assert r.status_code == 200
        assert "digraph" in r.text
        assert r.headers["content-type"].startswith("text/vnd.graphviz")

    def test_mermaid_export(self, client, small_infa_xml):
        """Mermaid export contains flowchart or graph keyword."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/lineage/mermaid", json=tier_data)
        assert r.status_code == 200
        text = r.text
        assert "graph" in text or "flowchart" in text

    def test_json_export(self, client, small_infa_xml):
        """JSON lineage export returns valid JSON with nodes and edges."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/lineage/json", json=tier_data)
        assert r.status_code == 200
        data = r.json()
        assert "nodes" in data
        assert "edges" in data


class TestDocumentExports:
    """JIRA, Databricks, and snapshot exports."""

    def test_jira_csv(self, client, small_infa_xml):
        """JIRA CSV export contains CSV headers."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/jira/csv", json=tier_data)
        assert r.status_code == 200
        assert "Summary" in r.text

    def test_jira_json(self, client, small_infa_xml):
        """JIRA JSON export contains tickets array."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/jira/json", json=tier_data)
        assert r.status_code == 200
        data = r.json()
        assert "tickets" in data
        assert "count" in data
        assert isinstance(data["tickets"], list)

    def test_databricks_scaffold(self, client, small_infa_xml):
        """Databricks export returns Python notebook scaffold."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/exports/databricks", json=tier_data)
        assert r.status_code == 200
        text = r.text
        assert "Databricks" in text or "spark" in text.lower() or "dbutils" in text.lower()

    def test_snapshot_export(self, client, small_infa_xml):
        """Snapshot export returns version and tier_data."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()
        upload_id = tier_data["upload_id"]

        r = client.post(
            f"/api/exports/snapshot?upload_id={upload_id}",
            json=tier_data,
        )
        assert r.status_code == 200
        snapshot = r.json()
        assert snapshot["version"] == "1.0"
        assert "tier_data" in snapshot

    def test_snapshot_with_upload_metadata(self, client, small_infa_xml):
        """Snapshot with upload_id includes filename and platform."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()
        upload_id = tier_data["upload_id"]

        r = client.post(
            f"/api/exports/snapshot?upload_id={upload_id}",
            json=tier_data,
        )
        snapshot = r.json()
        assert "upload_id" in snapshot
        assert "filename" in snapshot


class TestMultiUploadMerge:
    """Multi-upload merge endpoint."""

    def test_merge_two_uploads(self, client, small_infa_xml):
        """Merging two uploads deduplicates and produces valid stats."""
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

        r = client.post("/api/exports/merge", json=[id1, id2])
        assert r.status_code == 200
        merged = r.json()
        assert "tier_data" in merged
        stats = merged["tier_data"]["stats"]
        assert stats["session_count"] > 0
        assert "merged_upload_ids" in merged

    def test_merge_single_upload(self, client, small_infa_xml):
        """Merging a single upload returns its data unchanged."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        uid = r.json()["upload_id"]

        r = client.post("/api/exports/merge", json=[uid])
        assert r.status_code == 200
        merged = r.json()
        assert merged["tier_data"]["stats"]["session_count"] > 0

    def test_merge_nonexistent_upload(self, client):
        """Merging with a nonexistent upload ID produces empty result."""
        r = client.post("/api/exports/merge", json=[99999])
        assert r.status_code == 200
        merged = r.json()
        assert merged["tier_data"]["stats"]["session_count"] == 0
