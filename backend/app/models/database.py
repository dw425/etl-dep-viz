"""SQLAlchemy ORM models and engine setup for the ETL Dependency Visualizer.

This module defines the complete data model (26 tables) organized into:

  1. **Core entities** -- Project, Upload, UserProfile, ActivityLog
  2. **Foundation records** -- SessionRecord, TableRecord, ConnectionRecord,
     ConnectionProfileRecord (normalized parse output)
  3. **Per-view materialized tables** (``Vw*``) -- pre-computed data for each
     frontend visualization tab so views query dedicated tables for fast,
     independent rendering
  4. **Constellation tables** -- VwConstellationChunks/Points/Edges
  5. **Vector analysis tables** -- VwComplexityScores, VwWaveAssignments,
     VwUmapCoords, VwCommunities, VwWaveFunction, VwConcentrationGroups/Members,
     VwEnsemble

All ``Vw*`` tables are keyed by ``upload_id`` with ``CASCADE`` deletes, so
removing an Upload automatically cleans up every derived table.

Engine and session factory are created at module import time using
``settings.database_url`` (SQLite by default).
"""

import json
import logging
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Float, ForeignKey, Index, Integer, LargeBinary, String, Text, create_engine, inspect
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """SQLAlchemy declarative base for all ORM models in the application."""
    pass


# ── Core Entities ──────────────────────────────────────────────────────────

class Project(Base):
    """Top-level project container -- groups uploads and all derived data.

    Deleting a Project cascades to all its Uploads (and transitively to every
    view/vector table that references those uploads).
    """

    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(256), nullable=False)
    description = Column(Text, nullable=True)
    user_id = Column(String(64), nullable=True)          # localStorage UUID of creator
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    uploads = relationship("Upload", back_populates="project", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_project_user", "user_id"),
    )

    def __repr__(self) -> str:
        return f"<Project id={self.id} name={self.name!r}>"


class Upload(Base):
    """Persisted parse result -- stores tier data, constellation clusters, and
    vector analysis results as JSON blobs so users never need to re-parse.

    JSON accessor pairs (``set_*`` / ``get_*``) handle serialization with
    ``default=str`` to safely encode datetimes and other non-JSON types.
    """

    __tablename__ = "uploads"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
    filename = Column(String(512), nullable=False, default="unknown")
    platform = Column(String(64), nullable=False, default="mixed")   # "informatica", "nifi", or "mixed"
    session_count = Column(Integer, nullable=False, default=0)
    tier_data_json = Column(Text, nullable=False)         # Full parse output (sessions, tables, connections)
    constellation_json = Column(Text, nullable=True)      # Clustering result (null until first recluster)
    vector_results_json = Column(Text, nullable=True)     # Cached vector analysis output (V1-V11)
    algorithm = Column(String(64), nullable=True)         # Constellation algorithm name
    parse_duration_ms = Column(Integer, nullable=True)    # Wall-clock parse time for diagnostics
    user_id = Column(String(64), nullable=True)           # localStorage UUID of uploader
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    project = relationship("Project", back_populates="uploads")

    __table_args__ = (
        Index("ix_upload_project", "project_id"),
        Index("ix_upload_user", "user_id"),
        Index("ix_upload_created", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<Upload id={self.id} filename={self.filename!r} sessions={self.session_count}>"

    def set_tier_data(self, data: dict) -> None:
        """Serialize and store the tier data dict as a JSON blob."""
        self.tier_data_json = json.dumps(data, default=str)

    def get_tier_data(self) -> dict:
        """Deserialize the tier data JSON blob into a dict."""
        return json.loads(self.tier_data_json) if self.tier_data_json else {}

    def set_constellation(self, data: dict) -> None:
        """Serialize and store the constellation clustering result."""
        self.constellation_json = json.dumps(data, default=str)

    def get_constellation(self) -> dict | None:
        """Deserialize the constellation JSON blob, or return None if unset."""
        return json.loads(self.constellation_json) if self.constellation_json else None

    def set_vector_results(self, data: dict) -> None:
        """Serialize and store the vector analysis results (V1-V11)."""
        self.vector_results_json = json.dumps(data, default=str)

    def get_vector_results(self) -> dict | None:
        """Deserialize the vector results JSON blob, or return None if unset."""
        return json.loads(self.vector_results_json) if self.vector_results_json else None


# ── Engine & Session Factory ───────────────────────────────────────────────


def _attach_token_refresh(eng):
    """Refresh Databricks OAuth token on pool checkout with expiry caching.

    Caches the token and only refreshes when it expires (< 5 min remaining).
    Uses exponential backoff on transient failures to avoid thundering herd.
    """
    from sqlalchemy import event
    import os, json, urllib.request, time, logging, threading

    _log = logging.getLogger(__name__)
    _token_lock = threading.Lock()
    _token_cache: dict = {"token": None, "expires_at": 0.0}
    _MAX_RETRIES = 3

    def _fetch_token() -> str | None:
        host = os.environ.get("DATABRICKS_HOST", "")
        client_id = os.environ.get("DATABRICKS_CLIENT_ID", "")
        client_secret = os.environ.get("DATABRICKS_CLIENT_SECRET", "")
        if not (host and client_id and client_secret):
            return None
        if not host.startswith("https://"):
            host = f"https://{host}"
        token_url = f"{host}/oidc/v1/token"
        data = f"grant_type=client_credentials&client_id={client_id}&client_secret={client_secret}&scope=all-apis"
        for attempt in range(_MAX_RETRIES):
            try:
                req = urllib.request.Request(
                    token_url, data=data.encode(), method="POST",
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                resp = urllib.request.urlopen(req, timeout=10)
                body = json.loads(resp.read())
                token = body["access_token"]
                # Default 1hr expiry; refresh 5 min early
                expires_in = body.get("expires_in", 3600)
                _token_cache["token"] = token
                _token_cache["expires_at"] = time.time() + expires_in - 300
                _log.debug("OAuth token refreshed, expires_in=%ds", expires_in)
                return token
            except Exception as exc:
                wait = 2 ** attempt
                _log.warning("OAuth token fetch attempt %d failed: %s — retrying in %ds", attempt + 1, exc, wait)
                time.sleep(wait)
        _log.error("OAuth token fetch failed after %d attempts", _MAX_RETRIES)
        return _token_cache.get("token")  # return stale token as last resort

    @event.listens_for(eng, "do_connect")
    def on_connect(dialect, conn_rec, cargs, cparams):
        with _token_lock:
            if _token_cache["token"] and time.time() < _token_cache["expires_at"]:
                cparams["password"] = _token_cache["token"]
                return
            token = _fetch_token()
            if token:
                cparams["password"] = token


def _create_engine():
    """Build the SQLAlchemy engine based on the configured database URL.

    - **SQLite** (default): uses ``check_same_thread=False`` for FastAPI
      async compatibility — identical to the previous hard-coded behaviour.
    - **PostgreSQL** (Lakebase): connection pooling with pre-ping; when
      ``databricks_app=True``, attaches an OAuth token-refresh hook.
    """
    url = settings.database_url
    if url.startswith("sqlite"):
        return create_engine(url, connect_args={"check_same_thread": False})
    else:
        eng = create_engine(
            url,
            pool_size=settings.pool_size,
            max_overflow=settings.pool_max_overflow,
            pool_timeout=settings.pool_timeout,
            pool_pre_ping=True,
            pool_recycle=settings.pool_recycle,
            connect_args={"options": "-c statement_timeout=600000"},
        )
        if settings.databricks_app:
            _attach_token_refresh(eng)
        return eng


engine = _create_engine()
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


# ── Slow Query Monitoring ───────────────────────────────────────────────
# Logs SQL statements that take longer than _SLOW_QUERY_MS.

import time as _time
from collections import deque as _deque
from sqlalchemy import event as _sa_event

_SLOW_QUERY_MS = 1000  # threshold in milliseconds
_slow_query_log: _deque[dict] = _deque(maxlen=100)


@_sa_event.listens_for(engine, "before_cursor_execute")
def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    conn.info["query_start"] = _time.perf_counter()


@_sa_event.listens_for(engine, "after_cursor_execute")
def _after_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    start = conn.info.pop("query_start", None)
    if start is None:
        return
    elapsed_ms = (_time.perf_counter() - start) * 1000
    if elapsed_ms >= _SLOW_QUERY_MS:
        from datetime import datetime, timezone
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "elapsed_ms": round(elapsed_ms, 1),
            "statement": statement[:500],
        }
        _slow_query_log.append(entry)
        logger.warning("Slow query (%.0fms): %s", elapsed_ms, statement[:200])


# ── User & Activity Tracking ───────────────────────────────────────────────

class UserProfile(Base):
    """Local user profile -- no authentication; identified by a localStorage UUID."""

    __tablename__ = "user_profiles"

    id = Column(String(64), primary_key=True)
    display_name = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    last_active = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    def __repr__(self) -> str:
        return f"<UserProfile id={self.id} name={self.display_name!r}>"


class ActivityLog(Base):
    """Timestamped activity log for auditing user actions.

    Actions include: upload, download, recluster, analyze, delete, export.
    """

    __tablename__ = "activity_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), nullable=True)
    action = Column(String(64), nullable=False)  # upload|download|recluster|analyze|delete|export
    target_filename = Column(String(512), nullable=True)
    details_json = Column(Text, nullable=True)   # Arbitrary JSON payload for action context
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        Index("ix_activity_user", "user_id"),
        Index("ix_activity_created", "created_at"),
        Index("ix_activity_action", "action"),
    )

    def __repr__(self) -> str:
        return f"<ActivityLog id={self.id} action={self.action!r} user={self.user_id}>"

    def set_details(self, data: dict) -> None:
        """Serialize action-specific details into the JSON column."""
        self.details_json = json.dumps(data, default=str)

    def get_details(self) -> dict | None:
        """Deserialize the details JSON blob, or return None if unset."""
        return json.loads(self.details_json) if self.details_json else None


# ── Foundation Records (Normalized Parse Output) ──────────────────────────────
# These four tables store the core parsed data in normalized form, replacing
# the need to deserialize the large tier_data_json blob for every query.

class SessionRecord(Base):
    """One row per parsed ETL session (mapping/workflow/task).

    Columns like ``sources_json``, ``targets_json``, and ``lookups_json``
    store denormalized lists to avoid an extra join for common lookups.
    """

    __tablename__ = "session_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)   # e.g. S1, S2
    name = Column(String(512), nullable=False)
    full_name = Column(String(512), nullable=False)
    tier = Column(Float, nullable=False, default=1.0)
    step = Column(Integer, nullable=True)
    workflow = Column(String(512), nullable=True)
    transforms = Column(Integer, default=0)
    ext_reads = Column(Integer, default=0)
    lookup_count = Column(Integer, default=0)
    critical = Column(Integer, default=0)  # boolean as int for SQLite
    sources_json = Column(Text, nullable=True)   # JSON array of source table names
    targets_json = Column(Text, nullable=True)   # JSON array of target table names
    lookups_json = Column(Text, nullable=True)   # JSON array of lookup table names
    mapping_detail_json = Column(Text, nullable=True)  # deep mapping detail JSON
    connections_used_json = Column(Text, nullable=True)  # connection metadata JSON
    # Phase 5 expansion
    folder_path = Column(String(512), nullable=True)
    mapping_name = Column(String(512), nullable=True)
    config_reference = Column(String(256), nullable=True)
    scheduler_name = Column(String(256), nullable=True)
    expression_count = Column(Integer, default=0)
    field_mapping_count = Column(Integer, default=0)
    parse_completeness_pct = Column(Float, nullable=True)
    # Phase 6 expansion — code analysis summary
    total_loc = Column(Integer, default=0)
    total_functions_used = Column(Integer, default=0)
    distinct_functions_used = Column(Integer, default=0)
    has_embedded_sql = Column(Integer, default=0)
    has_embedded_java = Column(Integer, default=0)
    has_stored_procedure = Column(Integer, default=0)
    core_intent = Column(String(64), nullable=True)
    # Phase 7 (V7) expansion
    session_attributes_json = Column(Text, nullable=True)
    folder_owner = Column(String(256), nullable=True)
    mapping_is_valid = Column(String(16), nullable=True)
    workflow_enabled = Column(String(16), nullable=True)
    pipeline_partitions_json = Column(Text, nullable=True)
    connection_references_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_session_upload", "upload_id"),
        Index("ix_session_upload_sid", "upload_id", "session_id"),
        Index("ix_session_tier", "upload_id", "tier"),
        Index("ix_session_name", "upload_id", "full_name"),
    )

    def __repr__(self) -> str:
        return f"<SessionRecord id={self.id} sid={self.session_id} name={self.name!r}>"


