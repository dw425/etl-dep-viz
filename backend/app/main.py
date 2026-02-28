"""ETL Dependency Visualizer — slim FastAPI application."""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.models.database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


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


# Body size limit middleware
@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    max_bytes = settings.max_upload_mb * 1024 * 1024
    cl = request.headers.get("content-length")
    if cl and int(cl) > max_bytes:
        return Response(status_code=413, content="Request body too large")
    return await call_next(request)


# Health probe
@app.get("/api/health")
async def health():
    return {"status": "ok"}


# Mount router
from app.routers.tier_map import router as tier_map_router

app.include_router(tier_map_router, prefix="/api")

# Serve frontend static files in production (built by Vite into backend/static/)
static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
