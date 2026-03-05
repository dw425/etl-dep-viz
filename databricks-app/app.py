"""Databricks App entry point for the ETL Dependency Visualizer.

Uses Gunicorn with UvicornWorker for concurrent request handling.
Falls back to plain uvicorn if gunicorn is unavailable (e.g. local dev).
"""

import os
import sys

# Add backend to the Python path so "app.main:app" resolves correctly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

port = int(os.environ.get("DATABRICKS_APP_PORT", "8000"))
workers = int(os.environ.get("EDV_WORKERS", "2"))

try:
    from gunicorn.app.wsgiapp import WSGIApplication

    class StandaloneApplication(WSGIApplication):
        def init(self, parser, opts, args):
            return {
                "bind": f"0.0.0.0:{port}",
                "workers": workers,
                "worker_class": "uvicorn.workers.UvicornWorker",
                "preload_app": True,
                "timeout": 300,
                "graceful_timeout": 30,
                "accesslog": "-",
            }

        def load(self):
            from app.main import app
            return app

    StandaloneApplication("%(prog)s app.main:app").run()

except ImportError:
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=port)
