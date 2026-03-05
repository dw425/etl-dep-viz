"""Integration tests for the Tier Map API endpoints."""

import io
import json
import zipfile

import pytest


class TestTierMapAPI:
    def test_upload_xml(self, client, small_infa_xml):
        response = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        assert response.status_code == 200
        data = response.json()
        assert "sessions" in data
        assert "upload_id" in data
        assert len(data["sessions"]) > 0

    def test_upload_zip(self, client, small_infa_xml):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("folder/test.xml", small_infa_xml)
        buf.seek(0)
        response = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("archive.zip", buf.read(), "application/zip"))],
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["sessions"]) > 0

    def test_upload_empty(self, client):
        response = client.post("/api/tier-map/analyze", files=[])
        assert response.status_code == 422

    def test_list_uploads(self, client, small_infa_xml):
        # Upload first
        client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        response = client.get("/api/tier-map/uploads")
        assert response.status_code == 200
        uploads = response.json()
        assert len(uploads) >= 1

    def test_get_upload(self, client, small_infa_xml):
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        upload_id = r.json()["upload_id"]
        response = client.get(f"/api/tier-map/uploads/{upload_id}")
        assert response.status_code == 200
        data = response.json()
        assert data["upload_id"] == upload_id
        assert "tier_data" in data

    def test_delete_upload(self, client, small_infa_xml):
        r = client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
        )
        upload_id = r.json()["upload_id"]
        response = client.delete(f"/api/tier-map/uploads/{upload_id}")
        assert response.status_code == 200
        assert response.json()["deleted"] is True
        # Verify deleted
        response = client.get(f"/api/tier-map/uploads/{upload_id}")
        assert response.status_code == 404


class TestConstellationAPI:
    def test_constellation_stream(self, client, small_infa_xml):
        response = client.post(
            "/api/tier-map/constellation-stream",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
            params={"algorithm": "louvain"},
        )
        assert response.status_code == 200
        # SSE stream should contain data lines
        text = response.text
        assert "data:" in text

    def test_algorithms_list(self, client):
        response = client.get("/api/tier-map/algorithms")
        assert response.status_code == 200
        data = response.json()
        assert "algorithms" in data


class TestAnalyzePathAPI:
    def test_local_xml_path(self, client, small_infa_xml, tmp_path):
        """Parse a local XML file via the analyze-path endpoint."""
        xml_file = tmp_path / "test.xml"
        xml_file.write_bytes(small_infa_xml)
        # Temporarily add tmp_path to allowed paths
        from app.config import settings
        orig = settings.server_parse_allowed_paths
        settings.server_parse_allowed_paths = [str(tmp_path)]
        try:
            response = client.post(
                "/api/tier-map/analyze-path",
                params={"file_path": str(xml_file)},
            )
            assert response.status_code == 200
            text = response.text
            assert "data:" in text
            # Parse SSE events and check for complete
            events = []
            for line in text.split("\n\n"):
                line = line.strip()
                if line.startswith("data:"):
                    events.append(json.loads(line[len("data:"):].strip()))
            assert any(e.get("phase") == "complete" for e in events)
            complete = next(e for e in events if e.get("phase") == "complete")
            assert "result" in complete
            assert complete["result"]["upload_id"] is not None
        finally:
            settings.server_parse_allowed_paths = orig

    def test_local_zip_path(self, client, small_infa_xml, tmp_path):
        """Parse a local ZIP file via analyze-path."""
        zip_file = tmp_path / "archive.zip"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("folder/test.xml", small_infa_xml)
        zip_file.write_bytes(buf.getvalue())
        from app.config import settings
        orig = settings.server_parse_allowed_paths
        settings.server_parse_allowed_paths = [str(tmp_path)]
        try:
            response = client.post(
                "/api/tier-map/analyze-path",
                params={"file_path": str(zip_file)},
            )
            assert response.status_code == 200
            events = []
            for line in response.text.split("\n\n"):
                line = line.strip()
                if line.startswith("data:"):
                    events.append(json.loads(line[len("data:"):].strip()))
            assert any(e.get("phase") == "complete" for e in events)
        finally:
            settings.server_parse_allowed_paths = orig

    def test_file_not_found(self, client, tmp_path):
        """Returns 404 for nonexistent local file."""
        from app.config import settings
        orig = settings.server_parse_allowed_paths
        settings.server_parse_allowed_paths = [str(tmp_path)]
        try:
            response = client.post(
                "/api/tier-map/analyze-path",
                params={"file_path": str(tmp_path / "nonexistent.xml")},
            )
            assert response.status_code == 404
        finally:
            settings.server_parse_allowed_paths = orig

    def test_path_traversal_rejected(self, client):
        """Rejects paths containing '..'."""
        response = client.post(
            "/api/tier-map/analyze-path",
            params={"file_path": "/tmp/../etc/passwd"},
        )
        assert response.status_code == 400
        assert "traversal" in response.json()["detail"].lower()

    def test_disallowed_local_path(self, client, tmp_path):
        """Rejects local paths not in allowed prefixes."""
        response = client.post(
            "/api/tier-map/analyze-path",
            params={"file_path": "/unauthorized/path/file.xml"},
        )
        assert response.status_code == 400
        assert "allowed" in response.json()["detail"].lower()
