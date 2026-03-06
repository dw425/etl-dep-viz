"""Tests for the Compare API endpoint (/api/compare)."""

import pytest


def _upload(client, xml_bytes, filename="test.xml"):
    """Helper: upload an XML file and return the upload_id."""
    resp = client.post(
        "/api/tier-map/analyze",
        files=[("files", (filename, xml_bytes, "application/xml"))],
    )
    assert resp.status_code == 200, f"Upload failed: {resp.text}"
    return resp.json()["upload_id"]


class TestCompareHappyPath:
    """Compare two uploads that contain the same XML content."""

    def test_compare_two_uploads(self, client, small_infa_xml):
        id_a = _upload(client, small_infa_xml, "baseline.xml")
        id_b = _upload(client, small_infa_xml, "comparison.xml")

        resp = client.get("/api/compare", params={"upload_a": id_a, "upload_b": id_b})
        assert resp.status_code == 200
        data = resp.json()

        # Top-level keys must be present
        for key in (
            "upload_a_info",
            "upload_b_info",
            "matched",
            "added",
            "removed",
            "table_diff",
            "stats",
        ):
            assert key in data, f"Missing top-level key: {key}"

    def test_upload_info_metadata(self, client, small_infa_xml):
        id_a = _upload(client, small_infa_xml, "alpha.xml")
        id_b = _upload(client, small_infa_xml, "beta.xml")

        data = client.get(
            "/api/compare", params={"upload_a": id_a, "upload_b": id_b}
        ).json()

        for info_key, expected_id in [
            ("upload_a_info", id_a),
            ("upload_b_info", id_b),
        ]:
            info = data[info_key]
            assert info["id"] == expected_id
            assert "filename" in info
            assert "platform" in info
            assert "session_count" in info
            assert "created_at" in info


class TestCompareSameUpload:
    """Comparing an upload to itself should produce zero diffs."""

    def test_same_upload_no_diff(self, client, small_infa_xml):
        uid = _upload(client, small_infa_xml)

        data = client.get(
            "/api/compare", params={"upload_a": uid, "upload_b": uid}
        ).json()

        stats = data["stats"]
        assert stats["added_count"] == 0
        assert stats["removed_count"] == 0
        assert stats["changed_count"] == 0
        assert stats["matched_count"] == stats["total_a"]
        assert stats["matched_count"] == stats["total_b"]
        assert stats["unchanged_count"] == stats["matched_count"]
        assert len(data["added"]) == 0
        assert len(data["removed"]) == 0

        # Every matched entry should have no changes
        for entry in data["matched"]:
            assert entry["has_changes"] is False
            assert entry["changes"] == {}


class TestCompareIdenticalContent:
    """Two separate uploads with the same XML should also show zero diffs."""

    def test_identical_uploads_zero_changes(self, client, small_infa_xml):
        id_a = _upload(client, small_infa_xml, "copy1.xml")
        id_b = _upload(client, small_infa_xml, "copy2.xml")

        data = client.get(
            "/api/compare", params={"upload_a": id_a, "upload_b": id_b}
        ).json()

        stats = data["stats"]
        assert stats["added_count"] == 0
        assert stats["removed_count"] == 0
        assert stats["changed_count"] == 0
        assert stats["tables_added"] == 0
        assert stats["tables_removed"] == 0
        assert stats["tables_modified"] == 0
        assert stats["connections_added"] == 0
        assert stats["connections_removed"] == 0


class TestCompareNotFound:
    """Non-existent upload IDs should return 404."""

    def test_both_missing(self, client):
        resp = client.get(
            "/api/compare", params={"upload_a": 99999, "upload_b": 99998}
        )
        assert resp.status_code == 404

    def test_first_missing(self, client, small_infa_xml):
        id_b = _upload(client, small_infa_xml)
        resp = client.get(
            "/api/compare", params={"upload_a": 99999, "upload_b": id_b}
        )
        assert resp.status_code == 404
        assert "99999" in resp.json()["detail"]

    def test_second_missing(self, client, small_infa_xml):
        id_a = _upload(client, small_infa_xml)
        resp = client.get(
            "/api/compare", params={"upload_a": id_a, "upload_b": 99999}
        )
        assert resp.status_code == 404
        assert "99999" in resp.json()["detail"]


