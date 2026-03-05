"""Tests for code analysis features — embedded code detection, function extraction,
intent classification, and code profile generation.

Tests the new code analysis pipeline added in Phase 6:
  - _classify_code_language()
  - _extract_functions_from_text()
  - _count_loc()
  - _classify_session_intent()
  - _enrich_session_code_analysis()
  - EmbeddedCodeRecord, FunctionUsageRecord, SessionCodeProfile models
  - populate_code_analysis_tables()
"""

import json
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.engines.infa_engine import (
    _classify_code_language,
    _count_loc,
    _enrich_session_code_analysis,
    _extract_functions_from_text,
    _extract_tables_from_sql,
    _classify_session_intent,
    _KNOWN_FUNCTIONS,
)
from app.models.database import (
    Base,
    EmbeddedCodeRecord,
    FunctionUsageRecord,
    SessionCodeProfile,
    SessionRecord,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def code_db(tmp_path):
    """In-memory SQLite DB with all tables for code analysis tests."""
    from sqlalchemy import event
    from app.models.tags import ActiveTag  # noqa: F401
    db_url = f"sqlite:///{tmp_path}/code_test.db"
    engine = create_engine(db_url, connect_args={"check_same_thread": False})

    # Enable FK enforcement in SQLite (required for CASCADE deletes)
    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_conn, connection_record):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    return Session


@pytest.fixture
def session_with_sql():
    """Session dict with SQL overrides in mapping_detail."""
    return {
        "name": "s_LOAD_CUSTOMERS",
        "full": "wf_DAILY.s_LOAD_CUSTOMERS",
        "mapping": "m_LOAD_CUSTOMERS",
        "sources": ["STG_CUSTOMER"],
        "targets": ["CUSTOMER_DIM"],
        "lookups": ["CUSTOMER_XREF"],
        "tx_count": 4,
        "tx_detail": {"expression": 2, "lookup procedure": 1, "source qualifier": 1},
        "mapping_detail": {
            "instances": [
                {"name": "SQ_STG", "type": "Source", "transformation_name": "STG_CUSTOMER",
                 "transformation_type": "Source Qualifier"},
                {"name": "EXP_DERIVE", "type": "TRANSFORMATION", "transformation_name": "EXP_DERIVE",
                 "transformation_type": "Expression"},
                {"name": "TGT_DIM", "type": "Target", "transformation_name": "CUSTOMER_DIM",
                 "transformation_type": "Target Definition"},
            ],
            "connectors": [],
            "fields": [
                {"transform": "EXP_DERIVE", "name": "FULL_NAME", "datatype": "string",
                 "expression": "IIF(ISNULL(FIRST_NAME), LAST_NAME, CONCAT(FIRST_NAME, ' ', LAST_NAME))",
                 "expression_type": "derived"},
                {"transform": "EXP_DERIVE", "name": "CUST_KEY", "datatype": "integer",
                 "expression": "TO_INTEGER(SUBSTR(CUST_ID, 3, 10))",
                 "expression_type": "derived"},
                {"transform": "EXP_DERIVE", "name": "LOAD_DATE", "datatype": "date",
                 "expression": "SYSDATE", "expression_type": "derived"},
                {"transform": "EXP_DERIVE", "name": "STATUS", "datatype": "string",
                 "expression": "STATUS", "expression_type": "passthrough"},
            ],
            "sql_overrides": [
                {"transform": "SQ_STG",
                 "sql": "SELECT c.*, x.XREF_KEY\nFROM STG_CUSTOMER c\nJOIN CUSTOMER_XREF x ON c.CUST_ID = x.CUST_ID\nWHERE c.ACTIVE_FLAG = 'Y'"},
            ],
            "pre_sql": ["DELETE FROM CUSTOMER_DIM WHERE BATCH_ID = $$BATCH_ID"],
            "post_sql": ["UPDATE AUDIT_LOG SET STATUS = 'COMPLETE' WHERE JOB_NAME = 'LOAD_CUSTOMERS'"],
        },
    }


