"""Vectors router — run analysis vectors on tier map data."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.engines.vectors.orchestrator import VectorOrchestrator
from app.models.database import Upload, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/vectors", tags=["vectors"])


def _compute_cache_key(tier_data: dict, phase: int = 3, params: dict | None = None) -> str:
    """Content-addressed cache key: SHA-256 of (session IDs + connections + phase + params)."""
    session_ids = sorted(s.get('id', '') for s in tier_data.get('sessions', []))
    conn_keys = sorted(
        f"{c.get('from', '')}-{c.get('to', '')}" for c in tier_data.get('connections', [])
    )
    key_data = json.dumps({
        'sessions': session_ids,
        'connections': conn_keys,
        'phase': phase,
        'params': params or {},
    }, sort_keys=True)
    return hashlib.sha256(key_data.encode()).hexdigest()[:16]


@router.post("/analyze")
async def analyze_vectors(
    tier_data: dict[str, Any] = Body(...),
    phase: int = Query(1, ge=1, le=3, description="Phase to run (1=core, 2=advanced, 3=all)"),
    upload_id: int | None = Query(None, description="Upload ID to cache results"),
    db: Session = Depends(get_db),
):
    """Run analysis vectors on tier map data.

    Phase 1: V1 (community), V4 (SCC/waves), V11 (complexity)
    Phase 2: + V2, V3, V9, V10
    Phase 3: + V5, V6, V7, V8 (full ensemble)
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    # Validate tier_data has required fields
    for s in sessions[:3]:
        if "id" not in s or "tier" not in s:
            raise HTTPException(400, "Each session must have 'id' and 'tier' fields")

    orchestrator = VectorOrchestrator()

    if phase == 1:
        result = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    elif phase == 2:
        p1 = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
        result = await asyncio.to_thread(orchestrator.run_phase2, tier_data, p1)
    else:
        result = await asyncio.to_thread(orchestrator.run_all, tier_data)

    # Persist vector results if upload_id provided
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            upload.set_vector_results(result)
            db.commit()

    return result


@router.get("/results/{upload_id}")
def get_cached_vectors(upload_id: int, db: Session = Depends(get_db)):
    """Retrieve cached vector results for an upload."""
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")
    results = upload.get_vector_results()
    if not results:
        raise HTTPException(404, "No vector results cached for this upload")
    return results


