"""Tests for the lineage router — graph construction, traces, column lineage."""

import pytest


class TestLineageGraph:
    """Lineage graph construction from tier data."""

    def test_lineage_graph_basic(self, client, small_infa_xml):
        """Upload → lineage graph returns nodes and edges."""
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
        assert "table_sessions" in data
        assert len(data["nodes"]) > 0

    def test_lineage_graph_no_sessions(self, client):
        """Lineage graph with empty sessions returns 422."""
        r = client.post(
            "/api/lineage/graph",
            json={"sessions": [], "tables": [], "connections": []},
        )
        assert r.status_code == 422

    def test_lineage_graph_has_lineage_edges(self, client, small_infa_xml):
        """Lineage graph derives session-to-session edges via shared tables."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post("/api/lineage/graph", json=tier_data)
        data = r.json()
        assert "lineage_edges" in data


class TestLineageTrace:
    """Forward and backward lineage tracing."""

    def test_trace_forward(self, client, small_infa_xml):
        """Forward trace from a session returns reachable nodes."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()
        session_id = tier_data["sessions"][0]["id"]

        r = client.post(
            f"/api/lineage/trace/forward/{session_id}?max_hops=5",
            json=tier_data,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["direction"] == "forward"
        assert data["start"] == session_id

    def test_trace_backward(self, client, small_infa_xml):
        """Backward trace from a session returns upstream dependencies."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()
        session_id = tier_data["sessions"][0]["id"]

        r = client.post(
            f"/api/lineage/trace/backward/{session_id}?max_hops=5",
            json=tier_data,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["direction"] == "backward"


class TestTableLineage:
    """Table-specific lineage lookups."""

    def test_table_lineage(self, client, small_infa_xml):
        """Get readers/writers/lookups for a specific table."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        # Find a table name from the data
        if not tier_data.get("tables"):
            pytest.skip("No tables in test data")
        table_name = tier_data["tables"][0]["name"]

        r = client.post(
            f"/api/lineage/table/{table_name}",
            json=tier_data,
        )
        assert r.status_code == 200
        data = r.json()
        assert "readers" in data
        assert "writers" in data
        assert "lookups" in data

    def test_table_lineage_not_found(self, client, small_infa_xml):
        """Non-existent table returns 404."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post(
            "/api/lineage/table/NONEXISTENT_TABLE_XYZ",
            json=tier_data,
        )
        assert r.status_code == 404


class TestColumnLineage:
    """Column-level lineage from CONNECTOR data."""

    def test_column_lineage_no_connectors(self, client, small_infa_xml):
        """Column lineage without CONNECTOR data returns empty columns."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()
        session_id = tier_data["sessions"][0]["id"]

        r = client.post(
            f"/api/lineage/columns/{session_id}",
            json=tier_data,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["session_id"] == session_id

    def test_column_lineage_not_found(self, client, small_infa_xml):
        """Column lineage for non-existent session returns 404."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()

        r = client.post(
            "/api/lineage/columns/NONEXISTENT",
            json=tier_data,
        )
        assert r.status_code == 404


class TestImpactAnalysis:
    """Impact analysis endpoint."""

    def test_impact_analysis(self, client, small_infa_xml):
        """Impact analysis returns impacted sessions and tables."""
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        tier_data = r.json()
        session_id = tier_data["sessions"][0]["id"]

        r = client.post(
            f"/api/lineage/impact/{session_id}?max_hops=5",
            json=tier_data,
        )
        assert r.status_code == 200
        data = r.json()
        assert "impacted_sessions" in data
        assert "impacted_tables" in data
        assert data["source_session"] == session_id
