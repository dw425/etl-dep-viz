"""Locust load testing for ETL Dependency Visualizer (Item 94).

Run with: locust -f backend/tests/locustfile.py --host http://localhost:8000
"""

import io
import json
import zipfile

from locust import HttpUser, between, task


# Minimal Informatica XML for load testing
_MINI_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<POWERMART>
<REPOSITORY NAME="TEST">
<FOLDER NAME="LOAD_TEST">
  <SOURCE NAME="SRC_TABLE_1" DATABASETYPE="Oracle">
    <SOURCEFIELD NAME="ID" DATATYPE="number"/>
    <SOURCEFIELD NAME="NAME" DATATYPE="string"/>
  </SOURCE>
  <TARGET NAME="TGT_TABLE_1" DATABASETYPE="Oracle">
    <TARGETFIELD NAME="ID" DATATYPE="number"/>
    <TARGETFIELD NAME="NAME" DATATYPE="string"/>
  </TARGET>
  <MAPPING NAME="m_load_test_1">
    <TRANSFORMATION NAME="SQ_SRC_TABLE_1" TYPE="Source Qualifier"/>
    <INSTANCE NAME="SQ_SRC_TABLE_1" TRANSFORMATION_NAME="SQ_SRC_TABLE_1" TYPE="Source Qualifier"/>
    <INSTANCE NAME="TGT_TABLE_1" TRANSFORMATION_NAME="TGT_TABLE_1" TYPE="Target Definition"/>
    <CONNECTOR FROMINSTANCE="SQ_SRC_TABLE_1" TOINSTANCE="TGT_TABLE_1" FROMFIELD="ID" TOFIELD="ID"/>
    <CONNECTOR FROMINSTANCE="SQ_SRC_TABLE_1" TOINSTANCE="TGT_TABLE_1" FROMFIELD="NAME" TOFIELD="NAME"/>
  </MAPPING>
  <SESSION NAME="s_load_test_1" MAPPINGNAME="m_load_test_1"/>
  <WORKFLOW NAME="wf_load_test">
    <TASK TYPE="Session" NAME="s_load_test_1"/>
  </WORKFLOW>
</FOLDER>
</REPOSITORY>
</POWERMART>"""


class ETLUser(HttpUser):
    """Simulates a typical user workflow."""

    wait_time = between(1, 3)
    upload_id = None
    tier_data = None

    def on_start(self):
        """Upload a file on session start."""
        files = {"files": ("test.xml", _MINI_XML, "application/xml")}
        with self.client.post(
            "/api/tier-map/analyze",
            files=files,
            catch_response=True,
        ) as resp:
            if resp.status_code == 200:
                data = resp.json()
                self.upload_id = data.get("upload_id")
                self.tier_data = data
                resp.success()
            else:
                resp.failure(f"Upload failed: {resp.status_code}")

    @task(5)
    def health_check(self):
        self.client.get("/api/health")

    @task(3)
    def list_uploads(self):
        self.client.get("/api/tier-map/uploads?limit=10")

    @task(3)
    def get_upload(self):
        if self.upload_id:
            self.client.get(f"/api/tier-map/uploads/{self.upload_id}")

    @task(2)
    def list_algorithms(self):
        self.client.get("/api/tier-map/algorithms")

    @task(2)
    def get_l1(self):
        if self.tier_data:
            self.client.post(
                "/api/layers/L1",
                json=self.tier_data,
                headers={"Content-Type": "application/json"},
            )

    @task(2)
    def paginated_sessions(self):
        if self.upload_id:
            self.client.get(
                f"/api/tier-map/uploads/{self.upload_id}/sessions?limit=20"
            )

    @task(1)
    def vector_analysis(self):
        if self.tier_data:
            self.client.post(
                f"/api/vectors/analyze?phase=1&upload_id={self.upload_id}",
                json=self.tier_data,
                headers={"Content-Type": "application/json"},
            )

    @task(1)
    def lineage_graph(self):
        if self.tier_data:
            self.client.post(
                "/api/lineage/graph",
                json=self.tier_data,
                headers={"Content-Type": "application/json"},
            )

    @task(1)
    def export_jira_json(self):
        if self.tier_data:
            self.client.post(
                "/api/exports/jira/json",
                json=self.tier_data,
                headers={"Content-Type": "application/json"},
            )

    @task(1)
    def health_logs(self):
        self.client.get("/api/health/logs?limit=20")

    @task(1)
    def error_aggregation(self):
        self.client.get("/api/health/errors?limit=10")
