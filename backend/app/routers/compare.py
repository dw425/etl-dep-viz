"""Compare two uploads side-by-side.

Matches sessions by ``full_name`` across two uploads and returns a structured
diff showing added, removed, and modified sessions with their flow, tables,
functions, and tiering data.
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session as DbSession

from app.models.database import (
    Upload,
    SessionRecord,
    TableRecord,
    ConnectionRecord,
    get_db,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/compare", tags=["compare"])


def _session_detail(rec: SessionRecord) -> dict:
    """Build a detail dict from a SessionRecord row."""
    return {
        "session_id": rec.session_id,
        "name": rec.name,
        "full_name": rec.full_name,
        "tier": rec.tier,
        "step": rec.step,
        "workflow": rec.workflow,
        "folder_path": rec.folder_path,
        "mapping_name": rec.mapping_name,
        "transforms": rec.transforms or 0,
        "ext_reads": rec.ext_reads or 0,
        "lookup_count": rec.lookup_count or 0,
        "critical": bool(rec.critical),
        "sources": json.loads(rec.sources_json) if rec.sources_json else [],
        "targets": json.loads(rec.targets_json) if rec.targets_json else [],
        "lookups": json.loads(rec.lookups_json) if rec.lookups_json else [],
        "total_loc": rec.total_loc or 0,
        "total_functions_used": rec.total_functions_used or 0,
        "distinct_functions_used": rec.distinct_functions_used or 0,
        "has_embedded_sql": bool(rec.has_embedded_sql),
        "has_embedded_java": bool(rec.has_embedded_java),
        "has_stored_procedure": bool(rec.has_stored_procedure),
        "core_intent": rec.core_intent,
        "expression_count": rec.expression_count or 0,
        "field_mapping_count": rec.field_mapping_count or 0,
    }


def _session_from_tier_data(sess: dict) -> dict:
    """Build a detail dict from a tier_data JSON session entry (fallback)."""
    return {
        "session_id": sess.get("id", ""),
        "name": sess.get("name", ""),
        "full_name": sess.get("full", ""),
        "tier": sess.get("tier", 0),
        "step": sess.get("step", 0),
        "workflow": sess.get("workflow", ""),
        "folder_path": sess.get("folder", ""),
        "mapping_name": sess.get("mapping", ""),
        "transforms": sess.get("transforms", 0),
        "ext_reads": sess.get("extReads", 0),
        "lookup_count": sess.get("lookupCount", 0),
        "critical": bool(sess.get("critical", False)),
        "sources": sess.get("sources", []),
        "targets": sess.get("targets", []),
        "lookups": sess.get("lookups", []),
        "total_loc": sess.get("total_loc", 0),
        "total_functions_used": sess.get("total_functions_used", 0),
        "distinct_functions_used": sess.get("distinct_functions_used", 0),
        "has_embedded_sql": bool(sess.get("has_embedded_sql", 0)),
        "has_embedded_java": bool(sess.get("has_embedded_java", 0)),
        "has_stored_procedure": bool(sess.get("has_stored_procedure", 0)),
        "core_intent": sess.get("core_intent"),
        "expression_count": sess.get("expression_count", 0),
        "field_mapping_count": sess.get("field_mapping_count", 0),
    }


def _get_sessions(db: DbSession, upload: Upload) -> dict[str, dict]:
    """Return sessions keyed by full_name.  Prefer materialized rows, fall back to JSON."""
    rows = db.query(SessionRecord).filter(SessionRecord.upload_id == upload.id).all()
    if rows:
        return {r.full_name: _session_detail(r) for r in rows}
    # Fallback to JSON blob
    td = upload.get_tier_data()
    return {s.get("full", s.get("name", "")): _session_from_tier_data(s) for s in td.get("sessions", [])}


def _get_tables(db: DbSession, upload: Upload) -> dict[str, dict]:
    """Return tables keyed by name."""
    rows = db.query(TableRecord).filter(TableRecord.upload_id == upload.id).all()
    if rows:
        return {
            r.name: {
                "table_id": r.table_id,
                "name": r.name,
                "type": r.type,
                "tier": r.tier,
                "conflict_writers": r.conflict_writers,
                "readers": r.readers,
                "lookup_users": r.lookup_users,
            }
            for r in rows
        }
    td = upload.get_tier_data()
    return {
        t["name"]: {
            "table_id": t.get("id", ""),
            "name": t["name"],
            "type": t.get("type", ""),
            "tier": t.get("tier", 0),
            "conflict_writers": t.get("conflictWriters", 0),
            "readers": t.get("readers", 0),
            "lookup_users": t.get("lookupUsers", 0),
        }
        for t in td.get("tables", [])
    }


def _get_connections(db: DbSession, upload: Upload) -> list[dict]:
    """Return connection list."""
    rows = db.query(ConnectionRecord).filter(ConnectionRecord.upload_id == upload.id).all()
    if rows:
        return [{"from_id": r.from_id, "to_id": r.to_id, "conn_type": r.conn_type} for r in rows]
    td = upload.get_tier_data()
    return [{"from_id": c["from"], "to_id": c["to"], "conn_type": c["type"]} for c in td.get("connections", [])]


def _compute_changes(a_val, b_val) -> dict:
    """Compute per-field changes between two session dicts."""
    changes = {}
    compare_fields = [
        "tier", "step", "transforms", "ext_reads", "lookup_count", "critical",
        "total_loc", "total_functions_used", "distinct_functions_used",
        "has_embedded_sql", "has_embedded_java", "has_stored_procedure",
        "core_intent", "expression_count", "field_mapping_count",
    ]
    for field in compare_fields:
        old = a_val.get(field)
        new = b_val.get(field)
        if old != new:
            changes[field] = {"old": old, "new": new}

    # Compare source/target/lookup lists
    for list_field in ("sources", "targets", "lookups"):
        old_set = set(a_val.get(list_field, []))
        new_set = set(b_val.get(list_field, []))
        added = sorted(new_set - old_set)
        removed = sorted(old_set - new_set)
        if added or removed:
            changes[list_field] = {"added": added, "removed": removed}

    return changes


@router.get("")
def compare_uploads(
    upload_a: int = Query(..., description="First upload ID (baseline)"),
    upload_b: int = Query(..., description="Second upload ID (comparison)"),
    db: DbSession = Depends(get_db),
):
    """Compare two uploads and return session-level diffs.

    Sessions are matched by ``full_name`` (qualified path). Returns:
    - ``upload_a_info`` / ``upload_b_info``: Upload metadata
    - ``matched``: Sessions present in both, with per-field changes
    - ``added``: Sessions only in upload B
    - ``removed``: Sessions only in upload A
    - ``table_diff``: Tables added/removed/modified
    - ``stats``: Summary counts
    """
    ua = db.query(Upload).filter(Upload.id == upload_a).first()
    ub = db.query(Upload).filter(Upload.id == upload_b).first()
    if not ua:
        raise HTTPException(404, f"Upload {upload_a} not found")
    if not ub:
        raise HTTPException(404, f"Upload {upload_b} not found")

    sessions_a = _get_sessions(db, ua)
    sessions_b = _get_sessions(db, ub)
    tables_a = _get_tables(db, ua)
    tables_b = _get_tables(db, ub)
    conns_a = _get_connections(db, ua)
    conns_b = _get_connections(db, ub)

    keys_a = set(sessions_a.keys())
    keys_b = set(sessions_b.keys())

    matched = []
    for key in sorted(keys_a & keys_b):
        sa = sessions_a[key]
        sb = sessions_b[key]
        changes = _compute_changes(sa, sb)
        matched.append({
            "full_name": key,
            "upload_a": sa,
            "upload_b": sb,
            "changes": changes,
            "has_changes": len(changes) > 0,
        })

    added = [sessions_b[k] for k in sorted(keys_b - keys_a)]
    removed = [sessions_a[k] for k in sorted(keys_a - keys_b)]

    # Table diff
    tkeys_a = set(tables_a.keys())
    tkeys_b = set(tables_b.keys())
    tables_added = [tables_b[k] for k in sorted(tkeys_b - tkeys_a)]
    tables_removed = [tables_a[k] for k in sorted(tkeys_a - tkeys_b)]
    tables_modified = []
    for k in sorted(tkeys_a & tkeys_b):
        ta = tables_a[k]
        tb = tables_b[k]
        changes = {}
        for f in ("type", "tier", "conflict_writers", "readers", "lookup_users"):
            if ta.get(f) != tb.get(f):
                changes[f] = {"old": ta.get(f), "new": tb.get(f)}
        if changes:
            tables_modified.append({"name": k, "upload_a": ta, "upload_b": tb, "changes": changes})

    # Connection summary
    conn_set_a = {(c["from_id"], c["to_id"], c["conn_type"]) for c in conns_a}
    conn_set_b = {(c["from_id"], c["to_id"], c["conn_type"]) for c in conns_b}

    return {
        "upload_a_info": {
            "id": ua.id,
            "filename": ua.filename,
            "platform": ua.platform,
            "session_count": ua.session_count,
            "created_at": str(ua.created_at) if ua.created_at else None,
        },
        "upload_b_info": {
            "id": ub.id,
            "filename": ub.filename,
            "platform": ub.platform,
            "session_count": ub.session_count,
            "created_at": str(ub.created_at) if ub.created_at else None,
        },
        "matched": matched,
        "added": added,
        "removed": removed,
        "table_diff": {
            "added": tables_added,
            "removed": tables_removed,
            "modified": tables_modified,
        },
        "stats": {
            "total_a": len(keys_a),
            "total_b": len(keys_b),
            "matched_count": len(matched),
            "changed_count": sum(1 for m in matched if m["has_changes"]),
            "unchanged_count": sum(1 for m in matched if not m["has_changes"]),
            "added_count": len(added),
            "removed_count": len(removed),
            "tables_added": len(tables_added),
            "tables_removed": len(tables_removed),
            "tables_modified": len(tables_modified),
            "connections_added": len(conn_set_b - conn_set_a),
            "connections_removed": len(conn_set_a - conn_set_b),
        },
    }
