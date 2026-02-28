"""Active tags router — create, list, and delete annotations on ETL objects."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.tags import ActiveTag

router = APIRouter(prefix="/active-tags", tags=["active-tags"])


@router.post("")
def create_tag(
    data: dict[str, Any] = Body(...),
    db: Session = Depends(get_db),
):
    """Create a tag on a session, table, or transform."""
    tag = ActiveTag(
        tag_id=str(uuid.uuid4())[:8],
        object_id=data.get("object_id", ""),
        object_type=data.get("object_type", "session"),
        tag_type=data.get("tag_type", "custom"),
        label=data.get("label", ""),
        color=data.get("color", "#3B82F6"),
        note=data.get("note", ""),
        created_at=datetime.utcnow(),
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