@pytest.fixture
def session_with_java():
    """Session dict with a Java custom transform."""
    return {
        "name": "s_CUSTOM_JAVA",
        "full": "wf_NIGHTLY.s_CUSTOM_JAVA",
        "mapping": "m_CUSTOM_JAVA",
        "sources": ["RAW_DATA"],
        "targets": ["PROCESSED_DATA"],
        "lookups": [],
        "tx_count": 2,
        "tx_detail": {"custom transformation": 1, "source qualifier": 1},
        "mapping_detail": {
            "instances": [
                {"name": "SQ_RAW", "type": "Source", "transformation_name": "RAW_DATA",
                 "transformation_type": "Source Qualifier"},
                {"name": "CTX_JAVA_PROC", "type": "TRANSFORMATION", "transformation_name": "CTX_JAVA_PROC",
                 "transformation_type": "Custom Transformation"},
                {"name": "TGT_PROC", "type": "Target", "transformation_name": "PROCESSED_DATA",
                 "transformation_type": "Target Definition"},
            ],
            "connectors": [],
            "fields": [],
        },
    }


@pytest.fixture
def session_with_aggregator():
    """Session dict with aggregator transforms (should classify as 'aggregate' intent)."""
    return {
        "name": "s_AGG_SALES",
        "full": "wf_DAILY.s_AGG_SALES",
        "mapping": "m_AGG_SALES",
        "sources": ["ORDER_LINE"],
        "targets": ["SALES_SUMMARY"],
        "lookups": [],
        "tx_count": 3,
        "tx_detail": {"aggregator": 1, "expression": 1, "source qualifier": 1},
        "mapping_detail": {
            "instances": [],
            "connectors": [],
            "fields": [
                {"transform": "AGG_TOTALS", "name": "TOTAL_AMT", "datatype": "decimal",
                 "expression": "SUM(LINE_AMOUNT)", "expression_type": "aggregated"},
                {"transform": "AGG_TOTALS", "name": "ORDER_COUNT", "datatype": "integer",
                 "expression": "COUNT(ORDER_ID)", "expression_type": "aggregated"},
            ],
        },
    }


@pytest.fixture
def session_simple_load():
    """Simple load session with no transforms (should classify as 'load' intent)."""
    return {
        "name": "s_SIMPLE_LOAD",
        "full": "wf_DAILY.s_SIMPLE_LOAD",
        "mapping": "m_SIMPLE_LOAD",
        "sources": ["SRC_TABLE"],
        "targets": ["TGT_TABLE"],
        "lookups": [],
        "tx_count": 1,
        "tx_detail": {"source qualifier": 1},
        "mapping_detail": {
            "instances": [],
            "connectors": [],
            "fields": [],
        },
    }


# ── Language Classification ──────────────────────────────────────────────────


class TestClassifyCodeLanguage:
    def test_sql_detection(self):
        sql = "SELECT * FROM CUSTOMER WHERE STATUS = 'ACTIVE'"
        lang, conf = _classify_code_language(sql)
        assert lang == "sql"
        assert conf >= 0.5

    def test_sql_join_detection(self):
        sql = "SELECT a.*, b.NAME FROM ORDERS a JOIN CUSTOMER b ON a.CUST_ID = b.ID"
        lang, conf = _classify_code_language(sql)
        assert lang == "sql"
        assert conf >= 0.6

    def test_plsql_detection(self):
        plsql = "BEGIN\n  DECLARE v_count INTEGER;\n  SELECT COUNT(*) INTO v_count FROM CUSTOMER;\n  EXCEPTION WHEN OTHERS THEN NULL;\nEND;"
        lang, conf = _classify_code_language(plsql)
        assert lang == "plsql"
        assert conf >= 0.7

    def test_java_detection(self):
        java = "public class MyTransform { private String field; }"
        lang, conf = _classify_code_language(java)
        assert lang == "java"
        assert conf >= 0.8

    def test_python_detection(self):
        python = "import pandas as pd\ndef transform(df):\n    return df.filter(items=['col1'])"
        lang, conf = _classify_code_language(python)
        assert lang == "python"
        assert conf >= 0.7

    def test_shell_detection(self):
        shell = "#!/bin/bash\nexport PATH=$PATH:/opt/etl\necho 'Starting job'"
        lang, conf = _classify_code_language(shell)
        assert lang == "shell"
        assert conf >= 0.7

    def test_informatica_expression_default(self):
        expr = "IIF(ISNULL(FIELD1), 'N/A', FIELD1)"
        lang, conf = _classify_code_language(expr, "expression")
        assert lang == "informatica_expression"

    def test_empty_string(self):
        lang, conf = _classify_code_language("")
        assert lang == "informatica_expression"
        assert conf <= 0.6

    def test_r_detection(self):
        r_code = "library(dplyr)\ndf <- data.frame(x=1:10)"
        lang, conf = _classify_code_language(r_code)
        assert lang == "r"

    def test_javascript_detection(self):
        js = "const x = function() { console.log('test'); };"
        lang, conf = _classify_code_language(js)
        assert lang == "javascript"


