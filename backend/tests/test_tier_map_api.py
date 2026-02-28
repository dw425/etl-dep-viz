"""Integration tests for the Tier Map API endpoints."""

import io
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