class TableRecord(Base):
    """One row per table in the dependency graph.

    The ``type`` column classifies tables as: source, chain, conflict, or
    independent -- which drives colour coding in several frontend views.
    """

    __tablename__ = "table_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    table_id = Column(String(64), nullable=False)    # e.g. T_0, T_1
    name = Column(String(512), nullable=False)
    type = Column(String(32), nullable=False)        # source, chain, conflict, independent
    tier = Column(Float, nullable=False, default=0.5)
    conflict_writers = Column(Integer, default=0)
    readers = Column(Integer, default=0)
    lookup_users = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_table_upload", "upload_id"),
        Index("ix_table_name", "upload_id", "name"),
    )


class ConnectionRecord(Base):
    """One row per directed edge in the dependency graph.

    ``conn_type`` values: write_conflict, write_clean, read_after_write,
    chain, source_read, lookup_read.  Direction semantics vary by type --
    see MEMORY.md for the canonical definitions.
    """

    __tablename__ = "connection_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    from_id = Column(String(64), nullable=False)
    to_id = Column(String(64), nullable=False)
    conn_type = Column(String(32), nullable=False)   # write_conflict, chain, source_read, etc.

    __table_args__ = (
        Index("ix_conn_upload", "upload_id"),
        Index("ix_conn_from", "upload_id", "from_id"),
        Index("ix_conn_to", "upload_id", "to_id"),
    )


class ConnectionProfileRecord(Base):
    """Database connection profile extracted from parsed XML/JSON.

    Stores JDBC connection strings, DB types, and subtypes so the
    Infrastructure view can map sessions to their target systems.
    """

    __tablename__ = "connection_profiles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(512), nullable=False)
    dbtype = Column(String(64), nullable=True)
    dbsubtype = Column(String(64), nullable=True)
    connection_string = Column(Text, nullable=True)

    __table_args__ = (Index("ix_connprof_upload", "upload_id"),)


# ── Per-View Materialized Tables ─────────────────────────────────────────────
# Each frontend visualization tab gets its own dedicated table(s), populated by
# data_populator.py during parse/analysis.  This avoids heavy JSON
# deserialization on every page load and lets each view query only the columns
# it needs.  All tables use upload_id FK with CASCADE delete.

