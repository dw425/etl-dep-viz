#!/bin/bash
# Databricks App build script — installs dependencies, builds the frontend
# into backend/static/ for serving, then starts the application.
set -e
cd "$(dirname "$0")/.."

echo "=== Building frontend ==="
# Node.js is pre-installed in the Databricks Apps runtime
cd frontend && npm ci && npm run build && cd ..

echo "=== Installing Python dependencies ==="
# Install core backend deps (PgVectorStore replaces ChromaDB; Databricks BGE endpoint replaces sentence-transformers)
pip install \
  "fastapi>=0.115.0" \
  "uvicorn[standard]>=0.30.0" \
  "python-multipart>=0.0.9" \
  "lxml>=5.0.0" \
  "networkx>=3.0" \
  "pydantic>=2.0.0" \
  "pydantic-settings>=2.0.0" \
  "sqlalchemy>=2.0.0" \
  "alembic>=1.13.0" \
  "numpy>=1.24.0" \
  "scipy>=1.11.0" \
  "scikit-learn>=1.3.0" \
  "pandas>=2.0.0" \
  "chardet>=5.0.0" \
  "httpx>=0.24" \
  "psycopg2-binary>=2.9.0" \
  "umap-learn>=0.5.0" \
  "hdbscan>=0.8.33" \
  "orjson>=3.9.0"

# Make backend importable
pip install -e "./backend" --no-deps

echo "=== Starting ETL Dependency Visualizer ==="
python databricks-app/app.py
