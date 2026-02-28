"""ETL Dependency Visualizer — slim FastAPI application."""

import logging
import os
import time
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.models.database import init_db

# ── Ring-buffer log handler ────────────────────────────────────────────────


class RingBufferHandler(logging.Handler):
    """Stores the last N log records in a deque for on-demand retrieval."""

    def __init__(self, capacity: int = 500):
        super().__init__()
        self.buffer: deque[dict] = deque(maxlen=capacity)

    def emit(self, record: logging.LogRecord) -> None:
        self.buffer.append({
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": self.format(record),
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
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request timing middleware
@app.middleware("http")
async def request_timing(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    logger.info(
        "%s %s → %d (%.0fms)",
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    response.headers["X-Process-Time-Ms"] = f"{elapsed_ms:.0f}"
    return response


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
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "type": type(exc).__name__},
    )


# Health probe
@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/health/logs")
async def health_logs(
    limit: int = Query(100, ge=1, le=500),
    level: str | None = Query(None),
):
    """Return recent log entries from the ring buffer."""
    return ring_buffer.get_logs(limit=limit, level=level)


# Mount routers
from app.routers.tier_map import router as tier_map_router
from app.routers.vectors import router as vectors_router
from app.routers.layers import router as layers_router
from app.routers.active_tags import router as active_tags_router
from app.routers.users import router as users_router

app.include_router(tier_map_router, prefix="/api")
app.include_router(vectors_router, prefix="/api")
app.include_router(layers_router, prefix="/api")
app.include_router(active_tags_router, prefix="/api")
app.include_router(users_router, prefix="/api")

# Serve frontend static files in production (built by Vite into backend/static/)
static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
