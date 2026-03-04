"""Projects router — CRUD for project containers.

Projects group uploads and all derived data. The user selects a project
on the dashboard before uploading files or viewing results.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.database import Project, Upload, get_db

logger = logging.getLogger("edv.projects")
router = APIRouter(prefix="/projects", tags=["Projects"])


# ── Request Models ────────────────────────────────────────────────────────


class ProjectCreate(BaseModel):
    """Request body for creating a new project."""
    name: str
    description: str | None = None
    user_id: str | None = None


class ProjectUpdate(BaseModel):
    """Request body for updating a project (partial update — all fields optional)."""
    name: str | None = None
    description: str | None = None


# ── CRUD Endpoints ────────────────────────────────────────────────────────


@router.get("")
def list_projects(user_id: str | None = None, db: Session = Depends(get_db)):
    """List all projects (most recently updated first), optionally filtered by user_id.

    Each project includes an upload_count computed from the Upload table so the
    dashboard can show how many analyses belong to each project.

    Args:
        user_id: Optional filter for a specific user's projects.
        db: SQLAlchemy session (injected).

    Returns:
        List of project summary dicts with id, name, description, upload_count, etc.
    """
    upload_counts = (
        db.query(Upload.project_id, func.count(Upload.id).label("cnt"))
        .group_by(Upload.project_id)
        .subquery()
    )
    q = (
        db.query(Project, upload_counts.c.cnt)
        .outerjoin(upload_counts, Project.id == upload_counts.c.project_id)
        .order_by(Project.updated_at.desc())
    )
    if user_id:
        q = q.filter(Project.user_id == user_id)
    rows = q.all()
    return [
        {
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "user_id": p.user_id,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            "upload_count": cnt or 0,
        }
        for p, cnt in rows
    ]


@router.post("")
def create_project(body: ProjectCreate, db: Session = Depends(get_db)):
    """Create a new project container.

    Args:
        body: ProjectCreate with name, optional description and user_id.
        db: SQLAlchemy session (injected).

    Returns:
        Created project dict with id, name, description, user_id, created_at.
    """
    project = Project(
        name=body.name,
        description=body.description,
        user_id=body.user_id,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "user_id": project.user_id,
        "created_at": project.created_at.isoformat() if project.created_at else None,
    }


@router.get("/{project_id}")
def get_project(project_id: int, db: Session = Depends(get_db)):
    """Get a project with its uploads (most recent first).

    Args:
        project_id: DB primary key.
        db: SQLAlchemy session (injected).

    Returns:
        Project dict with nested uploads list.

    Raises:
        HTTPException(404): Project not found.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")

    uploads = (
        db.query(Upload)
        .filter(Upload.project_id == project_id)
        .order_by(Upload.created_at.desc())
        .all()
    )

    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "user_id": project.user_id,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "updated_at": project.updated_at.isoformat() if project.updated_at else None,
        "uploads": [
            {
                "id": u.id,
                "filename": u.filename,
                "platform": u.platform,
                "session_count": u.session_count,
                "parse_duration_ms": u.parse_duration_ms,
                "created_at": u.created_at.isoformat() if u.created_at else None,
            }
            for u in uploads
        ],
    }


@router.put("/{project_id}")
def update_project(project_id: int, body: ProjectUpdate, db: Session = Depends(get_db)):
    """Update project name and/or description. Bumps updated_at timestamp.

    Args:
        project_id: DB primary key.
        body: ProjectUpdate with optional name and description.
        db: SQLAlchemy session (injected).

    Returns:
        Updated project dict.

    Raises:
        HTTPException(404): Project not found.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    if body.name is not None:
        project.name = body.name
    if body.description is not None:
        project.description = body.description
    project.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"id": project.id, "name": project.name, "description": project.description}


@router.delete("/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)):
    """Delete a project and all associated uploads (CASCADE).

    SQLAlchemy cascading deletes automatically remove all uploads, their
    per-view materialized table rows, and vector results.

    Args:
        project_id: DB primary key.
        db: SQLAlchemy session (injected).

    Returns:
        {'deleted': True} on success.

    Raises:
        HTTPException(404): Project not found.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    db.delete(project)
    db.commit()
    return {"deleted": True}
