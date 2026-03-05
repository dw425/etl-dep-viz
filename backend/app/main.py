"""ETL Dependency Visualizer -- FastAPI application entry point.

This module wires together the entire backend:
  - Structured logging with a ring-buffer handler for ``/api/health/logs``
  - Correlation-ID propagation via ``contextvars``
  - Request-timing and body-size-limit middleware
  - Global exception handlers (timeout, import, domain errors)
  - Error-aggregation ring buffer for ``/api/health/errors``
  - Health-check endpoints (DB, disk, memory, library versions)
  - Frontend error reporting endpoint
  - Router mounts for all API modules
  - Static-file serving for the Vite-built frontend in production
"""

import contextvars
import logging
import os
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.models.database import init_db

# ── Correlation ID context var ────────────────────────────────────────────
# Each inbound request gets a short UUID stored here; the value is included in
# every log line and returned via the X-Correlation-ID response header.
correlation_id: contextvars.ContextVar[str] = contextvars.ContextVar('correlation_id', default='-')

# ── Ring-buffer log handler ────────────────────────────────────────────────


class RingBufferHandler(logging.Handler):
    """Stores the last N log records in a deque for on-demand retrieval."""

    def __init__(self, capacity: int = 500):
        super().__init__()
        self.buffer: deque[dict] = deque(maxlen=capacity)

    def emit(self, record: logging.LogRecord) -> None:
        """Serialize *record* into a dict and append to the ring buffer.

        Extra fields (those not part of a default LogRecord) are captured in
        the ``extra`` key so structured context is available to consumers.
        """
        cid = correlation_id.get('-')
        # Build a baseline LogRecord to discover which attrs are "extra"
        self.buffer.append({
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": self.format(record),
            "correlation_id": cid,
            "extra": {
                k: v for k, v in record.__dict__.items()
                if k not in logging.LogRecord(
                    "", 0, "", 0, "", (), None
                ).__dict__ and k not in ("message", "msg", "args")
            } if hasattr(record, "__dict__") else {},
        })

    def get_logs(self, limit: int = 100, level: str | None = None) -> list[dict]:
        """Return the most recent *limit* log entries, optionally filtered by minimum *level*."""
        logs = list(self.buffer)
        if level:
            # Convert the level name to a numeric threshold and filter
            level_no = getattr(logging, level.upper(), 0)
            logs = [l for l in logs if getattr(logging, l["level"], 0) >= level_no]
        return logs[-limit:]


ring_buffer = RingBufferHandler(capacity=settings.log_buffer_size)

# ── Structured logging setup ─────────────────────────────────────────────
# Configure the root logger with a human-readable format, then attach the
# ring-buffer handler so logs are also queryable via the /api/health/logs endpoint.
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logging.getLogger().addHandler(ring_buffer)
logger = logging.getLogger("edv")


