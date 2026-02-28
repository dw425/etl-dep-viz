"""Tests for NiFi XML parse engine."""

import pytest


class TestNifiParseBasics:
    def test_parse_nifi_template(self, small_nifi_xml):
        from app.engines.nifi_tier_engine import analyze
        result = analyze([small_nifi_xml], ["test_nifi.xml"])
        sessions = result["sessions"]
        assert len(sessions) >= 1  # Should find processors

    def test_processor_classification(self):
        from app.engines.nifi_tier_engine import _classify
        # _classify strips dots and uses last segment lowercase
        assert _classify("GetFile") == "source"
        assert _classify("PutDatabaseRecord") == "sink"
        assert _classify("JoltTransformJSON") == "transform"
        # Full class names — strips to last segment
        assert _classify("org.apache.nifi.processors.standard.GetFile") in ("source", "transform")

    def test_resource_extraction(self):
        from app.engines.nifi_tier_engine import _extract_resource
        props = {"Table Name": "CUSTOMER_TABLE"}
        assert _extract_resource("PutDatabaseRecord", props) == "CUSTOMER_TABLE"

    def test_resource_extraction_kafka(self):
        from app.engines.nifi_tier_engine import _extract_resource
        props = {"topic": "my-topic"}
        assert _extract_resource("PublishKafka", props) == "MY-TOPIC"

    def test_empty_input(self):
        from app.engines.nifi_tier_engine import analyze
        result = analyze([], [])
        assert result["sessions"] == []
        assert result["stats"]["session_count"] == 0

    def test_empty_content(self):
        from app.engines.nifi_tier_engine import analyze
        result = analyze([b""], ["empty.xml"])
        assert isinstance(result, dict)
