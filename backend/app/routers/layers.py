"""Layers router — 6-layer progressive disclosure data endpoints.

Each layer exposes a progressively deeper slice of the ETL dependency graph:
  L1 (Enterprise)   — high-level supernode graph; one node per community cluster
  L2 (Domain)       — all sessions inside one L1 community, with meso sub-clusters
  L3 (Workflow)     — sessions inside a sub-cluster or named workflow scope
  L4 (Session)      — single session exploded: complexity, criticality, direct connections
  L5 (Mapping)      — transform pipeline inside a session/mapping (requires deep XML data)
  L6 (Object)       — individual table or transform object detail

Clients drill down from L1 → L6; each layer accepts the full tier_data body plus
optional vector_results so the API stays stateless (no server-side session needed).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session as DBSession

from app.engines.vectors.feature_extractor import (
    FeatureMatrixBuilder,
    extract_session_features,
)
from app.engines.vectors.orchestrator import VectorOrchestrator
from app.engines.vectors.drill_through import DrillThroughEngine
from app.models.database import Upload, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/layers", tags=["layers"])


def _load_from_upload(upload_id: int, db: DBSession) -> tuple[dict, dict]:
    """Load tier_data and vector_results from DB by upload_id."""
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(404, f"Upload {upload_id} not found")
    tier_data = upload.get_tier_data() or {}
    vector_results = upload.get_vector_results() or {}
    return tier_data, vector_results


@router.post("/L1")
async def enterprise_constellation(
    tier_data: dict[str, Any] = Body(None),
    vector_results: dict[str, Any] | None = Body(None),
    upload_id: int | None = Query(None),
    db: DBSession = Depends(get_db),
):
    """L1: Enterprise constellation — supernodes, superedges, environment summary."""
    if upload_id and not tier_data:
        tier_data, vector_results = _load_from_upload(upload_id, db)
    if not tier_data:
        raise HTTPException(400, "Either tier_data body or upload_id query param required")
    sessions = tier_data.get("sessions", [])
    if not sessions:
        raise HTTPException(400, "tier_data must contain sessions")

    # Auto-run Phase 1 vectors if not supplied by the caller (lazy bootstrap)
    if vector_results is None or "v1_communities" not in vector_results:
        orch = VectorOrchestrator()
        vector_results = await asyncio.to_thread(orch.run_phase1, tier_data)

    v1 = vector_results.get("v1_communities", {})
    v11 = vector_results.get("v11_complexity", {})
    v4 = vector_results.get("v4_wave_plan", {})

    session_map = {s["id"]: s for s in sessions}

    # The V1 engine pre-builds the supernode graph; use it directly for L1
    supernode_graph = v1.get("supernode_graph", {"supernodes": [], "superedges": []})

    # ── Enrich each supernode with aggregated complexity metrics from V11 ──
    complexity_by_session = {}
    for score in v11.get("scores", []):
        complexity_by_session[score["session_id"]] = score

    for sn in supernode_graph.get("supernodes", []):
        sids = sn.get("session_ids", [])
        # Average complexity score across all member sessions; default 50 if no data
        complexities = [complexity_by_session.get(sid, {}).get("overall_score", 50.0) for sid in sids]
        sn["avg_complexity"] = round(sum(complexities) / max(len(complexities), 1), 1)
        buckets = [complexity_by_session.get(sid, {}).get("bucket", "Medium") for sid in sids]
        # Count how many sessions fall into each complexity bucket for the donut chart
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
    tier_data: dict[str, Any] = Body(None),
    vector_results: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: DBSession = Depends(get_db),
):
    """L2: Domain cluster — sessions within one gravity/community group."""
    if upload_id and not tier_data:
        tier_data, vector_results = _load_from_upload(upload_id, db)
    tier_data = tier_data or {}
    vector_results = vector_results or {}
    sessions = tier_data.get("sessions", [])
    session_map = {s["id"]: s for s in sessions}

    # ── Resolve group_id to its member session list ──
    # Community keys may be stored as plain integers or with a "community_" prefix;
    # strip the prefix and try both forms.
    group_sessions = []
    v1 = vector_results.get("v1_communities", {})
    macro_comms = v1.get("macro_communities", {})

    group_key = group_id.replace("community_", "")
    member_ids = macro_comms.get(group_key, [])

    if not member_ids:
        # Fallback: scan all community keys for a match (handles integer keys)
        for k, v in macro_comms.items():
            if k == group_key or f"community_{k}" == group_id:
                member_ids = v
                break

    group_sessions = [session_map[sid] for sid in member_ids if sid in session_map]

    if not group_sessions:
        raise HTTPException(404, f"Group {group_id} not found or empty")

    # ── Find meso-level sub-clusters that intersect with this group ──
    # Meso communities provide finer-grained groupings within the macro community.
    meso_comms = v1.get("meso_communities", {})
    sub_clusters: dict[str, list[str]] = {}
    for meso_id, meso_sids in meso_comms.items():
        overlap = [sid for sid in meso_sids if sid in member_ids]
        if overlap:
            sub_clusters[meso_id] = overlap

    # Filter V11 complexity scores to only the sessions in this group
    v11 = vector_results.get("v11_complexity", {})
    member_complexity = []
    for score in v11.get("scores", []):
        if score["session_id"] in member_ids:
            member_complexity.append(score)

    # Include connections where at least one endpoint is in this group
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
    tier_data: dict[str, Any] = Body(None),
    vector_results: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: DBSession = Depends(get_db),
):
    """L3: Workflow neighborhood — sessions in a sub-cluster or workflow."""
    if upload_id and not tier_data:
        tier_data, vector_results = _load_from_upload(upload_id, db)
    tier_data = tier_data or {}
    vector_results = vector_results or {}
    sessions = tier_data.get("sessions", [])
    session_map = {s["id"]: s for s in sessions}

    # ── Resolve scope to a list of session IDs ──
    scope_sids = []
    if scope_type == "sub_cluster":
        # Meso community key → member session IDs
        v1 = vector_results.get("v1_communities", {})
        meso = v1.get("meso_communities", {})
        scope_sids = meso.get(scope_id, [])
    elif scope_type == "workflow":
        # Match by the fully-qualified workflow path prefix stored in session["full"]
        for s in sessions:
            if s.get("full", "").startswith(scope_id):
                scope_sids.append(s["id"])

    scope_sessions = [session_map[sid] for sid in scope_sids if sid in session_map]

    # V9 wave cascade data for scope members (failure propagation risk)
    v9 = vector_results.get("v9_wave_function", {})
    cascade_data = [s for s in v9.get("sessions", []) if s["session_id"] in scope_sids]

    # Strongly-connected components that overlap with the scope (cyclic dependency groups)
    v4 = vector_results.get("v4_wave_plan", {})
    scc_groups = [
        g for g in v4.get("scc_groups", [])
        if any(sid in scope_sids for sid in g.get("session_ids", []))
    ]

    # Only include connections where both endpoints are within the scope (internal edges)
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
    tier_data: dict[str, Any] = Body(None),
    vector_results: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: DBSession = Depends(get_db),
):
    """L4: Session blueprint — single session exploded view."""
    if upload_id and not tier_data:
        tier_data, vector_results = _load_from_upload(upload_id, db)
    tier_data = tier_data or {}
    vector_results = vector_results or {}
    sessions = tier_data.get("sessions", [])
    session_map = {s["id"]: s for s in sessions}

    session = session_map.get(session_id)
    if not session:
        raise HTTPException(404, f"Session {session_id} not found")

    # Scan V11 scores list for this session's complexity entry (linear, list is not indexed)
    v11 = vector_results.get("v11_complexity", {})
    complexity = None
    for score in v11.get("scores", []):
        if score["session_id"] == session_id:
            complexity = score
            break

    # Scan V9 results for this session's wave/failure-propagation criticality score
    v9 = vector_results.get("v9_wave_function", {})
    criticality = None
    for s in v9.get("sessions", []):
        if s["session_id"] == session_id:
            criticality = s
            break

    # Direct upstream = connections that target this session
    # Direct downstream = connections that originate from this session
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
    tier_data: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: DBSession = Depends(get_db),
):
    """L5: Mapping pipeline — transform pipeline within a session."""
    if upload_id and not tier_data:
        tier_data, _ = _load_from_upload(upload_id, db)
    tier_data = tier_data or {}
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
    tier_data: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: DBSession = Depends(get_db),
):
    """L6: Object detail — table, transform, or expression detail."""
    if upload_id and not tier_data:
        tier_data, _ = _load_from_upload(upload_id, db)
    tier_data = tier_data or {}
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


@router.post("/flow/{session_id}")
async def flow_walker(
    session_id: str = Path(...),
    tier_data: dict[str, Any] = Body(None),
    vector_results: dict[str, Any] = Body(None),
    upload_id: int | None = Query(None),
    db: DBSession = Depends(get_db),
):
    """End-to-end flow walker — upstream/downstream chains, mapping pipeline, tables touched."""
    if upload_id and not tier_data:
        tier_data, vector_results = _load_from_upload(upload_id, db)
    tier_data = tier_data or {}
    vector_results = vector_results or {}
    sessions = tier_data.get("sessions", [])
    session_map = {s["id"]: s for s in sessions}
    connections = tier_data.get("connections", [])
    tables = tier_data.get("tables", [])
    table_map = {t["id"]: t for t in tables}

    session = session_map.get(session_id)
    if not session:
        raise HTTPException(404, f"Session {session_id} not found")

    # ── Build lookup indices for the recursive traversal ──
    # The connection graph is bipartite: sessions (S*) connect to tables (T*).
    # To walk upstream/downstream we need the reverse mappings:
    #   writes_to[table_id]  → which sessions write to this table
    #   reads_from[table_id] → which sessions read from this table
    writes_to: dict[str, list[str]] = {}      # table_id → [session_ids that write]
    reads_from: dict[str, list[str]] = {}     # table_id → [session_ids that read]
    for c in connections:
        frm, to, ctype = c.get("from", ""), c.get("to", ""), c.get("type", "")
        if frm.startswith("S") and to.startswith("T"):
            writes_to.setdefault(to, []).append(frm)
        elif frm.startswith("T") and to.startswith("S"):
            reads_from.setdefault(frm, []).append(to)

    # ── Recursive upstream walker ──
    # For session `sid`: find every table it reads, then find every session that
    # writes to that table — those are the upstream producers.  Recurse into each.
    # `visited` prevents infinite loops in cyclic graphs.
    def _upstream(sid: str, visited: set[str] | None = None) -> list[dict]:
        if visited is None:
            visited = set()
        if sid in visited:
            return []
        visited.add(sid)
        result = []
        s = session_map.get(sid)
        if not s:
            return []
        for c in connections:
            if c.get("to") == sid and c.get("from", "").startswith("T"):
                table_id = c["from"]
                for writer_sid in writes_to.get(table_id, []):
                    if writer_sid != sid and writer_sid not in visited:
                        ws = session_map.get(writer_sid)
                        if ws:
                            result.append({
                                "session_id": writer_sid,
                                "name": ws.get("full", ws.get("name", "")),
                                "tier": ws.get("tier"),
                                "via_table": table_map.get(table_id, {}).get("name", table_id),
                            })
                            result.extend(_upstream(writer_sid, visited))
        return result

    # ── Recursive downstream walker ──
    # Mirror of _upstream: for each table this session writes to, find every
    # session that reads from it — those are the downstream consumers.
    def _downstream(sid: str, visited: set[str] | None = None) -> list[dict]:
        if visited is None:
            visited = set()
        if sid in visited:
            return []
        visited.add(sid)
        result = []
        s = session_map.get(sid)
        if not s:
            return []
        for c in connections:
            if c.get("from") == sid and c.get("to", "").startswith("T"):
                table_id = c["to"]
                for reader_sid in reads_from.get(table_id, []):
                    if reader_sid != sid and reader_sid not in visited:
                        rs = session_map.get(reader_sid)
                        if rs:
                            result.append({
                                "session_id": reader_sid,
                                "name": rs.get("full", rs.get("name", "")),
                                "tier": rs.get("tier"),
                                "via_table": table_map.get(table_id, {}).get("name", table_id),
                            })
                            result.extend(_downstream(reader_sid, visited))
        return result

    upstream = _upstream(session_id)
    downstream = _downstream(session_id)

    # ── Collect all tables read or written by this session ──
    tables_touched = []
    for c in connections:
        if c.get("from") == session_id and c.get("to", "").startswith("T"):
            t = table_map.get(c["to"])
            if t:
                tables_touched.append({**t, "relation": "writes"})
        elif c.get("to") == session_id and c.get("from", "").startswith("T"):
            t = table_map.get(c["from"])
            if t:
                tables_touched.append({**t, "relation": "reads"})

    # Look up this session's V11 complexity score (used for effort estimation)
    v11 = vector_results.get("v11_complexity", {})
    complexity = None
    for score in v11.get("scores", []):
        if score["session_id"] == session_id:
            complexity = score
            break

    # Find which migration wave this session belongs to (V4 topological ordering)
    v4 = vector_results.get("v4_wave_plan", {})
    wave_info = None
    for w in v4.get("waves", []):
        if session_id in w.get("session_ids", []):
            wave_info = {"wave": w.get("wave"), "session_ids": w.get("session_ids", [])}
            break

    # Check if session is part of a strongly-connected component (cyclic dependency)
    scc = None
    for g in v4.get("scc_groups", []):
        if session_id in g.get("session_ids", []):
            scc = g
            break

    # Build mapping_detail — use parsed detail if available, else build minimal from session data
    mapping_detail = session.get("mapping_detail")
    if not mapping_detail:
        # Build minimal mapping detail from session's sources/targets/lookups
        instances = []
        for src in session.get("sources", []):
            instances.append({"name": src, "transformation_name": src, "type": "Source", "transformation_type": "Source Definition"})
        for tgt in session.get("targets", []):
            instances.append({"name": tgt, "transformation_name": tgt, "type": "Target", "transformation_type": "Target Definition"})
        for lkp in session.get("lookups", []):
            instances.append({"name": lkp, "transformation_name": lkp, "type": "Lookup", "transformation_type": "Lookup Procedure"})
        if instances:
            mapping_detail = {"instances": instances, "connectors": [], "fields": []}

    return {
        "session": session,
        "upstream": upstream,
        "downstream": downstream,
        "mapping_detail": mapping_detail,
        "tables_touched": tables_touched,
        "complexity": complexity,
        "wave_info": wave_info,
        "scc": scc,
        "upstream_count": len(upstream),
        "downstream_count": len(downstream),
    }