# ── Application Lifespan ──────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle hook.

    On startup: initializes the SQLite database (creates tables, runs migrations).
    On shutdown: logs a clean exit message.
    """
    logger.info("Starting ETL Dependency Visualizer v1.0.0")
    init_db()
    logger.info("Database initialized")
    yield
    logger.info("Shutting down")


app = FastAPI(
    title="Pipeline Analyzer",
    description=(
        "Visualize ETL session dependencies, write conflicts, and execution ordering.\n\n"
        "Upload Informatica PowerCenter XML or Apache NiFi flow definitions to analyze\n"
        "tier depth, clustering, complexity scoring, wave planning, and column-level lineage.\n\n"
        "## Key Features\n"
        "- **Tier Map**: Session dependency graph with automatic tier assignment\n"
        "- **Constellation**: Clustering algorithms (Louvain, Label Prop, Table Gravity, etc.)\n"
        "- **Vector Analysis**: 11 analysis vectors across 3 phases (Core/Advanced/Ensemble)\n"
        "- **Lineage**: Cross-session table lineage and column-level data flow\n"
        "- **Exports**: Excel, DOT, Mermaid, JIRA CSV, Databricks notebooks\n"
    ),
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_tags=[
        {"name": "tier-map", "description": "Upload, parse, and analyze ETL files"},
        {"name": "vectors", "description": "11 analysis vectors across 3 phases"},
        {"name": "layers", "description": "6-layer progressive disclosure navigation"},
        {"name": "active-tags", "description": "User annotations and tags on ETL objects"},
        {"name": "exports", "description": "Download results in various formats"},
        {"name": "users", "description": "User profiles and activity tracking"},
    ],
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Middleware ─────────────────────────────────────────────────────────────

@app.middleware("http")
async def request_timing(request: Request, call_next):
    """Attach a correlation ID and measure wall-clock request duration.

    The correlation ID is either forwarded from the ``X-Correlation-ID``
    request header or auto-generated as a short UUID.  Both the correlation
    ID and elapsed time are returned as response headers.
    """
    cid = request.headers.get("X-Correlation-ID", str(uuid.uuid4())[:8])
    token = correlation_id.set(cid)
    start = time.perf_counter()
    try:
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.info(
            "cid=%s %s %s -> %d (%.0fms)",
            cid,
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        response.headers["X-Process-Time-Ms"] = f"{elapsed_ms:.0f}"
        response.headers["X-Correlation-ID"] = cid
        return response
    finally:
        correlation_id.reset(token)


# Body size limit middleware
@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    """Reject requests whose Content-Length exceeds ``settings.max_upload_mb``.

    Returns HTTP 413 before the body is read if the declared size is too large.
    """
    max_bytes = settings.max_upload_mb * 1024 * 1024
    cl = request.headers.get("content-length")
    if cl and int(cl) > max_bytes:
        return Response(status_code=413, content="Request body too large")
    return await call_next(request)


# ── Exception Handlers ─────────────────────────────────────────────────────

@app.exception_handler(TimeoutError)
async def timeout_exception_handler(request: Request, exc: TimeoutError):
    """Return HTTP 408 when a parse or analysis operation exceeds its deadline."""
    cid = correlation_id.get('-')
    logger.warning("cid=%s Timeout on %s %s: %s", cid, request.method, request.url.path, exc)
    record_error(error_type="TimeoutError", message=str(exc)[:500], severity="warning")
    return JSONResponse(
        status_code=408,
        content={"detail": "Request timed out", "type": "TimeoutError", "correlation_id": cid},
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch-all handler: returns structured JSON instead of raw stack traces.

    Special cases:
    - ImportError/ModuleNotFoundError -> 503 (missing optional AI deps)
    - ETLMigrationError subclasses    -> 500 with code/severity metadata
    - Everything else                 -> generic 500
    """
    from app.utils.errors import ETLMigrationError
    cid = correlation_id.get('-')
    # Import errors for optional AI deps -> 503 Service Unavailable
    if isinstance(exc, (ImportError, ModuleNotFoundError)):
        logger.warning("cid=%s Missing dependency on %s %s: %s", cid, request.method, request.url.path, exc)
        record_error(error_type="ImportError", message=str(exc)[:500], severity="warning")
        return JSONResponse(
            status_code=503,
            content={
                "detail": f"Missing dependency: {exc}",
                "type": "ServiceUnavailable",
                "correlation_id": cid,
            },
        )
    logger.exception("cid=%s Unhandled error on %s %s", cid, request.method, request.url.path)
    if isinstance(exc, ETLMigrationError):
        record_error(
            error_type=type(exc).__name__,
            message=str(exc),
            code=str(exc.code) if exc.code else None,
            severity=exc.severity.value if hasattr(exc.severity, 'value') else str(exc.severity),
        )
        return JSONResponse(
            status_code=500,
            content={
                "detail": str(exc),
                "type": type(exc).__name__,
                "code": str(exc.code) if exc.code else None,
                "severity": exc.severity.value if hasattr(exc.severity, 'value') else str(exc.severity),
                "correlation_id": cid,
            },
        )
    record_error(
        error_type=type(exc).__name__,
        message=str(exc)[:500],
        severity="error",
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "type": type(exc).__name__,
            "correlation_id": cid,
        },
    )


