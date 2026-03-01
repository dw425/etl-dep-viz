"""ActiveTag model for in-graph annotations and user-defined labels."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, String, Text

from app.models.database import Base


class ActiveTag(Base):
    """Stores user-created tags on sessions, tables, and transforms."""

    __tablename__ = "active_tags"

    tag_id = Column(String(50), primary_key=True, default=lambda: str(uuid.uuid4())[:8])
    object_id = Column(String(200), nullable=False, index=True)
    object_type = Column(String(50), nullable=False)  # session, table, transform, domain
    tag_type = Column(String(50), nullable=False)  # pii_risk, review_needed, migration_ready, etc.
    label = Column(String(200), nullable=False)
    color = Column(String(20), default="#3B82F6")
    note = Column(Text, default="")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    created_by = Column(String(200), default="")
