"""Tests for health, error aggregation, and logging endpoints."""


class TestHealthExpanded:
    """Expanded health check endpoint."""

    def test_health_returns_ok(self, client):
        """Health endpoint returns ok or degraded status."""
        r = client.get("/api/health")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] in ("ok", "degraded")

    def test_health_includes_system_info(self, client):
        """Health check includes Python version and system info."""
        r = client.get("/api/health")
        data = r.json()
        assert "python" in data

    def test_health_includes_memory(self, client):
        """Health check includes memory usage info."""
        r = client.get("/api/health")
        data = r.json()
        assert "memory_mb" in data


class TestLogEndpoint:
    """Log buffer retrieval."""

    def test_log_buffer_returns_list(self, client):
        """Log buffer returns a list of log entries."""
        r = client.get("/api/health/logs?limit=10")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_log_buffer_with_level_filter(self, client):
        """Log buffer respects level filter."""
        r = client.get("/api/health/logs?limit=5&level=WARNING")
        assert r.status_code == 200
        entries = r.json()
        for entry in entries:
            assert entry.get("level", "") in ("WARNING", "ERROR", "CRITICAL")


class TestErrorAggregation:
    """Error aggregation and reporting."""

    def test_error_aggregation_structure(self, client):
        """Error aggregation returns expected structure."""
        r = client.get("/api/health/errors?limit=10")
        assert r.status_code == 200
        data = r.json()
        assert "errors" in data
        assert "total" in data
        assert "by_type" in data

    def test_report_frontend_error(self, client):
        """Frontend can report errors that show up in aggregation."""
        # Report an error
        r = client.post(
            "/api/health/report-error",
            json={
                "type": "test_error",
                "message": "Integration test error",
                "severity": "error",
            },
        )
        assert r.status_code == 200
        assert r.json()["accepted"] is True

        # Verify it appears in aggregation
        r = client.get("/api/health/errors?source=frontend")
        assert r.status_code == 200
        errors = r.json()["errors"]
        assert any(e["message"] == "Integration test error" for e in errors)

    def test_report_error_minimal(self, client):
        """Minimal error report with only message."""
        r = client.post(
            "/api/health/report-error",
            json={"message": "Minimal test error"},
        )
        assert r.status_code == 200

    def test_error_aggregation_by_type(self, client):
        """Error aggregation includes by_type breakdown."""
        # First report some errors
        client.post(
            "/api/health/report-error",
            json={"type": "alpha_error", "message": "A"},
        )
        client.post(
            "/api/health/report-error",
            json={"type": "alpha_error", "message": "B"},
        )
        client.post(
            "/api/health/report-error",
            json={"type": "beta_error", "message": "C"},
        )

        r = client.get("/api/health/errors")
        data = r.json()
        assert isinstance(data["by_type"], dict)
