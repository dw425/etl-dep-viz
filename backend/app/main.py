"""ETL Dependency Visualizer — slim FastAPI application."""

import contextvars
import logging
import os
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.models.database import init_db

# ── Correlation ID context var ────────────────────────────────────────────
correlation_id: contextvars.ContextVar[str] = contextvars.ContextVar('correlation_id', default='-')

# ── Ring-buffer log handler ────────────────────────────────────────────────


class RingBufferHandler(logging.Handler):
    """Stores the last N log records in a deque for on-demand retrieval."""

    def __init__(self, capacity: int = 500):
        super().__init__()
        self.buffer: deque[dict] = deque(maxlen=capacity)

    def emit(self, record: logging.LogRecord) -> None:
        cid = correlation_id.get('-')
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
        logs = list(self.buffer)
        if level:
            level_no = getattr(logging, level.upper(), 0)
            logs = [l for l in logs if getattr(logging, l["level"], 0) >= level_no]
        return logs[-limit:]


ring_buffer = RingBufferHandler(capacity=settings.log_buffer_size)

# Structured logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logging.getLogger().addHandler(ring_buffer)
logger = logging.getLogger("edv")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting ETL Dependency Visualizer v1.0.0")
    init_db()
    logger.info("Database initialized")
    yield
    logger.info("Shutting down")


app = FastAPI(
    title="ETL Dependency Visualizer",
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


# Request timing middleware with correlation ID
@app.middleware("http")
async def request_timing(request: Request, call_next):
    # Generate or extract correlation ID
    cid = request.headers.get("X-Correlation-ID", str(uuid.uuid4())[:8])
    token = correlation_id.set(cid)
    start = time.perf_counter()
    try:
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.info(
            "cid=%s %s %s → %d (%.0fms)",
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
    max_bytes = settings.max_upload_mb * 1024 * 1024
    cl = request.headers.get("content-length")
    if cl and int(cl) > max_bytes:
        return Response(status_code=413, content="Request body too large")
    return await call_next(request)


# Global exception handler — return JSON instead of stack traces
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    from app.utils.errors import ETLMigrationError
    cid = correlation_id.get('-')
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


# ── Error aggregation ring buffer (Item 27) ──────────────────────────────
_error_buffer: deque[dict] = deque(maxlen=200)


def record_error(error_type: str, message: str, code: str | None = None,
                 severity: str = "error", source: str = "backend",
                 extra: dict | None = None) -> None:
    """Record an error event for aggregation."""
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


# Health probe (Item 29: expanded health checks)
@app.get("/api/health")
async def health():
    """Expanded health check: DB, disk, memory, libraries."""
    import shutil
    import sys

    checks: dict = {"status": "ok"}

    # DB check
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

    # Disk space
    try:
        usage = shutil.disk_usage(os.path.dirname(__file__))
        free_mb = usage.free // (1024 * 1024)
        checks["disk_free_mb"] = free_mb
        if free_mb < 100:
            checks["status"] = "degraded"
    except Exception:
        pass

    # Memory usage
    try:
        import resource
        mem_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024  # macOS: bytes, Linux: KB
        if sys.platform == 'darwin':
            mem_mb = mem_mb // 1024  # macOS reports in bytes
        checks["memory_mb"] = mem_mb
    except Exception:
        pass

    # Key library versions
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


# ── Error Aggregation Endpoint (Item 27) ─────────────────────────────────

@app.get("/api/health/errors")
async def health_errors(
    limit: int = Query(50, ge=1, le=200),
    source: str | None = Query(None, description="Filter by source: backend, frontend"),
    severity: str | None = Query(None, description="Filter by severity: warning, error, critical"),
):
    """Return aggregated error events."""
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


# ── Frontend Error Reporting (Item 30) ───────────────────────────────────

@app.post("/api/health/report-error")
async def report_frontend_error(request: Request):
    """Accept error reports from the frontend."""
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


# Mount routers
from app.routers.tier_map import router as tier_map_router
from app.routers.vectors import router as vectors_router
from app.routers.layers import router as layers_router
from app.routers.active_tags import router as active_tags_router
from app.routers.users import router as users_router
from app.routers.lineage import router as lineage_router
from app.routers.exports import router as exports_router
from app.routers.chat import router as chat_router

app.include_router(tier_map_router, prefix="/api")
app.include_router(vectors_router, prefix="/api")
app.include_router(layers_router, prefix="/api")
app.include_router(active_tags_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(lineage_router, prefix="/api")
app.include_router(exports_router, prefix="/api")
app.include_router(chat_router, prefix="/api")

# Serve frontend static files in production (built by Vite into backend/static/)
static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