class VwTierLayout(Base):
    """Materialized view: Tier Diagram node positions."""

    __tablename__ = "vw_tier_layout"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=True)
    table_id = Column(String(64), nullable=True)
    name = Column(String(512), nullable=False)
    full_name = Column(String(512), nullable=True)
    tier = Column(Float, nullable=False)
    step = Column(Integer, nullable=True)
    is_critical = Column(Integer, default=0)
    x_band = Column(Float, nullable=True)  # tier-based x position
    node_type = Column(String(16), nullable=False)  # 'session' or 'table'

    __table_args__ = (
        Index("ix_vwtier_upload", "upload_id"),
        Index("ix_vwtier_upload_type", "upload_id", "node_type"),
    )


class VwGalaxyNodes(Base):
    """Materialized view: Galaxy Map nodes with 2D layout."""

    __tablename__ = "vw_galaxy_nodes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    node_id = Column(String(64), nullable=False)
    node_type = Column(String(16), nullable=False)  # 'session' or 'table'
    name = Column(String(512), nullable=False)
    tier = Column(Float, nullable=False)
    x = Column(Float, nullable=True)
    y = Column(Float, nullable=True)
    size = Column(Float, default=1.0)
    is_critical = Column(Integer, default=0)
    group_id = Column(String(64), nullable=True)

    __table_args__ = (Index("ix_vwgalaxy_upload", "upload_id"),)


class VwExplorerDetail(Base):
    """Materialized view: Explorer session detail with aggregated metrics."""

    __tablename__ = "vw_explorer_detail"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    name = Column(String(512), nullable=False)
    full_name = Column(String(512), nullable=False)
    tier = Column(Float, nullable=False)
    step = Column(Integer, nullable=True)
    workflow = Column(String(512), nullable=True)
    transforms = Column(Integer, default=0)
    ext_reads = Column(Integer, default=0)
    lookup_count = Column(Integer, default=0)
    is_critical = Column(Integer, default=0)
    write_targets_json = Column(Text, nullable=True)
    read_sources_json = Column(Text, nullable=True)
    lookup_tables_json = Column(Text, nullable=True)
    conflict_count = Column(Integer, default=0)
    chain_count = Column(Integer, default=0)
    total_connections = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_vwexplorer_upload", "upload_id"),
        Index("ix_vwexplorer_tier", "upload_id", "tier"),
        Index("ix_vwexplorer_name", "upload_id", "full_name"),
    )


class VwWriteConflicts(Base):
    """Materialized view: tables with multiple writers (write conflicts)."""

    __tablename__ = "vw_write_conflicts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    table_name = Column(String(512), nullable=False)
    table_id = Column(String(64), nullable=False)
    writer_count = Column(Integer, default=0)
    writer_sessions_json = Column(Text, nullable=True)  # [{id, name, tier}]

    __table_args__ = (Index("ix_vwconflict_upload", "upload_id"),)


class VwReadChains(Base):
    """Materialized view: tables that are both written and read (dependency chains)."""

    __tablename__ = "vw_read_chains"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    table_name = Column(String(512), nullable=False)
    table_id = Column(String(64), nullable=False)
    writer_sessions_json = Column(Text, nullable=True)
    reader_sessions_json = Column(Text, nullable=True)
    chain_length = Column(Integer, default=0)

    __table_args__ = (Index("ix_vwchain_upload", "upload_id"),)


class VwExecOrder(Base):
    """Materialized view: execution order with conflict/chain badges."""

    __tablename__ = "vw_exec_order"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    position = Column(Integer, nullable=False)
    session_id = Column(String(64), nullable=False)
    name = Column(String(512), nullable=False)
    full_name = Column(String(512), nullable=False)
    tier = Column(Float, nullable=False)
    step = Column(Integer, nullable=True)
    has_conflict = Column(Integer, default=0)
    has_chain = Column(Integer, default=0)
    write_targets_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_vwexec_upload", "upload_id"),
        Index("ix_vwexec_pos", "upload_id", "position"),
    )


class VwMatrixCells(Base):
    """Materialized view: sparse matrix of session-table connections."""

    __tablename__ = "vw_matrix_cells"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    table_id = Column(String(64), nullable=False)
    session_name = Column(String(512), nullable=False)
    table_name = Column(String(512), nullable=False)
    conn_type = Column(String(32), nullable=False)

    __table_args__ = (
        Index("ix_vwmatrix_upload", "upload_id"),
        Index("ix_vwmatrix_session", "upload_id", "session_id"),
        Index("ix_vwmatrix_table", "upload_id", "table_id"),
    )


class VwTableProfiles(Base):
    """Materialized view: table-centric stats (writer/reader/lookup counts)."""

    __tablename__ = "vw_table_profiles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    table_id = Column(String(64), nullable=False)
    table_name = Column(String(512), nullable=False)
    type = Column(String(32), nullable=False)
    tier = Column(Float, nullable=False)
    writer_count = Column(Integer, default=0)
    reader_count = Column(Integer, default=0)
    lookup_count = Column(Integer, default=0)
    total_refs = Column(Integer, default=0)
    writers_json = Column(Text, nullable=True)
    readers_json = Column(Text, nullable=True)
    lookup_users_json = Column(Text, nullable=True)

    __table_args__ = (Index("ix_vwtable_upload", "upload_id"),)


class VwDuplicateGroups(Base):
    """Materialized view: groups of duplicate/similar sessions."""

    __tablename__ = "vw_duplicate_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    group_id = Column(String(64), nullable=False)
    match_type = Column(String(16), nullable=False)  # 'exact', 'near', 'partial'
    fingerprint = Column(String(512), nullable=True)
    similarity = Column(Float, default=1.0)
    member_count = Column(Integer, default=0)

    __table_args__ = (Index("ix_vwdup_upload", "upload_id"),)


class VwDuplicateMembers(Base):
    """Materialized view: members within a duplicate group."""

    __tablename__ = "vw_duplicate_members"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    group_id = Column(String(64), nullable=False)
    session_id = Column(String(64), nullable=False)
    name = Column(String(512), nullable=False)
    full_name = Column(String(512), nullable=False)
    sources_json = Column(Text, nullable=True)
    targets_json = Column(Text, nullable=True)
    lookups_json = Column(Text, nullable=True)

    __table_args__ = (Index("ix_vwdupmem_upload", "upload_id"),)


# ── Constellation Materialized Tables ─────────────────────────────────────────

class VwConstellationChunks(Base):
    """Materialized view: constellation chunks (clusters)."""

    __tablename__ = "vw_constellation_chunks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    chunk_id = Column(String(64), nullable=False)
    label = Column(String(512), nullable=True)
    algorithm = Column(String(64), nullable=True)
    session_count = Column(Integer, default=0)
    table_count = Column(Integer, default=0)
    tier_min = Column(Float, nullable=True)
    tier_max = Column(Float, nullable=True)
    pivot_tables_json = Column(Text, nullable=True)
    session_ids_json = Column(Text, nullable=True)
    table_names_json = Column(Text, nullable=True)
    conflict_count = Column(Integer, default=0)
    chain_count = Column(Integer, default=0)
    critical_count = Column(Integer, default=0)
    color = Column(String(32), nullable=True)

    __table_args__ = (Index("ix_vwchunk_upload", "upload_id"),)


