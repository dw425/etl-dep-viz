"""User profile & activity log router — localStorage-based user tracking."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.models.database import ActivityLog, Upload, UserProfile, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/users", tags=["users"])


@router.post("")
def upsert_user(
    data: dict = Body(...),
    db: Session = Depends(get_db),
):
    """Create or update a user profile (upsert by user_id)."""
    user_id = data.get("user_id")
    if not user_id:
        raise HTTPException(400, "user_id is required")

    user = db.query(UserProfile).filter(UserProfile.id == user_id).first()
    if user:
        if "display_name" in data:
            user.display_name = data["display_name"]
        user.last_active = datetime.now(timezone.utc)
    else:
        user = UserProfile(
            id=user_id,
            display_name=data.get("display_name", ""),
        )
        db.add(user)

    db.commit()
    db.refresh(user)
    return {
        "user_id": user.id,
        "display_name": user.display_name,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "last_active": user.last_active.isoformat() if user.last_active else None,
    }


@router.get("/{user_id}")
def get_user(user_id: str, db: Session = Depends(get_db)):
    """Get user profile + stats."""
    user = db.query(UserProfile).filter(UserProfile.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    upload_count = db.query(Upload).filter(Upload.user_id == user_id).count()
    from sqlalchemy import func
    total_sessions = db.query(func.sum(Upload.session_count)).filter(
        Upload.user_id == user_id
    ).scalar() or 0

    return {
        "user_id": user.id,
        "display_name": user.display_name,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "last_active": user.last_active.isoformat() if user.last_active else None,
        "upload_count": upload_count,
        "total_sessions": total_sessions,
    }


@router.get("/{user_id}/uploads")
def get_user_uploads(
    user_id: str,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List user's uploads with parse_duration_ms."""
    rows = (
        db.query(Upload)
        .filter(Upload.user_id == user_id)
        .order_by(Upload.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": r.id,
            "filename": r.filename,
            "platform": r.platform,
            "session_count": r.session_count,
            "algorithm": r.algorithm,
            "parse_duration_ms": r.parse_duration_ms,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/{user_id}/activity")
def get_user_activity(
    user_id: str,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Get activity log for a user."""
    rows = (
        db.query(ActivityLog)
        .filter(ActivityLog.user_id == user_id)
        .order_by(ActivityLog.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": r.id,
            "action": r.action,
            "target_filename": r.target_filename,
            "details": r.get_details(),
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.post("/{user_id}/activity")
def log_activity(
    user_id: str,
    data: dict = Body(...),
    db: Session = Depends(get_db),
):
    """Log a user activity."""
    entry = ActivityLog(
        user_id=user_id,
        action=data.get("action", "unknown"),
        target_filename=data.get("target_filename"),
    )
    details = data.get("details")
    if details:
        entry.set_details(details)
    db.add(entry)

    # Update last_active
    user = db.query(UserProfile).filter(UserProfile.id == user_id).first()
    if user:
        user.last_active = datetime.now(timezone.utc)

    db.commit()
    return {"logged": True, "id": entry.id}
