"""Per-view API endpoints — each view queries its own materialized table.

All endpoints accept `upload_id` as a required query parameter and return
pre-computed data from the per-view materialized tables. Falls back to
JSON blob reconstruction for legacy uploads without materialized rows.
"""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.models.database import (
    Upload,
    VwComplexityScores,
    VwCommunities,
    VwConcentrationGroups,
    VwConcentrationMembers,
    VwConstellationChunks,
    VwConstellationEdges,
    VwConstellationPoints,
    VwDuplicateGroups,
    VwDuplicateMembers,
    VwEnsemble,
    VwExecOrder,
    VwExplorerDetail,
    VwGalaxyNodes,
    VwMatrixCells,
    VwReadChains,
    VwTableProfiles,
    VwTierLayout,
    VwUmapCoords,
    VwWaveAssignments,
    VwWaveFunction,
    VwWriteConflicts,
    get_db,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/views", tags=["views"])


# ── Helpers ───────────────────────────────────────────────────────────────


def _check_upload(db: Session, upload_id: int) -> Upload:
    """Return the Upload row or raise 404.

    Called at the start of every view endpoint to validate the upload exists.
    """
    row = db.query(Upload).filter(Upload.id == upload_id).first()
    if not row:
        raise HTTPException(404, "Upload not found")
    return row


def _json_load(val: str | None):
    """Safe JSON load — returns empty list for None/empty/null columns.

    Many view table columns store lists as JSON strings; this helper
    avoids repeated None-checks at every call site.
    """
    if not val or val == 'null':
        return []
    try:
        parsed = json.loads(val)
        return parsed if parsed is not None else []
    except (json.JSONDecodeError, TypeError):
        return []


# ── Explorer ──────────────────────────────────────────────────────────────

@router.get("/explorer")
def get_explorer(
    upload_id: int = Query(...),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    tier: float | None = Query(None),
    search: str | None = Query(None),
    sort: str = Query("tier"),
    db: Session = Depends(get_db),
):
    """Explorer detail view — paginated session list with aggregated metrics.

    Supports filtering by tier, text search on full_name, and dynamic sort column.

    Args:
        upload_id: Required — DB primary key of the upload.
        offset: Pagination offset.
        limit: Page size (1-500, default 100).
        tier: Optional filter by tier number.
        search: Optional substring match on session full_name.
        sort: Column name to sort by (default 'tier').
        db: SQLAlchemy session (injected).

    Returns:
        Dict with total, offset, limit, and sessions list.
    """
    _check_upload(db, upload_id)
    q = db.query(VwExplorerDetail).filter(VwExplorerDetail.upload_id == upload_id)
    if tier is not None:
        q = q.filter(VwExplorerDetail.tier == tier)
    if search:
        q = q.filter(VwExplorerDetail.full_name.ilike(f"%{search}%"))

    ALLOWED_SORTS = {'tier', 'step', 'full_name', 'transforms', 'ext_reads', 'lookup_count', 'name', 'conflict_count', 'chain_count', 'total_connections'}
    if sort not in ALLOWED_SORTS:
        raise HTTPException(400, f"Invalid sort: {sort}. Allowed: {', '.join(sorted(ALLOWED_SORTS))}")
    sort_col = getattr(VwExplorerDetail, sort, VwExplorerDetail.tier)
    total = q.count()
    rows = q.order_by(sort_col).offset(offset).limit(limit).all()

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "sessions": [
            {
                "session_id": r.session_id,
                "name": r.name,
                "full_name": r.full_name,
                "tier": r.tier,
                "step": r.step,
                "workflow": r.workflow,
                "transforms": r.transforms,
                "ext_reads": r.ext_reads,
                "lookup_count": r.lookup_count,
                "is_critical": bool(r.is_critical),
                "write_targets": _json_load(r.write_targets_json),
                "read_sources": _json_load(r.read_sources_json),
                "lookup_tables": _json_load(r.lookup_tables_json),
                "conflict_count": r.conflict_count,
                "chain_count": r.chain_count,
                "total_connections": r.total_connections,
            }
            for r in rows
        ],
    }


# ── Conflicts ─────────────────────────────────────────────────────────────