@router.post("/analyze-stream")
async def analyze_vectors_stream(
    tier_data: dict[str, Any] = Body(...),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Run all vector analysis phases with SSE progress streaming."""
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    queue: asyncio.Queue = asyncio.Queue()

    async def _process():
        try:
            orchestrator = VectorOrchestrator()

            await queue.put({"phase": "v1_community", "percent": 5})
            p1 = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
            await queue.put({"phase": "phase1_complete", "percent": 33})

            await queue.put({"phase": "v2_hierarchical", "percent": 35})
            p2 = await asyncio.to_thread(orchestrator.run_phase2, tier_data, p1)
            await queue.put({"phase": "phase2_complete", "percent": 66})

            await queue.put({"phase": "v5_affinity", "percent": 70})
            p3 = await asyncio.to_thread(orchestrator.run_phase3, tier_data, p2)
            await queue.put({"phase": "phase3_complete", "percent": 95})

            # Cache if upload_id provided
            if upload_id:
                upload = db.query(Upload).filter(Upload.id == upload_id).first()
                if upload:
                    upload.set_vector_results(p3)
                    db.commit()

            await queue.put({"phase": "complete", "percent": 100, "result": p3})
        except Exception as exc:
            logger.exception("Vector analysis stream error")
            await queue.put({"phase": "error", "message": str(exc)})

    async def _event_generator():
        while True:
            event = await queue.get()
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("phase") in ("complete", "error"):
                break

    asyncio.ensure_future(_process())
    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/wave-plan")
async def get_wave_plan(tier_data: dict[str, Any] = Body(...)):
    """Get migration wave plan (V4) from tier data."""
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    orchestrator = VectorOrchestrator()
    result = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    return result.get("v4_wave_plan", {})


@router.post("/complexity")
async def get_complexity(tier_data: dict[str, Any] = Body(...)):
    """Get complexity breakdown (V11) from tier data."""
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    orchestrator = VectorOrchestrator()
    result = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    return result.get("v11_complexity", {})


@router.post("/what-if/{session_id}")
async def what_if_simulation(
    session_id: str,
    tier_data: dict[str, Any] = Body(...),
):
    """Run what-if failure simulation for a session (V9 wave function)."""
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    session_ids = [s["id"] for s in sessions]
    if session_id not in session_ids:
        raise HTTPException(404, f"Session {session_id} not found")

    try:
        from app.engines.vectors.v9_wave_function import WaveFunctionVector
        from app.engines.vectors.feature_extractor import (
            FeatureMatrixBuilder,
            extract_session_features,
        )

        features = extract_session_features(tier_data)
        builder = FeatureMatrixBuilder(features)
        connections = tier_data.get("connections", [])
        adjacency = builder.build_adjacency_matrix(connections)

        v9 = WaveFunctionVector()
        result = await asyncio.to_thread(
            v9.what_if_failure, session_id, adjacency, builder.session_ids
        )
        return result
    except ImportError:
        raise HTTPException(501, "V9 wave function module not available")


# ── Vector configuration and selective execution ─────────────────────────

@router.get("/config")
async def get_vector_config():
    """Return available vectors, their phases, and configurable parameters."""
    return {
        'phases': [
            {
                'id': 1, 'name': 'Core',
                'vectors': ['v1_community', 'v4_topological', 'v11_complexity'],
                'description': 'Community detection, topological ordering, complexity scoring',
            },
            {
                'id': 2, 'name': 'Advanced',
                'vectors': ['v2_partition', 'v3_centrality', 'v9_umap', 'v10_concentration'],
                'description': 'Hierarchical partitioning, UMAP, wave function, concentration',
            },
            {
                'id': 3, 'name': 'Ensemble',
                'vectors': ['v5_ensemble', 'v6_wave', 'v7_gravity', 'v8_simulation'],
                'description': 'Affinity, spectral, HDBSCAN, ensemble consensus',
            },
        ],
        'vectors': {
            'v1_community':  {'name': 'Community Detection', 'phase': 1, 'required': True},
            'v4_topological': {'name': 'Topological Sort', 'phase': 1, 'required': True},
            'v11_complexity': {'name': 'Complexity Scoring', 'phase': 1, 'required': True},
            'v2_partition':   {'name': 'Partition Quality', 'phase': 2, 'required': False},
            'v3_centrality':  {'name': 'UMAP Projection', 'phase': 2, 'required': False},
            'v9_umap':        {'name': 'Wave Function', 'phase': 2, 'required': False},
            'v10_concentration': {'name': 'Concentration', 'phase': 2, 'required': False},
            'v5_ensemble':    {'name': 'Affinity Propagation', 'phase': 3, 'required': False},
            'v6_wave':        {'name': 'Spectral Clustering', 'phase': 3, 'required': False},
            'v7_gravity':     {'name': 'HDBSCAN', 'phase': 3, 'required': False},
            'v8_simulation':  {'name': 'Ensemble Consensus', 'phase': 3, 'required': False},
        },
    }


@router.post("/analyze-selective")
async def analyze_selective(
    tier_data: dict[str, Any] = Body(...),
    vectors: list[str] = Query(
        default=[],
        description="Specific vectors to run (empty = all for phase)",
    ),
    phase: int = Query(3, ge=1, le=3),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Run selected vectors only, skipping unwanted ones.

    If vectors list is empty, runs all vectors for the specified phase.
    If vectors are specified, only runs those (plus their dependencies).
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    # Content-addressed cache check
    cache_key = _compute_cache_key(tier_data, phase, {'vectors': sorted(vectors)})

    orchestrator = VectorOrchestrator()
    t0 = time.monotonic()

    # Phase 1 is always required (core vectors)
    p1 = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    result = dict(p1)

    if phase >= 2:
        p2 = await asyncio.to_thread(orchestrator.run_phase2, tier_data, p1)
        result.update(p2)

    if phase >= 3:
        p3 = await asyncio.to_thread(orchestrator.run_phase3, tier_data, result)
        result.update(p3)

    # Filter to only requested vectors (if specified)
    if vectors:
        allowed = set(vectors) | {'_timings'}  # always keep timings
        result = {k: v for k, v in result.items() if k in allowed or k.startswith('_')}

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    result['_cache_key'] = cache_key
    result['_elapsed_ms'] = elapsed_ms

    # Cache results
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            upload.set_vector_results(result)
            db.commit()

    return result


@router.post("/sweep-resolution")
async def sweep_resolution(
    tier_data: dict[str, Any] = Body(...),
):
    """Sweep V1 community detection resolution to show parameter sensitivity."""
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    orchestrator = VectorOrchestrator()
    result = await asyncio.to_thread(orchestrator.sweep_resolution, tier_data)
    return result


@router.post("/analyze-incremental")
async def analyze_incremental(
    tier_data: dict[str, Any] = Body(...),
    vectors: list[str] = Query(
        default=[],
        description="Specific vector keys to (re-)run",
    ),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Incrementally run only specified vectors, reusing previous results.

    Automatically resolves vector dependencies so prerequisite vectors
    are computed if their results aren't already cached.
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    # Load previous results from cache if available
    previous = None
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            previous = upload.get_vector_results()

    orchestrator = VectorOrchestrator()
    t0 = time.monotonic()
    result = await asyncio.to_thread(
        orchestrator.run_incremental, tier_data, vectors, previous
    )
    result['_elapsed_ms'] = int((time.monotonic() - t0) * 1000)

    # Cache updated results
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            upload.set_vector_results(result)
            db.commit()

    return result