# ── Error Aggregation Ring Buffer ──────────────────────────────────────────
# Stores the last 200 error events (backend + frontend) for the
# /api/health/errors dashboard.  Older entries are automatically evicted.
_error_buffer: deque[dict] = deque(maxlen=200)


def record_error(error_type: str, message: str, code: str | None = None,
                 severity: str = "error", source: str = "backend",
                 extra: dict | None = None) -> None:
    """Append an error event to the aggregation ring buffer.

    Called by exception handlers, the frontend error endpoint, and any backend
    code that wants to surface issues to the operations dashboard.
    """
    _error_buffer.append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": error_type,
        "message": message[:500],
        "code": code,
        "severity": severity,
        "source": source,
        "correlation_id": correlation_id.get('-'),
        "extra": extra or {},
    })


# ── Health & Diagnostics Endpoints ─────────────────────────────────────────

@app.get("/api/health")
async def health():
    """Expanded health check: DB connectivity, disk space, memory, library versions.

    Returns ``status: "ok"`` when all subsystems are healthy, or
    ``status: "degraded"`` if any check fails (DB unreachable, low disk, etc.).
    """
    import shutil
    import sys

    checks: dict = {"status": "ok"}

    # DB check -- run a trivial query to verify SQLite is accessible
    try:
        from sqlalchemy import text as sa_text
        from app.models.database import SessionLocal
        db = SessionLocal()
        db.execute(sa_text("SELECT 1"))
        db.close()
        checks["db"] = "ok"
    except Exception as e:
        checks["db"] = f"error: {e}"
        checks["status"] = "degraded"

    # Disk space -- degrade if <100 MB free (may block uploads/exports)
    try:
        usage = shutil.disk_usage(os.path.dirname(__file__))
        free_mb = usage.free // (1024 * 1024)
        checks["disk_free_mb"] = free_mb
        if free_mb < 100:
            checks["status"] = "degraded"
    except Exception:
        pass

    # Memory usage (peak RSS) -- platform-dependent units
    try:
        import resource
        mem_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
        if sys.platform == 'darwin':
            mem_mb = mem_mb // 1024  # macOS ru_maxrss is in bytes; Linux is in KB
        checks["memory_mb"] = mem_mb
    except Exception:
        pass

    # Key library versions -- useful for debugging env mismatches
    checks["python"] = sys.version.split()[0]
    try:
        import fastapi
        checks["fastapi"] = fastapi.__version__
    except Exception:
        pass
    try:
        from lxml import etree
        checks["lxml"] = etree.__version__
    except Exception:
        checks["lxml"] = "not installed"
    try:
        import networkx
        checks["networkx"] = networkx.__version__
    except Exception:
        checks["networkx"] = "not installed"

    checks["log_buffer_size"] = len(ring_buffer.buffer)
    checks["error_count"] = len(_error_buffer)

    return checks


@app.get("/api/health/logs")
async def health_logs(
    limit: int = Query(100, ge=1, le=500),
    level: str | None = Query(None),
):
    """Return recent log entries from the ring buffer."""
    return ring_buffer.get_logs(limit=limit, level=level)


# ── Error Aggregation Endpoint ─────────────────────────────────────────────

