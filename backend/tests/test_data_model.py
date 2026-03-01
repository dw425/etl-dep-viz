"""Tests for the per-view materialized table data model and population functions.

Covers:
  - populate_core_tables with fixture data
  - populate_view_tables derivation logic
  - populate_constellation_tables
  - populate_vector_tables
  - Roundtrip: populate → reconstruct_tier_data
  - Idempotency: populate twice → same row counts
  - Cascade delete: delete Upload → all tables cascade-clean
  - Per-view API endpoints return correct data
"""

import json

import pytest


# ── Sample data matching the infa_engine output shape ─────────────────────

SAMPLE_TIER_DATA = {
    "sessions": [
        {
            "id": "S1", "name": "load_accounts", "full": "wf_daily/s_load_accounts",
            "tier": 1, "step": 1, "workflow": "wf_daily",
            "transforms": 3, "extReads": 1, "lookupCount": 2, "critical": False,
            "sources": ["SRC_ACCOUNTS"], "targets": ["STG_ACCOUNTS"], "lookups": ["LKP_COUNTRY"],
        },
        {
            "id": "S2", "name": "load_orders", "full": "wf_daily/s_load_orders",
            "tier": 1, "step": 2, "workflow": "wf_daily",
            "transforms": 5, "extReads": 0, "lookupCount": 1, "critical": True,
            "sources": ["SRC_ORDERS"], "targets": ["STG_ORDERS", "STG_ACCOUNTS"], "lookups": ["LKP_STATUS"],
        },
        {
            "id": "S3", "name": "agg_daily", "full": "wf_daily/s_agg_daily",
            "tier": 2, "step": 3, "workflow": "wf_daily",
            "transforms": 2, "extReads": 0, "lookupCount": 0, "critical": False,
            "sources": ["STG_ORDERS"], "targets": ["AGG_DAILY"], "lookups": [],
        },
    ],
    "tables": [
        {"id": "T_0", "name": "SRC_ACCOUNTS", "type": "source", "tier": 0.5, "conflictWriters": 0, "readers": 1, "lookupUsers": 0},
        {"id": "T_1", "name": "STG_ACCOUNTS", "type": "conflict", "tier": 1.5, "conflictWriters": 2, "readers": 0, "lookupUsers": 0},
        {"id": "T_2", "name": "SRC_ORDERS", "type": "source", "tier": 0.5, "conflictWriters": 0, "readers": 1, "lookupUsers": 0},
        {"id": "T_3", "name": "STG_ORDERS", "type": "chain", "tier": 1.5, "conflictWriters": 1, "readers": 1, "lookupUsers": 0},
        {"id": "T_4", "name": "LKP_COUNTRY", "type": "source", "tier": 0.5, "conflictWriters": 0, "readers": 0, "lookupUsers": 1},
        {"id": "T_5", "name": "LKP_STATUS", "type": "source", "tier": 0.5, "conflictWriters": 0, "readers": 0, "lookupUsers": 1},
        {"id": "T_6", "name": "AGG_DAILY", "type": "independent", "tier": 2.5, "conflictWriters": 1, "readers": 0, "lookupUsers": 0},
    ],
    "connections": [
        {"from": "S1", "to": "T_1", "type": "write_clean"},
        {"from": "S2", "to": "T_1", "type": "write_conflict"},
        {"from": "S2", "to": "T_3", "type": "write_clean"},
        {"from": "T_3", "to": "S3", "type": "chain"},
        {"from": "S3", "to": "T_6", "type": "write_clean"},
        {"from": "S1", "to": "T_4", "type": "lookup_stale"},
        {"from": "S2", "to": "T_5", "type": "lookup_stale"},
    ],
    "stats": {
        "session_count": 3, "write_conflicts": 1, "dep_chains": 1,
        "staleness_risks": 2, "source_tables": 3, "max_tier": 2,
    },
    "connection_profiles": [
        {"name": "ORCL_PROD", "type": "Oracle", "host": "db-prod.example.com"},
    ],
}

