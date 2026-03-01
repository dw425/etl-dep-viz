"""Tests for user profile and activity tracking endpoints."""


class TestUserProfile:
    """User profile CRUD."""

    def test_create_user(self, client):
        """Creating a user returns success."""
        r = client.post(
            "/api/users",
            json={"user_id": "test-user-1", "display_name": "Test User"},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["user_id"] == "test-user-1"

    def test_upsert_user(self, client):
        """Creating the same user twice updates display_name."""
        client.post(
            "/api/users",
            json={"user_id": "test-user-2", "display_name": "Original"},
        )
        r = client.post(
            "/api/users",
            json={"user_id": "test-user-2", "display_name": "Updated"},
        )
        assert r.status_code == 200
        assert r.json()["display_name"] == "Updated"

    def test_get_user(self, client):
        """Get user returns profile and stats."""
        client.post(
            "/api/users",
            json={"user_id": "test-user-3", "display_name": "Test 3"},
        )
        r = client.get("/api/users/test-user-3")
        assert r.status_code == 200
        data = r.json()
        assert data["user_id"] == "test-user-3"
        assert "upload_count" in data or "total_sessions" in data

    def test_get_nonexistent_user(self, client):
        """Get non-existent user returns 404."""
        r = client.get("/api/users/nonexistent-user-xyz")
        assert r.status_code == 404


class TestUserActivity:
    """Activity logging and retrieval."""

    def test_log_activity(self, client):
        """Logging an activity succeeds."""
        client.post(
            "/api/users",
            json={"user_id": "activity-user", "display_name": "Activity Test"},
        )
        r = client.post(
            "/api/users/activity-user/activity",
            json={"action": "upload", "target_filename": "test.xml"},
        )
        assert r.status_code == 200

    def test_get_activity(self, client):
        """Get activity log returns logged actions."""
        client.post(
            "/api/users",
            json={"user_id": "activity-user-2", "display_name": "Activity Test 2"},
        )
        client.post(
            "/api/users/activity-user-2/activity",
            json={"action": "upload", "target_filename": "file1.xml"},
        )
        client.post(
            "/api/users/activity-user-2/activity",
            json={"action": "export", "target_filename": "export.xlsx"},
        )

        r = client.get("/api/users/activity-user-2/activity?limit=10")
        assert r.status_code == 200
        activity = r.json()
        assert len(activity) >= 2

    def test_activity_limit(self, client):
        """Activity endpoint respects limit parameter."""
        client.post(
            "/api/users",
            json={"user_id": "limit-user", "display_name": "Limit Test"},
        )
        for i in range(5):
            client.post(
                "/api/users/limit-user/activity",
                json={"action": f"action_{i}"},
            )

        r = client.get("/api/users/limit-user/activity?limit=3")
        assert r.status_code == 200
        activity = r.json()
        assert len(activity) <= 3


class TestUserUploads:
    """User upload history."""

    def test_user_uploads(self, client, small_infa_xml):
        """Upload history for a user lists their uploads."""
        client.post(
            "/api/users",
            json={"user_id": "upload-user", "display_name": "Upload Test"},
        )
        # Upload with user header
        client.post(
            "/api/tier-map/analyze",
            files=[("files", ("test.xml", small_infa_xml, "application/xml"))],
            headers={"X-User-Id": "upload-user"},
        )

        r = client.get("/api/users/upload-user/uploads")
        assert r.status_code == 200
        uploads = r.json()
        assert len(uploads) >= 1