class VwConstellationPoints(Base):
    """Materialized view: constellation session points with 2D coordinates."""

    __tablename__ = "vw_constellation_points"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    chunk_id = Column(String(64), nullable=False)
    x = Column(Float, nullable=True)
    y = Column(Float, nullable=True)
    tier = Column(Float, nullable=True)
    is_critical = Column(Integer, default=0)
    name = Column(String(512), nullable=True)

    __table_args__ = (
        Index("ix_vwpoint_upload", "upload_id"),
        Index("ix_vwpoint_chunk", "upload_id", "chunk_id"),
    )


class VwConstellationEdges(Base):
    """Materialized view: cross-chunk edges in the constellation."""

    __tablename__ = "vw_constellation_edges"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    from_chunk = Column(String(64), nullable=False)
    to_chunk = Column(String(64), nullable=False)
    count = Column(Integer, default=1)

    __table_args__ = (Index("ix_vwedge_upload", "upload_id"),)


# ── Vector Analysis Materialized Tables ───────────────────────────────────────

class VwComplexityScores(Base):
    """Materialized view: V11 complexity scores per session.

    Each session is scored across 16 complexity dimensions (d1-d16):
      d1=transform_volume, d2=diversity, d3=risk, d4=io_volume,
      d5=lookup_intensity, d6=coupling, d7=structural_depth, d8=external_reads,
      d9=expression_complexity, d10=parameter_dependency, d11=sql_override,
      d12=join_complexity, d13=field_mapping_density, d14=lookup_cache,
      d15=error_handling, d16=schedule_dependency.
    Both raw and percentile-normalized values are stored.
    """

    __tablename__ = "vw_complexity_scores"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    name = Column(String(512), nullable=False)
    tier = Column(Float, nullable=True)
    overall_score = Column(Float, default=0.0)         # Weighted composite 0-100
    bucket = Column(String(16), nullable=True)         # Simple/Medium/Complex/Very Complex
    # Raw dimension values (pre-normalization) — D1-D8 original, D9-D16 Phase 7
    d1_raw = Column(Float, default=0.0)
    d2_raw = Column(Float, default=0.0)
    d3_raw = Column(Float, default=0.0)
    d4_raw = Column(Float, default=0.0)
    d5_raw = Column(Float, default=0.0)
    d6_raw = Column(Float, default=0.0)
    d7_raw = Column(Float, default=0.0)
    d8_raw = Column(Float, default=0.0)
    d9_raw = Column(Float, default=0.0)
    d10_raw = Column(Float, default=0.0)
    d11_raw = Column(Float, default=0.0)
    d12_raw = Column(Float, default=0.0)
    d13_raw = Column(Float, default=0.0)
    d14_raw = Column(Float, default=0.0)
    d15_raw = Column(Float, default=0.0)
    d16_raw = Column(Float, default=0.0)
    # Normalized dimension values (0-100 percentile)
    d1_norm = Column(Float, default=0.0)
    d2_norm = Column(Float, default=0.0)
    d3_norm = Column(Float, default=0.0)
    d4_norm = Column(Float, default=0.0)
    d5_norm = Column(Float, default=0.0)
    d6_norm = Column(Float, default=0.0)
    d7_norm = Column(Float, default=0.0)
    d8_norm = Column(Float, default=0.0)
    d9_norm = Column(Float, default=0.0)
    d10_norm = Column(Float, default=0.0)
    d11_norm = Column(Float, default=0.0)
    d12_norm = Column(Float, default=0.0)
    d13_norm = Column(Float, default=0.0)
    d14_norm = Column(Float, default=0.0)
    d15_norm = Column(Float, default=0.0)
    d16_norm = Column(Float, default=0.0)
    hours_low = Column(Float, default=0.0)       # Effort estimate lower bound (hours)
    hours_high = Column(Float, default=0.0)      # Effort estimate upper bound (hours)
    top_drivers_json = Column(Text, nullable=True)  # JSON list of top complexity drivers

    __table_args__ = (
        Index("ix_vwcomplexity_upload", "upload_id"),
        Index("ix_vwcomplexity_session", "upload_id", "session_id"),
        Index("ix_vwcomplexity_bucket", "upload_id", "bucket"),
    )


class VwWaveAssignments(Base):
    """Materialized view: V4 wave plan assignments per session.

    Sessions are assigned to migration waves based on their dependency
    ordering.  Sessions in the same SCC (strongly connected component)
    share an ``scc_group_id`` and ``is_cycle`` is set to 1.
    """

    __tablename__ = "vw_wave_assignments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    name = Column(String(512), nullable=False)
    wave_number = Column(Integer, nullable=False)
    scc_group_id = Column(Integer, nullable=True)
    is_cycle = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_vwwave_upload", "upload_id"),
        Index("ix_vwwave_upload_wave", "upload_id", "wave_number"),
    )


class VwUmapCoords(Base):
    """Materialized view: V3 UMAP 2D coordinates per session.

    Stores three scale variants (local, balanced, global) controlled by the
    ``scale`` column.  Each variant produces different neighborhood emphasis.
    """

    __tablename__ = "vw_umap_coords"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    scale = Column(String(16), nullable=False, default="balanced")  # local, balanced, global
    x = Column(Float, nullable=False)
    y = Column(Float, nullable=False)
    cluster_id = Column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_vwumap_upload", "upload_id"),
        Index("ix_vwumap_session", "upload_id", "session_id"),
        Index("ix_vwumap_scale", "upload_id", "scale"),
    )


class VwCommunities(Base):
    """Materialized view: V1 community assignments (macro/meso/micro).

    Three hierarchical community levels detected by Louvain modularity:
    macro (coarse), meso (mid-level), and micro (fine-grained).
    """

    __tablename__ = "vw_communities"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    macro_id = Column(Integer, nullable=True)
    meso_id = Column(Integer, nullable=True)
    micro_id = Column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_vwcomm_upload", "upload_id"),
        Index("ix_vwcomm_session", "upload_id", "session_id"),
    )


class VwWaveFunction(Base):
    """Materialized view: V9 wave function (failure propagation) scores.

    Models how a failure in one session propagates through the dependency
    graph.  ``blast_radius`` measures downstream impact, ``chain_depth``
    counts the longest failure propagation path, and ``amplification_factor``
    captures fan-out multiplier effects.
    """

    __tablename__ = "vw_wave_function"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    name = Column(String(512), nullable=False)
    blast_radius = Column(Float, default=0.0)
    chain_depth = Column(Integer, default=0)
    criticality_score = Column(Float, default=0.0)
    amplification_factor = Column(Float, default=0.0)
    criticality_tier = Column(String(16), nullable=True)

    __table_args__ = (
        Index("ix_vwwavefn_upload", "upload_id"),
        Index("ix_vwwavefn_session", "upload_id", "session_id"),
    )


class VwConcentrationGroups(Base):
    """Materialized view: V10 concentration analysis groups.

    Groups of sessions that share a common set of core tables.
    ``cohesion`` measures intra-group similarity; ``coupling`` measures
    inter-group dependency strength.
    """

    __tablename__ = "vw_concentration_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    group_id = Column(String(64), nullable=False)
    medoid_session_id = Column(String(64), nullable=True)
    core_tables_json = Column(Text, nullable=True)
    cohesion = Column(Float, default=0.0)
    coupling = Column(Float, default=0.0)
    session_count = Column(Integer, default=0)

    __table_args__ = (Index("ix_vwconc_upload", "upload_id"),)