class TestCompareResponseStructure:
    """Validate the shape of every section in the compare response."""

    @pytest.fixture(autouse=True)
    def _setup(self, client, small_infa_xml):
        self.id_a = _upload(client, small_infa_xml, "struct_a.xml")
        self.id_b = _upload(client, small_infa_xml, "struct_b.xml")
        self.data = client.get(
            "/api/compare",
            params={"upload_a": self.id_a, "upload_b": self.id_b},
        ).json()

    def test_stats_keys(self):
        expected_keys = {
            "total_a",
            "total_b",
            "matched_count",
            "changed_count",
            "unchanged_count",
            "added_count",
            "removed_count",
            "tables_added",
            "tables_removed",
            "tables_modified",
            "connections_added",
            "connections_removed",
        }
        assert set(self.data["stats"].keys()) == expected_keys

    def test_matched_entry_shape(self):
        """Each matched entry has full_name, upload_a/b dicts, changes, has_changes."""
        if not self.data["matched"]:
            pytest.skip("No matched sessions to validate")

        entry = self.data["matched"][0]
        assert "full_name" in entry
        assert "upload_a" in entry
        assert "upload_b" in entry
        assert "changes" in entry
        assert "has_changes" in entry
        assert isinstance(entry["changes"], dict)
        assert isinstance(entry["has_changes"], bool)

    def test_session_detail_shape(self):
        """Session detail dicts contain expected fields."""
        if not self.data["matched"]:
            pytest.skip("No matched sessions to validate")

        detail = self.data["matched"][0]["upload_a"]
        expected_fields = {
            "session_id",
            "name",
            "full_name",
            "tier",
            "step",
            "workflow",
            "folder_path",
            "mapping_name",
            "transforms",
            "ext_reads",
            "lookup_count",
            "critical",
            "sources",
            "targets",
            "lookups",
            "total_loc",
            "total_functions_used",
            "distinct_functions_used",
            "has_embedded_sql",
            "has_embedded_java",
            "has_stored_procedure",
            "core_intent",
            "expression_count",
            "field_mapping_count",
        }
        assert expected_fields.issubset(set(detail.keys()))

    def test_table_diff_shape(self):
        td = self.data["table_diff"]
        assert "added" in td
        assert "removed" in td
        assert "modified" in td
        assert isinstance(td["added"], list)
        assert isinstance(td["removed"], list)
        assert isinstance(td["modified"], list)

    def test_added_removed_are_lists(self):
        assert isinstance(self.data["added"], list)
        assert isinstance(self.data["removed"], list)

    def test_stats_counts_are_integers(self):
        for key, value in self.data["stats"].items():
            assert isinstance(value, int), f"stats.{key} should be int, got {type(value)}"

    def test_stats_consistency(self):
        """matched + added (from A's perspective removed) should sum correctly."""
        stats = self.data["stats"]
        # All sessions in A are either matched or removed
        assert stats["matched_count"] + stats["removed_count"] == stats["total_a"]
        # All sessions in B are either matched or added
        assert stats["matched_count"] + stats["added_count"] == stats["total_b"]
        # changed + unchanged = matched
        assert stats["changed_count"] + stats["unchanged_count"] == stats["matched_count"]


class TestCompareMissingParams:
    """Omitting required query params should return 422."""

    def test_no_params(self, client):
        resp = client.get("/api/compare")
        assert resp.status_code == 422

    def test_missing_upload_b(self, client):
        resp = client.get("/api/compare", params={"upload_a": 1})
        assert resp.status_code == 422

    def test_missing_upload_a(self, client):
        resp = client.get("/api/compare", params={"upload_b": 1})
        assert resp.status_code == 422
