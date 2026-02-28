"""Vectors router — run analysis vectors on tier map data."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query

from app.engines.vectors.orchestrator import VectorOrchestrator

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/vectors", tags=["vectors"])


@router.post("/analyze")
async def analyze_vectors(
    tier_data: dict[str, Any] = Body(...),
    phase: int = Query(1, ge=1, le=3, description="Phase to run (1=core, 2=advanced, 3=all)"),
):
    """Run analysis vectors on tier map data.

    Phase 1: V1 (community), V4 (SCC/waves), V11 (complexity)
    Phase 2: + V2, V3, V9, V10
    Phase 3: + V5, V6, V7, V8 (full ensemble)
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    orchestrator = VectorOrchestrator()

    if phase == 1:
        result = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    elif phase == 2:
        p1 = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
        result = await asyncio.to_thread(orchestrator.run_phase2, tier_data, p1)
    else:
        result = await asyncio.to_thread(orchestrator.run_all, tier_data)

    return result


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
