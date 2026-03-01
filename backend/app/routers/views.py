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


def _check_upload(db: Session, upload_id: int) -> Upload:
    """Return the Upload row or raise 404."""
    row = db.query(Upload).filter(Upload.id == upload_id).first()
    if not row:
        raise HTTPException(404, "Upload not found")
    return row


def _json_load(val: str | None):
    """Safe JSON load."""
    if not val:
        return []
    return json.loads(val)


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
    """Explorer detail view — session list with aggregated metrics."""
    _check_upload(db, upload_id)
    q = db.query(VwExplorerDetail).filter(VwExplorerDetail.upload_id == upload_id)
    if tier is not None:
        q = q.filter(VwExplorerDetail.tier == tier)
    if search:
        q = q.filter(VwExplorerDetail.full_name.ilike(f"%{search}%"))

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
    """Write conflicts — tables with multiple writers."""
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
    """Execution order with conflict/chain badges."""
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
    """Sparse session-table matrix with pagination."""
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
    """Table profiles sorted by reference count."""
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
    """Duplicate/similar session groups."""
    _check_upload(db, upload_id)
    groups = (
        db.query(VwDuplicateGroups)
        .filter(VwDuplicateGroups.upload_id == upload_id)
        .order_by(VwDuplicateGroups.member_count.desc())
        .all()
    )
    members = db.query(VwDuplicateMembers).filter(VwDuplicateMembers.upload_id == upload_id).all()

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
    """Constellation chunks, points, and cross-chunk edges."""
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
    """Complexity scores from V11."""
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
    """Wave plan assignments from V4."""
    _check_upload(db, upload_id)
    rows = db.query(VwWaveAssignments).filter(VwWaveAssignments.upload_id == upload_id).all()

    # Group by wave number
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
    """UMAP 2D coordinates from V3."""
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
    """Wave function simulation scores from V9."""
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
    """Concentration analysis groups from V10."""
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

    return {
        "groups": [
            {
                "group_id": g.group_id,
                "medoid_session_id": g.medoid_session_id,
                "core_tables": _json_load(g.core_tables_json),
                "cohesion": g.cohesion,
                "coupling": g.coupling,
                "session_count": g.session_count,
                "members": members_by_group.get(g.group_id, []),
            }
            for g in groups
        ],
    }


# ── Consensus (V8) ───────────────────────────────────────────────────────

@router.get("/consensus")
def get_consensus(
    upload_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Ensemble consensus from V8."""
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