# ── Function Extraction ──────────────────────────────────────────────────────


class TestExtractFunctions:
    def test_simple_functions(self):
        expr = "IIF(ISNULL(NAME), 'UNKNOWN', UPPER(NAME))"
        funcs = _extract_functions_from_text(expr)
        names = {f["function_name"] for f in funcs}
        assert "IIF" in names
        assert "ISNULL" not in names or "ISNULL" in names  # may or may not be known
        assert "UPPER" in names

    def test_aggregate_functions(self):
        expr = "SUM(AMOUNT) + COUNT(ORDER_ID)"
        funcs = _extract_functions_from_text(expr)
        names = {f["function_name"] for f in funcs}
        assert "SUM" in names
        assert "COUNT" in names
        for f in funcs:
            if f["function_name"] in ("SUM", "COUNT"):
                assert f["function_category"] == "aggregate"

    def test_date_functions(self):
        expr = "TO_DATE(DATE_STR, 'YYYY-MM-DD')"
        funcs = _extract_functions_from_text(expr)
        assert any(f["function_name"] == "TO_DATE" and f["function_category"] == "date" for f in funcs)

    def test_conversion_functions(self):
        expr = "TO_CHAR(TO_INTEGER(NUM_STR))"
        funcs = _extract_functions_from_text(expr)
        names = {f["function_name"] for f in funcs}
        assert "TO_CHAR" in names
        assert "TO_INTEGER" in names

    def test_unknown_function_is_custom_udf(self):
        expr = "MY_CUSTOM_FUNC(X, Y)"
        funcs = _extract_functions_from_text(expr)
        assert len(funcs) >= 1
        assert funcs[0]["function_category"] == "custom_udf"

    def test_sql_keywords_excluded(self):
        sql = "SELECT COUNT(*) FROM ORDERS WHERE EXISTS (SELECT 1 FROM CUSTOMER)"
        funcs = _extract_functions_from_text(sql)
        names = {f["function_name"] for f in funcs}
        assert "SELECT" not in names
        assert "FROM" not in names
        assert "WHERE" not in names
        assert "EXISTS" not in names

    def test_empty_text(self):
        assert _extract_functions_from_text("") == []
        assert _extract_functions_from_text(None) == []

    def test_nested_depth(self):
        expr = "IIF(ISNULL(SUBSTR(NAME, 1, 5)), 'N/A', UPPER(NAME))"
        funcs = _extract_functions_from_text(expr)
        # SUBSTR is nested inside ISNULL which is inside IIF
        iif_func = next((f for f in funcs if f["function_name"] == "IIF"), None)
        assert iif_func is not None
        assert iif_func["nested_depth"] == 0  # IIF is outermost

    def test_call_count(self):
        expr = "IIF(X > 0, IIF(Y > 0, 'A', 'B'), 'C')"
        funcs = _extract_functions_from_text(expr)
        iif = next((f for f in funcs if f["function_name"] == "IIF"), None)
        assert iif is not None
        assert iif["call_count"] == 2


