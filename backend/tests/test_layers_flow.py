"""Tests for the layers router flow walker and L1/L2 layer endpoints.

Covers:
  - Flow walker happy path with known session_id
  - Flow walker 404 for non-existent session_id
  - Flow walker upstream/downstream BFS structure
  - L1 enterprise constellation with upload_id query param
  - L2 domain cluster with valid and invalid group_id

Uses the sample_tier_data fixture which parses the small Informatica XML.
The fixture produces 6 sessions (S1-S6), 13 tables (T_0-T_12), and 19 connections.
"""

import json

import pytest

from app.engines.vectors.orchestrator import VectorOrchestrator
from app.models.database import Upload


# ── Fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
def vector_results(sample_tier_data):
    """Run Phase 1 vectors on the small fixture to get v1, v4, v11 results.

    Strips internal keys (e.g. _matrices) that contain non-JSON-serializable
    objects like scipy sparse matrices and dataclass instances.
    """
    orch = VectorOrchestrator()
    raw = orch.run_phase1(sample_tier_data)
    # Strip internal keys — same as the L1 endpoint does before returning
    return {k: v for k, v in raw.items() if not k.startswith("_")}


@pytest.fixture
def upload_with_data(test_db, sample_tier_data, vector_results):
    """Persist an Upload row with tier_data and vector_results to the DB."""
    db = test_db()
    upload = Upload(
        filename="test_small.xml",
        platform="informatica",
        session_count=len(sample_tier_data.get("sessions", [])),
        tier_data_json=json.dumps(sample_tier_data),
        vector_results_json=json.dumps(vector_results),
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)
    upload_id = upload.id
    db.close()
    return upload_id


# ── Flow Walker Tests ─────────────────────────────────────────────────────