@app.get("/api/health/errors")
async def health_errors(
    limit: int = Query(50, ge=1, le=200),
    source: str | None = Query(None, description="Filter by source: backend, frontend"),
    severity: str | None = Query(None, description="Filter by severity: warning, error, critical"),
):
    """Return aggregated error events with optional source/severity filters.

    The response includes per-type and per-severity summary counts to power
    the operations dashboard without client-side aggregation.
    """
    errors = list(_error_buffer)
    if source:
        errors = [e for e in errors if e.get("source") == source]
    if severity:
        errors = [e for e in errors if e.get("severity") == severity]
    # Summary counts
    by_type: dict[str, int] = {}
    by_severity: dict[str, int] = {}
    for e in errors:
        by_type[e.get("type", "unknown")] = by_type.get(e.get("type", "unknown"), 0) + 1
        by_severity[e.get("severity", "unknown")] = by_severity.get(e.get("severity", "unknown"), 0) + 1
    return {
        "errors": errors[-limit:],
        "total": len(errors),
        "by_type": by_type,
        "by_severity": by_severity,
    }


# ── Frontend Error Reporting ───────────────────────────────────────────────

@app.post("/api/health/report-error")
async def report_frontend_error(request: Request):
    """Accept error reports posted by the React frontend.

    The body is a JSON object with ``type``, ``message``, ``severity``, and
    optional ``stack`` / ``url`` / ``user_id`` fields.  Errors are funnelled
    into the same ring buffer as backend errors so they appear together in
    ``/api/health/errors``.
    """
    try:
        body = await request.json()
    except Exception:
        return {"accepted": False}
    record_error(
        error_type=body.get("type", "frontend_error"),
        message=body.get("message", "Unknown frontend error"),
        code=body.get("code"),
        severity=body.get("severity", "error"),
        source="frontend",
        extra={
            "url": body.get("url", ""),
            "stack": body.get("stack", "")[:2000],
            "user_agent": request.headers.get("user-agent", ""),
            "user_id": body.get("user_id", ""),
        },
    )
    logger.warning("Frontend error: %s", body.get("message", "")[:200])
    return {"accepted": True}


# ── Router Mounts ─────────────────────────────────────────────────────────
# All routers are mounted under the /api prefix so the Vite dev proxy and
# the production static-file mount can coexist without path collisions.
from app.routers.tier_map import router as tier_map_router
from app.routers.vectors import router as vectors_router
from app.routers.layers import router as layers_router
from app.routers.active_tags import router as active_tags_router
from app.routers.users import router as users_router
from app.routers.lineage import router as lineage_router
from app.routers.exports import router as exports_router
from app.routers.chat import router as chat_router
from app.routers.views import router as views_router
from app.routers.projects import router as projects_router