SAMPLE_CONSTELLATION = {
    "algorithm": "louvain",
    "chunks": [
        {
            "id": "C0", "label": "Chunk 0", "session_count": 2, "table_count": 3,
            "tier_min": 1, "tier_max": 1, "session_ids": ["S1", "S2"],
            "tables": ["STG_ACCOUNTS"], "conflict_count": 1, "chain_count": 0,
            "critical_count": 1, "color": "#3b82f6",
        },
        {
            "id": "C1", "label": "Chunk 1", "session_count": 1, "table_count": 2,
            "tier_min": 2, "tier_max": 2, "session_ids": ["S3"],
            "tables": ["AGG_DAILY"], "conflict_count": 0, "chain_count": 1,
            "critical_count": 0, "color": "#10b981",
        },
    ],
    "points": [
        {"id": "S1", "chunk": "C0", "x": 10, "y": 20, "tier": 1, "critical": False, "name": "load_accounts"},
        {"id": "S2", "chunk": "C0", "x": 30, "y": 20, "tier": 1, "critical": True, "name": "load_orders"},
        {"id": "S3", "chunk": "C1", "x": 50, "y": 40, "tier": 2, "critical": False, "name": "agg_daily"},
    ],
    "cross_chunk_edges": [
        {"from": "C0", "to": "C1", "count": 1},
    ],
    "stats": {"total_sessions": 3, "total_chunks": 2},
}

SAMPLE_VECTOR_RESULTS = {
    "v11_complexity": {
        "scores": [
            {
                "session_id": "S1", "name": "load_accounts", "tier": 1,
                "overall_score": 0.45, "bucket": "medium",
                "dimensions_raw": {"d1": 3, "d2": 1, "d3": 1, "d4": 2, "d5": 1, "d6": 2, "d7": 1, "d8": 0},
                "dimensions_normalized": {"d1": 0.6, "d2": 0.2, "d3": 0.2, "d4": 0.4, "d5": 0.2, "d6": 0.4, "d7": 0.2, "d8": 0.0},
                "effort_estimate": {"hours_low": 4, "hours_high": 8},
                "top_drivers": ["transforms", "lookups"],
            },
            {
                "session_id": "S2", "name": "load_orders", "tier": 1,
                "overall_score": 0.72, "bucket": "high",
                "dimensions_raw": {"d1": 5, "d2": 1, "d3": 2, "d4": 1, "d5": 1, "d6": 3, "d7": 0, "d8": 1},
                "dimensions_normalized": {"d1": 1.0, "d2": 0.2, "d3": 0.4, "d4": 0.2, "d5": 0.2, "d6": 0.6, "d7": 0.0, "d8": 0.2},
                "effort_estimate": {"hours_low": 8, "hours_high": 16},
                "top_drivers": ["transforms", "connections"],
            },
        ],
    },
    "v4_wave_plan": {
        "waves": [
            {"wave": 1, "sessions": [{"id": "S1", "name": "load_accounts"}, {"id": "S2", "name": "load_orders"}]},
            {"wave": 2, "sessions": [{"id": "S3", "name": "agg_daily"}]},
        ],
    },
}


# ── Fixtures ──────────────────────────────────────────────────────────────

@pytest.fixture
def db_session(test_db):
    """Yield a DB session and ensure cleanup."""
    session = test_db()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def upload_row(db_session):
    """Create and return an Upload row."""
    from app.models.database import Upload
    upload = Upload(
        filename="test.xml", platform="informatica", session_count=3,
    )
    upload.set_tier_data(SAMPLE_TIER_DATA)
    db_session.add(upload)
    db_session.commit()
    db_session.refresh(upload)
    return upload


# ── Test: populate_core_tables ────────────────────────────────────────────

