"""Integration tests for Active Tags API."""

import pytest


class TestActiveTagsAPI:
    def test_create_tag(self, client):
        response = client.post("/api/active-tags", json={
            "object_id": "S1",
            "object_type": "session",
            "tag_type": "review_needed",
            "label": "Needs Review",
            "color": "#FF0000",
        })
        assert response.status_code == 200
        data = response.json()
        assert data["object_id"] == "S1"
        assert data["label"] == "Needs Review"

    def test_get_tags(self, client):
        client.post("/api/active-tags", json={
            "object_id": "S1",
            "object_type": "session",
            "tag_type": "pii_risk",
            "label": "PII",
        })
        response = client.get("/api/active-tags/S1")
        assert response.status_code == 200
        tags = response.json()["tags"]
        assert len(tags) >= 1

    def test_delete_tag(self, client):
        r = client.post("/api/active-tags", json={
            "object_id": "S2",
            "object_type": "session",
            "tag_type": "custom",
            "label": "Temp",
        })
        tag_id = r.json()["tag_id"]
        response = client.delete(f"/api/active-tags/{tag_id}")
        assert response.status_code == 200
        assert response.json()["deleted"] is True

    def test_list_all_tags(self, client):
        client.post("/api/active-tags", json={
            "object_id": "S3",
            "object_type": "session",
            "tag_type": "migration_ready",
            "label": "Ready",
        })
        response = client.get("/api/active-tags")
        assert response.status_code == 200
        tags = response.json()["tags"]
        assert len(tags) >= 1

    def test_filter_by_type(self, client):
        client.post("/api/active-tags", json={
            "object_id": "T1",
            "object_type": "table",
            "tag_type": "pii_risk",
            "label": "Has PII",
        })
        response = client.get("/api/active-tags", params={"object_type": "table"})
        assert response.status_code == 200
        tags = response.json()["tags"]
        assert all(t["object_type"] == "table" for t in tags)