class VwConcentrationMembers(Base):
    """Materialized view: V10 concentration group members.

    Each row maps a session to its concentration group.  The ``medoid``
    flag marks the most representative session; ``independence_type``
    classifies the session's role (e.g. 'core', 'peripheral').
    """

    __tablename__ = "vw_concentration_members"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    group_id = Column(String(64), nullable=False)
    is_medoid = Column(Integer, default=0)
    independence_type = Column(String(32), nullable=True)
    confidence = Column(Float, default=0.0)

    __table_args__ = (
        Index("ix_vwconcmem_upload", "upload_id"),
        Index("ix_vwconcmem_session", "upload_id", "session_id"),
        Index("ix_vwconcmem_group", "upload_id", "group_id"),
    )


class VwEnsemble(Base):
    """Materialized view: V8 ensemble consensus clustering.

    Combines community assignments from multiple vectors (V1, V3, V10) into
    a single consensus cluster.  ``is_contested`` flags sessions where the
    source vectors disagree, and ``consensus_score`` quantifies agreement.
    """

    __tablename__ = "vw_ensemble"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    consensus_cluster = Column(Integer, nullable=True)
    consensus_score = Column(Float, default=0.0)
    per_vector_json = Column(Text, nullable=True)
    is_contested = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_vwensemble_upload", "upload_id"),
        Index("ix_vwensemble_session", "upload_id", "session_id"),
    )


class VwHierarchicalLineage(Base):
    """Materialized view: V2 hierarchical clustering (dendrogram) results.

    Stores hierarchical clustering assignments with merge distances and
    parent cluster relationships for dendrogram visualization.
    """

    __tablename__ = "vw_hierarchical_lineage"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    cluster_id = Column(Integer, nullable=True)
    level = Column(Integer, default=0)
    parent_cluster = Column(Integer, nullable=True)
    merge_distance = Column(Float, default=0.0)
    session_count = Column(Integer, default=1)

    __table_args__ = (
        Index("ix_vwhier_upload", "upload_id"),
        Index("ix_vwhier_session", "upload_id", "session_id"),
    )


class VwAffinityPropagation(Base):
    """Materialized view: V5 affinity propagation cluster assignments.

    Each session is assigned to a cluster with an exemplar (representative)
    session.  Responsibility and availability scores capture the AP message
    passing dynamics.
    """

    __tablename__ = "vw_affinity_propagation"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    exemplar_id = Column(String(64), nullable=True)
    cluster_id = Column(Integer, nullable=True)
    responsibility = Column(Float, default=0.0)
    availability = Column(Float, default=0.0)
    preference = Column(Float, default=0.0)

    __table_args__ = (
        Index("ix_vwaffinity_upload", "upload_id"),
        Index("ix_vwaffinity_session", "upload_id", "session_id"),
    )


class VwSpectralClustering(Base):
    """Materialized view: V6 spectral clustering results.

    Stores cluster assignments derived from the eigenvectors of the
    graph Laplacian.  Eigenvalue and eigen_gap help determine optimal k.
    """

    __tablename__ = "vw_spectral_clustering"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    cluster_id = Column(Integer, nullable=True)
    eigenvalue = Column(Float, default=0.0)
    eigen_gap = Column(Float, default=0.0)

    __table_args__ = (
        Index("ix_vwspectral_upload", "upload_id"),
        Index("ix_vwspectral_session", "upload_id", "session_id"),
    )


class VwHdbscanDensity(Base):
    """Materialized view: V7 HDBSCAN density-based clustering results.

    Stores cluster assignments with probability scores and outlier
    identification.  Noise points have ``cluster_id = -1``.
    """

    __tablename__ = "vw_hdbscan_density"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    cluster_id = Column(Integer, nullable=True)
    probability = Column(Float, default=0.0)
    outlier_score = Column(Float, default=0.0)
    persistence = Column(Float, default=0.0)

    __table_args__ = (
        Index("ix_vwhdbscan_upload", "upload_id"),
        Index("ix_vwhdbscan_session", "upload_id", "session_id"),
    )


class VwExpressionComplexity(Base):
    """Materialized view: V12 expression complexity scores per session."""

    __tablename__ = "vw_expression_complexity"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    cluster_id = Column(Integer, default=0)
    expression_count = Column(Integer, default=0)
    avg_depth = Column(Float, default=0.0)
    total_functions = Column(Integer, default=0)
    expression_density = Column(Float, default=0.0)
    score = Column(Integer, default=0)
    bucket = Column(String(16), nullable=True)

    __table_args__ = (
        Index("ix_vwexprcomp_upload", "upload_id"),
        Index("ix_vwexprcomp_session", "upload_id", "session_id"),
    )


class VwDataFlow(Base):
    """Materialized view: V13 data flow volume estimates per session."""

    __tablename__ = "vw_data_flow"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    cluster_id = Column(Integer, default=0)
    source_volume = Column(Float, default=0.0)
    output_volume = Column(Float, default=0.0)
    funnel_ratio = Column(Float, default=0.0)
    bottleneck_transform = Column(String(256), nullable=True)

    __table_args__ = (
        Index("ix_vwdataflow_upload", "upload_id"),
        Index("ix_vwdataflow_session", "upload_id", "session_id"),
    )


class VwSchemaDrift(Base):
    """Materialized view: V14 schema drift baseline per session."""

    __tablename__ = "vw_schema_drift"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    cluster_id = Column(Integer, default=0)
    field_count = Column(Integer, default=0)
    drift_score = Column(Integer, default=0)
    added_fields = Column(Integer, default=0)
    removed_fields = Column(Integer, default=0)
    type_changes = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_vwschemadrift_upload", "upload_id"),
        Index("ix_vwschemadrift_session", "upload_id", "session_id"),
    )


class VwTransformCentrality(Base):
    """Materialized view: V15 transform graph centrality per session."""

    __tablename__ = "vw_transform_centrality"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    cluster_id = Column(Integer, default=0)
    transform_count = Column(Integer, default=0)
    max_centrality = Column(Float, default=0.0)
    chokepoint_transform = Column(String(256), nullable=True)
    avg_degree = Column(Float, default=0.0)

    __table_args__ = (
        Index("ix_vwtranscentr_upload", "upload_id"),
        Index("ix_vwtranscentr_session", "upload_id", "session_id"),
    )


class VwTableGravity(Base):
    """Materialized view: V16 table gravity scores."""

    __tablename__ = "vw_table_gravity"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)  # table name used as ID
    cluster_id = Column(Integer, default=0)
    table_name = Column(String(512), nullable=False)
    reader_count = Column(Integer, default=0)
    writer_count = Column(Integer, default=0)
    lookup_count = Column(Integer, default=0)
    gravity_score = Column(Float, default=0.0)
    is_hub = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_vwtablegrav_upload", "upload_id"),
        Index("ix_vwtablegrav_session", "upload_id", "session_id"),
    )


class DocumentEmbedding(Base):
    """PG-backed vector store: persists document embeddings for RAG chat.

    Replaces ChromaDB's ephemeral file-based store with a durable PostgreSQL
    table that survives Databricks App restarts.  Embeddings are stored as
    binary blobs (numpy float32 arrays) and loaded into an LRU cache for
    fast cosine similarity search.
    """

    __tablename__ = "document_embeddings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    doc_id = Column(String(256), nullable=False)       # e.g. "session:S001", "table:CUSTOMER"
    doc_type = Column(String(32), nullable=False)       # session, table, chain, group, environment
    content = Column(Text, nullable=False)              # document text
    embedding_blob = Column(LargeBinary, nullable=True) # numpy float32 bytes
    metadata_json = Column(Text, nullable=True)         # JSON metadata dict
    chunk_index = Column(Integer, default=0)            # chunk position for chunked docs
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        Index("ix_docembed_upload", "upload_id"),
        Index("ix_docembed_upload_docid", "upload_id", "doc_id"),
    )


