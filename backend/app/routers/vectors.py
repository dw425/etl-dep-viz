"""Vectors router — run analysis vectors on tier map data.

Vector execution is organised into three phases:
  Phase 1 (Core):     V1 community detection, V4 topological sort / wave plan, V11 complexity scoring
  Phase 2 (Advanced): V2 partition quality, V3 centrality, V9 UMAP/wave function, V10 concentration
  Phase 3 (Ensemble): V5 affinity propagation, V6 spectral, V7 HDBSCAN, V8 ensemble consensus

All heavy computation runs in a thread pool via asyncio.to_thread to keep the
async event loop responsive.  SSE streaming is available via /analyze-stream.
"""

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


# ── Cache Utilities ───────────────────────────────────────────────────────


def _compute_cache_key(tier_data: dict, phase: int = 3, params: dict | None = None) -> str:
    """Content-addressed cache key: SHA-256 of (session IDs + connections + phase + params).

    Sorting IDs before hashing ensures the key is order-independent, so the
    same logical dataset always produces the same cache key regardless of
    the order sessions appear in the JSON body.

    Args:
        tier_data: The tier data dict containing sessions and connections.
        phase: Vector analysis phase (1-3).
        params: Extra parameters that affect the result (e.g., selected vectors).

    Returns:
        16-character hex string — short enough for URLs, long enough to avoid collisions.
    """
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
    # Truncate to 16 hex chars — short enough for URLs, long enough to avoid collisions
    return hashlib.sha256(key_data.encode()).hexdigest()[:16]


# ── Core Analysis Endpoints ───────────────────────────────────────────────


