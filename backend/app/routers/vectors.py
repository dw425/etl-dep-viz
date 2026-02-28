"""Vectors router — run analysis vectors on tier map data."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.engines.vectors.orchestrator import VectorOrchestrator
from app.models.database import Upload, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/vectors", tags=["vectors"])


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