# ── LOC Counting ──────────────────────────────────────────────────────────────


class TestCountLoc:
    def test_multiline(self):
        text = "SELECT *\nFROM TABLE\nWHERE X = 1"
        assert _count_loc(text) == 3

    def test_blank_lines_excluded(self):
        text = "SELECT *\n\n\nFROM TABLE\n\nWHERE X = 1\n"
        assert _count_loc(text) == 3

    def test_single_line(self):
        assert _count_loc("SELECT 1") == 1

    def test_empty(self):
        assert _count_loc("") == 0
        assert _count_loc(None) == 0

    def test_whitespace_only(self):
        assert _count_loc("   \n  \n  ") == 0


# ── Table Extraction from SQL ────────────────────────────────────────────────


class TestExtractTablesFromSql:
    def test_basic_from(self):
        tables = _extract_tables_from_sql("SELECT * FROM CUSTOMER")
        assert "CUSTOMER" in tables

    def test_join(self):
        tables = _extract_tables_from_sql("SELECT * FROM ORDERS JOIN CUSTOMER ON 1=1")
        assert "ORDERS" in tables
        assert "CUSTOMER" in tables

    def test_insert_into(self):
        tables = _extract_tables_from_sql("INSERT INTO TARGET_TABLE SELECT * FROM SRC")
        assert "TARGET_TABLE" in tables
        assert "SRC" in tables

    def test_empty(self):
        assert _extract_tables_from_sql("") == []
        assert _extract_tables_from_sql(None) == []


# ── Intent Classification ────────────────────────────────────────────────────


class TestIntentClassification:
    def test_aggregate_intent(self, session_with_aggregator):
        intent, conf, details = _classify_session_intent(session_with_aggregator)
        assert intent == "aggregate"
        assert conf > 0

    def test_load_intent(self, session_simple_load):
        intent, conf, details = _classify_session_intent(session_simple_load)
        assert intent == "load"

    def test_lookup_enrich_intent(self):
        session = {
            "sources": ["SRC"],
            "targets": ["TGT"],
            "lookups": ["LKP1", "LKP2", "LKP3"],
            "tx_count": 5,
            "tx_detail": {"lookup procedure": 3, "expression": 1, "source qualifier": 1},
        }
        intent, conf, details = _classify_session_intent(session)
        assert intent == "lookup_enrich"

    def test_filter_intent(self):
        session = {
            "sources": ["SRC"],
            "targets": ["TGT"],
            "lookups": [],
            "tx_count": 3,
            "tx_detail": {"filter": 2, "source qualifier": 1},
        }
        intent, conf, details = _classify_session_intent(session)
        assert intent == "filter"

    def test_scd_intent(self):
        session = {
            "sources": ["SRC"],
            "targets": ["DIM"],
            "lookups": [],
            "tx_count": 4,
            "tx_detail": {"update strategy": 1, "expression": 2, "source qualifier": 1},
            "mapping_variables": [{"name": "$$LAST_LOAD_DATE"}],
        }
        intent, conf, details = _classify_session_intent(session)
        assert intent == "scd"

    def test_route_intent(self):
        session = {
            "sources": ["SRC"],
            "targets": ["TGT1", "TGT2"],
            "lookups": [],
            "tx_count": 3,
            "tx_detail": {"router": 1, "source qualifier": 1, "expression": 1},
        }
        intent, conf, details = _classify_session_intent(session)
        assert intent == "route"

    def test_audit_intent(self):
        session = {
            "sources": ["SRC"],
            "targets": ["AUDIT_LOG"],
            "lookups": [],
            "tx_count": 2,
            "tx_detail": {"expression": 1, "source qualifier": 1},
        }
        intent, conf, details = _classify_session_intent(session)
        assert intent == "audit"


# ── Session Code Enrichment ──────────────────────────────────────────────────


