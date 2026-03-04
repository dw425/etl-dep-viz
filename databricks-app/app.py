"""Databricks App entry point for the ETL Dependency Visualizer.

Starts uvicorn on the port assigned by the Databricks Apps runtime
(DATABRICKS_APP_PORT) and serves the FastAPI application.
"""

import os
import sys

import uvicorn

# Add backend to the Python path so "app.main:app" resolves correctly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

port = int(os.environ.get("DATABRICKS_APP_PORT", "8000"))
uvicorn.run("app.main:app", host="0.0.0.0", port=port)