# ── Phase 5: Normalized Storage Tables ────────────────────────────────────


class TransformRecord(Base):
    """Normalized transform instances from mapping_detail."""

    __tablename__ = "transform_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_name = Column(String(512), nullable=False)
    mapping_name = Column(String(512), nullable=True)
    transform_name = Column(String(512), nullable=False)
    transform_type = Column(String(64), nullable=True)
    instance_name = Column(String(512), nullable=True)
    port_count = Column(Integer, default=0)
    properties_json = Column(Text, nullable=True)
    sql_override = Column(Text, nullable=True)
    lookup_table = Column(String(512), nullable=True)
    lookup_condition = Column(Text, nullable=True)
    filter_condition = Column(Text, nullable=True)
    expression_count = Column(Integer, default=0)
    # Phase 7 (V7) expansion
    is_reusable = Column(String(16), nullable=True)
    component_version = Column(String(64), nullable=True)
    description = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_transform_upload_session", "upload_id", "session_name"),
        Index("ix_transform_upload_type", "upload_id", "transform_type"),
    )


class FieldMappingRecord(Base):
    """Normalized field-to-field mappings from connectors."""

    __tablename__ = "field_mapping_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_name = Column(String(512), nullable=False)
    from_instance = Column(String(512), nullable=False)
    from_field = Column(String(256), nullable=False)
    from_instance_type = Column(String(64), nullable=True)
    to_instance = Column(String(512), nullable=False)
    to_field = Column(String(256), nullable=False)
    to_instance_type = Column(String(64), nullable=True)
    from_datatype = Column(String(64), nullable=True)
    to_datatype = Column(String(64), nullable=True)

    __table_args__ = (
        Index("ix_fieldmap_upload_session", "upload_id", "session_name"),
        Index("ix_fieldmap_from", "upload_id", "from_instance", "from_field"),
        Index("ix_fieldmap_to", "upload_id", "to_instance", "to_field"),
    )


class ExpressionRecord(Base):
    """Normalized expression records from TRANSFORMFIELD elements."""

    __tablename__ = "expression_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_name = Column(String(512), nullable=False)
    transform_name = Column(String(512), nullable=False)
    field_name = Column(String(256), nullable=False)
    datatype = Column(String(64), nullable=True)
    port_type = Column(String(32), nullable=True)
    expression_text = Column(Text, nullable=True)
    expression_type = Column(String(32), nullable=True)     # passthrough, derived, aggregated, etc.
    expression_complexity = Column(Integer, default=0)
    nesting_depth = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_expr_upload_session", "upload_id", "session_name"),
        Index("ix_expr_upload_transform", "upload_id", "transform_name"),
    )


class WorkflowRecord(Base):
    """Normalized workflow execution DAGs."""

    __tablename__ = "workflow_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    workflow_name = Column(String(512), nullable=False)
    folder_name = Column(String(512), nullable=True)
    session_count = Column(Integer, default=0)
    task_count = Column(Integer, default=0)
    worklet_count = Column(Integer, default=0)
    has_scheduler = Column(Integer, default=0)
    critical_path_length = Column(Integer, default=0)
    parallelism_degree = Column(Integer, default=0)
    # Phase 7 (V7) expansion
    is_enabled = Column(String(16), nullable=True)
    is_service = Column(String(16), nullable=True)
    suspend_on_error = Column(String(16), nullable=True)
    server_name = Column(String(256), nullable=True)
    description = Column(Text, nullable=True)
    schedule_info_json = Column(Text, nullable=True)
    workflow_variables_json = Column(Text, nullable=True)
    task_edges_count = Column(Integer, default=0)
    conditional_links_count = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_workflow_upload", "upload_id"),
    )


class LookupConfigRecord(Base):
    """Normalized lookup configuration from transforms."""

    __tablename__ = "lookup_config_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_name = Column(String(512), nullable=False)
    lookup_name = Column(String(512), nullable=False)
    lookup_table = Column(String(512), nullable=True)
    lookup_condition = Column(Text, nullable=True)
    sql_override = Column(Text, nullable=True)
    cache_enabled = Column(Integer, default=1)
    lookup_policy = Column(String(64), nullable=True)

    __table_args__ = (
        Index("ix_lookup_upload_session", "upload_id", "session_name"),
    )


class ParameterRecord(Base):
    """Normalized parameter records ($$user_params, $PM_system_params)."""

    __tablename__ = "parameter_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    parameter_name = Column(String(256), nullable=False)
    parameter_type = Column(String(32), nullable=True)    # user, system, mapping_variable
    default_value = Column(Text, nullable=True)
    datatype = Column(String(64), nullable=True)
    aggregate_type = Column(String(32), nullable=True)
    used_by_sessions_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_param_upload", "upload_id"),
        Index("ix_param_upload_name", "upload_id", "parameter_name"),
    )


class SQLOverrideRecord(Base):
    """Normalized SQL override text with referenced tables."""

    __tablename__ = "sql_override_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_name = Column(String(512), nullable=False)
    transform_name = Column(String(512), nullable=False)
    override_type = Column(String(32), nullable=True)    # source, lookup, target, pre_sql, post_sql
    sql_text = Column(Text, nullable=False)
    referenced_tables_json = Column(Text, nullable=True)
    sql_complexity = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_sqloverride_upload_session", "upload_id", "session_name"),
    )


# ── Code Analysis Tables ──────────────────────────────────────────────────

class EmbeddedCodeRecord(Base):
    """Stores detected embedded code per session — SQL overrides, Java transforms,
    stored procedures, pre/post SQL, R code, Python, shell scripts."""

    __tablename__ = "embedded_code_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_name = Column(String(512), nullable=False)
    transform_name = Column(String(512), nullable=True)
    code_type = Column(String(32), nullable=False)      # sql, java, python, r, shell, plsql, javascript, informatica_expression
    code_subtype = Column(String(64), nullable=True)     # sql_override, pre_sql, post_sql, stored_proc, custom_transform, filter, join_condition, lookup_condition, router_expression
    code_text = Column(Text, nullable=True)
    line_count = Column(Integer, default=0)
    char_count = Column(Integer, default=0)
    language_confidence = Column(Float, default=1.0)
    contains_dml = Column(Integer, default=0)            # INSERT/UPDATE/DELETE/MERGE
    contains_ddl = Column(Integer, default=0)            # CREATE/ALTER/DROP
    referenced_tables_json = Column(Text, nullable=True)
    referenced_functions_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_embcode_upload_session", "upload_id", "session_name"),
        Index("ix_embcode_upload_type", "upload_id", "code_type"),
    )


class FunctionUsageRecord(Base):
    """Catalogs every function call found in expressions and SQL."""

    __tablename__ = "function_usage_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_name = Column(String(512), nullable=False)
    transform_name = Column(String(512), nullable=True)
    field_name = Column(String(512), nullable=True)
    function_name = Column(String(256), nullable=False)
    function_category = Column(String(64), nullable=True)  # aggregate, string, date, math, conversion, conditional, lookup, custom_udf, system
    call_count = Column(Integer, default=1)
    nested_depth = Column(Integer, default=0)
    arguments_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_funcusage_upload_func", "upload_id", "function_name"),
        Index("ix_funcusage_upload_session", "upload_id", "session_name"),
    )


