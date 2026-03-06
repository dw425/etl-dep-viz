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
import traceback
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.engines.vectors.orchestrator import VectorOrchestrator
from app.models.database import Upload, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/vectors", tags=["vectors"])


def _resolve_tier_data(
    tier_data: dict | None, upload_id: int | None, db: Session,
) -> dict:
    """Resolve tier_data from body or upload_id with DB reconstruction fallback."""
    if tier_data and tier_data.get("sessions"):
        return tier_data
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if not upload:
            from fastapi import HTTPException as _H
            raise _H(404, f"Upload {upload_id} not found")
        td = upload.get_tier_data()
        if td and td.get("sessions"):
            return td
        from app.engines.data_populator import reconstruct_tier_data
        td = reconstruct_tier_data(db, upload_id)
        if td:
            return td
    from fastapi import HTTPException as _H
    raise _H(400, "Either tier_data body or upload_id query param required")


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
    tier_data: dict[str, Any] = Body(None),
    phase: int = Query(1, ge=1, le=3, description="Phase to run (1=core, 2=advanced, 3=all)"),
    upload_id: int | None = Query(None, description="Upload ID to cache results"),
    db: Session = Depends(get_db),
):
    """Run analysis vectors on tier map data (synchronous, no SSE).

    Accepts tier_data in POST body OR upload_id query param (loads from DB).
    """
    tier_data = _resolve_tier_data(tier_data, upload_id, db)
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
    """Retrieve cached vector results for an upload via StreamingResponse.

    Returns the raw JSON string directly from the DB column, avoiding
    a JSON deserialize→re-serialize round-trip that is the bottleneck
    for large datasets (~50MB for 14K sessions).

    Args:
        upload_id: DB primary key of the upload whose vectors to retrieve.
        db: SQLAlchemy session (injected).

    Returns:
        StreamingResponse with application/json content type.

    Raises:
        HTTPException(404): Upload not found or no vector results cached.
    """
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, "Upload not found")
    raw_json = upload.vector_results_json
    if not raw_json:
        raise HTTPException(404, "No vector results cached for this upload")

    def _stream():
        # Yield in 64KB chunks to avoid loading the full string into a single response buffer
        chunk_size = 65536
        for i in range(0, len(raw_json), chunk_size):
            yield raw_json[i:i + chunk_size]

    return StreamingResponse(
        _stream(),
        media_type="application/json",
    )


# ── SSE Streaming Analysis ────────────────────────────────────────────────