@router.post("/analyze")
async def analyze_vectors(
    tier_data: dict[str, Any] = Body(...),
    phase: int = Query(1, ge=1, le=3, description="Phase to run (1=core, 2=advanced, 3=all)"),
    upload_id: int | None = Query(None, description="Upload ID to cache results"),
    db: Session = Depends(get_db),
):
    """Run analysis vectors on tier map data (synchronous, no SSE).

    Phase 1 (Core):     V1 community detection, V4 SCC/wave plan, V11 complexity
    Phase 2 (Advanced): + V2 partition quality, V3 centrality, V9 UMAP, V10 concentration
    Phase 3 (All):      + V5 affinity, V6 spectral, V7 HDBSCAN, V8 ensemble consensus

    Each phase depends on the previous: Phase 2 needs Phase 1's communities as
    input features, Phase 3 needs Phase 2's results for ensemble voting.

    Args:
        tier_data: Tier data dict with sessions, connections, tables.
        phase: Which phase to run up to (1=core only, 2=+advanced, 3=full).
        upload_id: Optional — if provided, results are cached against this upload.
        db: SQLAlchemy session (injected).

    Returns:
        Dict keyed by vector name (e.g. v1_communities, v4_wave_plan, v11_complexity).
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    # Validate tier_data has required fields
    for s in sessions[:3]:
        if "id" not in s or "tier" not in s:
            raise HTTPException(400, "Each session must have 'id' and 'tier' fields")

    orchestrator = VectorOrchestrator()

    # ── Phase execution: each phase depends on the previous phase's results ──
    if phase == 1:
        result = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    elif phase == 2:
        # Phase 2 vectors need Phase 1 community/wave data as input features
        p1 = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
        result = await asyncio.to_thread(orchestrator.run_phase2, tier_data, p1)
    else:
        # Phase 3 runs all phases internally via run_all for a full ensemble result
        result = await asyncio.to_thread(orchestrator.run_all, tier_data)

    # Remove internal cached matrices before serialization
    result.pop('_matrices', None)

    # Persist vector results against the upload row if an ID was provided
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            upload.set_vector_results(result)
            db.commit()
            # Populate per-view vector tables
            from app.engines.data_populator import populate_vector_tables
            try:
                populate_vector_tables(db, upload_id, result)
                db.commit()
            except Exception as exc:
                logger.warning("Failed to populate vector tables: %s", exc)
                db.rollback()

    return result


# ── Cached Results ────────────────────────────────────────────────────────


@router.get("/results/{upload_id}")
def get_cached_vectors(upload_id: int, db: Session = Depends(get_db)):
    """Retrieve cached vector results for an upload.

    Args:
        upload_id: DB primary key of the upload whose vectors to retrieve.
        db: SQLAlchemy session (injected).

    Returns:
        Full vector results dict (all phases that have been computed).

    Raises:
        HTTPException(404): Upload not found or no vector results cached.
    """
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")
    results = upload.get_vector_results()
    if not results:
        raise HTTPException(404, "No vector results cached for this upload")
    return results


# ── SSE Streaming Analysis ────────────────────────────────────────────────


@router.post("/analyze-stream")
async def analyze_vectors_stream(
    tier_data: dict[str, Any] = Body(...),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Run all vector analysis phases with SSE progress streaming.

    Returns text/event-stream with progress events as each phase completes:
      data: {"phase":"v1_community","percent":5}
      data: {"phase":"phase1_complete","percent":33}
      ...
      data: {"phase":"complete","percent":100,"result":{...}}

    Args:
        tier_data: Tier data dict with sessions, connections, tables.
        upload_id: Optional — if provided, final results are cached.
        db: SQLAlchemy session (injected).

    Returns:
        StreamingResponse (text/event-stream) with JSON progress events.
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    queue: asyncio.Queue = asyncio.Queue()

    async def _process():
        """Run all three vector phases sequentially, emitting SSE progress events."""
        try:
            orchestrator = VectorOrchestrator()

            # ── Phase 1: Core vectors (V1, V4, V11) ──
            await queue.put({"phase": "v1_community", "percent": 5})
            p1 = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
            await queue.put({"phase": "phase1_complete", "percent": 33})

            # ── Phase 2: Advanced vectors (V2, V3, V9, V10) — builds on Phase 1 ──
            await queue.put({"phase": "v2_hierarchical", "percent": 35})
            p2 = await asyncio.to_thread(orchestrator.run_phase2, tier_data, p1)
            await queue.put({"phase": "phase2_complete", "percent": 66})

            # ── Phase 3: Ensemble vectors (V5–V8) — builds on Phase 2 ──
            await queue.put({"phase": "v5_affinity", "percent": 70})
            p3 = await asyncio.to_thread(orchestrator.run_phase3, tier_data, p2)
            await queue.put({"phase": "phase3_complete", "percent": 95})

            # Persist final results if an upload_id was supplied
            if upload_id:
                upload = db.query(Upload).filter(Upload.id == upload_id).first()
                if upload:
                    upload.set_vector_results(p3)
                    db.commit()
                    from app.engines.data_populator import populate_vector_tables
                    try:
                        populate_vector_tables(db, upload_id, p3)
                        db.commit()
                    except Exception as exc:
                        logger.warning("Failed to populate vector tables (stream): %s", exc)

            await queue.put({"phase": "complete", "percent": 100, "result": p3})
        except Exception as exc:
            logger.exception("Vector analysis stream error")
            await queue.put({"phase": "error", "message": str(exc)})

    async def _event_generator():
        """Drain the queue and yield SSE lines; stop on terminal phase."""
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


# ── Single-Vector Convenience Endpoints ───────────────────────────────────


@router.post("/wave-plan")
async def get_wave_plan(tier_data: dict[str, Any] = Body(...)):
    """Get migration wave plan (V4) from tier data.

    Runs Phase 1 (which includes V4 topological sort) and returns only the
    v4_wave_plan slice. Convenience shortcut for clients that only need waves.

    Args:
        tier_data: Tier data dict with sessions and connections.

    Returns:
        V4 wave plan dict with waves, scc_groups, and execution ordering.
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    orchestrator = VectorOrchestrator()
    result = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    return result.get("v4_wave_plan", {})