class SessionCodeProfile(Base):
    """Per-session summary of all code metrics — flags and counts."""

    __tablename__ = "session_code_profiles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_name = Column(String(512), nullable=False)
    # Code presence flags (0/1)
    has_sql = Column(Integer, default=0)
    has_plsql = Column(Integer, default=0)
    has_java = Column(Integer, default=0)
    has_python = Column(Integer, default=0)
    has_r_code = Column(Integer, default=0)
    has_shell = Column(Integer, default=0)
    has_javascript = Column(Integer, default=0)
    has_stored_procedure = Column(Integer, default=0)
    has_custom_transform = Column(Integer, default=0)
    has_pre_post_sql = Column(Integer, default=0)
    # Counts
    total_code_blocks = Column(Integer, default=0)
    total_loc = Column(Integer, default=0)
    total_functions_used = Column(Integer, default=0)
    distinct_functions_used = Column(Integer, default=0)
    total_expressions = Column(Integer, default=0)
    # Function type breakdown
    aggregate_function_count = Column(Integer, default=0)
    string_function_count = Column(Integer, default=0)
    date_function_count = Column(Integer, default=0)
    math_function_count = Column(Integer, default=0)
    conversion_function_count = Column(Integer, default=0)
    conditional_function_count = Column(Integer, default=0)
    lookup_function_count = Column(Integer, default=0)
    custom_udf_count = Column(Integer, default=0)
    # Phase 7 (V7) new function categories
    analytic_function_count = Column(Integer, default=0)
    financial_function_count = Column(Integer, default=0)
    binary_function_count = Column(Integer, default=0)
    encoding_function_count = Column(Integer, default=0)
    encryption_function_count = Column(Integer, default=0)
    # Core intent classification
    core_intent = Column(String(64), nullable=True)
    intent_confidence = Column(Float, default=0.0)
    intent_details_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_codeprof_upload_session", "upload_id", "session_name", unique=True),
    )


# ── Deep Parse Expansion Tables (V7) ──────────────────────────────────────


class RepositoryMetadataRecord(Base):
    """POWERMART root + REPOSITORY metadata from Informatica XML."""

    __tablename__ = "repository_metadata"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    creation_date = Column(String(128), nullable=True)
    repository_version = Column(String(64), nullable=True)
    repository_name = Column(String(256), nullable=True)
    version = Column(String(64), nullable=True)
    codepage = Column(String(64), nullable=True)
    database_type = Column(String(64), nullable=True)

    __table_args__ = (Index("ix_repometa_upload", "upload_id"),)


class FolderRecord(Base):
    """Folder-level metadata from Informatica XML."""

    __tablename__ = "folder_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(512), nullable=False)
    description = Column(Text, nullable=True)
    owner = Column(String(256), nullable=True)
    shared = Column(String(16), nullable=True)
    permissions = Column(String(256), nullable=True)
    session_count = Column(Integer, default=0)
    mapping_count = Column(Integer, default=0)
    workflow_count = Column(Integer, default=0)
    shortcut_count = Column(Integer, default=0)

    __table_args__ = (Index("ix_folder_upload", "upload_id"),)


class MappingRecord(Base):
    """Mapping-level metadata from Informatica XML."""

    __tablename__ = "mapping_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    mapping_name = Column(String(512), nullable=False)
    folder_name = Column(String(512), nullable=True)
    is_valid = Column(String(16), nullable=True)
    is_profile_mapping = Column(String(16), nullable=True)
    description = Column(Text, nullable=True)
    source_count = Column(Integer, default=0)
    target_count = Column(Integer, default=0)
    transform_count = Column(Integer, default=0)
    connector_count = Column(Integer, default=0)
    used_by_sessions_json = Column(Text, nullable=True)
    target_load_order_json = Column(Text, nullable=True)
    map_dependencies_json = Column(Text, nullable=True)
    metadata_extensions_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_mapping_upload", "upload_id"),
        Index("ix_mapping_name", "upload_id", "mapping_name"),
    )


class ShortcutRecord(Base):
    """Cross-folder SHORTCUT references."""

    __tablename__ = "shortcut_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(512), nullable=False)
    ref_object_name = Column(String(512), nullable=True)
    object_type = Column(String(64), nullable=True)
    source_folder = Column(String(512), nullable=True)
    repository_name = Column(String(256), nullable=True)
    reference_type = Column(String(64), nullable=True)

    __table_args__ = (Index("ix_shortcut_upload", "upload_id"),)


class MetadataExtensionRecord(Base):
    """METADATAEXTENSION governance tags from Informatica XML."""

    __tablename__ = "metadata_extension_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    parent_type = Column(String(64), nullable=False)  # FOLDER, MAPPING, TRANSFORMATION, SESSION, WORKFLOW
    parent_name = Column(String(512), nullable=False)
    extension_name = Column(String(256), nullable=False)
    extension_value = Column(Text, nullable=True)
    datatype = Column(String(64), nullable=True)
    domain_name = Column(String(256), nullable=True)

    __table_args__ = (
        Index("ix_metaext_upload", "upload_id"),
        Index("ix_metaext_parent", "upload_id", "parent_type"),
    )


class SourceDefinitionRecord(Base):
    """Normalized SOURCE definitions with field metadata."""

    __tablename__ = "source_definition_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    source_name = Column(String(512), nullable=False)
    database_name = Column(String(512), nullable=True)
    database_type = Column(String(64), nullable=True)
    folder_name = Column(String(512), nullable=True)
    field_count = Column(Integer, default=0)
    fields_json = Column(Text, nullable=True)
    flatfile_info_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_srcdef_upload", "upload_id"),
        Index("ix_srcdef_name", "upload_id", "source_name"),
    )


class TargetDefinitionRecord(Base):
    """Normalized TARGET definitions with field metadata and indexes."""

    __tablename__ = "target_definition_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    target_name = Column(String(512), nullable=False)
    database_name = Column(String(512), nullable=True)
    database_type = Column(String(64), nullable=True)
    folder_name = Column(String(512), nullable=True)
    field_count = Column(Integer, default=0)
    fields_json = Column(Text, nullable=True)
    indexes_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_tgtdef_upload", "upload_id"),
        Index("ix_tgtdef_name", "upload_id", "target_name"),
    )


class WorkflowTaskEdgeRecord(Base):
    """WORKFLOWLINK task dependency edges with conditions."""

    __tablename__ = "workflow_task_edges"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    workflow_name = Column(String(512), nullable=False)
    from_task = Column(String(512), nullable=False)
    to_task = Column(String(512), nullable=False)
    condition = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_wftask_upload", "upload_id"),
        Index("ix_wftask_workflow", "upload_id", "workflow_name"),
    )


class ConfigRecord(Base):
    """Session CONFIG objects with their attributes."""

    __tablename__ = "config_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    config_name = Column(String(512), nullable=False)
    is_default = Column(String(16), nullable=True)
    description = Column(Text, nullable=True)
    attributes_json = Column(Text, nullable=True)
    used_by_sessions_json = Column(Text, nullable=True)

    __table_args__ = (Index("ix_config_upload", "upload_id"),)


# ── Schema Migrations ─────────────────────────────────────────────────────