@router.post("/analyze-stream")
async def analyze_vectors_stream(
    tier_data: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Run all vector analysis phases with SSE progress streaming.

    Accepts tier_data in POST body OR upload_id query param (loads from DB).
    """
    tier_data = _resolve_tier_data(tier_data, upload_id, db)
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
                        db.rollback()
                        logger.warning("Failed to populate vector tables (stream): %s", exc)

            await queue.put({"phase": "complete", "percent": 100, "result": p3})
        except Exception as exc:
            logger.exception("Vector analysis stream error")
            await queue.put({"phase": "error", "message": str(exc)})

    async def _event_generator():
        """Drain the queue and yield SSE lines; stop on terminal phase.

        Sends heartbeat comments every 15s to keep Databricks reverse proxy alive.
        """
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("phase") in ("complete", "error"):
                    break
            except asyncio.TimeoutError:
                # Send SSE comment as keepalive
                yield ": heartbeat\n\n"

    asyncio.ensure_future(_process())
    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Background Job Endpoints (for proxies with hard connection timeouts) ──

import threading

from app.config import settings as _settings

_bg_jobs: dict[int, dict] = {}  # upload_id -> {state, phase, percent, result, error, start_time}
_bg_lock = threading.Lock()


def _cleanup_stale_jobs() -> int:
    """Remove jobs older than bg_job_ttl_seconds. Returns count removed."""
    now = time.time()
    ttl = _settings.bg_job_ttl_seconds
    with _bg_lock:
        stale = [k for k, v in _bg_jobs.items()
                 if v.get("state") != "running" and (now - v.get("start_time", 0)) > ttl]
        for k in stale:
            del _bg_jobs[k]
    return len(stale)


@router.post("/analyze-background")
async def analyze_vectors_background(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Start vector analysis in background thread. Poll /analyze-status for progress."""
    # Opportunistic cleanup of stale jobs
    _cleanup_stale_jobs()

    with _bg_lock:
        existing = _bg_jobs.get(upload_id)
        if existing and existing.get("state") == "running":
            return {"status": "already_running", "upload_id": upload_id}
        _bg_jobs[upload_id] = {
            "state": "running", "phase": "starting", "percent": 0,
            "start_time": time.time(),
        }

    tier_data = _resolve_tier_data(None, upload_id, db)

    def _run():
        from app.models.database import SessionLocal
        phase_timings: dict[str, float] = {}
        current_phase = "init"
        job_start = time.monotonic()
        session_count = len(tier_data.get("sessions", []))
        logger.info("Vector BG job started: upload_id=%d, sessions=%d", upload_id, session_count)

        try:
            orch = VectorOrchestrator()

            # ── Phase 1 ──
            current_phase = "phase1"
            logger.info("upload_id=%d: Phase 1 (Core) starting", upload_id)
            t0 = time.monotonic()
            with _bg_lock:
                _bg_jobs[upload_id].update(phase="phase1", percent=5, phase_timings=dict(phase_timings))
            p1 = orch.run_phase1(tier_data)
            phase_timings["phase1"] = round(time.monotonic() - t0, 2)
            logger.info("upload_id=%d: Phase 1 complete in %.1fs", upload_id, phase_timings["phase1"])
            with _bg_lock:
                _bg_jobs[upload_id].update(phase="phase1_complete", percent=33, phase_timings=dict(phase_timings))

            # ── Phase 2 ──
            current_phase = "phase2"
            logger.info("upload_id=%d: Phase 2 (Advanced) starting", upload_id)
            t0 = time.monotonic()
            with _bg_lock:
                _bg_jobs[upload_id].update(phase="phase2", percent=35, phase_timings=dict(phase_timings))
            p2 = orch.run_phase2(tier_data, p1)
            phase_timings["phase2"] = round(time.monotonic() - t0, 2)
            logger.info("upload_id=%d: Phase 2 complete in %.1fs", upload_id, phase_timings["phase2"])
            with _bg_lock:
                _bg_jobs[upload_id].update(phase="phase2_complete", percent=66, phase_timings=dict(phase_timings))

            # ── Phase 3 ──
            current_phase = "phase3"
            logger.info("upload_id=%d: Phase 3 (Ensemble) starting", upload_id)
            t0 = time.monotonic()
            with _bg_lock:
                _bg_jobs[upload_id].update(phase="phase3", percent=70, phase_timings=dict(phase_timings))
            p3 = orch.run_phase3(tier_data, p2)
            phase_timings["phase3"] = round(time.monotonic() - t0, 2)
            logger.info("upload_id=%d: Phase 3 complete in %.1fs", upload_id, phase_timings["phase3"])

            # ── Persist to DB ──
            current_phase = "persist"
            t0 = time.monotonic()
            sdb = SessionLocal()
            try:
                upload = sdb.query(Upload).filter(Upload.id == upload_id).first()
                if upload:
                    upload.set_vector_results(p3)
                    sdb.commit()
                    from app.engines.data_populator import populate_vector_tables
                    try:
                        populate_vector_tables(sdb, upload_id, p3)
                        sdb.commit()
                    except Exception as exc:
                        sdb.rollback()
                        logger.warning("Failed to populate vector tables: %s", exc)
            finally:
                sdb.close()
            phase_timings["persist"] = round(time.monotonic() - t0, 2)

            total_time = round(time.monotonic() - job_start, 2)
            phase_timings["total"] = total_time
            vector_keys = sorted(k for k in p3 if k.startswith("v") and not k.startswith("_"))
            logger.info(
                "upload_id=%d: Vector analysis complete in %.1fs — %d vectors, %d sessions",
                upload_id, total_time, len(vector_keys), session_count,
            )

            # Store lightweight summary only — NOT the full 50MB result
            with _bg_lock:
                _bg_jobs[upload_id].update(
                    state="complete", phase="complete", percent=100,
                    phase_timings=dict(phase_timings),
                    summary={
                        "vector_keys": vector_keys,
                        "session_count": session_count,
                        "total_time": total_time,
                        "phase_timings": dict(phase_timings),
                    },
                )
        except Exception as exc:
            total_time = round(time.monotonic() - job_start, 2)
            phase_timings["total"] = total_time
            tb = traceback.format_exc()
            logger.exception(
                "Background vector analysis failed for upload_id=%d in phase=%s after %.1fs",
                upload_id, current_phase, total_time,
            )
            with _bg_lock:
                _bg_jobs[upload_id].update(
                    state="error", phase="error", error=str(exc),
                    phase_timings=dict(phase_timings),
                    error_detail={
                        "message": str(exc),
                        "failed_phase": current_phase,
                        "phase_timings": dict(phase_timings),
                        "traceback": tb[-2000:],  # last 2000 chars
                    },
                )

    threading.Thread(target=_run, daemon=True, name=f"vec-bg-{upload_id}").start()
    return {"status": "started", "upload_id": upload_id}


@router.get("/analyze-status")
async def analyze_vectors_status(upload_id: int = Query(...)):
    """Poll for background vector analysis progress."""
    with _bg_lock:
        job = _bg_jobs.get(upload_id)
        if not job:
            return {"state": "not_found", "upload_id": upload_id}
        resp: dict[str, Any] = {
            "state": job.get("state"),
            "phase": job.get("phase"),
            "percent": job.get("percent"),
            "upload_id": upload_id,
            "phase_timings": job.get("phase_timings", {}),
        }
        if job.get("state") == "complete":
            resp["summary"] = job.get("summary", {})
        elif job.get("state") == "error":
            resp["error"] = job.get("error")
            resp["error_detail"] = job.get("error_detail", {})
    return resp


@router.get("/analyze-result")
async def analyze_vectors_result(upload_id: int = Query(...)):
    """Fetch completed background vector analysis summary.

    Full results are no longer returned here (too large for proxy timeouts).
    Use GET /vectors/results/{upload_id} to stream full results from DB.
    """
    with _bg_lock:
        job = _bg_jobs.get(upload_id)
        if not job or job.get("state") != "complete":
            raise HTTPException(404, "No completed results")
        summary = job.get("summary", {})
        # Clean up after retrieval
        del _bg_jobs[upload_id]
    return {"status": "complete", "upload_id": upload_id, "summary": summary}


# ── Single-Vector Convenience Endpoints ───────────────────────────────────


@router.post("/wave-plan")
async def get_wave_plan(
    tier_data: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Get migration wave plan (V4). Accepts tier_data body or upload_id."""
    tier_data = _resolve_tier_data(tier_data, upload_id, db)
    orchestrator = VectorOrchestrator()
    result = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    return result.get("v4_wave_plan", {})


@router.post("/complexity")
async def get_complexity(
    tier_data: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Get complexity breakdown (V11). Accepts tier_data body or upload_id."""
    tier_data = _resolve_tier_data(tier_data, upload_id, db)
    orchestrator = VectorOrchestrator()
    result = await asyncio.to_thread(orchestrator.run_phase1, tier_data)
    return result.get("v11_complexity", {})


# ── What-If Simulation ────────────────────────────────────────────────────


@router.post("/what-if/{session_id}")
async def what_if_simulation(
    session_id: str,
    tier_data: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Run what-if failure simulation. Accepts tier_data body or upload_id."""
    tier_data = _resolve_tier_data(tier_data, upload_id, db)
    sessions = tier_data.get("sessions", [])

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
    tier_data: dict[str, Any] = Body(None),
    vectors: list[str] = Query(
        default=[],
        description="Specific vectors to run (empty = all for phase)",
    ),
    phase: int = Query(3, ge=1, le=3),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Run selected vectors only. Accepts tier_data body or upload_id."""
    tier_data = _resolve_tier_data(tier_data, upload_id, db)
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
                db.rollback()
                logger.warning("Failed to populate vector tables (selective): %s", exc)

    return result


@router.post("/sweep-resolution")
async def sweep_resolution(
    tier_data: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Sweep V1 community detection resolution. Accepts tier_data body or upload_id."""
    tier_data = _resolve_tier_data(tier_data, upload_id, db)
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain at least one session")

    orchestrator = VectorOrchestrator()
    result = await asyncio.to_thread(orchestrator.sweep_resolution, tier_data)
    return result


@router.post("/analyze-incremental")
async def analyze_incremental(
    tier_data: dict[str, Any] = Body(None),
    vectors: list[str] = Query(
        default=[],
        description="Specific vector keys to (re-)run",
    ),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Incrementally run specified vectors. Accepts tier_data body or upload_id."""
    tier_data = _resolve_tier_data(tier_data, upload_id, db)
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
                db.rollback()
                logger.warning("Failed to populate vector tables (incremental): %s", exc)

    return result