@router.post("/complexity")
async def get_complexity(tier_data: dict[str, Any] = Body(...)):
    """Get complexity breakdown (V11) from tier data.

    Runs Phase 1 (which includes V11 complexity scoring) and returns only
    the v11_complexity slice. Convenience shortcut for the complexity view.

    Args:
        tier_data: Tier data dict with sessions and connections.

    Returns:
        V11 complexity dict with per-session scores, buckets, and effort estimates.
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    orchestrator = VectorOrchestrator()
    result = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    return result.get("v11_complexity", {})


# ── What-If Simulation ────────────────────────────────────────────────────


@router.post("/what-if/{session_id}")
async def what_if_simulation(
    session_id: str,
    tier_data: dict[str, Any] = Body(...),
):
    """Run what-if failure simulation for a session (V9 wave function).

    Simulates removing `session_id` from the dependency graph and propagating
    the cascade to identify all downstream sessions that would be affected.

    Args:
        session_id: The session to simulate failure for.
        tier_data: Full tier data (sessions + connections) for graph context.

    Returns:
        V9 what-if result: blast radius, affected sessions, cascade depth.

    Raises:
        HTTPException(404): session_id not found in tier_data.
        HTTPException(501): V9 module not installed.
    """
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

        # Build the feature matrix and adjacency graph required by V9
        features = extract_session_features(tier_data)
        builder = FeatureMatrixBuilder(features)
        connections = tier_data.get("connections", [])
        adjacency = builder.build_adjacency_matrix(connections)

        # what_if_failure simulates removing session_id and propagating the
        # cascade of downstream sessions that would be affected
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
    """Return available vectors, their phases, and configurable parameters.

    Used by the frontend to render the vector configuration panel, showing
    which vectors are available, which phase they belong to, and whether
    they are required (Phase 1 core vectors) or optional.
    """
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
    Phase 1 always runs because all later vectors depend on its outputs.

    Args:
        tier_data: Tier data dict with sessions, connections, tables.
        vectors: List of vector keys to keep in the output (empty = all).
        phase: Max phase to run (1-3).
        upload_id: Optional — if provided, results are cached.
        db: SQLAlchemy session (injected).

    Returns:
        Filtered dict of vector results, plus _cache_key and _elapsed_ms metadata.
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    # Compute a deterministic cache key for this exact input + vector selection
    cache_key = _compute_cache_key(tier_data, phase, {'vectors': sorted(vectors)})

    orchestrator = VectorOrchestrator()
    t0 = time.monotonic()

    # Phase 1 must always run — later phases depend on its community/wave output
    p1 = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    result = dict(p1)

    if phase >= 2:
        p2 = await asyncio.to_thread(orchestrator.run_phase2, tier_data, p1)
        result.update(p2)

    if phase >= 3:
        p3 = await asyncio.to_thread(orchestrator.run_phase3, tier_data, result)
        result.update(p3)

    # Post-filter: if the caller named specific vectors, strip all others.
    # Internal metadata keys (prefix '_') are always retained.
    if vectors:
        allowed = set(vectors) | {'_timings'}  # always keep timings metadata
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
            from app.engines.data_populator import populate_vector_tables
            try:
                populate_vector_tables(db, upload_id, result)
                db.commit()
            except Exception as exc:
                logger.warning("Failed to populate vector tables (selective): %s", exc)

    return result


@router.post("/sweep-resolution")
async def sweep_resolution(
    tier_data: dict[str, Any] = Body(...),
):
    """Sweep V1 community detection resolution to show parameter sensitivity.

    Runs V1 at multiple resolution values to show how the number of detected
    communities changes with the resolution parameter. Useful for choosing
    the best resolution for a given dataset.

    Args:
        tier_data: Tier data dict with sessions and connections.

    Returns:
        List of {resolution, community_count, modularity} for each sweep point.
    """
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
    are computed if their results aren't already cached. Previously cached
    results are loaded from the upload row and merged with freshly computed
    vectors, avoiding redundant work when only one vector needs re-running.

    Args:
        tier_data: Tier data dict with sessions, connections, tables.
        vectors: List of vector keys to (re-)compute.
        upload_id: Optional — used to load previous results and persist merged output.
        db: SQLAlchemy session (injected).

    Returns:
        Merged dict of old + new vector results, plus _elapsed_ms metadata.
    """
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    # ── Load previously cached results to avoid recomputing unchanged vectors ──
    previous = None
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            previous = upload.get_vector_results()

    orchestrator = VectorOrchestrator()
    t0 = time.monotonic()
    # The orchestrator merges `previous` with freshly computed vectors, only
    # re-running vectors listed in `vectors` (plus any unresolved dependencies).
    result = await asyncio.to_thread(
        orchestrator.run_incremental, tier_data, vectors, previous
    )
    result['_elapsed_ms'] = int((time.monotonic() - t0) * 1000)

    # Persist the merged (old + new) results back to the upload row
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            upload.set_vector_results(result)
            db.commit()
            from app.engines.data_populator import populate_vector_tables
            try:
                populate_vector_tables(db, upload_id, result)
                db.commit()
            except Exception as exc:
                logger.warning("Failed to populate vector tables (incremental): %s", exc)

    return result