class TestPopulateCoreTablesUnit:
    def test_populates_sessions(self, db_session, upload_row):
        from app.engines.data_populator import populate_core_tables
        from app.models.database import SessionRecord

        populate_core_tables(db_session, upload_row.id, SAMPLE_TIER_DATA, SAMPLE_TIER_DATA.get("connection_profiles"))
        db_session.commit()

        rows = db_session.query(SessionRecord).filter(SessionRecord.upload_id == upload_row.id).all()
        assert len(rows) == 3
        names = {r.name for r in rows}
        assert "load_accounts" in names
        assert "load_orders" in names

    def test_populates_tables(self, db_session, upload_row):
        from app.engines.data_populator import populate_core_tables
        from app.models.database import TableRecord

        populate_core_tables(db_session, upload_row.id, SAMPLE_TIER_DATA)
        db_session.commit()

        rows = db_session.query(TableRecord).filter(TableRecord.upload_id == upload_row.id).all()
        assert len(rows) == 7

    def test_populates_connections(self, db_session, upload_row):
        from app.engines.data_populator import populate_core_tables
        from app.models.database import ConnectionRecord

        populate_core_tables(db_session, upload_row.id, SAMPLE_TIER_DATA)
        db_session.commit()

        rows = db_session.query(ConnectionRecord).filter(ConnectionRecord.upload_id == upload_row.id).all()
        assert len(rows) == 7

    def test_populates_connection_profiles(self, db_session, upload_row):
        from app.engines.data_populator import populate_core_tables
        from app.models.database import ConnectionProfileRecord

        populate_core_tables(db_session, upload_row.id, SAMPLE_TIER_DATA, SAMPLE_TIER_DATA["connection_profiles"])
        db_session.commit()

        rows = db_session.query(ConnectionProfileRecord).filter(ConnectionProfileRecord.upload_id == upload_row.id).all()
        assert len(rows) == 1
        assert rows[0].name == "ORCL_PROD"


# ── Test: populate_view_tables ────────────────────────────────────────────

class TestPopulateViewTables:
    def _populate(self, db_session, upload_row):
        from app.engines.data_populator import populate_core_tables, populate_view_tables
        populate_core_tables(db_session, upload_row.id, SAMPLE_TIER_DATA)
        populate_view_tables(db_session, upload_row.id)
        db_session.commit()

    def test_explorer_detail(self, db_session, upload_row):
        from app.models.database import VwExplorerDetail
        self._populate(db_session, upload_row)
        rows = db_session.query(VwExplorerDetail).filter(VwExplorerDetail.upload_id == upload_row.id).all()
        assert len(rows) == 3
        s2 = next(r for r in rows if r.session_id == "S2")
        assert s2.is_critical == 1
        assert s2.conflict_count >= 1

    def test_write_conflicts(self, db_session, upload_row):
        from app.models.database import VwWriteConflicts
        self._populate(db_session, upload_row)
        rows = db_session.query(VwWriteConflicts).filter(VwWriteConflicts.upload_id == upload_row.id).all()
        assert len(rows) >= 1
        assert rows[0].table_name == "STG_ACCOUNTS"
        assert rows[0].writer_count == 2

    def test_exec_order(self, db_session, upload_row):
        from app.models.database import VwExecOrder
        self._populate(db_session, upload_row)
        rows = db_session.query(VwExecOrder).filter(VwExecOrder.upload_id == upload_row.id).order_by(VwExecOrder.position).all()
        assert len(rows) == 3
        assert rows[0].position == 0

    def test_matrix_cells(self, db_session, upload_row):
        from app.models.database import VwMatrixCells
        self._populate(db_session, upload_row)
        rows = db_session.query(VwMatrixCells).filter(VwMatrixCells.upload_id == upload_row.id).all()
        assert len(rows) > 0

    def test_table_profiles(self, db_session, upload_row):
        from app.models.database import VwTableProfiles
        self._populate(db_session, upload_row)
        rows = db_session.query(VwTableProfiles).filter(VwTableProfiles.upload_id == upload_row.id).all()
        assert len(rows) == 7

    def test_tier_layout(self, db_session, upload_row):
        from app.models.database import VwTierLayout
        self._populate(db_session, upload_row)
        rows = db_session.query(VwTierLayout).filter(VwTierLayout.upload_id == upload_row.id).all()
        assert len(rows) == 10  # 3 sessions + 7 tables

    def test_duplicate_groups(self, db_session, upload_row):
        from app.models.database import VwDuplicateGroups
        self._populate(db_session, upload_row)
        # With 3 distinct sessions, no duplicates expected
        rows = db_session.query(VwDuplicateGroups).filter(VwDuplicateGroups.upload_id == upload_row.id).all()
        assert len(rows) == 0


# ── Test: populate_constellation_tables ───────────────────────────────────

