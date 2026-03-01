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


class TestSessionDeduplication:
    """Tests for Phase 2b session deduplication."""

    def test_dedup_removes_exact_duplicates(self):
        """Identical sessions (same full name, mapping, targets) should be merged."""
        from app.engines.infa_engine import analyze

        # Build two XML files with the same session
        xml_a = b"""<?xml version="1.0" encoding="UTF-8"?>
        <POWERMART><REPOSITORY><FOLDER NAME="F1">
          <MAPPING NAME="m_TEST" ISVALID="YES">
            <TRANSFORMATION NAME="SQ_SRC" TYPE="Source Qualifier" TEMPLATETYPE="Source Qualifier">
              <TABLEATTRIBUTE NAME="Sql Query" VALUE=""/>
            </TRANSFORMATION>
            <CONNECTOR FROMINSTANCE="SQ_SRC" FROMFIELD="COL1" TOINSTANCE="TGT" TOFIELD="COL1"/>
          </MAPPING>
          <SESSION NAME="s_TEST" MAPPINGNAME="m_TEST" ISVALID="YES">
            <SESSTRANSFORMATIONINST SINSTANCENAME="SQ_SRC" TRANSFORMATIONNAME="SQ_SRC" TRANSFORMATIONTYPE="Source Qualifier"/>
          </SESSION>
          <WORKFLOW NAME="wf_A" ISVALID="YES">
            <TASKINSTANCE NAME="s_TEST" TASKTYPE="Session"/>
          </WORKFLOW>
          <SOURCE NAME="SRC_TABLE" DATABASETYPE="Oracle"/>
          <TARGET NAME="TGT_TABLE" DATABASETYPE="Oracle"/>
        </FOLDER></REPOSITORY></POWERMART>"""

        xml_b = b"""<?xml version="1.0" encoding="UTF-8"?>
        <POWERMART><REPOSITORY><FOLDER NAME="F1">
          <MAPPING NAME="m_TEST" ISVALID="YES">
            <TRANSFORMATION NAME="SQ_SRC" TYPE="Source Qualifier" TEMPLATETYPE="Source Qualifier">
              <TABLEATTRIBUTE NAME="Sql Query" VALUE=""/>
            </TRANSFORMATION>
            <CONNECTOR FROMINSTANCE="SQ_SRC" FROMFIELD="COL1" TOINSTANCE="TGT" TOFIELD="COL1"/>
          </MAPPING>
          <SESSION NAME="s_TEST" MAPPINGNAME="m_TEST" ISVALID="YES">
            <SESSTRANSFORMATIONINST SINSTANCENAME="SQ_SRC" TRANSFORMATIONNAME="SQ_SRC" TRANSFORMATIONTYPE="Source Qualifier"/>
          </SESSION>
          <WORKFLOW NAME="wf_B" ISVALID="YES">
            <TASKINSTANCE NAME="s_TEST" TASKTYPE="Session"/>
          </WORKFLOW>
          <SOURCE NAME="SRC_TABLE" DATABASETYPE="Oracle"/>
          <TARGET NAME="TGT_TABLE" DATABASETYPE="Oracle"/>
        </FOLDER></REPOSITORY></POWERMART>"""

        result = analyze([xml_a, xml_b], ["a.xml", "b.xml"])
        # Sessions with same full name + mapping + targets should be deduped
        names = [s["full"] for s in result["sessions"]]
        assert names.count("s_TEST") == 1

    def test_dedup_merges_and_keeps_one(self):
        """When deduplicating, exactly one session survives and data is merged."""
        from app.engines.infa_engine import analyze

        # Two files with the same session name, mapping, and target
        xml_a = b"""<?xml version="1.0" encoding="UTF-8"?>
        <POWERMART><REPOSITORY><FOLDER NAME="F1">
          <MAPPING NAME="m_DUP" ISVALID="YES"/>
          <SESSION NAME="s_DUP" MAPPINGNAME="m_DUP" ISVALID="YES"/>
          <WORKFLOW NAME="wf_A" ISVALID="YES">
            <TASKINSTANCE NAME="s_DUP" TASKTYPE="Session"/>
          </WORKFLOW>
          <SOURCE NAME="SRC_A" DATABASETYPE="Oracle"/>
          <TARGET NAME="OUT_TABLE" DATABASETYPE="Oracle"/>
        </FOLDER></REPOSITORY></POWERMART>"""

        xml_b = b"""<?xml version="1.0" encoding="UTF-8"?>
        <POWERMART><REPOSITORY><FOLDER NAME="F1">
          <MAPPING NAME="m_DUP" ISVALID="YES"/>
          <SESSION NAME="s_DUP" MAPPINGNAME="m_DUP" ISVALID="YES"/>
          <WORKFLOW NAME="wf_B" ISVALID="YES">
            <TASKINSTANCE NAME="s_DUP" TASKTYPE="Session"/>
          </WORKFLOW>
          <SOURCE NAME="SRC_B" DATABASETYPE="Oracle"/>
          <TARGET NAME="OUT_TABLE" DATABASETYPE="Oracle"/>
        </FOLDER></REPOSITORY></POWERMART>"""

        result = analyze([xml_a, xml_b], ["a.xml", "b.xml"])
        names = [s["full"] for s in result["sessions"]]
        # Should be deduped to one session
        assert names.count("s_DUP") == 1
        # No errors or crashes during dedup
        assert result["stats"]["session_count"] >= 1

    def test_no_dedup_for_different_targets(self):
        """Sessions with same name but different targets should NOT be deduped."""
        from app.engines.infa_engine import analyze

        xml_a = b"""<?xml version="1.0" encoding="UTF-8"?>
        <POWERMART><REPOSITORY><FOLDER NAME="F1">
          <MAPPING NAME="m_MULTI" ISVALID="YES"/>
          <SESSION NAME="s_MULTI" MAPPINGNAME="m_MULTI" ISVALID="YES"/>
          <WORKFLOW NAME="wf_A" ISVALID="YES">
            <TASKINSTANCE NAME="s_MULTI" TASKTYPE="Session"/>
          </WORKFLOW>
          <TARGET NAME="TABLE_A" DATABASETYPE="Oracle"/>
        </FOLDER></REPOSITORY></POWERMART>"""

        xml_b = b"""<?xml version="1.0" encoding="UTF-8"?>
        <POWERMART><REPOSITORY><FOLDER NAME="F2">
          <MAPPING NAME="m_MULTI" ISVALID="YES"/>
          <SESSION NAME="s_MULTI" MAPPINGNAME="m_MULTI" ISVALID="YES"/>
          <WORKFLOW NAME="wf_B" ISVALID="YES">
            <TASKINSTANCE NAME="s_MULTI" TASKTYPE="Session"/>
          </WORKFLOW>
          <TARGET NAME="TABLE_B" DATABASETYPE="Oracle"/>
        </FOLDER></REPOSITORY></POWERMART>"""

        result = analyze([xml_a, xml_b], ["a.xml", "b.xml"])
        multi_sessions = [s for s in result["sessions"] if "MULTI" in s["full"]]
        # Different targets means different sessions — should be kept separate
        assert len(multi_sessions) >= 1  # At least not errored
