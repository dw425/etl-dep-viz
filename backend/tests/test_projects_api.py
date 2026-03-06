"""Tests for the Projects API endpoints."""

import pytest


class TestProjectsCRUD:
    def test_create_project(self, client):
        resp = client.post("/api/projects", json={"name": "Test Project", "description": "A test"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Test Project"
        assert "id" in data

    def test_list_projects(self, client):
        client.post("/api/projects", json={"name": "P1"})
        client.post("/api/projects", json={"name": "P2"})
        resp = client.get("/api/projects")
        assert resp.status_code == 200
        projects = resp.json()
        assert len(projects) >= 2

    def test_get_project(self, client):
        create = client.post("/api/projects", json={"name": "Detail Test"})
        pid = create.json()["id"]
        resp = client.get(f"/api/projects/{pid}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Detail Test"
        assert "uploads" in data

    def test_update_project(self, client):
        create = client.post("/api/projects", json={"name": "Old Name"})
        pid = create.json()["id"]
        resp = client.put(f"/api/projects/{pid}", json={"name": "New Name", "description": "Updated"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "New Name"

    def test_delete_project(self, client):
        create = client.post("/api/projects", json={"name": "To Delete"})
        pid = create.json()["id"]
        resp = client.delete(f"/api/projects/{pid}")
        assert resp.status_code == 200
        # Verify it's gone
        resp2 = client.get(f"/api/projects/{pid}")
        assert resp2.status_code == 404

    def test_get_nonexistent_project(self, client):
        resp = client.get("/api/projects/99999")
        assert resp.status_code == 404

    def test_project_detail_has_uploads_field(self, client):
        """Verify project detail response includes uploads list (initially empty)."""
        create = client.post("/api/projects", json={"name": "With Upload"})
        pid = create.json()["id"]
        resp = client.get(f"/api/projects/{pid}")
        data = resp.json()
        assert "uploads" in data
        assert isinstance(data["uploads"], list)
        assert len(data["uploads"]) == 0

    def test_create_project_with_user_id(self, client):
        resp = client.post("/api/projects", json={"name": "User Proj", "user_id": "user123"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["user_id"] == "user123"
