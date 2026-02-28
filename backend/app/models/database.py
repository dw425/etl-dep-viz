"""SQLAlchemy models + engine setup for upload persistence."""

import json
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


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
    algorithm = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    def set_tier_data(self, data: dict) -> None:
        self.tier_data_json = json.dumps(data, default=str)

    def get_tier_data(self) -> dict:
        return json.loads(self.tier_data_json) if self.tier_data_json else {}

    def set_constellation(self, data: dict) -> None:
        self.constellation_json = json.dumps(data, default=str)

    def get_constellation(self) -> dict | None:
        return json.loads(self.constellation_json) if self.constellation_json else None


engine = create_engine(settings.database_url, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def init_db() -> None:
    """Create tables if they don't exist."""
    Base.metadata.create_all(bind=engine)


def get_db():
    """FastAPI dependency — yields a DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
