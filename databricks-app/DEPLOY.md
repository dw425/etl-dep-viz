# Deploying ETL Dependency Visualizer as a Databricks App

## Prerequisites

- Databricks workspace with **Databricks Apps** enabled
- **Lakebase** (managed PostgreSQL 17) provisioned in the workspace
- Databricks CLI installed and authenticated (`databricks auth login`)

## Step 1 — Create the Lakebase Database

1. Open your Databricks workspace
2. Navigate to **SQL > Lakebase** and locate your instance
3. Connect to the instance and create the application database:

```sql
CREATE DATABASE etl_dep_viz;
```

4. Note the connection string — it follows this format:

```
postgresql://<user>:<token>@<lakebase-host>:5432/etl_dep_viz?sslmode=require
```

## Step 2 — Configure Environment Variables

Set the following environment variables in your Databricks App configuration:

| Variable | Description |
|---|---|
| `EDV_DATABASE_URL` | Lakebase PostgreSQL connection string from Step 1 |
| `EDV_DATABRICKS_APP` | `true` (set automatically by `app.yaml`) |
| `DATABRICKS_HOST` | Workspace URL (e.g. `https://adb-1234.azuredatabricks.net`) |
| `DATABRICKS_CLIENT_ID` | Service principal client ID (for OAuth token refresh) |
| `DATABRICKS_CLIENT_SECRET` | Service principal client secret |

> **Note**: `DATABRICKS_APP_PORT` is set automatically by the Databricks Apps runtime.

## Step 3 — Deploy

From the repository root:

```bash
databricks apps deploy --app etl-dep-viz --source-code-path .
```

This uploads the entire repo, runs `databricks-app/build.sh` inside the
container (installs Node.js, builds the frontend, installs Python deps),
and starts the FastAPI server.

## Step 4 — Verify

1. Open the Databricks Apps UI and find **etl-dep-viz**
2. Click the app URL — the frontend should load
3. Upload an XML/JSON file and confirm parsing completes successfully
4. Check the app logs for any database connection errors

## Architecture Notes

- **Database**: Lakebase (PostgreSQL 17) replaces SQLite. All 26 tables are
  created automatically on first startup via `init_db()`.
- **Auth**: OAuth token refresh is handled transparently — the app fetches a
  fresh access token on each new database connection using the workspace's
  OIDC endpoint.
- **Frontend**: Built at deploy time (`npm run build`) and served as static
  files by FastAPI's `StaticFiles` middleware.
- **No local changes**: The `databricks_app` flag and engine factory are
  backwards-compatible — local/Docker deployments continue to use SQLite
  with identical behavior.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `psycopg2` import error | Ensure `psycopg2-binary` is in requirements |
| Token refresh 401 | Verify `DATABRICKS_CLIENT_ID/SECRET` are correct |
| Tables not created | Check `EDV_DATABASE_URL` points to `etl_dep_viz` DB |
| Frontend 404 | Confirm `npm run build` succeeded in deploy logs |
