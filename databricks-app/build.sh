#!/bin/bash
# Databricks App build script — installs dependencies, builds the frontend
# into backend/static/ for serving, then starts the application.
set -e
cd "$(dirname "$0")/.."

echo "=== Installing Node.js and building frontend ==="
apt-get update && apt-get install -y nodejs npm
cd frontend && npm ci && npm run build && cd ..

echo "=== Installing Python dependencies ==="
pip install -e "./backend[full]"
pip install psycopg2-binary  # PostgreSQL driver for Lakebase

echo "=== Starting ETL Dependency Visualizer ==="
python databricks-app/app.py