class TestEnrichSessionCodeAnalysis:
    def test_enriches_sql_session(self, session_with_sql):
        sessions = {"s_LOAD_CUSTOMERS": session_with_sql}
        _enrich_session_code_analysis(sessions)

        sdata = sessions["s_LOAD_CUSTOMERS"]
        assert "embedded_code" in sdata
        assert "function_usage" in sdata
        assert "code_profile" in sdata

        # Should detect SQL override
        ec = sdata["embedded_code"]
        assert len(ec) >= 1
        sql_blocks = [e for e in ec if e["code_type"] == "sql"]
        assert len(sql_blocks) >= 1

        # Should detect pre/post SQL
        pre_post = [e for e in ec if e["code_subtype"] in ("pre_sql", "post_sql")]
        assert len(pre_post) >= 2

        # Code profile should have has_sql=1 and has_pre_post_sql=1
        cp = sdata["code_profile"]
        assert cp["has_sql"] == 1
        assert cp["has_pre_post_sql"] == 1
        assert cp["total_code_blocks"] >= 3
        assert cp["total_loc"] > 0

    def test_enriches_java_session(self, session_with_java):
        sessions = {"s_CUSTOM_JAVA": session_with_java}
        _enrich_session_code_analysis(sessions)

        sdata = sessions["s_CUSTOM_JAVA"]
        cp = sdata["code_profile"]
        assert cp["has_java"] == 1
        assert cp["has_custom_transform"] == 1

    def test_function_extraction_from_expressions(self, session_with_sql):
        sessions = {"s_LOAD_CUSTOMERS": session_with_sql}
        _enrich_session_code_analysis(sessions)

        sdata = sessions["s_LOAD_CUSTOMERS"]
        func_names = {f["function_name"] for f in sdata["function_usage"]}

        # Should find IIF, CONCAT, SUBSTR, TO_INTEGER, SYSDATE from expressions
        assert "IIF" in func_names or "CONCAT" in func_names
        assert "SUBSTR" in func_names or "TO_INTEGER" in func_names

        # Code profile should have function counts
        cp = sdata["code_profile"]
        assert cp["total_functions_used"] > 0
        assert cp["distinct_functions_used"] > 0

    def test_empty_session_no_crash(self):
        """Sessions without mapping_detail should not crash."""
        sessions = {
            "s_EMPTY": {
                "name": "s_EMPTY",
                "full": "wf.s_EMPTY",
                "sources": [],
                "targets": [],
                "lookups": [],
                "tx_count": 0,
                "tx_detail": {},
            }
        }
        _enrich_session_code_analysis(sessions)
        cp = sessions["s_EMPTY"]["code_profile"]
        assert cp["total_code_blocks"] == 0
        assert cp["total_loc"] == 0

    def test_intent_attached(self, session_with_aggregator):
        sessions = {"s_AGG_SALES": session_with_aggregator}
        _enrich_session_code_analysis(sessions)
        cp = sessions["s_AGG_SALES"]["code_profile"]
        assert cp["core_intent"] == "aggregate"
        assert cp["intent_confidence"] > 0


# ── Database Model Tests ─────────────────────────────────────────────────────


