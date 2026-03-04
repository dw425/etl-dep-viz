# Deploying ETL Dependency Visualizer to Databricks — Complete Walkthrough

This is a comprehensive, step-by-step guide for deploying the ETL Dependency
Visualizer as a **Databricks App** backed by **Lakebase** (managed PostgreSQL 17).

By the end of this guide you will have a fully functioning, multi-user instance
of the visualizer running inside your Databricks workspace — accessible to
anyone with workspace permissions, with persistent storage in Lakebase.

---

## Table of Contents

1. [What You're Deploying](#1-what-youre-deploying)
2. [Prerequisites](#2-prerequisites)
3. [Install and Configure the Databricks CLI](#3-install-and-configure-the-databricks-cli)
4. [Provision a Lakebase Instance](#4-provision-a-lakebase-instance)
5. [Create the Application Database](#5-create-the-application-database)
6. [Create a Service Principal for OAuth](#6-create-a-service-principal-for-oauth)
7. [Create the Databricks App](#7-create-the-databricks-app)
8. [Configure Environment Variables](#8-configure-environment-variables)
9. [Deploy the Application](#9-deploy-the-application)
10. [Verify the Deployment](#10-verify-the-deployment)
11. [Update and Redeploy](#11-update-and-redeploy)
12. [Monitoring and Logs](#12-monitoring-and-logs)
13. [Cleanup and Teardown](#13-cleanup-and-teardown)
14. [Troubleshooting](#14-troubleshooting)
15. [Architecture Reference](#15-architecture-reference)

---

## 1. What You're Deploying

The deployment package lives in the `databricks-app/` folder and consists of:

```
databricks-app/
├── app.yaml           # Databricks Apps manifest — declares the start command and env vars
├── app.py             # Python entry point — starts uvicorn on the runtime-assigned port
├── build.sh           # Build script — installs Node, builds frontend, installs Python deps
├── requirements.txt   # Fallback Python dependency list
└── DEPLOY.md          # Quick-reference deployment guide
```

**What happens at deploy time:**

1. Databricks uploads your entire repo into a container
2. The runtime executes `databricks-app/build.sh` (declared in `app.yaml`)
3. `build.sh` installs Node.js, runs `npm ci && npm run build` to compile the
   React frontend into `backend/static/`
4. `build.sh` installs Python dependencies via `pip install -e ./backend[full]`
   plus `psycopg2-binary` for PostgreSQL
5. `build.sh` starts `databricks-app/app.py`, which launches uvicorn on
   `$DATABRICKS_APP_PORT`
6. FastAPI detects `backend/static/` exists and serves the SPA at `/`
7. All API endpoints are available at `/api/*`
8. On first startup, `init_db()` creates all 26 database tables in Lakebase

**What stays the same locally:** Nothing changes for local development or Docker.
The `EDV_DATABRICKS_APP` flag defaults to `false` and `EDV_DATABASE_URL` defaults
to SQLite. The engine factory in `database.py` branches on the URL scheme.

---

## 2. Prerequisites

Before starting, confirm you have the following:

| Requirement | How to Check | Notes |
|---|---|---|
| Databricks workspace | Log in to your workspace URL | Must have Apps and Lakebase enabled |
| Workspace admin (or Apps permission) | Settings > Identity and access | Needed to create apps and service principals |
| Lakebase enabled | SQL sidebar > Lakebase | Preview feature — request access if not visible |
| Git repo cloned locally | `ls databricks-app/app.yaml` | This walkthrough assumes you're in the repo root |
| Python 3.11+ | `python3 --version` | For local testing (optional) |
| Node.js 18+ | `node --version` | For local testing (optional) |

---

## 3. Install and Configure the Databricks CLI

### 3a. Install the CLI

**macOS (Homebrew):**
```bash
brew tap databricks/tap
brew install databricks
```

**Linux / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh
```

**Windows (winget):**
```powershell
winget install Databricks.DatabricksCLI
```

Verify the installation:
```bash
databricks --version
# Should print v0.200+ (Apps support requires recent CLI)
```

### 3b. Authenticate

```bash
databricks auth login --host https://<your-workspace>.azuredatabricks.net
```

This opens a browser for OAuth login. Once complete, the CLI stores a token in
`~/.databrickscfg`.

Verify:
```bash
databricks auth env
# Should show DATABRICKS_HOST and a valid token
```

> **Tip:** If you manage multiple workspaces, use profiles:
> ```bash
> databricks auth login --host https://workspace-a.azuredatabricks.net --profile prod
> databricks auth login --host https://workspace-b.azuredatabricks.net --profile staging
> export DATABRICKS_CONFIG_PROFILE=prod
> ```

---

## 4. Provision a Lakebase Instance

Lakebase is Databricks' managed PostgreSQL 17 service. Each instance gets a
dedicated PostgreSQL endpoint.

### 4a. Create the instance via the UI

1. Open your Databricks workspace
2. In the left sidebar, click **SQL**
3. Click **Lakebase** (under the SQL section)
4. Click **Create Lakebase instance**
5. Fill in:
   - **Name**: `etl-dep-viz-db` (or any name you prefer)
   - **Size**: Start with the smallest tier — the app uses minimal storage
6. Click **Create**
7. Wait for the status to show **Running** (usually 2–5 minutes)

### 4b. Note the connection details

Once the instance is running, click on it to view its details. You'll need:

| Field | Example Value |
|---|---|
| **Host** | `lakebase-abc123.cloud.databricks.com` |
| **Port** | `5432` |
| **Username** | Usually your workspace username or a service principal |

The full connection string format is:
```
postgresql://<username>:<password>@<host>:5432/<database>?sslmode=require
```

> **Important:** The `<password>` is a Databricks OAuth access token, not a
> static password. The app handles token refresh automatically when
> `EDV_DATABRICKS_APP=true` — you can use a placeholder in the connection
> string and the token-refresh hook will inject a fresh token on each connection.

---

## 5. Create the Application Database

### 5a. Connect to Lakebase

You can connect using any PostgreSQL client. From the Databricks SQL editor or
a local `psql`:

```bash
psql "postgresql://<username>:<token>@<lakebase-host>:5432/postgres?sslmode=require"
```

Or use the Databricks SQL editor:
1. Go to **SQL > SQL Editor**
2. Select your Lakebase instance as the warehouse
3. Run the command below

### 5b. Create the database

```sql
CREATE DATABASE etl_dep_viz;
```

Verify:
```sql
\l
-- or in the SQL editor:
SELECT datname FROM pg_database WHERE datname = 'etl_dep_viz';
```

> **Note:** You do NOT need to create any tables manually. The app's `init_db()`
> function creates all 26 tables automatically on first startup.

---

## 6. Create a Service Principal for OAuth

The app needs a service principal to refresh OAuth tokens for Lakebase
connections. This is what keeps the database connection alive without a
static password.

### 6a. Create the service principal

1. In your workspace, go to **Settings** (gear icon)
2. Click **Identity and access > Service principals**
3. Click **Add service principal**
4. Fill in:
   - **Name**: `etl-dep-viz-app`
5. Click **Add**

### 6b. Generate a client secret

1. Click on the newly created service principal
2. Go to the **Secrets** tab
3. Click **Generate secret**
4. **Copy both values immediately** — the secret is only shown once:

| Field | Save This |
|---|---|
| **Client ID** (Application ID) | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| **Client Secret** | `dapi_xxxxxxxxxxxxxxxx` |

### 6c. Grant Lakebase access

The service principal needs permission to connect to your Lakebase instance:

1. Go to **SQL > Lakebase**
2. Click your instance (`etl-dep-viz-db`)
3. Go to **Permissions**
4. Add the `etl-dep-viz-app` service principal with **Can Use** permission

Also grant access to the database:
```sql
-- Run as an admin user connected to the etl_dep_viz database
GRANT ALL PRIVILEGES ON DATABASE etl_dep_viz TO "etl-dep-viz-app";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "etl-dep-viz-app";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "etl-dep-viz-app";
```

---

## 7. Create the Databricks App

### 7a. Create the app registration

```bash
databricks apps create --name etl-dep-viz
```

This registers the app in your workspace. You'll see output like:
```
App "etl-dep-viz" created successfully.
URL: https://<workspace>/apps/etl-dep-viz
```

> **Tip:** You can also create the app via the UI: **Compute > Apps > Create App**.

### 7b. Verify the app exists

```bash
databricks apps list
```

You should see `etl-dep-viz` in the list with status `IDLE`.

---

## 8. Configure Environment Variables

The app needs several environment variables. Some are set automatically by
`app.yaml`, others you must configure manually.

### Automatically set (by `app.yaml`):

| Variable | Value | Purpose |
|---|---|---|
| `EDV_DATABRICKS_APP` | `true` | Enables Databricks-specific behavior (token refresh) |
| `EDV_CORS_ORIGINS` | `["*"]` | Allow all origins (app is behind Databricks auth) |

### Set by the Databricks Apps runtime:

| Variable | Value | Purpose |
|---|---|---|
| `DATABRICKS_APP_PORT` | (auto-assigned) | Port the app must listen on |

### You must configure these:

```bash
# The Lakebase connection string
databricks apps set-env --app etl-dep-viz \
  --env-var "EDV_DATABASE_URL=postgresql://<sp-client-id>:<placeholder>@<lakebase-host>:5432/etl_dep_viz?sslmode=require"

# Your workspace URL (used for OAuth token endpoint)
databricks apps set-env --app etl-dep-viz \
  --env-var "DATABRICKS_HOST=https://<your-workspace>.azuredatabricks.net"

# Service principal credentials (from Step 6b)
databricks apps set-env --app etl-dep-viz \
  --env-var "DATABRICKS_CLIENT_ID=<client-id-from-step-6b>"

databricks apps set-env --app etl-dep-viz \
  --env-var "DATABRICKS_CLIENT_SECRET=<client-secret-from-step-6b>"
```

> **About the password placeholder:** The `<placeholder>` in the connection
> string can be any non-empty value (e.g., `token`). The app's token-refresh
> hook replaces it with a fresh OAuth token on every new database connection.
> Use a connection string like:
> ```
> postgresql://sp-client-id:token@lakebase-host:5432/etl_dep_viz?sslmode=require
> ```

### Optional configuration:

```bash
# Increase parse timeout for very large files (default: 1800s = 30 min)
databricks apps set-env --app etl-dep-viz \
  --env-var "EDV_PARSE_TIMEOUT_SECONDS=3600"

# Increase vector analysis timeout (default: 1800s = 30 min)
databricks apps set-env --app etl-dep-viz \
  --env-var "EDV_VECTOR_TIMEOUT_SECONDS=3600"

# Set log level for debugging
databricks apps set-env --app etl-dep-viz \
  --env-var "EDV_LOG_LEVEL=DEBUG"
```

---

## 9. Deploy the Application

### 9a. Deploy from your local repo

From the repository root:

```bash
databricks apps deploy --app etl-dep-viz --source-code-path .
```

This uploads the full repository to Databricks and starts the build process.

### 9b. Watch the deployment

```bash
databricks apps get --app etl-dep-viz
```

The deployment goes through these stages:

| Stage | What's Happening | Typical Duration |
|---|---|---|
| `UPLOADING` | Source code being uploaded | 10–30 seconds |
| `BUILDING` | `build.sh` running (Node install, npm build, pip install) | 3–8 minutes |
| `STARTING` | Uvicorn starting, `init_db()` creating tables | 10–30 seconds |
| `RUNNING` | App is live and accepting requests | — |

### 9c. Watch live build logs (optional)

```bash
databricks apps logs --app etl-dep-viz --follow
```

You should see output like:
```
=== Installing Node.js and building frontend ===
...
=== Installing Python dependencies ===
...
=== Starting ETL Dependency Visualizer ===
INFO:     Started server process
INFO:     Application startup complete
```

---

## 10. Verify the Deployment

### 10a. Get the app URL

```bash
databricks apps get --app etl-dep-viz
```

Look for the `url` field in the output. It will be something like:
```
https://<workspace-id>.azuredatabricks.net/apps/etl-dep-viz
```

### 10b. Open the app

1. Open the URL in your browser
2. You'll be redirected through Databricks OAuth (SSO)
3. The ETL Dependency Visualizer frontend should load

### 10c. Check the health endpoint

```bash
curl -s https://<app-url>/api/health | python3 -m json.tool
```

Expected response:
```json
{
    "status": "ok",
    "db": "ok",
    "disk_free_mb": 1234,
    "python": "3.11.x",
    "fastapi": "0.115.x",
    "lxml": "5.x.x",
    "networkx": "3.x"
}
```

**Critical check:** `"db": "ok"` confirms the Lakebase connection is working.

### 10d. Test the full pipeline

1. Click **Upload** in the app
2. Upload a small Informatica XML export or NiFi flow JSON
3. Wait for parsing to complete (you'll see a progress indicator)
4. Verify the Tier Map view renders
5. Try running Vector Analysis from the Vectors tab
6. Check that data persists across browser refreshes (it's in Lakebase now)

### 10e. Verify tables were created

Connect to your Lakebase instance and confirm the tables exist:

```sql
-- Connect to etl_dep_viz database
\dt
```

You should see all 26 tables:
```
projects
uploads
user_profiles
activity_log
session_records
table_records
connection_records
connection_profiles
vw_tier_layout
vw_galaxy_nodes
vw_explorer_detail
vw_write_conflicts
vw_read_chains
vw_exec_order
vw_matrix_cells
vw_table_profiles
vw_duplicate_groups
vw_duplicate_members
vw_constellation_chunks
vw_constellation_points
vw_constellation_edges
vw_complexity_scores
vw_wave_assignments
vw_umap_coords
vw_communities
vw_wave_function
vw_concentration_groups
vw_concentration_members
vw_ensemble
```

---

## 11. Update and Redeploy

When you push code changes and want to update the deployed app:

### 11a. Simple redeploy (same config)

```bash
# From the repo root, after pulling/committing changes
databricks apps deploy --app etl-dep-viz --source-code-path .
```

This uploads the new code and reruns `build.sh`. The app restarts automatically.

### 11b. Redeploy with zero downtime

Databricks Apps handles rolling deploys — the old instance stays running until
the new one passes its health check. Users experience no downtime.

### 11c. Update environment variables

```bash
# Change a single variable
databricks apps set-env --app etl-dep-viz \
  --env-var "EDV_LOG_LEVEL=WARNING"

# The app restarts automatically after env changes
```

### 11d. Rollback

If a deployment fails or introduces a bug:

```bash
# List recent deployments
databricks apps deployments list --app etl-dep-viz

# Redeploy a previous version by re-deploying from a known-good commit
git checkout <known-good-commit>
databricks apps deploy --app etl-dep-viz --source-code-path .
git checkout main
```

---

## 12. Monitoring and Logs

### 12a. Application logs

```bash
# Tail live logs
databricks apps logs --app etl-dep-viz --follow

# Get recent logs
databricks apps logs --app etl-dep-viz
```

### 12b. In-app log endpoint

The app exposes its own log ring buffer:

```bash
# Last 100 log entries
curl -s https://<app-url>/api/health/logs?limit=100

# Only warnings and above
curl -s https://<app-url>/api/health/logs?limit=50&level=WARNING
```

### 12c. Error aggregation

```bash
# Recent errors (backend + frontend)
curl -s https://<app-url>/api/health/errors

# Only backend errors
curl -s https://<app-url>/api/health/errors?source=backend
```

### 12d. Database monitoring

Check table sizes and row counts in Lakebase:

```sql
SELECT
    relname AS table_name,
    n_live_tup AS row_count,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
```

---

## 13. Cleanup and Teardown

### 13a. Stop the app (keep configuration)

```bash
databricks apps stop --app etl-dep-viz
```

### 13b. Delete the app entirely

```bash
databricks apps delete --app etl-dep-viz
```

### 13c. Drop the database (irreversible)

If you want to remove all stored data:

```sql
-- Connect to the 'postgres' default database first
DROP DATABASE etl_dep_viz;
```

### 13d. Delete the service principal

1. Go to **Settings > Identity and access > Service principals**
2. Find `etl-dep-viz-app`
3. Click **Delete**

### 13e. Delete the Lakebase instance (if no other apps use it)

1. Go to **SQL > Lakebase**
2. Click your instance
3. Click **Delete**

---

## 14. Troubleshooting

### App won't start

| Symptom | Likely Cause | Fix |
|---|---|---|
| Build fails at `npm ci` | Node.js install failed | Check `build.sh` logs — `apt-get` may need network access |
| Build fails at `pip install` | Missing system library (lxml) | Ensure container base image has `libxml2-dev` |
| `ModuleNotFoundError: psycopg2` | `psycopg2-binary` not installed | Verify `build.sh` includes `pip install psycopg2-binary` |
| `Connection refused` on startup | Port mismatch | Ensure `app.py` reads `DATABRICKS_APP_PORT` |

### Database connection failures

| Symptom | Likely Cause | Fix |
|---|---|---|
| `"db": "error"` in health check | Connection string wrong | Double-check `EDV_DATABASE_URL` format |
| `password authentication failed` | OAuth token expired / wrong creds | Verify `DATABRICKS_CLIENT_ID` and `SECRET` |
| `FATAL: database "etl_dep_viz" does not exist` | Database not created | Run `CREATE DATABASE etl_dep_viz;` (Step 5) |
| `SSL connection required` | Missing `sslmode=require` | Add `?sslmode=require` to the connection URL |
| `could not connect to server` | Lakebase instance stopped | Check instance status in SQL > Lakebase |

### OAuth token refresh issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| 401 from OIDC endpoint | Wrong client ID/secret | Regenerate the secret (Step 6b) |
| `DATABRICKS_HOST` not set | Env var missing | Run the `set-env` command (Step 8) |
| Token works once then fails | Token not being refreshed | Verify `EDV_DATABRICKS_APP=true` is set |

### Frontend issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| Blank page / 404 | Frontend build failed | Check logs for `npm run build` errors |
| API calls fail with CORS | CORS not configured | Verify `EDV_CORS_ORIGINS` is set to `["*"]` |
| "Loading..." spinner forever | Backend not responding | Check `/api/health` endpoint directly |

### Performance issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| Slow file parsing | Container has limited resources | Increase app compute tier |
| Database queries slow | Missing indexes | Tables have indexes by default — check with `\di` |
| Out of memory during vector analysis | Large dataset + small container | Increase memory or set `EDV_MAX_SESSIONS_FOR_PHASE3` lower |

### Quick diagnostic commands

```bash
# Check app status
databricks apps get --app etl-dep-viz

# View recent logs
databricks apps logs --app etl-dep-viz

# Test health endpoint
curl -s https://<app-url>/api/health | python3 -m json.tool

# Test database connectivity (from the app's perspective)
curl -s https://<app-url>/api/health | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('DB:', d.get('db', 'MISSING'))
print('Status:', d.get('status', 'UNKNOWN'))
"

# List all uploads (verify data persistence)
curl -s https://<app-url>/api/projects
```

---

## 15. Architecture Reference

### How the pieces fit together

```
┌─────────────────────────────────────────────────────────────────┐
│                    Databricks Workspace                         │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  Databricks App Container                  │ │
│  │                                                            │ │
│  │  ┌──────────────┐    ┌──────────────────────────────────┐  │ │
│  │  │  build.sh     │───>│  npm run build                   │  │ │
│  │  │  (on deploy)  │    │  pip install -e ./backend[full]  │  │ │
│  │  └──────────────┘    │  pip install psycopg2-binary     │  │ │
│  │         │            └──────────────────────────────────┘  │ │
│  │         v                                                  │ │
│  │  ┌──────────────┐    ┌──────────────────────────────────┐  │ │
│  │  │  app.py       │───>│  uvicorn (port $DATABRICKS_APP_  │  │ │
│  │  │  (entry)      │    │                          PORT)   │  │ │
│  │  └──────────────┘    └───────────────┬──────────────────┘  │ │
│  │                                      │                     │ │
│  │                      ┌───────────────v──────────────────┐  │ │
│  │                      │        FastAPI app (main.py)     │  │ │
│  │                      │                                  │  │ │
│  │                      │  /           → static SPA files  │  │ │
│  │                      │  /api/*      → routers           │  │ │
│  │                      │  /api/health → diagnostics       │  │ │
│  │                      │  /api/docs   → Swagger UI        │  │ │
│  │                      └───────────────┬──────────────────┘  │ │
│  │                                      │                     │ │
│  └──────────────────────────────────────┼─────────────────────┘ │
│                                         │                       │
│  ┌──────────────────────────────────────v─────────────────────┐ │
│  │              Lakebase (PostgreSQL 17)                       │ │
│  │                                                             │ │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐  │ │
│  │  │projects │ │ uploads  │ │session_   │ │ vw_* tables  │  │ │
│  │  │         │ │          │ │records    │ │ (26 total)   │  │ │
│  │  └─────────┘ └──────────┘ └───────────┘ └──────────────┘  │ │
│  │                                                             │ │
│  │  OAuth token refreshed on each connection via OIDC hook     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key configuration settings

| Setting | Env Var | Default | Databricks Value |
|---|---|---|---|
| Database URL | `EDV_DATABASE_URL` | `sqlite:///./etl_dep_viz.db` | `postgresql://...` |
| Databricks mode | `EDV_DATABRICKS_APP` | `false` | `true` |
| CORS origins | `EDV_CORS_ORIGINS` | `["*"]` | `["*"]` |
| Parse timeout | `EDV_PARSE_TIMEOUT_SECONDS` | `1800` | `1800` (or higher) |
| Vector timeout | `EDV_VECTOR_TIMEOUT_SECONDS` | `1800` | `1800` (or higher) |
| Log level | `EDV_LOG_LEVEL` | `INFO` | `INFO` |
| Max upload size | `EDV_MAX_UPLOAD_MB` | `10240` | `10240` |

### Database engine behavior

The engine factory in `backend/app/models/database.py` branches on the URL:

- **SQLite** (`sqlite:///...`): Uses `check_same_thread=False` — identical to
  local dev. No connection pooling (SQLite is single-writer).
- **PostgreSQL** (`postgresql://...`): Uses connection pooling (`pool_size=5`,
  `max_overflow=10`, `pool_pre_ping=True`). When `EDV_DATABRICKS_APP=true`,
  attaches an event hook that refreshes the OAuth access token on every new
  connection via the workspace's `/oidc/v1/token` endpoint.

### Files modified for Databricks support

Only two existing files were changed, both backwards-compatible:

| File | Change |
|---|---|
| `backend/app/config.py` | Added `lakebase_instance` and `databricks_app` settings (default off) |
| `backend/app/models/database.py` | Replaced direct `create_engine()` with `_create_engine()` factory |

Local/Docker behavior is identical — the SQLite code path is unchanged.
