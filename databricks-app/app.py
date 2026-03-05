"""Databricks App entry point for the ETL Dependency Visualizer.

Single-process uvicorn server. Databricks Apps run one container per app,
so multi-worker Gunicorn adds complexity (table-creation race conditions on
Lakebase) without meaningful concurrency benefit.
"""

import os
import sys

# Add backend to the Python path so "app.main:app" resolves correctly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

port = int(os.environ.get("DATABRICKS_APP_PORT", "8000"))

import uvicorn
uvicorn.run(
    "app.main:app",
    host="0.0.0.0",
    port=port,
    timeout_keep_alive=300,
    workers=int(os.environ.get("EDV_WORKERS", "2")),
)
