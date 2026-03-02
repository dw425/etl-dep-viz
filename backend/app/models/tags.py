"""ActiveTag model for in-graph annotations and user-defined labels.

Active Tags let users annotate any object in the dependency graph (sessions,
tables, transforms, domains) with colored labels and free-text notes.  Tags
are persisted in SQLite and surfaced as overlay badges in the frontend views.

Common tag types include: ``pii_risk``, ``review_needed``, ``migration_ready``,
``tech_debt``, ``custom``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, String, Text

from app.models.database import Base


class ActiveTag(Base):
    """Stores user-created tags on sessions, tables, and transforms.

    Tags are polymorphic -- ``object_type`` determines whether the tag
    is attached to a session, table, transform, or domain.  The
    ``object_id`` references the target entity's string ID (e.g. "S1",
    "T_5", or a domain name).
    """

    __tablename__ = "active_tags"

    tag_id = Column(String(50), primary_key=True, default=lambda: str(uuid.uuid4())[:8])
    object_id = Column(String(200), nullable=False, index=True)   # ID of the tagged entity
    object_type = Column(String(50), nullable=False)  # session, table, transform, domain
    tag_type = Column(String(50), nullable=False)     # pii_risk, review_needed, migration_ready, etc.
    label = Column(String(200), nullable=False)       # Human-readable display label
    color = Column(String(20), default="#3B82F6")     # Hex colour for badge rendering
    note = Column(Text, default="")                   # Optional free-text annotation
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    created_by = Column(String(200), default="")      # User display name or UUID
