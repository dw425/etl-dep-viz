"""Databricks App entry point for the Pipeline Analyzer.

Multi-worker uvicorn server (EDV_WORKERS, default 2). Databricks Apps run
one container per app. Workers are managed by uvicorn's built-in process
spawning (no Gunicorn needed). Database init is guarded against concurrent
table-creation races via CREATE IF NOT EXISTS + DuplicateTable handling.
"""

import os
import sys

# Add backend to the Python path so "app.main:app" resolves correctly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

port = int(os.environ.get("DATABRICKS_APP_PORT", "8000"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=port,
        timeout_keep_alive=300,
        workers=int(os.environ.get("EDV_WORKERS", "2")),
    )
