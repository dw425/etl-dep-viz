"""SQLAlchemy models + engine setup for upload persistence."""

import json
import logging
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Integer, String, Text, create_engine, inspect
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class Upload(Base):
    """Stores parsed tier_data + constellation results so users don't re-parse."""

    __tablename__ = "uploads"

    id = Column(Integer, primary_key=True, autoincrement=True)
    filename = Column(String(512), nullable=False, default="unknown")
    platform = Column(String(64), nullable=False, default="mixed")
    session_count = Column(Integer, nullable=False, default=0)
    tier_data_json = Column(Text, nullable=False)         # JSON blob
    constellation_json = Column(Text, nullable=True)      # JSON blob (may be null if not yet clustered)
    vector_results_json = Column(Text, nullable=True)     # JSON blob for cached vector analysis
    algorithm = Column(String(64), nullable=True)
    parse_duration_ms = Column(Integer, nullable=True)
    user_id = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    def set_tier_data(self, data: dict) -> None:
        self.tier_data_json = json.dumps(data, default=str)

    def get_tier_data(self) -> dict:
        return json.loads(self.tier_data_json) if self.tier_data_json else {}

    def set_constellation(self, data: dict) -> None:
        self.constellation_json = json.dumps(data, default=str)

    def get_constellation(self) -> dict | None:
        return json.loads(self.constellation_json) if self.constellation_json else None

    def set_vector_results(self, data: dict) -> None:
        self.vector_results_json = json.dumps(data, default=str)

    def get_vector_results(self) -> dict | None:
        return json.loads(self.vector_results_json) if self.vector_results_json else None


engine = create_engine(settings.database_url, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


class UserProfile(Base):
    """Local user profile (no auth — localStorage UUID)."""

    __tablename__ = "user_profiles"

    id = Column(String(64), primary_key=True)
    display_name = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    last_active = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class ActivityLog(Base):
    """Timestamped activity log entries."""

    __tablename__ = "activity_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), nullable=True)
    action = Column(String(64), nullable=False)  # upload|download|recluster|analyze|delete|export
    target_filename = Column(String(512), nullable=True)
    details_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    def set_details(self, data: dict) -> None:
        self.details_json = json.dumps(data, default=str)

    def get_details(self) -> dict | None:
        return json.loads(self.details_json) if self.details_json else None


def _migrate_db() -> None:
    """Add missing columns to existing databases (lightweight ALTER TABLE migration)."""
    insp = inspect(engine)
    if "uploads" not in insp.get_table_names():
        return
    existing = {col["name"] for col in insp.get_columns("uploads")}
    with engine.begin() as conn:
        if "vector_results_json" not in existing:
            conn.execute(
                __import__("sqlalchemy").text(
                    "ALTER TABLE uploads ADD COLUMN vector_results_json TEXT"
                )
            )
            logger.info("Migrated: added vector_results_json column to uploads")
        if "parse_duration_ms" not in existing:
            conn.execute(
                __import__("sqlalchemy").text(
                    "ALTER TABLE uploads ADD COLUMN parse_duration_ms INTEGER"
                )
            )
            logger.info("Migrated: added parse_duration_ms column to uploads")
        if "user_id" not in existing:
            conn.execute(
                __import__("sqlalchemy").text(
                    "ALTER TABLE uploads ADD COLUMN user_id VARCHAR(64)"
                )
            )
            logger.info("Migrated: added user_id column to uploads")


def init_db() -> None:
    """Create tables if they don't exist, then run lightweight migrations."""
    Base.metadata.create_all(bind=engine)
    _migrate_db()


def get_db():
    """FastAPI dependency — yields a DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
