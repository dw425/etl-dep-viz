"""Layers router — 6-layer progressive disclosure data endpoints.

L1: Enterprise constellation (supernodes)
L2: Domain cluster (sessions within a group)
L3: Workflow neighborhood
L4: Session blueprint
L5: Mapping pipeline
L6: Object detail
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Path, Query

from app.engines.vectors.feature_extractor import (
    FeatureMatrixBuilder,
    extract_session_features,
)
from app.engines.vectors.orchestrator import VectorOrchestrator
from app.engines.vectors.drill_through import DrillThroughEngine

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/layers", tags=["layers"])


@router.post("/L1")
async def enterprise_constellation(
    tier_data: dict[str, Any] = Body(...),
    vector_results: dict[str, Any] | None = Body(None),
):
    """L1: Enterprise constellation — supernodes, superedges, environment summary."""
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain sessions")

    # Run vectors if not provided
    if vector_results is None or "v1_communities" not in vector_results:
        orch = VectorOrchestrator()
        vector_results = await asyncio.to_thread(orch.run_phase1, tier_data)

    v1 = vector_results.get("v1_communities", {})
    v11 = vector_results.get("v11_complexity", {})
    v4 = vector_results.get("v4_wave_plan", {})

    # Build session lookup
    session_map = {s["id"]: s for s in sessions}

    # Supernode graph from V1
    supernode_graph = v1.get("supernode_graph", {"supernodes": [], "superedges": []})

    # Enrich supernodes with complexity stats
    complexity_by_session = {}
    for score in v11.get("scores", []):
        complexity_by_session[score["session_id"]] = score

    for sn in supernode_graph.get("supernodes", []):
        sids = sn.get("session_ids", [])
        complexities = [complexity_by_session.get(sid, {}).get("overall_score", 50.0) for sid in sids]
        sn["avg_complexity"] = round(sum(complexities) / max(len(complexities), 1), 1)
        buckets = [complexity_by_session.get(sid, {}).get("bucket", "Medium") for sid in sids]
        sn["bucket_distribution"] = {
            b: buckets.count(b) for b in ["Simple", "Medium", "Complex", "Very Complex"] if buckets.count(b) > 0
        }

    # Environment summary
    env_summary = {
        "total_sessions": len(sessions),
        "total_groups": len(supernode_graph.get("supernodes", [])),
        "complexity_distribution": v11.get("bucket_distribution", {}),
        "wave_count": len(v4.get("waves", [])),
        "total_hours_low": v11.get("total_hours_low", 0),
        "total_hours_high": v11.get("total_hours_high", 0),
        "cyclic_sessions": v4.get("cyclic_session_count", 0),
    }

    return {
        "layer": 1,
        "supernode_graph": supernode_graph,
        "environment_summary": env_summary,
        "vector_results": vector_results,
    }


@router.post("/L2/{group_id}")
async def domain_cluster(
    group_id: str = Path(...),
    tier_data: dict[str, Any] = Body(...),
    vector_results: dict[str, Any] = Body({}),
):
    """L2: Domain cluster — sessions within one gravity/community group."""
    sessions = tier_data.get("sessions", [])
    session_map = {s["id"]: s for s in sessions}

    # Find sessions in this group
    group_sessions = []
    v1 = vector_results.get("v1_communities", {})
    macro_comms = v1.get("macro_communities", {})

    group_key = group_id.replace("community_", "")
    member_ids = macro_comms.get(group_key, [])

    if not member_ids:
        # Try numeric key
        for k, v in macro_comms.items():
            if k == group_key or f"community_{k}" == group_id:
                member_ids = v
                break

    group_sessions = [session_map[sid] for sid in member_ids if sid in session_map]

    if not group_sessions:
        raise HTTPException(404, f"Group {group_id} not found or empty")

    # Get meso sub-clusters for this group
    meso_comms = v1.get("meso_communities", {})
    sub_clusters: dict[str, list[str]] = {}
    for meso_id, meso_sids in meso_comms.items():
        overlap = [sid for sid in meso_sids if sid in member_ids]
        if overlap:
            sub_clusters[meso_id] = overlap

    # Get complexity scores for group members
    v11 = vector_results.get("v11_complexity", {})
    member_complexity = []
    for score in v11.get("scores", []):
        if score["session_id"] in member_ids:
            member_complexity.append(score)

    # Connections within group
    connections = tier_data.get("connections", [])
    group_connections = [
        c for c in connections
        if c.get("from") in member_ids or c.get("to") in member_ids
    ]

    return {
        "layer": 2,
        "group_id": group_id,
        "sessions": group_sessions,
        "sub_clusters": sub_clusters,
        "connections": group_connections,
        "complexity_scores": member_complexity,
        "session_count": len(group_sessions),
    }


@router.post("/L3/{group_id}/{scope_type}/{scope_id}")
async def workflow_neighborhood(
    group_id: str = Path(...),
    scope_type: str = Path(...),  # "sub_cluster" or "workflow"
    scope_id: str = Path(...),
    tier_data: dict[str, Any] = Body(...),
    vector_results: dict[str, Any] = Body({}),
):
    """L3: Workflow neighborhood — sessions in a sub-cluster or workflow."""
    sessions = tier_data.get("sessions", [])
    session_map = {s["id"]: s for s in sessions}

    # Find sessions in scope
    scope_sids = []
    if scope_type == "sub_cluster":
        v1 = vector_results.get("v1_communities", {})
        meso = v1.get("meso_communities", {})
        scope_sids = meso.get(scope_id, [])
    elif scope_type == "workflow":
        for s in sessions:
            if s.get("full", "").startswith(scope_id):
                scope_sids.append(s["id"])

    scope_sessions = [session_map[sid] for sid in scope_sids if sid in session_map]

    # Wave cascade data
    v9 = vector_results.get("v9_wave_function", {})
    cascade_data = [s for s in v9.get("sessions", []) if s["session_id"] in scope_sids]

    # SCC groups within scope
    v4 = vector_results.get("v4_wave_plan", {})
    scc_groups = [
        g for g in v4.get("scc_groups", [])
        if any(sid in scope_sids for sid in g.get("session_ids", []))
    ]

    connections = tier_data.get("connections", [])
    scope_connections = [
        c for c in connections
        if c.get("from") in scope_sids and c.get("to") in scope_sids
    ]

    return {
        "layer": 3,
        "scope_type": scope_type,
        "scope_id": scope_id,
        "sessions": scope_sessions,
        "connections": scope_connections,
        "cascade_data": cascade_data,
        "scc_groups": scc_groups,
        "session_count": len(scope_sessions),
    }


@router.post("/L4/{session_id}")
async def session_blueprint(
    session_id: str = Path(...),
    tier_data: dict[str, Any] = Body(...),
    vector_results: dict[str, Any] = Body({}),
):
    """L4: Session blueprint — single session exploded view."""
    sessions = tier_data.get("sessions", [])
    session_map = {s["id"]: s for s in sessions}

    session = session_map.get(session_id)
    if not session:
        raise HTTPException(404, f"Session {session_id} not found")

    # Complexity breakdown
    v11 = vector_results.get("v11_complexity", {})
    complexity = None
    for score in v11.get("scores", []):
        if score["session_id"] == session_id:
            complexity = score
            break

    # Wave/criticality data
    v9 = vector_results.get("v9_wave_function", {})
    criticality = None
    for s in v9.get("sessions", []):
        if s["session_id"] == session_id:
            criticality = s
            break

    # Upstream/downstream
    connections = tier_data.get("connections", [])
    upstream = [c for c in connections if c.get("to") == session_id]
    downstream = [c for c in connections if c.get("from") == session_id]

    return {
        "layer": 4,
        "session": session,
        "complexity": complexity,
        "criticality": criticality,
        "upstream_connections": upstream,
        "downstream_connections": downstream,
    }


@router.post("/L5/{session_id}/{mapping_id}")
async def mapping_pipeline(
    session_id: str = Path(...),
    mapping_id: str = Path(...),
    tier_data: dict[str, Any] = Body(...),
):
    """L5: Mapping pipeline — transform pipeline within a session."""
    # This endpoint requires deeper XML parsing data than basic tier_data
    # Returns whatever transform-level detail is available
    sessions = tier_data.get("sessions", [])
    session = next((s for s in sessions if s["id"] == session_id), None)
    if not session:
        raise HTTPException(404, f"Session {session_id} not found")

    return {
        "layer": 5,
        "session_id": session_id,
        "mapping_id": mapping_id,
        "session": session,
        "message": "Detailed mapping pipeline requires extended XML parsing data",
    }


@router.post("/L6/{object_type}/{object_id}")
async def object_detail(
    object_type: str = Path(...),
    object_id: str = Path(...),
    tier_data: dict[str, Any] = Body(...),
):
    """L6: Object detail — table, transform, or expression detail."""
    if object_type == "table":
        tables = tier_data.get("tables", [])
        table = next((t for t in tables if t["id"] == object_id or t.get("name") == object_id), None)
        if not table:
            raise HTTPException(404, f"Table {object_id} not found")

        # Find all sessions that read/write this table
        connections = tier_data.get("connections", [])
        readers = [c["to"] for c in connections if c.get("from") == table["id"] and c.get("type") == "source_read"]
        writers = [c["from"] for c in connections if c.get("to") == table["id"]]

        return {
            "layer": 6,
            "object_type": "table",
            "table": table,
            "readers": readers,
            "writers": writers,
        }

    return {
        "layer": 6,
        "object_type": object_type,
        "object_id": object_id,
        "message": f"Detailed {object_type} view requires extended parsing data",
    }
