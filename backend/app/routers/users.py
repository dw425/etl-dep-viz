"""User profile & activity log router — localStorage-based user tracking.

User identities are managed entirely on the client: the browser generates a UUID
on first visit and stores it in localStorage.  That UUID is passed as user_id in
request bodies and as the X-User-Id header on file uploads.  The server never
issues or validates tokens — this is lightweight usage tracking, not authentication.

Endpoints:
  POST /users                        — upsert profile (create or update display_name)
  GET  /users/{user_id}              — profile + aggregate upload stats
  GET  /users/{user_id}/uploads      — paginated upload history
  GET  /users/{user_id}/activity     — paginated activity log
  POST /users/{user_id}/activity     — append an activity event
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.models.database import ActivityLog, Upload, UserProfile, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/users", tags=["users"])


# ── Profile upsert ────────────────────────────────────────────────────────


@router.post("")
def upsert_user(
    data: dict = Body(...),
    db: Session = Depends(get_db),
):
    """Create or update a user profile (upsert by user_id).

    Idempotent: calling this repeatedly with the same user_id is safe.
    Always updates last_active so the profile reflects recent usage.
    """
    user_id = data.get("user_id")
    if not user_id:
        raise HTTPException(400, "user_id is required")

    user = db.query(UserProfile).filter(UserProfile.id == user_id).first()
    if user:
        # Update mutable fields only if supplied in the request body
        if "display_name" in data:
            user.display_name = data["display_name"]
        user.last_active = datetime.now(timezone.utc)
    else:
        # First visit — create a new profile row
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


# ── Profile retrieval ─────────────────────────────────────────────────────


@router.get("/{user_id}")
def get_user(user_id: str, db: Session = Depends(get_db)):
    """Get user profile + aggregate upload stats.

    Computes upload_count and total_sessions across all of the user's uploads
    for the dashboard summary card.

    Args:
        user_id: The browser-generated UUID.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with user_id, display_name, timestamps, upload_count, total_sessions.

    Raises:
        HTTPException(404): User not found.
    """
    user = db.query(UserProfile).filter(UserProfile.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    upload_count = db.query(Upload).filter(Upload.user_id == user_id).count()
    from sqlalchemy import func
    # SUM(session_count) across all of the user's uploads — may be NULL if no uploads
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


# ── Upload history ────────────────────────────────────────────────────────


@router.get("/{user_id}/uploads")
def get_user_uploads(
    user_id: str,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List user's uploads (most recent first) with parse_duration_ms.

    Args:
        user_id: The browser-generated UUID.
        limit: Max results (1-200, default 50).
        db: SQLAlchemy session (injected).

    Returns:
        List of upload summary dicts.
    """
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


# ── Activity log ──────────────────────────────────────────────────────────


@router.get("/{user_id}/activity")
def get_user_activity(
    user_id: str,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Get activity log for a user (most recent first).

    Activity events are logged by the frontend via POST /{user_id}/activity
    and include actions like 'upload', 'view_change', 'export', etc.

    Args:
        user_id: The browser-generated UUID.
        limit: Max results (1-200, default 50).
        db: SQLAlchemy session (injected).

    Returns:
        List of activity event dicts with id, action, target_filename, details, created_at.
    """
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
    """Append an activity event and bump the user's last_active timestamp.

    Args:
        user_id: The browser-generated UUID.
        data: JSON body with 'action' (string), optional 'target_filename', optional 'details' (dict).
        db: SQLAlchemy session (injected).

    Returns:
        Dict with logged=True and the new entry's id.
    """
    entry = ActivityLog(
        user_id=user_id,
        action=data.get("action", "unknown"),
        target_filename=data.get("target_filename"),
    )
    # details is an arbitrary JSON payload (e.g. session counts, algorithm used)
    details = data.get("details")
    if details:
        entry.set_details(details)
    db.add(entry)

    # Keep last_active current so the profile reflects recent usage
    user = db.query(UserProfile).filter(UserProfile.id == user_id).first()
    if user:
        user.last_active = datetime.now(timezone.utc)

    db.commit()
    return {"logged": True, "id": entry.id}