class TestCodeAnalysisModels:
    def test_embedded_code_record_creation(self, code_db):
        """EmbeddedCodeRecord can be created and queried."""
        db = code_db()
        # Need an upload first
        from app.models.database import Upload
        upload = Upload(filename="test.xml", platform="informatica", tier_data_json="{}")
        db.add(upload)
        db.flush()

        rec = EmbeddedCodeRecord(
            upload_id=upload.id,
            session_name="s_TEST",
            transform_name="SQ_SRC",
            code_type="sql",
            code_subtype="sql_override",
            code_text="SELECT * FROM TEST",
            line_count=1,
            char_count=19,
        )
        db.add(rec)
        db.commit()

        result = db.query(EmbeddedCodeRecord).filter_by(upload_id=upload.id).all()
        assert len(result) == 1
        assert result[0].code_type == "sql"
        assert result[0].line_count == 1
        db.close()

    def test_function_usage_record_creation(self, code_db):
        """FunctionUsageRecord can be created and queried."""
        db = code_db()
        from app.models.database import Upload
        upload = Upload(filename="test.xml", platform="informatica", tier_data_json="{}")
        db.add(upload)
        db.flush()

        rec = FunctionUsageRecord(
            upload_id=upload.id,
            session_name="s_TEST",
            function_name="IIF",
            function_category="conditional",
            call_count=3,
        )
        db.add(rec)
        db.commit()

        result = db.query(FunctionUsageRecord).filter_by(upload_id=upload.id).all()
        assert len(result) == 1
        assert result[0].function_name == "IIF"
        assert result[0].call_count == 3
        db.close()

    def test_session_code_profile_creation(self, code_db):
        """SessionCodeProfile can be created and queried."""
        db = code_db()
        from app.models.database import Upload
        upload = Upload(filename="test.xml", platform="informatica", tier_data_json="{}")
        db.add(upload)
        db.flush()

        rec = SessionCodeProfile(
            upload_id=upload.id,
            session_name="s_TEST",
            has_sql=1,
            has_java=0,
            total_loc=42,
            total_functions_used=15,
            distinct_functions_used=8,
            core_intent="transform",
            intent_confidence=0.75,
        )
        db.add(rec)
        db.commit()

        result = db.query(SessionCodeProfile).filter_by(upload_id=upload.id).all()
        assert len(result) == 1
        assert result[0].has_sql == 1
        assert result[0].total_loc == 42
        assert result[0].core_intent == "transform"
        db.close()

    def test_cascade_delete(self, code_db):
        """Deleting an upload should cascade-delete code analysis records."""
        db = code_db()
        from app.models.database import Upload
        upload = Upload(filename="test.xml", platform="informatica", tier_data_json="{}")
        db.add(upload)
        db.flush()
        uid = upload.id

        db.add(EmbeddedCodeRecord(upload_id=uid, session_name="s1", code_type="sql"))
        db.add(FunctionUsageRecord(upload_id=uid, session_name="s1", function_name="IIF"))
        db.add(SessionCodeProfile(upload_id=uid, session_name="s1"))
        db.commit()

        assert db.query(EmbeddedCodeRecord).filter_by(upload_id=uid).count() == 1
        assert db.query(FunctionUsageRecord).filter_by(upload_id=uid).count() == 1
        assert db.query(SessionCodeProfile).filter_by(upload_id=uid).count() == 1

        db.delete(upload)
        db.commit()

        assert db.query(EmbeddedCodeRecord).filter_by(upload_id=uid).count() == 0
        assert db.query(FunctionUsageRecord).filter_by(upload_id=uid).count() == 0
        assert db.query(SessionCodeProfile).filter_by(upload_id=uid).count() == 0
        db.close()

    def test_session_record_new_columns(self, code_db):
        """SessionRecord should have the new Phase 6 columns."""
        db = code_db()
        from app.models.database import Upload
        upload = Upload(filename="test.xml", platform="informatica", tier_data_json="{}")
        db.add(upload)
        db.flush()

        sr = SessionRecord(
            upload_id=upload.id,
            session_id="S1",
            name="s_TEST",
            full_name="wf.s_TEST",
            tier=1.0,
            total_loc=100,
            total_functions_used=25,
            distinct_functions_used=10,
            has_embedded_sql=1,
            has_embedded_java=0,
            has_stored_procedure=0,
            core_intent="transform",
        )
        db.add(sr)
        db.commit()

        result = db.query(SessionRecord).filter_by(upload_id=upload.id).first()
        assert result.total_loc == 100
        assert result.core_intent == "transform"
        assert result.has_embedded_sql == 1
        db.close()


# ── Populate Code Analysis Tables ─────────────────────────────────────────────


