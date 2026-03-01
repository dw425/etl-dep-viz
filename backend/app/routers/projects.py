"""Projects router — CRUD for project containers.

Projects group uploads and all derived data. The user selects a project
on the dashboard before uploading files or viewing results.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import Project, Upload, get_db

logger = logging.getLogger("edv.projects")
router = APIRouter(prefix="/projects", tags=["Projects"])


class ProjectCreate(BaseModel):
    name: str
    description: str | None = None
    user_id: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


@router.get("")
def list_projects(user_id: str | None = None, db: Session = Depends(get_db)):
    """List all projects, optionally filtered by user_id."""
    q = db.query(Project).order_by(Project.updated_at.desc())
    if user_id:
        q = q.filter(Project.user_id == user_id)
    projects = q.all()
    return [
        {
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "user_id": p.user_id,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            "upload_count": db.query(Upload).filter(Upload.project_id == p.id).count(),
        }
        for p in projects
    ]


@router.post("")
def create_project(body: ProjectCreate, db: Session = Depends(get_db)):
    """Create a new project."""
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
    """Get a project with its uploads."""
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
    """Update project name/description."""
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
    """Delete a project and all associated uploads (CASCADE)."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    db.delete(project)
    db.commit()
    return {"deleted": True}
