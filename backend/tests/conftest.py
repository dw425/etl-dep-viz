"""Shared pytest fixtures for ETL Dependency Visualizer tests."""

import os
import pathlib

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"


@pytest.fixture
def small_infa_xml() -> bytes:
    """Raw bytes of the small Informatica test fixture."""
    return (FIXTURES_DIR / "small_informatica.xml").read_bytes()


@pytest.fixture
def small_nifi_xml() -> bytes:
    """Raw bytes of the small NiFi test fixture."""
    return (FIXTURES_DIR / "small_nifi_template.xml").read_bytes()


@pytest.fixture
def malformed_infa_xml() -> bytes:
    """Raw bytes of malformed Informatica XML."""
    return (FIXTURES_DIR / "malformed_infa.xml").read_bytes()


@pytest.fixture
def sample_tier_data(small_infa_xml):
    """Parsed tier_data from the small Informatica fixture."""
    from app.engines.infa_engine import analyze
    return analyze([small_infa_xml], ["small_informatica.xml"])


@pytest.fixture
def test_db(tmp_path):
    """In-memory SQLite database for testing."""
    from app.models.database import Base
    # Import ActiveTag so its table is registered with Base.metadata
    from app.models.tags import ActiveTag  # noqa: F401
    db_url = f"sqlite:///{tmp_path}/test.db"
    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    return TestSession


@pytest.fixture
def client(test_db):
    """FastAPI TestClient with DB override."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models.database import get_db

    def _override_db():
        db = test_db()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