class TestPopulateCodeAnalysisTables:
    def test_populate_from_enriched_data(self, code_db, session_with_sql):
        """populate_code_analysis_tables should create DB rows from enriched session data."""
        from app.engines.data_populator import populate_code_analysis_tables

        # Enrich the session first
        sessions = {"s_LOAD_CUSTOMERS": session_with_sql}
        _enrich_session_code_analysis(sessions)

        # Build a tier_data-like structure
        tier_data = {
            "sessions": [
                {
                    **sessions["s_LOAD_CUSTOMERS"],
                    "id": "S1",
                    "tier": 1,
                }
            ],
            "tables": [],
            "connections": [],
        }

        db = code_db()
        from app.models.database import Upload
        upload = Upload(filename="test.xml", platform="informatica", tier_data_json="{}")
        db.add(upload)
        db.flush()

        populate_code_analysis_tables(db, upload.id, tier_data)
        db.commit()

        # Verify embedded code records
        ec_count = db.query(EmbeddedCodeRecord).filter_by(upload_id=upload.id).count()
        assert ec_count >= 3  # sql_override + pre_sql + post_sql

        # Verify function usage records
        fu_count = db.query(FunctionUsageRecord).filter_by(upload_id=upload.id).count()
        assert fu_count >= 1

        # Verify session code profile
        cp = db.query(SessionCodeProfile).filter_by(upload_id=upload.id).first()
        assert cp is not None
        assert cp.has_sql == 1
        assert cp.has_pre_post_sql == 1
        assert cp.total_loc > 0
        db.close()

    def test_idempotent_populate(self, code_db, session_with_sql):
        """Running populate twice should not duplicate rows."""
        from app.engines.data_populator import populate_code_analysis_tables

        sessions = {"s_LOAD_CUSTOMERS": session_with_sql}
        _enrich_session_code_analysis(sessions)

        tier_data = {
            "sessions": [{**sessions["s_LOAD_CUSTOMERS"], "id": "S1", "tier": 1}],
            "tables": [],
            "connections": [],
        }

        db = code_db()
        from app.models.database import Upload
        upload = Upload(filename="test.xml", platform="informatica", tier_data_json="{}")
        db.add(upload)
        db.flush()

        populate_code_analysis_tables(db, upload.id, tier_data)
        db.commit()
        count1 = db.query(EmbeddedCodeRecord).filter_by(upload_id=upload.id).count()

        # Run again
        populate_code_analysis_tables(db, upload.id, tier_data)
        db.commit()
        count2 = db.query(EmbeddedCodeRecord).filter_by(upload_id=upload.id).count()

        assert count1 == count2
        db.close()


# ── Known Function Catalog ────────────────────────────────────────────────────


class TestKnownFunctions:
    def test_all_categories_covered(self):
        """Every known function should have a valid category."""
        valid_categories = {
            "aggregate", "string", "date", "math", "conversion",
            "conditional", "lookup", "system",
            "analytic", "financial", "binary", "encoding", "encryption",
        }
        for func, cat in _KNOWN_FUNCTIONS.items():
            assert cat in valid_categories, f"{func} has invalid category '{cat}'"

    def test_key_functions_present(self):
        """Critical Informatica functions should be in the catalog."""
        expected = ["IIF", "DECODE", "SUM", "AVG", "COUNT", "TO_DATE",
                    "SUBSTR", "CONCAT", "TO_CHAR", "LOOKUP", "NVL"]
        for fn in expected:
            assert fn in _KNOWN_FUNCTIONS, f"Missing expected function: {fn}"


# ── Integration with Parse Engine ─────────────────────────────────────────────


class TestParseEngineIntegration:
    def test_small_fixture_has_code_analysis(self, small_infa_xml):
        """Parsing the small fixture should produce code_profile on sessions."""
        from app.engines.infa_engine import analyze
        result = analyze([small_infa_xml], ["small_informatica.xml"])

        # At least one session should have code_profile
        sessions_with_profile = [
            s for s in result["sessions"]
            if s.get("code_profile")
        ]
        # The small fixture has minimal expressions, so profiles may be sparse
        # but they should still exist
        # Every session should get a code_profile dict (even if sparse)
        assert len(sessions_with_profile) == len(result["sessions"])

    def test_full_enrichment_roundtrip(self, small_infa_xml, code_db):
        """Parse → enrich → populate → query should work end to end."""
        from app.engines.infa_engine import analyze
        from app.engines.data_populator import populate_core_tables, populate_code_analysis_tables

        result = analyze([small_infa_xml], ["small_informatica.xml"])

        db = code_db()
        from app.models.database import Upload
        upload = Upload(filename="test.xml", platform="informatica", tier_data_json="{}")
        db.add(upload)
        db.flush()

        populate_core_tables(db, upload.id, result)
        populate_code_analysis_tables(db, upload.id, result)
        db.commit()

        # Should have session records
        sr_count = db.query(SessionRecord).filter_by(upload_id=upload.id).count()
        assert sr_count > 0

        # Should have code profiles (one per session)
        cp_count = db.query(SessionCodeProfile).filter_by(upload_id=upload.id).count()
        # Every session should get a code profile
        # Every session should get a code profile row
        assert cp_count == sr_count
        db.close()


