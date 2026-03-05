"""Databricks Workflow/Jobs parser.

Parses Databricks Jobs API JSON into the ETL Dependency Visualizer's
session/table/connection model. Maps tasks to sessions, table references
to tables, and task dependencies to connections.

Usage:
    parser = DatabricksWorkflowParser(workspace_host, token)
    result = parser.parse(job_id=12345)
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field

logger = logging.getLogger("edv.dbx_workflow_parser")

# Patterns to detect table references in notebook/SQL code
_READ_PATTERNS = [
    re.compile(r'''spark\.read\.\w+\(['"]([\w.]+)['"]''', re.IGNORECASE),
    re.compile(r'''spark\.table\(['"]([\w.]+)['"]''', re.IGNORECASE),
    re.compile(r'''FROM\s+([\w.]+)''', re.IGNORECASE),
    re.compile(r'''JOIN\s+([\w.]+)''', re.IGNORECASE),
]
_WRITE_PATTERNS = [
    re.compile(r'''\.write\.\w+\.\w+\(['"]([\w.]+)['"]''', re.IGNORECASE),
    re.compile(r'''\.saveAsTable\(['"]([\w.]+)['"]''', re.IGNORECASE),
    re.compile(r'''INSERT\s+(?:INTO|OVERWRITE)\s+([\w.]+)''', re.IGNORECASE),
    re.compile(r'''CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+([\w.]+)''', re.IGNORECASE),
    re.compile(r'''MERGE\s+INTO\s+([\w.]+)''', re.IGNORECASE),
]


@dataclass
class WorkflowParseResult:
    """Parsed Databricks Workflow in TierMapResult-compatible format."""
    sessions: list[dict] = field(default_factory=list)
    tables: list[dict] = field(default_factory=list)
    connections: list[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


class DatabricksWorkflowParser:
    """Parse Databricks Jobs into ETL dependency graph."""

    def __init__(self, workspace_host: str | None = None, token: str | None = None):
        self.workspace_host = workspace_host
        self.token = token

    def _get_credentials(self) -> tuple[str, str]:
        if self.workspace_host and self.token:
            return self.workspace_host, self.token
        from app.engines.databricks_auth import get_databricks_token
        return get_databricks_token()

    def _api_get(self, path: str) -> dict:
        """GET request to Databricks REST API."""
        host, token = self._get_credentials()
        url = f"{host}/api/2.1{path}"
        req = urllib.request.Request(
            url, method="GET",
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=30)
            return json.loads(resp.read())
        except Exception as exc:
            logger.error("Databricks API call failed: %s %s", path, exc)
            return {}

    def parse(self, job_id: int | None = None) -> WorkflowParseResult:
        """Parse Databricks job(s) into ETL dependency graph.

        Args:
            job_id: Specific job to parse. If None, lists all jobs.

        Returns:
            WorkflowParseResult with sessions, tables, connections.
        """
        result = WorkflowParseResult()
        tables_seen: dict[str, dict] = {}
        sessions: list[dict] = []
        connections: list[dict] = []

        if job_id:
            jobs = [self._api_get(f"/jobs/get?job_id={job_id}")]
        else:
            resp = self._api_get("/jobs/list?limit=100")
            jobs = resp.get("jobs", [])

        for job in jobs:
            if not job:
                continue
            job_name = job.get("settings", {}).get("name", f"job_{job.get('job_id', 'unknown')}")
            tasks = job.get("settings", {}).get("tasks", [])

            task_map: dict[str, str] = {}  # task_key → session_id

            for task in tasks:
                task_key = task.get("task_key", "")
                session_id = f"dbx_{job.get('job_id', '')}_{task_key}"
                task_map[task_key] = session_id

                # Determine task type and extract table references
                sources: list[str] = []
                targets: list[str] = []

                # Extract code references from different task types
                code = ""
                if "notebook_task" in task:
                    code = task["notebook_task"].get("notebook_path", "")
                elif "sql_task" in task:
                    query = task["sql_task"].get("query", {})
                    code = query.get("query", "")
                elif "spark_python_task" in task:
                    code = task["spark_python_task"].get("python_file", "")

                # Scan for table references
                for pattern in _READ_PATTERNS:
                    sources.extend(pattern.findall(code))
                for pattern in _WRITE_PATTERNS:
                    targets.extend(pattern.findall(code))

                # Register tables
                for tbl in set(sources + targets):
                    if tbl not in tables_seen:
                        tables_seen[tbl] = {
                            "id": tbl, "name": tbl.split(".")[-1],
                            "type": "delta", "tier": 0,
                        }

                task_type = "notebook" if "notebook_task" in task else \
                           "sql" if "sql_task" in task else \
                           "python" if "spark_python_task" in task else \
                           "jar" if "spark_jar_task" in task else \
                           "dbt" if "dbt_task" in task else \
                           "pipeline" if "pipeline_task" in task else "other"

                sessions.append({
                    "id": session_id,
                    "name": task_key,
                    "full": f"{job_name}.{task_key}",
                    "tier": 0,
                    "transforms": 1,
                    "sources": list(set(sources)),
                    "targets": list(set(targets)),
                    "lookups": [],
                    "task_type": task_type,
                    "job_name": job_name,
                })

                # Table connections
                for src in set(sources):
                    connections.append({"from": src, "to": session_id, "type": "source_read"})
                for tgt in set(targets):
                    connections.append({"from": session_id, "to": tgt, "type": "write_clean"})

            # Task dependency connections
            for task in tasks:
                task_key = task.get("task_key", "")
                sid = task_map.get(task_key, "")
                for dep in task.get("depends_on", []):
                    dep_key = dep.get("task_key", "")
                    dep_sid = task_map.get(dep_key, "")
                    if sid and dep_sid:
                        connections.append({"from": dep_sid, "to": sid, "type": "chain"})

        result.sessions = sessions
        result.tables = list(tables_seen.values())
        result.connections = connections
        result.stats = {
            "jobs": len(jobs),
            "tasks": len(sessions),
            "tables": len(tables_seen),
            "connections": len(connections),
        }
        logger.info("Databricks Workflow: %d tasks, %d tables from %d jobs",
                     len(sessions), len(tables_seen), len(jobs))
        return result
