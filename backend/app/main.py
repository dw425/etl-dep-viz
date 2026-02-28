"""ETL Dependency Visualizer — slim FastAPI application."""

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.models.database import init_db

# Structured logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
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


# Mount routers
from app.routers.tier_map import router as tier_map_router
from app.routers.vectors import router as vectors_router
from app.routers.layers import router as layers_router
from app.routers.active_tags import router as active_tags_router

app.include_router(tier_map_router, prefix="/api")
app.include_router(vectors_router, prefix="/api")
app.include_router(layers_router, prefix="/api")
app.include_router(active_tags_router, prefix="/api")

# Serve frontend static files in production (built by Vite into backend/static/)
static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