@router.get("/conflicts")
def get_conflicts(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Write conflicts and read-after-write chains.

    Write conflicts: tables written by more than one session (potential race conditions).
    Read chains: tables where a writer's output is read by another session (ordering dependency).

    Args:
        upload_id: Required upload ID.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with write_conflicts and read_chains lists.
    """
    _check_upload(db, upload_id)
    conflicts = db.query(VwWriteConflicts).filter(VwWriteConflicts.upload_id == upload_id).all()
    chains = db.query(VwReadChains).filter(VwReadChains.upload_id == upload_id).all()

    return {
        "write_conflicts": [
            {
                "table_name": r.table_name,
                "table_id": r.table_id,
                "writer_count": r.writer_count,
                "writer_sessions": _json_load(r.writer_sessions_json),
            }
            for r in conflicts
        ],
        "read_chains": [
            {
                "table_name": r.table_name,
                "table_id": r.table_id,
                "writer_sessions": _json_load(r.writer_sessions_json),
                "reader_sessions": _json_load(r.reader_sessions_json),
                "chain_length": r.chain_length,
            }
            for r in chains
        ],
    }


# ── Exec Order ────────────────────────────────────────────────────────────

@router.get("/exec-order")
def get_exec_order(
    upload_id: int = Query(...),
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    """Execution order — sessions sorted by topological position, with conflict/chain badges.

    Args:
        upload_id: Required upload ID.
        offset: Pagination offset.
        limit: Page size (1-1000, default 200).
        db: SQLAlchemy session (injected).

    Returns:
        Dict with total, offset, limit, and sessions list ordered by position.
    """
    _check_upload(db, upload_id)
    q = db.query(VwExecOrder).filter(VwExecOrder.upload_id == upload_id)
    total = q.count()
    rows = q.order_by(VwExecOrder.position).offset(offset).limit(limit).all()

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "sessions": [
            {
                "position": r.position,
                "session_id": r.session_id,
                "name": r.name,
                "full_name": r.full_name,
                "tier": r.tier,
                "step": r.step,
                "has_conflict": bool(r.has_conflict),
                "has_chain": bool(r.has_chain),
                "write_targets": _json_load(r.write_targets_json),
            }
            for r in rows
        ],
    }


# ── Matrix ────────────────────────────────────────────────────────────────

@router.get("/matrix")
def get_matrix(
    upload_id: int = Query(...),
    page: int = Query(0, ge=0),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Sparse session-table matrix with page-based pagination.

    Each cell represents a connection between a session and a table,
    with conn_type indicating the relationship (write, read, lookup, etc.).

    Args:
        upload_id: Required upload ID.
        page: Zero-indexed page number.
        page_size: Cells per page (1-200, default 50).
        db: SQLAlchemy session (injected).

    Returns:
        Dict with total, page, page_size, and cells list.
    """
    _check_upload(db, upload_id)
    q = db.query(VwMatrixCells).filter(VwMatrixCells.upload_id == upload_id)
    total = q.count()
    rows = q.offset(page * page_size).limit(page_size).all()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "cells": [
            {
                "session_id": r.session_id,
                "table_id": r.table_id,
                "session_name": r.session_name,
                "table_name": r.table_name,
                "conn_type": r.conn_type,
            }
            for r in rows
        ],
    }


# ── Tables ────────────────────────────────────────────────────────────────