class TestFlowWalker:
    """Tests for POST /api/layers/flow/{session_id}."""

    def test_flow_walker_happy_path(self, client, sample_tier_data):
        """Flow walker returns session detail with upstream/downstream data."""
        response = client.post(
            "/api/layers/flow/S1",
            json={"tier_data": sample_tier_data},
        )
        assert response.status_code == 200
        data = response.json()

        # Must contain the core flow walker keys
        assert data["session"]["id"] == "S1"
        assert "upstream" in data
        assert "downstream" in data
        assert "tables_touched" in data
        assert "upstream_count" in data
        assert "downstream_count" in data
        assert isinstance(data["upstream"], list)
        assert isinstance(data["downstream"], list)

    def test_flow_walker_nonexistent_session(self, client, sample_tier_data):
        """Non-existent session_id returns 404."""
        response = client.post(
            "/api/layers/flow/S999",
            json={"tier_data": sample_tier_data},
        )
        assert response.status_code == 404
        assert "S999" in response.json()["detail"]

    def test_flow_walker_upstream_structure(self, client, sample_tier_data):
        """S5 reads from T_7 and T_8; S1 and S4 write T_8 -> upstream includes S1, S4.

        Deeper BFS: S4 reads T_12, S2 writes T_12 -> upstream also includes S2.
        S1 reads T_0, T_1 (no session writers) -> stops.
        Full upstream of S5: {S1, S4, S2}
        """
        response = client.post(
            "/api/layers/flow/S5",
            json={"tier_data": sample_tier_data},
        )
        assert response.status_code == 200
        data = response.json()

        upstream_ids = {u["session_id"] for u in data["upstream"]}
        assert upstream_ids == {"S1", "S4", "S2"}
        assert data["upstream_count"] == 3

        # Each upstream entry must have via_table showing the linking table
        for entry in data["upstream"]:
            assert "via_table" in entry
            assert "name" in entry
            assert "tier" in entry

    def test_flow_walker_downstream_structure(self, client, sample_tier_data):
        """S2 writes T_12 -> S4 reads T_12.

        S4 writes T_8 -> S5 and S6 read T_8.
        S5 writes T_10 -> S6 reads T_10 (already visited).
        S6 writes T_11 -> no readers.
        Full downstream of S2: {S4, S5, S6}
        """
        response = client.post(
            "/api/layers/flow/S2",
            json={"tier_data": sample_tier_data},
        )
        assert response.status_code == 200
        data = response.json()

        downstream_ids = {d["session_id"] for d in data["downstream"]}
        assert downstream_ids == {"S4", "S5", "S6"}
        assert data["downstream_count"] == 3

    def test_flow_walker_leaf_session_no_downstream(self, client, sample_tier_data):
        """S6 writes only T_11 (RPT_SALES_SUMMARY) which no session reads."""
        response = client.post(
            "/api/layers/flow/S6",
            json={"tier_data": sample_tier_data},
        )
        assert response.status_code == 200
        data = response.json()

        assert data["downstream_count"] == 0
        assert data["downstream"] == []
        # S6 reads from T_8, T_9, T_10 so it should have upstream entries
        assert data["upstream_count"] > 0

    def test_flow_walker_tables_touched(self, client, sample_tier_data):
        """S1 writes T_8 (CUSTOMER_DIM) and reads T_0 (CUSTOMER_RAW), T_1 (CUSTOMER_XREF)."""
        response = client.post(
            "/api/layers/flow/S1",
            json={"tier_data": sample_tier_data},
        )
        assert response.status_code == 200
        data = response.json()

        tables = data["tables_touched"]
        assert len(tables) > 0

        writes = [t for t in tables if t["relation"] == "writes"]
        reads = [t for t in tables if t["relation"] == "reads"]

        write_names = {t["name"] for t in writes}
        read_names = {t["name"] for t in reads}

        assert "CUSTOMER_DIM" in write_names
        assert "CUSTOMER_RAW" in read_names
        assert "CUSTOMER_XREF" in read_names

    def test_flow_walker_mapping_detail_from_deep_parse(self, client, sample_tier_data):
        """S1 has deep-parsed mapping_detail with instances and connectors."""
        response = client.post(
            "/api/layers/flow/S1",
            json={"tier_data": sample_tier_data},
        )
        assert response.status_code == 200
        data = response.json()

        md = data["mapping_detail"]
        assert md is not None
        assert "instances" in md
        assert "connectors" in md
        assert len(md["instances"]) > 0
        assert len(md["connectors"]) > 0

    def test_flow_walker_mapping_detail_fallback(self, client):
        """When session has no mapping_detail, a minimal one is built from sources/targets/lookups."""
        # Construct a minimal tier_data with no mapping_detail on the session
        tier_data = {
            "sessions": [
                {
                    "id": "S1",
                    "name": "test_session",
                    "full": "test_session",
                    "tier": 1,
                    "sources": ["SRC_TABLE"],
                    "targets": ["TGT_TABLE"],
                    "lookups": ["LKP_TABLE"],
                }
            ],
            "tables": [],
            "connections": [],
        }
        response = client.post(
            "/api/layers/flow/S1",
            json={"tier_data": tier_data},
        )
        assert response.status_code == 200
        data = response.json()

        md = data["mapping_detail"]
        assert md is not None
        assert "instances" in md

        instance_names = {i["name"] for i in md["instances"]}
        assert "SRC_TABLE" in instance_names
        assert "TGT_TABLE" in instance_names
        assert "LKP_TABLE" in instance_names

        # Verify types are assigned correctly
        types_by_name = {i["name"]: i["type"] for i in md["instances"]}
        assert types_by_name["SRC_TABLE"] == "Source"
        assert types_by_name["TGT_TABLE"] == "Target"
        assert types_by_name["LKP_TABLE"] == "Lookup"

    def test_flow_walker_with_vector_results(self, client, sample_tier_data, vector_results):
        """When vector_results are provided, complexity and wave_info are populated."""
        response = client.post(
            "/api/layers/flow/S1",
            json={"tier_data": sample_tier_data, "vector_results": vector_results},
        )
        assert response.status_code == 200
        data = response.json()

        # With vector results, complexity should be populated for this session
        assert data["complexity"] is not None
        assert data["complexity"]["session_id"] == "S1"
        assert "overall_score" in data["complexity"]

    def test_flow_walker_empty_tier_data(self, client):
        """Posting with empty tier_data (no sessions) should 404 the session."""
        response = client.post(
            "/api/layers/flow/S1",
            json={"tier_data": {"sessions": [], "tables": [], "connections": []}},
        )
        assert response.status_code == 404


# ── L1 Tests ──────────────────────────────────────────────────────────────