class TestPopulateConstellationTables:
    def test_populates_chunks(self, db_session, upload_row):
        from app.engines.data_populator import populate_constellation_tables
        from app.models.database import VwConstellationChunks

        populate_constellation_tables(db_session, upload_row.id, SAMPLE_CONSTELLATION)
        db_session.commit()

        rows = db_session.query(VwConstellationChunks).filter(VwConstellationChunks.upload_id == upload_row.id).all()
        assert len(rows) == 2

    def test_populates_points(self, db_session, upload_row):
        from app.engines.data_populator import populate_constellation_tables
        from app.models.database import VwConstellationPoints

        populate_constellation_tables(db_session, upload_row.id, SAMPLE_CONSTELLATION)
        db_session.commit()

        rows = db_session.query(VwConstellationPoints).filter(VwConstellationPoints.upload_id == upload_row.id).all()
        assert len(rows) == 3

    def test_populates_edges(self, db_session, upload_row):
        from app.engines.data_populator import populate_constellation_tables
        from app.models.database import VwConstellationEdges

        populate_constellation_tables(db_session, upload_row.id, SAMPLE_CONSTELLATION)
        db_session.commit()

        rows = db_session.query(VwConstellationEdges).filter(VwConstellationEdges.upload_id == upload_row.id).all()
        assert len(rows) == 1


# ── Test: populate_vector_tables ──────────────────────────────────────────

class TestPopulateVectorTables:
    def test_populates_complexity(self, db_session, upload_row):
        from app.engines.data_populator import populate_vector_tables
        from app.models.database import VwComplexityScores

        populate_vector_tables(db_session, upload_row.id, SAMPLE_VECTOR_RESULTS)
        db_session.commit()

        rows = db_session.query(VwComplexityScores).filter(VwComplexityScores.upload_id == upload_row.id).all()
        assert len(rows) == 2
        s2 = next(r for r in rows if r.session_id == "S2")
        assert s2.bucket == "high"
        assert s2.overall_score == pytest.approx(0.72)

    def test_populates_waves(self, db_session, upload_row):
        from app.engines.data_populator import populate_vector_tables
        from app.models.database import VwWaveAssignments

        populate_vector_tables(db_session, upload_row.id, SAMPLE_VECTOR_RESULTS)
        db_session.commit()

        rows = db_session.query(VwWaveAssignments).filter(VwWaveAssignments.upload_id == upload_row.id).all()
        assert len(rows) == 3
        wave1 = [r for r in rows if r.wave_number == 1]
        assert len(wave1) == 2


# ── Test: roundtrip (populate → reconstruct) ─────────────────────────────

class TestRoundtrip:
    def test_reconstruct_matches_original(self, db_session, upload_row):
        from app.engines.data_populator import populate_core_tables, reconstruct_tier_data

        populate_core_tables(db_session, upload_row.id, SAMPLE_TIER_DATA)
        db_session.commit()

        reconstructed = reconstruct_tier_data(db_session, upload_row.id)
        assert reconstructed is not None
        assert len(reconstructed["sessions"]) == 3
        assert len(reconstructed["tables"]) == 7
        assert len(reconstructed["connections"]) == 7

        # Verify session fields roundtrip
        s1 = next(s for s in reconstructed["sessions"] if s["id"] == "S1")
        assert s1["name"] == "load_accounts"
        assert s1["tier"] == 1.0
        assert s1["sources"] == ["SRC_ACCOUNTS"]


# ── Test: idempotency ────────────────────────────────────────────────────

class TestIdempotency:
    def test_populate_twice_same_counts(self, db_session, upload_row):
        from app.engines.data_populator import populate_core_tables, populate_view_tables
        from app.models.database import SessionRecord, VwExplorerDetail

        populate_core_tables(db_session, upload_row.id, SAMPLE_TIER_DATA)
        populate_view_tables(db_session, upload_row.id)
        db_session.commit()
        count1_sessions = db_session.query(SessionRecord).filter(SessionRecord.upload_id == upload_row.id).count()
        count1_explorer = db_session.query(VwExplorerDetail).filter(VwExplorerDetail.upload_id == upload_row.id).count()

        # Populate again
        populate_core_tables(db_session, upload_row.id, SAMPLE_TIER_DATA)
        populate_view_tables(db_session, upload_row.id)
        db_session.commit()
        count2_sessions = db_session.query(SessionRecord).filter(SessionRecord.upload_id == upload_row.id).count()
        count2_explorer = db_session.query(VwExplorerDetail).filter(VwExplorerDetail.upload_id == upload_row.id).count()

        assert count1_sessions == count2_sessions == 3
        assert count1_explorer == count2_explorer == 3


# ── Test: cascade delete ─────────────────────────────────────────────────