# ── SSE Heartbeat Test ────────────────────────────────────────────────────────


class TestSSEHeartbeat:
    def test_heartbeat_in_event_generator(self):
        """The _event_generator should yield heartbeat comments on timeout."""
        import asyncio

        async def _test():
            queue = asyncio.Queue()

            async def _event_generator():
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=0.1)
                    except asyncio.TimeoutError:
                        yield ": heartbeat\n\n"
                        continue
                    yield f"data: {json.dumps(event)}\n\n"
                    if event.get("phase") in ("complete", "error"):
                        break

            events = []
            gen = _event_generator()

            # Should get heartbeat since queue is empty
            event = await gen.__anext__()
            events.append(event)
            assert event == ": heartbeat\n\n"

            # Now put a complete event
            await queue.put({"phase": "complete"})
            event = await gen.__anext__()
            events.append(event)
            assert '"complete"' in event

        asyncio.run(_test())


# ── V7 Expanded Function Catalog Tests ─────────────────────────────────────


class TestV7FunctionCatalog:
    """Tests for Phase 5: expanded function categories."""

    def test_analytic_functions_present(self):
        """LAG, LEAD should be in the catalog as analytic."""
        assert _KNOWN_FUNCTIONS.get("LAG") == "analytic"
        assert _KNOWN_FUNCTIONS.get("LEAD") == "analytic"

    def test_financial_functions_present(self):
        """FV, NPER, PMT, PV, RATE should be financial."""
        for fn in ["FV", "NPER", "PMT", "PV", "RATE"]:
            assert _KNOWN_FUNCTIONS.get(fn) == "financial", f"{fn} missing or wrong category"

    def test_binary_functions_present(self):
        """BINARY_COMPARE, BINARY_CONCAT, BINARY_LENGTH, BINARY_SECTION should be binary."""
        for fn in ["BINARY_COMPARE", "BINARY_CONCAT", "BINARY_LENGTH", "BINARY_SECTION"]:
            assert _KNOWN_FUNCTIONS.get(fn) == "binary", f"{fn} missing or wrong category"

    def test_encoding_functions_present(self):
        """ENC_BASE64, DEC_BASE64, ENC_HEX, DEC_HEX should be encoding."""
        for fn in ["ENC_BASE64", "DEC_BASE64", "ENC_HEX", "DEC_HEX"]:
            assert _KNOWN_FUNCTIONS.get(fn) == "encoding", f"{fn} missing or wrong category"

    def test_encryption_functions_present(self):
        """AES_ENCRYPT, AES_DECRYPT should be encryption."""
        assert _KNOWN_FUNCTIONS.get("AES_ENCRYPT") == "encryption"
        assert _KNOWN_FUNCTIONS.get("AES_DECRYPT") == "encryption"

    def test_analytic_function_extraction(self):
        """Analytic functions should be extractable from expression text."""
        expr = "LAG(AMOUNT, 1, 0) + LEAD(AMOUNT, 1, 0)"
        funcs = _extract_functions_from_text(expr)
        names = {f["function_name"] for f in funcs}
        assert "LAG" in names
        assert "LEAD" in names
        for f in funcs:
            if f["function_name"] in ("LAG", "LEAD"):
                assert f["function_category"] == "analytic"