class TestL1Enterprise:
    """Tests for POST /api/layers/L1."""

    def test_l1_with_tier_data_body(self, client, sample_tier_data):
        """L1 accepts tier_data in the body and returns supernode graph."""
        response = client.post(
            "/api/layers/L1",
            json={"tier_data": sample_tier_data},
        )
        assert response.status_code == 200
        data = response.json()

        assert data["layer"] == 1
        assert "supernode_graph" in data
        assert "environment_summary" in data
        assert "vector_results" in data

        env = data["environment_summary"]
        assert env["total_sessions"] == 6

    def test_l1_with_upload_id(self, client, upload_with_data):
        """L1 loads data from DB when upload_id is provided."""
        response = client.post(
            f"/api/layers/L1?upload_id={upload_with_data}",
        )
        assert response.status_code == 200
        data = response.json()

        assert data["layer"] == 1
        assert data["environment_summary"]["total_sessions"] == 6

    def test_l1_invalid_upload_id(self, client):
        """L1 returns 404 for a non-existent upload_id."""
        response = client.post("/api/layers/L1?upload_id=99999")
        assert response.status_code == 404

    def test_l1_no_data_returns_400(self, client):
        """L1 with neither tier_data nor upload_id returns 400."""
        response = client.post("/api/layers/L1")
        assert response.status_code == 400

    def test_l1_empty_sessions_returns_400(self, client):
        """L1 rejects tier_data with an empty sessions list."""
        response = client.post(
            "/api/layers/L1",
            json={"tier_data": {"sessions": []}},
        )
        assert response.status_code == 400

    def test_l1_supernode_graph_structure(self, client, sample_tier_data, vector_results):
        """L1 supernode graph contains supernodes with complexity enrichment."""
        response = client.post(
            "/api/layers/L1",
            json={"tier_data": sample_tier_data, "vector_results": vector_results},
        )
        assert response.status_code == 200
        data = response.json()

        graph = data["supernode_graph"]
        assert "supernodes" in graph
        assert "superedges" in graph

        # Each supernode should have complexity enrichment
        for sn in graph["supernodes"]:
            assert "session_ids" in sn
            assert "avg_complexity" in sn
            assert "bucket_distribution" in sn


# ── L2 Tests ──────────────────────────────────────────────────────────────


class TestL2DomainCluster:
    """Tests for POST /api/layers/L2/{group_id}."""

    def test_l2_valid_group(self, client, sample_tier_data, vector_results):
        """L2 returns sessions and connections for a valid community group."""
        # Extract a valid group_id from the vector results
        v1 = vector_results.get("v1_communities", {})
        macro = v1.get("macro_communities", {})
        assert len(macro) > 0, "Need at least one macro community to test L2"

        group_id = list(macro.keys())[0]
        expected_member_ids = macro[group_id]

        response = client.post(
            f"/api/layers/L2/{group_id}",
            json={"tier_data": sample_tier_data, "vector_results": vector_results},
        )
        assert response.status_code == 200
        data = response.json()

        assert data["layer"] == 2
        assert data["group_id"] == group_id
        assert data["session_count"] == len(expected_member_ids)

        returned_ids = {s["id"] for s in data["sessions"]}
        assert returned_ids == set(expected_member_ids)

        assert "connections" in data
        assert "sub_clusters" in data
        assert "complexity_scores" in data

    def test_l2_invalid_group_returns_404(self, client, sample_tier_data, vector_results):
        """L2 returns 404 for a group_id that does not exist."""
        response = client.post(
            "/api/layers/L2/nonexistent_group_99",
            json={"tier_data": sample_tier_data, "vector_results": vector_results},
        )
        assert response.status_code == 404
        assert "nonexistent_group_99" in response.json()["detail"]

    def test_l2_with_community_prefix(self, client, sample_tier_data, vector_results):
        """L2 strips the 'community_' prefix when looking up groups."""
        v1 = vector_results.get("v1_communities", {})
        macro = v1.get("macro_communities", {})
        group_id = list(macro.keys())[0]

        # Post with the community_ prefix — should still resolve
        response = client.post(
            f"/api/layers/L2/community_{group_id}",
            json={"tier_data": sample_tier_data, "vector_results": vector_results},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["session_count"] > 0

    def test_l2_connections_include_boundary_edges(self, client, sample_tier_data, vector_results):
        """L2 connections include cross-boundary edges (at least one endpoint in group)."""
        v1 = vector_results.get("v1_communities", {})
        macro = v1.get("macro_communities", {})
        group_id = list(macro.keys())[0]
        member_ids = set(macro[group_id])

        response = client.post(
            f"/api/layers/L2/{group_id}",
            json={"tier_data": sample_tier_data, "vector_results": vector_results},
        )
        assert response.status_code == 200
        data = response.json()

        # Every returned connection must have at least one endpoint in the group
        for c in data["connections"]:
            assert c.get("from") in member_ids or c.get("to") in member_ids

    def test_l2_with_upload_id(self, client, upload_with_data, vector_results):
        """L2 loads tier_data from DB when upload_id is provided."""
        v1 = vector_results.get("v1_communities", {})
        macro = v1.get("macro_communities", {})
        group_id = list(macro.keys())[0]

        response = client.post(
            f"/api/layers/L2/{group_id}?upload_id={upload_with_data}",
        )
        assert response.status_code == 200
        data = response.json()
        assert data["session_count"] > 0