app.include_router(tier_map_router, prefix="/api")
app.include_router(vectors_router, prefix="/api")
app.include_router(layers_router, prefix="/api")
app.include_router(active_tags_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(lineage_router, prefix="/api")
app.include_router(exports_router, prefix="/api")
app.include_router(chat_router, prefix="/api")
app.include_router(views_router, prefix="/api")
app.include_router(projects_router, prefix="/api")

# ── SQLite → PostgreSQL Migration Endpoint ─────────────────────────────────

MIGRATE_TABLES = [
    "user_profiles", "projects", "uploads", "activity_log",
    "session_records", "table_records", "connection_records", "connection_profiles",
    "vw_tier_layout", "vw_galaxy_nodes", "vw_explorer_detail",
    "vw_write_conflicts", "vw_read_chains", "vw_exec_order",
    "vw_matrix_cells", "vw_table_profiles",
    "vw_duplicate_groups", "vw_duplicate_members",
    "vw_constellation_chunks", "vw_constellation_points", "vw_constellation_edges",
    "vw_complexity_scores", "vw_wave_assignments", "vw_umap_coords",
    "vw_communities", "vw_wave_function",
    "vw_concentration_groups", "vw_concentration_members", "vw_ensemble",
]


_migrate_status: dict = {"state": "idle"}


def _run_migration(db_path: str):
    """Background migration worker — streams rows from SQLite to PostgreSQL."""
    import sqlite3 as sqlite3_mod
    from app.models.database import engine
    from sqlalchemy import text as sa_text

    _migrate_status.update(state="running", current_table="", migrated_rows=0, tables={}, error="")

    try:
        src = sqlite3_mod.connect(db_path)

        for table in MIGRATE_TABLES:
            _migrate_status["current_table"] = table
            try:
                cur = src.execute(f'SELECT COUNT(*) FROM "{table}"')
                count = cur.fetchone()[0]
                if count == 0:
                    _migrate_status["tables"][table] = 0
                    continue

                cur = src.execute(f'PRAGMA table_info("{table}")')
                columns = [row[1] for row in cur.fetchall()]
                col_list = ", ".join(f'"{c}"' for c in columns)
                placeholders = ", ".join(f":{c}" for c in columns)
                insert_sql = sa_text(f'INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})')

                # Get valid upload_ids to filter orphaned rows
                valid_upload_ids = None
                if "upload_id" in columns:
                    valid_cur = src.execute('SELECT id FROM uploads')
                    valid_upload_ids = {row[0] for row in valid_cur.fetchall()}

                with engine.begin() as conn:
                    conn.execute(sa_text(f'DELETE FROM "{table}"'))

                    # Stream rows with fetchmany to limit memory usage
                    cur = src.execute(f'SELECT * FROM "{table}"')
                    uid_idx = columns.index("upload_id") if "upload_id" in columns else None
                    skipped = 0
                    while True:
                        rows = cur.fetchmany(100)
                        if not rows:
                            break
                        # Filter out orphaned rows
                        if uid_idx is not None and valid_upload_ids is not None:
                            filtered = [r for r in rows if r[uid_idx] in valid_upload_ids]
                            skipped += len(rows) - len(filtered)
                            rows = filtered
                        if rows:
                            batch = [dict(zip(columns, row)) for row in rows]
                            conn.execute(insert_sql, batch)

                    if skipped:
                        logger.info("Skipped %d orphaned rows in %s", skipped, table)

                    if "id" in columns:
                        try:
                            conn.execute(sa_text(
                                f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                                f"(SELECT MAX(CAST(id AS INTEGER)) FROM \"{table}\"))"
                            ))
                        except Exception:
                            pass

                _migrate_status["tables"][table] = count
                _migrate_status["migrated_rows"] += count
                logger.info("Migrated %s: %d rows", table, count)
            except Exception as e:
                _migrate_status["tables"][table] = f"error: {e}"
                logger.error("Failed to migrate %s: %s", table, e)

        src.close()
        _migrate_status["state"] = "done"
        logger.info("Migration complete: %d rows", _migrate_status["migrated_rows"])
    except Exception as e:
        _migrate_status.update(state="error", error=str(e))
        logger.error("Migration failed: %s", e)
    finally:
        if os.path.exists(db_path):
            os.unlink(db_path)


@app.post("/api/admin/migrate-sqlite")
async def migrate_sqlite(file: UploadFile):
    """Upload SQLite file and start background migration into Lakebase.

    Usage: curl -X POST -F "file=@backend/etl_dep_viz.db" URL/api/admin/migrate-sqlite
    Returns immediately; check progress at GET /api/admin/migrate-status.
    """
    import tempfile
    import threading

    if _migrate_status.get("state") == "running":
        return JSONResponse(status_code=409, content={"detail": "Migration already in progress"})

    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    total_bytes = 0
    while True:
        chunk = await file.read(4 * 1024 * 1024)
        if not chunk:
            break
        tmp.write(chunk)
        total_bytes += len(chunk)
    tmp.close()
    logger.info("Received SQLite upload: %d bytes -> %s", total_bytes, tmp.name)

    # Start migration in background thread
    threading.Thread(target=_run_migration, args=(tmp.name,), daemon=True).start()
    return {"status": "started", "file_size": total_bytes}


@app.get("/api/admin/migrate-status")
async def migrate_status():
    """Check migration progress."""
    return _migrate_status


# ── Static File Serving (Production) ──────────────────────────────────────
# In the Docker image Vite builds into backend/static/. When that directory
# exists we serve it as a catch-all SPA mount (html=True enables index.html
# fallback for client-side routing).
static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
