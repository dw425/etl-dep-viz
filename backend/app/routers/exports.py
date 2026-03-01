"""Exports router — download tier data in various formats.

Items: 59 (lineage export), 81 (PDF), 82 (Excel), 83 (JIRA), 84 (Databricks), 89 (snapshot).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, Depends
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from app.models.database import Upload, get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/exports", tags=["exports"])


# ── Lineage Exports (Item 59) ─────────────────────────────────────────────

@router.post("/lineage/dot")
async def export_lineage_dot(tier_data: dict[str, Any] = Body(...)):
    """Export lineage graph as Graphviz DOT format."""
    from app.routers.lineage import _build_lineage_graph
    from app.exports.lineage_export import lineage_to_dot

    graph = _build_lineage_graph(tier_data)
    dot = lineage_to_dot(graph)
    return Response(
        content=dot,
        media_type="text/vnd.graphviz",
        headers={"Content-Disposition": "attachment; filename=lineage.dot"},
    )


@router.post("/lineage/mermaid")
async def export_lineage_mermaid(tier_data: dict[str, Any] = Body(...)):
    """Export lineage graph as Mermaid flowchart format."""
    from app.routers.lineage import _build_lineage_graph
    from app.exports.lineage_export import lineage_to_mermaid

    graph = _build_lineage_graph(tier_data)
    mermaid = lineage_to_mermaid(graph)
    return Response(
        content=mermaid,
        media_type="text/plain",
        headers={"Content-Disposition": "attachment; filename=lineage.mmd"},
    )


@router.post("/lineage/json")
async def export_lineage_json(tier_data: dict[str, Any] = Body(...)):
    """Export lineage graph as JSON."""
    from app.routers.lineage import _build_lineage_graph
    from app.exports.lineage_export import lineage_to_json

    graph = _build_lineage_graph(tier_data)
    return lineage_to_json(graph)


# ── Excel Export (Item 82) ─────────────────────────────────────────────────

@router.post("/excel")
async def export_excel(
    tier_data: dict[str, Any] = Body(...),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Export tier data as multi-sheet Excel workbook."""
    try:
        from app.exports.excel_workbook import generate_excel_workbook
    except ImportError:
        raise HTTPException(501, "openpyxl not installed — Excel export unavailable")

    # Get vector results if cached
    vector_results = None
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            vector_results = upload.get_vector_results()

    content = generate_excel_workbook(tier_data, vector_results)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=etl_analysis.xlsx"},
    )


# ── JIRA Export (Item 83) ──────────────────────────────────────────────────

@router.post("/jira/csv")
async def export_jira_csv(
    tier_data: dict[str, Any] = Body(...),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Export migration tasks as JIRA-importable CSV."""
    from app.integrations.jira_export import generate_jira_csv

    vector_results = None
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            vector_results = upload.get_vector_results()

    csv_content = generate_jira_csv(tier_data, vector_results)
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=jira_migration_tasks.csv"},
    )


@router.post("/jira/json")
async def export_jira_json(
    tier_data: dict[str, Any] = Body(...),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Export migration tasks as JSON for JIRA API."""
    from app.integrations.jira_export import generate_jira_json

    vector_results = None
    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            vector_results = upload.get_vector_results()

    tickets = generate_jira_json(tier_data, vector_results)
    return {"tickets": tickets, "count": len(tickets)}


# ── Databricks Scaffold (Item 84) ──────────────────────────────────────────

@router.post("/databricks")
async def export_databricks(tier_data: dict[str, Any] = Body(...)):
    """Export Databricks notebook scaffolding."""
    from app.exports.databricks_scaffold import generate_databricks_notebook

    notebook = generate_databricks_notebook(tier_data)
    return Response(
        content=notebook,
        media_type="text/x-python",
        headers={"Content-Disposition": "attachment; filename=etl_migration.py"},
    )


# ── Snapshot (Item 89) ─────────────────────────────────────────────────────

@router.post("/snapshot")
async def export_snapshot(
    tier_data: dict[str, Any] = Body(...),
    upload_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Export complete state snapshot (tier data + vector results + constellation)."""
    snapshot = {
        'version': '1.0',
        'tier_data': tier_data,
    }

    if upload_id:
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            snapshot['upload_id'] = upload_id
            snapshot['filename'] = upload.filename
            snapshot['platform'] = upload.platform
            snapshot['created_at'] = str(upload.created_at)
            vr = upload.get_vector_results()
            if vr:
                snapshot['vector_results'] = vr
            cd = upload.get_constellation()
            if cd:
                snapshot['constellation'] = cd

    content = json.dumps(snapshot, indent=2)
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=etl_snapshot.json"},
    )


# ── Multi-upload merge (Item 90) ───────────────────────────────────────────

@router.post("/merge")
async def merge_uploads(
    upload_ids: list[int] = Body(...),
    db: Session = Depends(get_db),
):
    """Merge multiple uploads into a single tier data view."""
    merged_sessions = []
    merged_tables = []
    merged_connections = []
    seen_session_ids = set()
    seen_table_ids = set()

    for uid in upload_ids:
        upload = db.query(Upload).filter(Upload.id == uid).first()
        if not upload:
            continue
        td = upload.get_tier_data()
        if not td:
            continue

        for s in td.get('sessions', []):
            if s['id'] not in seen_session_ids:
                seen_session_ids.add(s['id'])
                merged_sessions.append(s)

        for t in td.get('tables', []):
            if t['id'] not in seen_table_ids:
                seen_table_ids.add(t['id'])
                merged_tables.append(t)

        for c in td.get('connections', []):
            merged_connections.append(c)

    # Deduplicate connections
    conn_keys = set()
    unique_conns = []
    for c in merged_connections:
        key = f"{c['from']}-{c['to']}-{c.get('type', '')}"
        if key not in conn_keys:
            conn_keys.add(key)
            unique_conns.append(c)

    stats = {
        'session_count': len(merged_sessions),
        'write_conflicts': sum(1 for c in unique_conns if c.get('type') == 'write_conflict'),
        'dep_chains': 0,
        'staleness_risks': sum(1 for c in unique_conns if c.get('type') == 'lookup_stale'),
        'source_tables': sum(1 for t in merged_tables if t.get('type') == 'source'),
        'max_tier': max((s.get('tier', 0) for s in merged_sessions), default=0),
    }

    return {
        'tier_data': {
            'sessions': merged_sessions,
            'tables': merged_tables,
            'connections': unique_conns,
            'stats': stats,
            'warnings': [f'Merged {len(upload_ids)} uploads'],
        },
        'merged_upload_ids': upload_ids,
    }