@router.get("/tables")
def get_tables(
    upload_id: int = Query(...),
    sort: str = Query("total_refs"),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    """Table profiles sorted by reference count (most-referenced tables first).

    Each table profile includes writer/reader/lookup counts and the session IDs
    that interact with it. Used by the Tables view for hotspot analysis.

    Args:
        upload_id: Required upload ID.
        sort: Column to sort by (default 'total_refs', descending).
        limit: Max rows to return (1-1000, default 100).
        db: SQLAlchemy session (injected).

    Returns:
        Dict with tables list.
    """
    _check_upload(db, upload_id)
    sort_col = getattr(VwTableProfiles, sort, VwTableProfiles.total_refs)
    rows = (
        db.query(VwTableProfiles)
        .filter(VwTableProfiles.upload_id == upload_id)
        .order_by(sort_col.desc())
        .limit(limit)
        .all()
    )

    return {
        "tables": [
            {
                "table_id": r.table_id,
                "table_name": r.table_name,
                "type": r.type,
                "tier": r.tier,
                "writer_count": r.writer_count,
                "reader_count": r.reader_count,
                "lookup_count": r.lookup_count,
                "total_refs": r.total_refs,
                "writers": _json_load(r.writers_json),
                "readers": _json_load(r.readers_json),
                "lookup_users": _json_load(r.lookup_users_json),
            }
            for r in rows
        ],
    }


# ── Duplicates ────────────────────────────────────────────────────────────

@router.get("/duplicates")
def get_duplicates(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Duplicate/similar session groups (sorted by member count, largest first).

    Groups are identified by fingerprint similarity. Each group contains
    members with their source/target/lookup lists for comparison.

    Args:
        upload_id: Required upload ID.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with groups list, each containing members sub-list.
    """
    _check_upload(db, upload_id)
    groups = (
        db.query(VwDuplicateGroups)
        .filter(VwDuplicateGroups.upload_id == upload_id)
        .order_by(VwDuplicateGroups.member_count.desc())
        .all()
    )
    members = db.query(VwDuplicateMembers).filter(VwDuplicateMembers.upload_id == upload_id).all()

    # Index members by group_id for O(1) lookup when building the response
    members_by_group = {}
    for m in members:
        members_by_group.setdefault(m.group_id, []).append({
            "session_id": m.session_id,
            "name": m.name,
            "full_name": m.full_name,
            "sources": _json_load(m.sources_json),
            "targets": _json_load(m.targets_json),
            "lookups": _json_load(m.lookups_json),
        })

    return {
        "groups": [
            {
                "group_id": g.group_id,
                "match_type": g.match_type,
                "fingerprint": g.fingerprint,
                "similarity": g.similarity,
                "member_count": g.member_count,
                "members": members_by_group.get(g.group_id, []),
            }
            for g in groups
        ],
    }


# ── Constellation ─────────────────────────────────────────────────────────

@router.get("/constellation")
def get_constellation(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Constellation chunks, points, and cross-chunk edges.

    Returns the three components of the constellation visualization:
    - chunks: cluster summaries with labels, session counts, and pivot tables.
    - points: individual session positions with x/y coordinates for scatterplot.
    - edges: inter-chunk connections showing data flow between clusters.

    Args:
        upload_id: Required upload ID.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with chunks, points, and edges lists.
    """
    _check_upload(db, upload_id)
    chunks = db.query(VwConstellationChunks).filter(VwConstellationChunks.upload_id == upload_id).all()
    points = db.query(VwConstellationPoints).filter(VwConstellationPoints.upload_id == upload_id).all()
    edges = db.query(VwConstellationEdges).filter(VwConstellationEdges.upload_id == upload_id).all()

    return {
        "chunks": [
            {
                "chunk_id": c.chunk_id,
                "label": c.label,
                "algorithm": c.algorithm,
                "session_count": c.session_count,
                "table_count": c.table_count,
                "tier_min": c.tier_min,
                "tier_max": c.tier_max,
                "pivot_tables": _json_load(c.pivot_tables_json),
                "session_ids": _json_load(c.session_ids_json),
                "table_names": _json_load(c.table_names_json),
                "conflict_count": c.conflict_count,
                "chain_count": c.chain_count,
                "critical_count": c.critical_count,
                "color": c.color,
            }
            for c in chunks
        ],
        "points": [
            {
                "session_id": p.session_id,
                "chunk_id": p.chunk_id,
                "x": p.x,
                "y": p.y,
                "tier": p.tier,
                "is_critical": bool(p.is_critical),
                "name": p.name,
            }
            for p in points
        ],
        "edges": [
            {"from_chunk": e.from_chunk, "to_chunk": e.to_chunk, "count": e.count}
            for e in edges
        ],
    }


# ── Complexity (V11) ─────────────────────────────────────────────────────

@router.get("/complexity")
def get_complexity(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Complexity scores from V11 vector engine.

    Each session gets an 8-dimension complexity score (d1-d8), an overall
    score, a bucket label, and an effort estimate in hours.

    Args:
        upload_id: Required upload ID.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with scores list.
    """
    _check_upload(db, upload_id)
    rows = db.query(VwComplexityScores).filter(VwComplexityScores.upload_id == upload_id).all()

    return {
        "scores": [
            {
                "session_id": r.session_id,
                "name": r.name,
                "tier": r.tier,
                "overall_score": r.overall_score,
                "bucket": r.bucket,
                "dimensions_raw": {
                    f"d{i}": getattr(r, f"d{i}_raw", 0) for i in range(1, 9)
                },
                "dimensions_normalized": {
                    f"d{i}": getattr(r, f"d{i}_norm", 0) for i in range(1, 9)
                },
                "hours_low": r.hours_low,
                "hours_high": r.hours_high,
                "top_drivers": _json_load(r.top_drivers_json),
            }
            for r in rows
        ],
    }


# ── Waves (V4) ───────────────────────────────────────────────────────────

@router.get("/waves")
def get_waves(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Wave plan assignments from V4 topological sort.

    Sessions are grouped by migration wave number. Sessions in the same
    wave can be migrated in parallel; wave N depends on wave N-1.

    Args:
        upload_id: Required upload ID.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with waves list, each containing its member sessions.
    """
    _check_upload(db, upload_id)
    rows = db.query(VwWaveAssignments).filter(VwWaveAssignments.upload_id == upload_id).all()

    # Group flat session rows into nested wave dicts keyed by wave_number
    waves = {}
    for r in rows:
        w = r.wave_number
        if w not in waves:
            waves[w] = {"wave": w, "sessions": []}
        waves[w]["sessions"].append({
            "session_id": r.session_id,
            "name": r.name,
            "scc_group_id": r.scc_group_id,
            "is_cycle": bool(r.is_cycle),
        })

    return {"waves": sorted(waves.values(), key=lambda w: w["wave"])}


# ── UMAP (V3) ────────────────────────────────────────────────────────────

@router.get("/umap")
def get_umap(
    upload_id: int = Query(...),
    scale: str = Query("balanced"),
    db: Session = Depends(get_db),
):
    """UMAP 2D coordinates from V3 centrality/projection vector.

    Returns (x, y) scatter points for each session, optionally filtered by
    scale preset ('balanced', 'spread', 'tight').

    Args:
        upload_id: Required upload ID.
        scale: UMAP scale preset to filter by (default 'balanced').
        db: SQLAlchemy session (injected).

    Returns:
        Dict with points list.
    """
    _check_upload(db, upload_id)
    q = db.query(VwUmapCoords).filter(VwUmapCoords.upload_id == upload_id)
    if scale:
        q = q.filter(VwUmapCoords.scale == scale)
    rows = q.all()

    return {
        "points": [
            {
                "session_id": r.session_id,
                "x": r.x,
                "y": r.y,
                "cluster_id": r.cluster_id,
                "scale": r.scale,
            }
            for r in rows
        ],
    }


# ── Simulator (V9) ───────────────────────────────────────────────────────

@router.get("/simulator")
def get_simulator(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Wave function simulation scores from V9.

    Each session has a blast_radius (how many sessions would be impacted
    by its failure), chain_depth, criticality_score, and criticality_tier.

    Args:
        upload_id: Required upload ID.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with sessions list.
    """
    _check_upload(db, upload_id)
    rows = db.query(VwWaveFunction).filter(VwWaveFunction.upload_id == upload_id).all()

    return {
        "sessions": [
            {
                "session_id": r.session_id,
                "name": r.name,
                "blast_radius": r.blast_radius,
                "chain_depth": r.chain_depth,
                "criticality_score": r.criticality_score,
                "amplification_factor": r.amplification_factor,
                "criticality_tier": r.criticality_tier,
            }
            for r in rows
        ],
    }


# ── Concentration (V10) ──────────────────────────────────────────────────

@router.get("/concentration")
def get_concentration(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Concentration analysis groups from V10.

    Groups sessions by shared table-access patterns. Each group has a medoid
    (representative session), cohesion/coupling metrics, and member details
    including independence type and confidence.

    Args:
        upload_id: Required upload ID.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with groups list, each containing members sub-list.
    """
    _check_upload(db, upload_id)
    groups = db.query(VwConcentrationGroups).filter(VwConcentrationGroups.upload_id == upload_id).all()
    members = db.query(VwConcentrationMembers).filter(VwConcentrationMembers.upload_id == upload_id).all()

    members_by_group = {}
    for m in members:
        members_by_group.setdefault(m.group_id, []).append({
            "session_id": m.session_id,
            "is_medoid": bool(m.is_medoid),
            "independence_type": m.independence_type,
            "confidence": m.confidence,
        })

    # Build gravity_groups in the shape the frontend ConcentrationResult expects
    gravity_groups = []
    independent_sessions = []
    for g in groups:
        group_members = members_by_group.get(g.group_id, [])
        session_ids = [m["session_id"] for m in group_members]
        gravity_groups.append({
            "group_id": g.group_id,
            "medoid_session_id": g.medoid_session_id,
            "session_ids": session_ids,
            "core_tables": _json_load(g.core_tables_json),
            "signature_transforms": [],
            "cohesion": g.cohesion,
            "coupling": g.coupling,
            "session_count": g.session_count,
            "members": group_members,
        })
        # Collect independent sessions from members
        for m in group_members:
            if m.get("independence_type") in ("full", "near"):
                independent_sessions.append(m)

    return {
        "gravity_groups": gravity_groups,
        "independent_sessions": independent_sessions,
        "optimal_k": len(groups),
        "silhouette": 0,
    }


# ── Consensus (V8) ───────────────────────────────────────────────────────

@router.get("/consensus")
def get_consensus(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Ensemble consensus from V8.

    Combines clustering results from multiple vectors (V5-V7) into a
    consensus assignment. Sessions flagged as 'contested' have disagreement
    between the underlying clustering methods.

    Args:
        upload_id: Required upload ID.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with assignments list.
    """
    _check_upload(db, upload_id)
    rows = db.query(VwEnsemble).filter(VwEnsemble.upload_id == upload_id).all()

    return {
        "assignments": [
            {
                "session_id": r.session_id,
                "consensus_cluster": r.consensus_cluster,
                "consensus_score": r.consensus_score,
                "per_vector": _json_load(r.per_vector_json),
                "is_contested": bool(r.is_contested),
            }
            for r in rows
        ],
    }