class TestCascadeDelete:
    def test_delete_upload_cascades(self, db_session, upload_row):
        from sqlalchemy import text
        from app.engines.data_populator import (
            populate_core_tables, populate_view_tables,
            populate_constellation_tables, populate_vector_tables,
        )
        from app.models.database import (
            Upload, SessionRecord, TableRecord, ConnectionRecord,
            VwExplorerDetail, VwConstellationChunks, VwComplexityScores,
        )

        # Enable SQLite foreign keys (required for CASCADE to work)
        db_session.execute(text("PRAGMA foreign_keys = ON"))

        populate_core_tables(db_session, upload_row.id, SAMPLE_TIER_DATA)
        populate_view_tables(db_session, upload_row.id)
        populate_constellation_tables(db_session, upload_row.id, SAMPLE_CONSTELLATION)
        populate_vector_tables(db_session, upload_row.id, SAMPLE_VECTOR_RESULTS)
        db_session.commit()

        # Verify data exists
        assert db_session.query(SessionRecord).filter(SessionRecord.upload_id == upload_row.id).count() == 3
        assert db_session.query(VwExplorerDetail).filter(VwExplorerDetail.upload_id == upload_row.id).count() == 3
        assert db_session.query(VwConstellationChunks).filter(VwConstellationChunks.upload_id == upload_row.id).count() == 2
        assert db_session.query(VwComplexityScores).filter(VwComplexityScores.upload_id == upload_row.id).count() == 2

        # Delete the upload
        db_session.delete(upload_row)
        db_session.commit()

        # Verify all cascaded
        assert db_session.query(SessionRecord).filter(SessionRecord.upload_id == upload_row.id).count() == 0
        assert db_session.query(TableRecord).filter(TableRecord.upload_id == upload_row.id).count() == 0
        assert db_session.query(ConnectionRecord).filter(ConnectionRecord.upload_id == upload_row.id).count() == 0
        assert db_session.query(VwExplorerDetail).filter(VwExplorerDetail.upload_id == upload_row.id).count() == 0
        assert db_session.query(VwConstellationChunks).filter(VwConstellationChunks.upload_id == upload_row.id).count() == 0
        assert db_session.query(VwComplexityScores).filter(VwComplexityScores.upload_id == upload_row.id).count() == 0


# ── Test: per-view API endpoints ──────────────────────────────────────────

class TestViewEndpoints:
    def _setup_data(self, client, small_infa_xml):
        """Upload and parse via the API to populate all tables."""
        response = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        assert response.status_code == 200
        return response.json()["upload_id"]

    def test_explorer_endpoint(self, client, small_infa_xml):
        uid = self._setup_data(client, small_infa_xml)
        res = client.get(f"/api/views/explorer?upload_id={uid}")
        assert res.status_code == 200
        data = res.json()
        assert "sessions" in data
        assert "total" in data

    def test_conflicts_endpoint(self, client, small_infa_xml):
        uid = self._setup_data(client, small_infa_xml)
        res = client.get(f"/api/views/conflicts?upload_id={uid}")
        assert res.status_code == 200
        data = res.json()
        assert "write_conflicts" in data
        assert "read_chains" in data

    def test_exec_order_endpoint(self, client, small_infa_xml):
        uid = self._setup_data(client, small_infa_xml)
        res = client.get(f"/api/views/exec-order?upload_id={uid}")
        assert res.status_code == 200
        data = res.json()
        assert "sessions" in data

    def test_tables_endpoint(self, client, small_infa_xml):
        uid = self._setup_data(client, small_infa_xml)
        res = client.get(f"/api/views/tables?upload_id={uid}")
        assert res.status_code == 200
        data = res.json()
        assert "tables" in data

    def test_upload_not_found(self, client):
        res = client.get("/api/views/explorer?upload_id=99999")
        assert res.status_code == 404

    def test_get_upload_includes_vector_results(self, client, small_infa_xml):
        """Verify getUpload returns vector_results when available."""
        # Upload
        res = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        uid = res.json()["upload_id"]
        # Run vectors
        tier_data = res.json()
        vres = client.post(f"/api/vectors/analyze?phase=1&upload_id={uid}", json=tier_data)
        assert vres.status_code == 200
        # Get upload
        gres = client.get(f"/api/tier-map/uploads/{uid}")
        assert gres.status_code == 200
        data = gres.json()
        assert "vector_results" in data
        assert data["vector_results"] is not None