def _migrate_db() -> None:
    """Add missing columns to existing databases (lightweight ALTER TABLE migration).

    SQLite does not support DROP COLUMN or column type changes, so migrations
    are additive only.  Each migration checks for column existence before
    issuing ALTER TABLE to make the function idempotent.
    """
    from sqlalchemy import text as sa_text
    insp = inspect(engine)
    if "uploads" not in insp.get_table_names():
        return  # Fresh DB -- tables were just created by create_all()
    existing = {col["name"] for col in insp.get_columns("uploads")}
    with engine.begin() as conn:
        if "vector_results_json" not in existing:
            conn.execute(sa_text("ALTER TABLE uploads ADD COLUMN vector_results_json TEXT"))
            logger.info("Migrated: added vector_results_json column to uploads")
        if "parse_duration_ms" not in existing:
            conn.execute(sa_text("ALTER TABLE uploads ADD COLUMN parse_duration_ms INTEGER"))
            logger.info("Migrated: added parse_duration_ms column to uploads")
        if "user_id" not in existing:
            conn.execute(sa_text("ALTER TABLE uploads ADD COLUMN user_id VARCHAR(64)"))
            logger.info("Migrated: added user_id column to uploads")

    # Migrate uploads for project_id (added when Project support was introduced)
    if "project_id" not in existing:
        with engine.begin() as conn:
            conn.execute(sa_text("ALTER TABLE uploads ADD COLUMN project_id INTEGER REFERENCES projects(id)"))
            logger.info("Migrated: added project_id column to uploads")

    # Migrate vw_complexity_scores for D9-D16 columns (Phase 7 expansion)
    if "vw_complexity_scores" in insp.get_table_names():
        cs_cols = {col["name"] for col in insp.get_columns("vw_complexity_scores")}
        with engine.begin() as conn:
            for i in range(9, 17):
                for suffix in ("raw", "norm"):
                    col_name = f"d{i}_{suffix}"
                    if col_name not in cs_cols:
                        conn.execute(sa_text(f"ALTER TABLE vw_complexity_scores ADD COLUMN {col_name} FLOAT DEFAULT 0.0"))
                        logger.info("Migrated: added %s to vw_complexity_scores", col_name)

    # Migrate session_records for V3 columns (ext_reads, lookup_count, etc.)
    if "session_records" in insp.get_table_names():
        sr_cols = {col["name"] for col in insp.get_columns("session_records")}
        with engine.begin() as conn:
            for col_name, col_type in [
                ("ext_reads", "INTEGER DEFAULT 0"),
                ("lookup_count", "INTEGER DEFAULT 0"),
                ("mapping_detail_json", "TEXT"),
                ("connections_used_json", "TEXT"),
                ("folder_path", "VARCHAR(512)"),
                ("mapping_name", "VARCHAR(512)"),
                ("config_reference", "VARCHAR(256)"),
                ("scheduler_name", "VARCHAR(256)"),
                ("expression_count", "INTEGER DEFAULT 0"),
                ("field_mapping_count", "INTEGER DEFAULT 0"),
                ("parse_completeness_pct", "FLOAT"),
            ]:
                if col_name not in sr_cols:
                    conn.execute(sa_text(f"ALTER TABLE session_records ADD COLUMN {col_name} {col_type}"))
                    logger.info("Migrated: added %s column to session_records", col_name)

        # Phase 6 code analysis columns
        for col_name, col_type in [
            ("total_loc", "INTEGER DEFAULT 0"),
            ("total_functions_used", "INTEGER DEFAULT 0"),
            ("distinct_functions_used", "INTEGER DEFAULT 0"),
            ("has_embedded_sql", "INTEGER DEFAULT 0"),
            ("has_embedded_java", "INTEGER DEFAULT 0"),
            ("has_stored_procedure", "INTEGER DEFAULT 0"),
            ("core_intent", "VARCHAR(64)"),
        ]:
            if col_name not in sr_cols:
                with engine.begin() as conn:
                    conn.execute(sa_text(f"ALTER TABLE session_records ADD COLUMN {col_name} {col_type}"))
                    logger.info("Migrated: added %s column to session_records", col_name)

        # Phase 7 (V7) expanded session columns
        for col_name, col_type in [
            ("session_attributes_json", "TEXT"),
            ("folder_owner", "VARCHAR(256)"),
            ("mapping_is_valid", "VARCHAR(16)"),
            ("workflow_enabled", "VARCHAR(16)"),
            ("pipeline_partitions_json", "TEXT"),
            ("connection_references_json", "TEXT"),
        ]:
            if col_name not in sr_cols:
                with engine.begin() as conn:
                    conn.execute(sa_text(f"ALTER TABLE session_records ADD COLUMN {col_name} {col_type}"))
                    logger.info("Migrated: added %s column to session_records", col_name)

    # Phase 7 (V7): Migrate workflow_records for new columns
    if "workflow_records" in insp.get_table_names():
        wf_cols = {col["name"] for col in insp.get_columns("workflow_records")}
        for col_name, col_type in [
            ("is_enabled", "VARCHAR(16)"),
            ("is_service", "VARCHAR(16)"),
            ("suspend_on_error", "VARCHAR(16)"),
            ("server_name", "VARCHAR(256)"),
            ("description", "TEXT"),
            ("schedule_info_json", "TEXT"),
            ("workflow_variables_json", "TEXT"),
            ("task_edges_count", "INTEGER DEFAULT 0"),
            ("conditional_links_count", "INTEGER DEFAULT 0"),
        ]:
            if col_name not in wf_cols:
                with engine.begin() as conn:
                    conn.execute(sa_text(f"ALTER TABLE workflow_records ADD COLUMN {col_name} {col_type}"))
                    logger.info("Migrated: added %s column to workflow_records", col_name)

    # Phase 7 (V7): Migrate transform_records for new columns
    if "transform_records" in insp.get_table_names():
        tr_cols = {col["name"] for col in insp.get_columns("transform_records")}
        for col_name, col_type in [
            ("is_reusable", "VARCHAR(16)"),
            ("component_version", "VARCHAR(64)"),
            ("description", "TEXT"),
        ]:
            if col_name not in tr_cols:
                with engine.begin() as conn:
                    conn.execute(sa_text(f"ALTER TABLE transform_records ADD COLUMN {col_name} {col_type}"))
                    logger.info("Migrated: added %s column to transform_records", col_name)

    # Phase 7 (V7): Migrate session_code_profiles for new function category columns
    if "session_code_profiles" in insp.get_table_names():
        scp_cols = {col["name"] for col in insp.get_columns("session_code_profiles")}
        for col_name, col_type in [
            ("analytic_function_count", "INTEGER DEFAULT 0"),
            ("financial_function_count", "INTEGER DEFAULT 0"),
            ("binary_function_count", "INTEGER DEFAULT 0"),
            ("encoding_function_count", "INTEGER DEFAULT 0"),
            ("encryption_function_count", "INTEGER DEFAULT 0"),
        ]:
            if col_name not in scp_cols:
                with engine.begin() as conn:
                    conn.execute(sa_text(f"ALTER TABLE session_code_profiles ADD COLUMN {col_name} {col_type}"))
                    logger.info("Migrated: added %s column to session_code_profiles", col_name)


# ── Public API ────────────────────────────────────────────────────────────

def init_db() -> None:
    """Create all tables if they don't exist, then run additive migrations.

    Called once during application startup (see ``main.py`` lifespan hook).
    Safe to call repeatedly -- ``create_all`` is a no-op for existing tables.
    Handles concurrent worker startup gracefully (DuplicateTable is ignored).
    """
    try:
        Base.metadata.create_all(bind=engine)
    except Exception as e:
        if "already exists" in str(e).lower() or "DuplicateTable" in type(e).__name__:
            logger.info("Tables already exist (concurrent worker startup) — skipping create_all")
        else:
            raise
    _migrate_db()


def get_db():
    """FastAPI dependency that provides a scoped DB session.

    Usage in a router::

        @router.get("/example")
        def example(db: Session = Depends(get_db)):
            ...

    The session is closed automatically after the request completes.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
