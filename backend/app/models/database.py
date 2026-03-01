"""SQLAlchemy models + engine setup for upload persistence."""

import json
import logging
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Float, ForeignKey, Index, Integer, String, Text, create_engine, inspect
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class Project(Base):
    """Top-level project container — groups uploads and all derived data."""

    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(256), nullable=False)
    description = Column(Text, nullable=True)
    user_id = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    uploads = relationship("Upload", back_populates="project", cascade="all, delete-orphan")


class Upload(Base):
    """Stores parsed tier_data + constellation results so users don't re-parse."""

    __tablename__ = "uploads"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
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

    project = relationship("Project", back_populates="uploads")

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


# ── Normalized relational models (Wave 5) ─────────────────────────────────────

class SessionRecord(Base):
    """Normalized session record — one row per parsed ETL session."""

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

    __table_args__ = (
        Index("ix_session_upload", "upload_id"),
        Index("ix_session_tier", "upload_id", "tier"),
        Index("ix_session_name", "upload_id", "full_name"),
    )


class TableRecord(Base):
    """Normalized table record — one row per table in the dependency graph."""

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
    """Normalized connection record — one row per edge in the dependency graph."""

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
    """Connection profile — database connection metadata from parsed XML."""

    __tablename__ = "connection_profiles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(512), nullable=False)
    dbtype = Column(String(64), nullable=True)
    dbsubtype = Column(String(64), nullable=True)
    connection_string = Column(Text, nullable=True)

    __table_args__ = (Index("ix_connprof_upload", "upload_id"),)


# ── Per-View Materialized Tables ─────────────────────────────────────────────
# Each visualization view gets its own dedicated table(s), populated during
# parse/analysis so views query their own table for fast, independent rendering.

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

    __table_args__ = (Index("ix_vwtier_upload", "upload_id"),)


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

    __table_args__ = (Index("ix_vwmatrix_upload", "upload_id"),)


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

    __table_args__ = (Index("ix_vwpoint_upload", "upload_id"),)


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
    """Materialized view: V11 complexity scores per session."""

    __tablename__ = "vw_complexity_scores"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    name = Column(String(512), nullable=False)
    tier = Column(Float, nullable=True)
    overall_score = Column(Float, default=0.0)
    bucket = Column(String(16), nullable=True)  # 'low', 'medium', 'high', 'critical'
    d1_raw = Column(Float, default=0.0)
    d2_raw = Column(Float, default=0.0)
    d3_raw = Column(Float, default=0.0)
    d4_raw = Column(Float, default=0.0)
    d5_raw = Column(Float, default=0.0)
    d6_raw = Column(Float, default=0.0)
    d7_raw = Column(Float, default=0.0)
    d8_raw = Column(Float, default=0.0)
    d1_norm = Column(Float, default=0.0)
    d2_norm = Column(Float, default=0.0)
    d3_norm = Column(Float, default=0.0)
    d4_norm = Column(Float, default=0.0)
    d5_norm = Column(Float, default=0.0)
    d6_norm = Column(Float, default=0.0)
    d7_norm = Column(Float, default=0.0)
    d8_norm = Column(Float, default=0.0)
    hours_low = Column(Float, default=0.0)
    hours_high = Column(Float, default=0.0)
    top_drivers_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_vwcomplexity_upload", "upload_id"),
        Index("ix_vwcomplexity_bucket", "upload_id", "bucket"),
    )


class VwWaveAssignments(Base):
    """Materialized view: V4 wave plan assignments per session."""

    __tablename__ = "vw_wave_assignments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    name = Column(String(512), nullable=False)
    wave_number = Column(Integer, nullable=False)
    scc_group_id = Column(Integer, nullable=True)
    is_cycle = Column(Integer, default=0)

    __table_args__ = (Index("ix_vwwave_upload", "upload_id"),)


class VwUmapCoords(Base):
    """Materialized view: V3 UMAP 2D coordinates per session."""

    __tablename__ = "vw_umap_coords"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    scale = Column(String(16), nullable=False, default="balanced")  # local, balanced, global
    x = Column(Float, nullable=False)
    y = Column(Float, nullable=False)
    cluster_id = Column(Integer, nullable=True)

    __table_args__ = (Index("ix_vwumap_upload", "upload_id"),)


class VwCommunities(Base):
    """Materialized view: V1 community assignments (macro/meso/micro)."""

    __tablename__ = "vw_communities"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    macro_id = Column(Integer, nullable=True)
    meso_id = Column(Integer, nullable=True)
    micro_id = Column(Integer, nullable=True)

    __table_args__ = (Index("ix_vwcomm_upload", "upload_id"),)


class VwWaveFunction(Base):
    """Materialized view: V9 wave function simulation scores."""

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

    __table_args__ = (Index("ix_vwwavefn_upload", "upload_id"),)


class VwConcentrationGroups(Base):
    """Materialized view: V10 concentration analysis groups."""

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
    """Materialized view: V10 concentration group members."""

    __tablename__ = "vw_concentration_members"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    group_id = Column(String(64), nullable=False)
    is_medoid = Column(Integer, default=0)
    independence_type = Column(String(32), nullable=True)
    confidence = Column(Float, default=0.0)

    __table_args__ = (Index("ix_vwconcmem_upload", "upload_id"),)


class VwEnsemble(Base):
    """Materialized view: V8 ensemble consensus clustering."""

    __tablename__ = "vw_ensemble"

    id = Column(Integer, primary_key=True, autoincrement=True)
    upload_id = Column(Integer, ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    consensus_cluster = Column(Integer, nullable=True)
    consensus_score = Column(Float, default=0.0)
    per_vector_json = Column(Text, nullable=True)
    is_contested = Column(Integer, default=0)

    __table_args__ = (Index("ix_vwensemble_upload", "upload_id"),)


def _migrate_db() -> None:
    """Add missing columns to existing databases (lightweight ALTER TABLE migration)."""
    from sqlalchemy import text as sa_text
    insp = inspect(engine)
    if "uploads" not in insp.get_table_names():
        return
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

    # Migrate uploads for project_id
    if "project_id" not in existing:
        with engine.begin() as conn:
            conn.execute(sa_text("ALTER TABLE uploads ADD COLUMN project_id INTEGER REFERENCES projects(id)"))
            logger.info("Migrated: added project_id column to uploads")

    # Migrate session_records for V3 columns
    if "session_records" in insp.get_table_names():
        sr_cols = {col["name"] for col in insp.get_columns("session_records")}
        with engine.begin() as conn:
            for col_name, col_type in [
                ("ext_reads", "INTEGER DEFAULT 0"),
                ("lookup_count", "INTEGER DEFAULT 0"),
                ("mapping_detail_json", "TEXT"),
                ("connections_used_json", "TEXT"),
            ]:
                if col_name not in sr_cols:
                    conn.execute(sa_text(f"ALTER TABLE session_records ADD COLUMN {col_name} {col_type}"))
                    logger.info("Migrated: added %s column to session_records", col_name)


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
