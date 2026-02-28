"""Tests for Informatica XML parse engine."""

import pytest


class TestInfaParseBasics:
    """Basic parsing of Informatica XML."""

    def test_parse_small_xml(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        sessions = result["sessions"]
        # 3 folders: ETL_CUSTOMER (3 sessions), ETL_STAGING (2), ETL_REPORTING (1) = 6 total
        assert len(sessions) == 6
        assert result["stats"]["session_count"] == 6

    def test_tier_assignments(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        by_name = {s["full"]: s for s in result["sessions"]}
        # s_LOAD_CUSTOMER_DIM writes CUSTOMER_DIM (tier 1 — no deps)
        assert by_name["s_LOAD_CUSTOMER_DIM"]["tier"] == 1
        # s_LOAD_PRODUCT_DIM reads CUSTOMER_DIM (should be tier > 1)
        assert by_name["s_LOAD_PRODUCT_DIM"]["tier"] > by_name["s_LOAD_CUSTOMER_DIM"]["tier"]

    def test_lookup_table_resolution(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        by_name = {s["full"]: s for s in result["sessions"]}
        cust_session = by_name["s_LOAD_CUSTOMER_DIM"]
        assert "CUSTOMER_XREF" in cust_session["lookups"]

    def test_conflict_detection(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        # CUSTOMER_DIM is written by both s_LOAD_CUSTOMER_DIM and s_CONFLICT_CUST_LOAD
        assert result["stats"]["write_conflicts"] >= 1
        conflict_tables = [t for t in result["tables"] if t["type"] == "conflict"]
        conflict_names = [t["name"] for t in conflict_tables]
        assert "CUSTOMER_DIM" in conflict_names

    def test_source_only_tables(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        source_tables = [t for t in result["tables"] if t["type"] == "source"]
        source_names = [t["name"] for t in source_tables]
        # CUSTOMER_RAW, ORDER_HEADER, ORDER_LINE, PRODUCT_REF should be source-only
        assert "CUSTOMER_RAW" in source_names

    def test_workflow_ordering(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        by_name = {s["full"]: s for s in result["sessions"]}
        # In wf_CUSTOMER_ETL: s_LOAD_CUSTOMER_DIM -> s_LOAD_ORDER_FACT and s_LOAD_PRODUCT_DIM
        cust = by_name["s_LOAD_CUSTOMER_DIM"]
        order = by_name["s_LOAD_ORDER_FACT"]
        assert cust["step"] < order["step"]


class TestTableNormalization:
    def test_norm_strips_schema(self):
        from app.engines.infa_engine import _norm
        assert _norm("SCHEMA.TABLE_NAME") == "TABLE_NAME"
        assert _norm("owner.table") == "TABLE"

    def test_norm_strips_brackets(self):
        from app.engines.infa_engine import _norm
        assert _norm("[TABLE_NAME]") == "TABLE_NAME"
        assert _norm('"TABLE_NAME"') == "TABLE_NAME"

    def test_norm_strips_connection_prefix(self):
        from app.engines.infa_engine import _norm
        assert _norm("ORACLESTG/TABLE_NAME") == "TABLE_NAME"
        assert _norm("DBNAME:TABLE_NAME") == "TABLE_NAME"


class TestGracefulDegradation:
    def test_empty_input(self):
        from app.engines.infa_engine import analyze
        result = analyze([], [])
        assert result["sessions"] == []
        assert result["stats"]["session_count"] == 0

    def test_malformed_xml(self, malformed_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([malformed_infa_xml], ["malformed.xml"])
        # Should not crash — returns results (even if sparse)
        assert isinstance(result["sessions"], list)
        assert isinstance(result["warnings"], list)

    def test_empty_content(self):
        from app.engines.infa_engine import analyze
        result = analyze([b""], ["empty.xml"])
        assert isinstance(result["warnings"], list)

    def test_mapping_detail_populated(self, small_infa_xml):
        from app.engines.infa_engine import _parse_file
        sessions = _parse_file(small_infa_xml, "test.xml")
        # At least one session should have mapping_detail
        has_detail = any(s.get("mapping_detail") for s in sessions.values())
        assert has_detail
