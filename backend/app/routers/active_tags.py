"""Active tags router — CRUD operations for user annotations on ETL objects.

Tags are freeform labels that users attach to sessions, tables, or transforms
to mark migration status, review notes, or custom categories.  Each tag carries
a colour, label, and optional note so the UI can render coloured badges.

tag_id is a short 8-character UUID prefix — short enough for URLs, unique enough
to avoid collisions in typical datasets.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.tags import ActiveTag

router = APIRouter(prefix="/active-tags", tags=["active-tags"])


# ── Create ────────────────────────────────────────────────────────────────


@router.post("")
def create_tag(
    data: dict[str, Any] = Body(...),
    db: Session = Depends(get_db),
):
    """Create a tag on a session, table, or transform."""
    tag = ActiveTag(
        tag_id=str(uuid.uuid4())[:8],  # short but collision-resistant prefix
        object_id=data.get("object_id", ""),
        object_type=data.get("object_type", "session"),
        tag_type=data.get("tag_type", "custom"),
        label=data.get("label", ""),
        color=data.get("color", "#3B82F6"),
        note=data.get("note", ""),
        created_at=datetime.now(timezone.utc),
        created_by=data.get("created_by", ""),
    )
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return {
        "tag_id": tag.tag_id,
        "object_id": tag.object_id,
        "object_type": tag.object_type,
        "tag_type": tag.tag_type,
        "label": tag.label,
        "color": tag.color,
        "note": tag.note,
    }


# ── Read (by object) ──────────────────────────────────────────────────────


@router.get("/{object_id}")
def get_tags_for_object(
    object_id: str,
    db: Session = Depends(get_db),
):
    """Get all tags for an object."""
    tags = db.query(ActiveTag).filter(ActiveTag.object_id == object_id).all()
    return {
        "tags": [
            {
                "tag_id": t.tag_id,
                "object_id": t.object_id,
                "object_type": t.object_type,
                "tag_type": t.tag_type,
                "label": t.label,
                "color": t.color,
                "note": t.note,
            }
            for t in tags
        ]
    }


# ── Update ────────────────────────────────────────────────────────────────


@router.patch("/{tag_id}")
def update_tag(
    tag_id: str,
    data: dict[str, Any] = Body(...),
    db: Session = Depends(get_db),
):
    """Update tag fields (color, label, note)."""
    tag = db.query(ActiveTag).filter(ActiveTag.tag_id == tag_id).first()
    if not tag:
        raise HTTPException(404, "Tag not found")
    # Apply only the fields that were supplied; other fields remain unchanged
    for field in ('color', 'label', 'note', 'tag_type'):
        if field in data:
            setattr(tag, field, data[field])
    db.commit()
    db.refresh(tag)
    return {
        "tag_id": tag.tag_id,
        "object_id": tag.object_id,
        "object_type": tag.object_type,
        "tag_type": tag.tag_type,
        "label": tag.label,
        "color": tag.color,
        "note": tag.note,
    }


# ── Delete ────────────────────────────────────────────────────────────────


@router.delete("/{tag_id}")
def delete_tag(
    tag_id: str,
    db: Session = Depends(get_db),
):
    """Delete a tag by ID."""
    tag = db.query(ActiveTag).filter(ActiveTag.tag_id == tag_id).first()
    if not tag:
        raise HTTPException(404, "Tag not found")
    db.delete(tag)
    db.commit()
    return {"deleted": True}


# ── List (all tags, optional filter) ──────────────────────────────────────


@router.get("")
def list_tags(
    object_type: str | None = Query(None),
    tag_type: str | None = Query(None),
    db: Session = Depends(get_db),
):
    """List all tags with optional filters."""
    q = db.query(ActiveTag)
    if object_type:
        q = q.filter(ActiveTag.object_type == object_type)
    if tag_type:
        q = q.filter(ActiveTag.tag_type == tag_type)
    tags = q.order_by(ActiveTag.created_at.desc()).all()
    return {
        "tags": [
            {
                "tag_id": t.tag_id,
                "object_id": t.object_id,
                "object_type": t.object_type,
                "tag_type": t.tag_type,
                "label": t.label,
                "color": t.color,
                "note": t.note,
            }
            for t in tags
        ]
    }
