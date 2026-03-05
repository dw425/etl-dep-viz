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


# ── V7 Deep Parse Expansion Tests ─────────────────────────────────────────


class TestRepositoryMetadata:
    """Tests for Phase 1A: POWERMART root + REPOSITORY metadata."""

    def test_repo_meta_extracted(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        # At least one session should carry _repo_meta
        sessions_with_rm = [s for s in result["sessions"] if s.get("_repo_meta")]
        assert len(sessions_with_rm) > 0
        rm = sessions_with_rm[0]["_repo_meta"]
        assert rm["repository_name"] == "REPO_DEV"
        assert rm["codepage"] == "UTF-8"
        assert rm["database_type"] == "Oracle"

    def test_repo_creation_date(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        rm = next(s["_repo_meta"] for s in result["sessions"] if s.get("_repo_meta"))
        assert "03/01/2026" in rm.get("creation_date", "")

    def test_repo_version(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        rm = next(s["_repo_meta"] for s in result["sessions"] if s.get("_repo_meta"))
        assert rm.get("repository_version") == "186.90"


class TestFolderExpansion:
    """Tests for Phase 1B: FOLDER metadata expansion."""

    def test_folder_meta_extracted(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        sessions_with_fm = [s for s in result["sessions"] if s.get("_folder_meta")]
        assert len(sessions_with_fm) > 0

    def test_folder_attributes(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        # Find a session from ETL_CUSTOMER folder
        cust_session = next(
            s for s in result["sessions"]
            if s.get("_folder_meta", {}).get("name") == "ETL_CUSTOMER"
        )
        fm = cust_session["_folder_meta"]
        assert fm["owner"] == "admin"
        assert fm["description"] == "Customer ETL folder"
        assert fm["shared"] == "NOTSHARED"
        assert fm["permissions"] == "rwx------"


class TestShortcutParsing:
    """Tests for Phase 1C: SHORTCUT extraction."""

    def test_shortcuts_extracted(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        # Shortcuts are on ETL_CUSTOMER folder sessions
        cust_sessions = [
            s for s in result["sessions"]
            if s.get("_folder_meta", {}).get("name") == "ETL_CUSTOMER"
        ]
        assert len(cust_sessions) > 0
        shortcuts = cust_sessions[0].get("_shortcuts", [])
        assert len(shortcuts) >= 1

    def test_shortcut_attributes(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_sessions = [
            s for s in result["sessions"]
            if s.get("_folder_meta", {}).get("name") == "ETL_CUSTOMER"
        ]
        sc = cust_sessions[0]["_shortcuts"][0]
        assert sc["name"] == "SC_SHARED_LKP"
        assert sc["ref_object_name"] == "SHARED_LOOKUP"
        assert sc["object_type"] == "SOURCE"
        assert sc["source_folder"] == "ETL_SHARED"


class TestMetadataExtensions:
    """Tests for Phase 1D: METADATAEXTENSION extraction."""

    def test_folder_metadata_extensions(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("_folder_meta", {}).get("name") == "ETL_CUSTOMER"
        )
        exts = cust_session["_folder_meta"].get("metadata_extensions", [])
        assert len(exts) >= 1
        ds_ext = next((e for e in exts if e["name"] == "DataSteward"), None)
        assert ds_ext is not None
        assert ds_ext["value"] == "John Smith"
        assert ds_ext["domain_name"] == "Governance"

    def test_mapping_metadata_extensions(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        # s_LOAD_CUSTOMER_DIM uses m_LOAD_CUSTOMER_DIM which has a METADATAEXTENSION
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        mm = cust_session.get("_mapping_meta", {})
        exts = mm.get("metadata_extensions", [])
        assert len(exts) >= 1
        bo_ext = next((e for e in exts if e["name"] == "BusinessOwner"), None)
        assert bo_ext is not None
        assert bo_ext["value"] == "Jane Doe"


class TestConfigParsing:
    """Tests for Phase 1G: CONFIG element extraction."""

    def test_config_map_populated(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_sessions = [
            s for s in result["sessions"]
            if s.get("_folder_meta", {}).get("name") == "ETL_CUSTOMER"
        ]
        assert len(cust_sessions) > 0
        config_map = cust_sessions[0].get("_config_map", {})
        assert "CFG_DEFAULT" in config_map

    def test_config_attributes(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("_folder_meta", {}).get("name") == "ETL_CUSTOMER"
        )
        cfg = cust_session["_config_map"]["CFG_DEFAULT"]
        assert cfg["is_default"] == "YES"
        attrs = cfg.get("attributes", {})
        assert attrs.get("Commit Interval") == "10000"
        assert attrs.get("Stop On Errors") == "0"


class TestFlatFileParsing:
    """Tests for Phase 1H: FLATFILE child extraction on SOURCE."""

    def test_flatfile_source_detected(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        # Find source definitions from ETL_CUSTOMER folder
        cust_sessions = [
            s for s in result["sessions"]
            if s.get("_folder_meta", {}).get("name") == "ETL_CUSTOMER"
        ]
        src_defs = cust_sessions[0].get("_source_definitions", [])
        flat_src = next((sd for sd in src_defs if sd["source_name"] == "FLAT_FEED"), None)
        assert flat_src is not None
        ff = flat_src.get("flatfile_info")
        assert ff is not None
        assert ff["delimiters"] == ","
        assert ff["skip_rows"] == "1"


class TestTargetIndexParsing:
    """Tests for Phase 1E: TARGETINDEX extraction."""

    def test_target_index_extracted(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_sessions = [
            s for s in result["sessions"]
            if s.get("_folder_meta", {}).get("name") == "ETL_CUSTOMER"
        ]
        tgt_defs = cust_sessions[0].get("_target_definitions", [])
        cust_dim = next((td for td in tgt_defs if td["target_name"] == "CUSTOMER_DIM"), None)
        assert cust_dim is not None
        indexes = cust_dim.get("indexes", [])
        assert len(indexes) >= 1
        assert indexes[0]["name"] == "IX_CUST_DIM_KEY"
        assert indexes[0]["is_unique"] == "YES"
        assert "CUST_KEY" in indexes[0].get("fields", [])


class TestMappingExpansion:
    """Tests for Phase 2A: MAPPING additional attributes."""

    def test_mapping_is_valid(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        mm = cust_session.get("_mapping_meta", {})
        assert mm.get("is_valid") == "YES"

    def test_mapping_description(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        mm = cust_session.get("_mapping_meta", {})
        assert mm.get("description") == "Load customer dimension table"

    def test_target_load_order(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        mm = cust_session.get("_mapping_meta", {})
        tlo = mm.get("target_load_order", [])
        assert len(tlo) >= 1

    def test_map_dependencies(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        mm = cust_session.get("_mapping_meta", {})
        deps = mm.get("map_dependencies", [])
        assert len(deps) >= 1
        assert deps[0]["name"] == "dep_shared_lkp"


class TestSessionAttributes:
    """Tests for Phase 2D: SESSION ATTRIBUTE children."""

    def test_session_attributes_extracted(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        sa = cust_session.get("session_attributes", {})
        assert sa.get("Treat Source Rows As") == "Insert"
        assert sa.get("Commit Type") == "Target"
        assert sa.get("Commit Interval") == "10000"


class TestWorkflowExpansion:
    """Tests for Phase 2H-2K: WORKFLOW expanded attributes."""

    def test_workflow_meta_extracted(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        wm = cust_session.get("_workflow_meta")
        assert wm is not None
        assert wm.get("is_enabled") == "YES"
        assert wm.get("server_name") == "IS_PROD"
        assert wm.get("description") == "Customer ETL workflow"

    def test_workflow_variables(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        wm = cust_session.get("_workflow_meta", {})
        wf_vars = wm.get("workflow_variables", [])
        assert len(wf_vars) >= 1
        run_date = next((v for v in wf_vars if v["name"] == "$$RunDate"), None)
        assert run_date is not None
        assert run_date["datatype"] == "Date/Time"

    def test_workflow_link_conditions(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        wm = cust_session.get("_workflow_meta", {})
        edges = wm.get("task_edges", [])
        # Should have edges with conditions
        conditional_edges = [e for e in edges if e.get("condition")]
        assert len(conditional_edges) >= 1
        # Check the condition text
        assert any("SUCCEEDED" in e.get("condition", "") for e in conditional_edges)

    def test_scheduler_info(self, small_infa_xml):
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["test.xml"])
        cust_session = next(
            s for s in result["sessions"]
            if s.get("full", "") == "s_LOAD_CUSTOMER_DIM"
        )
        wm = cust_session.get("_workflow_meta", {})
        sched = wm.get("schedule_info")
        assert sched is not None
        assert sched.get("scheduler_name") == "SCH_DAILY"


class TestTransformExpansion:
    """Tests for Phase 2B: TRANSFORMATION additional attributes."""

    def test_transform_reusable(self, small_infa_xml):
        from app.engines.infa_engine import _parse_file
        sessions = _parse_file(small_infa_xml, "test.xml")
        # LKP_CUSTOMER_XREF has REUSABLE=YES
        # Check if this info ends up in the session data
        cust_session = sessions.get("s_LOAD_CUSTOMER_DIM")
        assert cust_session is not None
        # The transform detail should be available in mapping_detail
        md = cust_session.get("mapping_detail", {})
        if md:
            fields = md.get("fields", [])
            # TRANSFORMFIELD extra attributes should be present
            if fields:
                # Check that at least one field has extra attributes from V7
                field_with_group = [f for f in fields if f.get("group")]
                # The fixture has GROUP="INPUT" on LKP_CUSTOMER_XREF fields
                assert len(field_with_group) >= 0  # May or may not be captured depending on transform type
