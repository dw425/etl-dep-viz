"""Infrastructure graph — system-level topology from connection analysis.

Aggregates session connections into system nodes (Oracle, Teradata, S3, etc.)
with edge thickness proportional to session count.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from app.engines.vectors.feature_extractor import SessionFeatures


@dataclass
class SystemNode:
    system_id: str
    name: str
    system_type: str  # oracle, teradata, s3, kafka, hdfs, etc.
    environment: str  # on-prem, aws, azure, gcp, third-party
    session_count: int = 0
    table_count: int = 0
    tables: list[str] = field(default_factory=list)


@dataclass
class SystemEdge:
    from_system: str
    to_system: str
    session_count: int = 0
    session_ids: list[str] = field(default_factory=list)
    direction: str = "forward"  # forward, bidirectional


def build_infrastructure_graph(
    features: list[SessionFeatures],
    connection_map: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build system-level infrastructure graph.

    Args:
        features: SessionFeatures from feature_extractor
        connection_map: Optional explicit table→system mapping

    Returns:
        Dict with systems, edges, and environment groupings.
    """
    # Infer system from table names
    table_to_system: dict[str, str] = {}
    if connection_map:
        table_to_system.update(connection_map)

    # Auto-detect systems from table name patterns
    all_tables: set[str] = set()
    for f in features:
        all_tables.update(f.source_tables)
        all_tables.update(f.target_tables)
        all_tables.update(f.lookup_tables)

    for table in all_tables:
        if table not in table_to_system:
            table_to_system[table] = _infer_system(table)

    # Build system nodes
    system_tables: dict[str, set[str]] = defaultdict(set)
    system_sessions: dict[str, set[str]] = defaultdict(set)

    for f in features:
        session_systems: set[str] = set()
        for t in set(f.source_tables) | set(f.target_tables) | set(f.lookup_tables):
            sys = table_to_system.get(t, "unknown")
            system_tables[sys].add(t)
            system_sessions[sys].add(f.session_id)
            session_systems.add(sys)

    systems = []
    for sys_name, tables in sorted(system_tables.items()):
        systems.append(SystemNode(
            system_id=sys_name,
            name=sys_name.replace("_", " ").title(),
            system_type=sys_name,
            environment=_infer_environment(sys_name),
            session_count=len(system_sessions[sys_name]),
            table_count=len(tables),
            tables=sorted(tables)[:50],
        ))

    # Build edges: session connects source-system → target-system
    edge_map: dict[tuple[str, str], set[str]] = defaultdict(set)
    for f in features:
        source_systems = {table_to_system.get(t, "unknown") for t in f.source_tables}
        target_systems = {table_to_system.get(t, "unknown") for t in f.target_tables}

        for ss in source_systems:
            for ts in target_systems:
                if ss != ts:
                    edge_map[(ss, ts)].add(f.session_id)

    edges = []
    for (src, dst), sids in sorted(edge_map.items()):
        edges.append(SystemEdge(
            from_system=src,
            to_system=dst,
            session_count=len(sids),
            session_ids=sorted(sids)[:100],
        ))

    # Environment grouping
    env_groups: dict[str, list[str]] = defaultdict(list)
    for sys in systems:
        env_groups[sys.environment].append(sys.system_id)

    return {
        "systems": [
            {
                "system_id": s.system_id,
                "name": s.name,
                "system_type": s.system_type,
                "environment": s.environment,
                "session_count": s.session_count,
                "table_count": s.table_count,
                "tables": s.tables,
            }
            for s in systems
        ],
        "edges": [
            {
                "from_system": e.from_system,
                "to_system": e.to_system,
                "session_count": e.session_count,
                "session_ids": e.session_ids,
            }
            for e in edges
        ],
        "environment_groups": dict(env_groups),
    }


_SYSTEM_PATTERNS = {
    "oracle": ["ora_", "oracle_", "dblink", "ownername.", "v$", "dba_", "all_tab"],
    "teradata": ["td_", "tera_", "teradata", "pdcrdata", "dbc."],
    "s3": ["s3://", "s3_", "aws_"],
    "hdfs": ["hdfs://", "hdfs_", "/user/", "/warehouse/"],
    "kafka": ["kafka_", "topic_", "kafka."],
    "postgresql": ["pg_", "postgres", "psql_"],
    "mysql": ["mysql_"],
    "sqlserver": ["mssql", "sqlsrv", "dbo.", "[dbo]"],
    "db2": ["db2_", "sysibm"],
    "hive": ["hive_", "metastore"],
    "snowflake": ["snowflake", "sf_"],
    "bigquery": ["bq_", "bigquery", "dataset."],
    "redshift": ["rs_", "redshift"],
    "azure_sql": ["azure_", "azuresql"],
    "ftp": ["ftp_", "sftp_"],
    "file": ["file_", "flat_file", "csv_", ".csv", ".txt", ".dat"],
}


def _infer_system(table_name: str) -> str:
    """Infer system type from table name patterns."""
    lower = table_name.lower()
    for system, patterns in _SYSTEM_PATTERNS.items():
        for pattern in patterns:
            if pattern in lower:
                return system
    return "database"


def _infer_environment(system_type: str) -> str:
    """Infer deployment environment from system type."""
    cloud_aws = {"s3", "redshift", "emr", "glue"}
    cloud_azure = {"azure_sql", "synapse", "adls"}
    cloud_gcp = {"bigquery", "dataflow", "gcs"}
    on_prem = {"oracle", "teradata", "db2", "sqlserver", "file", "ftp"}

    if system_type in cloud_aws:
        return "aws"
    if system_type in cloud_azure:
        return "azure"
    if system_type in cloud_gcp:
        return "gcp"
    if system_type in on_prem:
        return "on-prem"
    return "other"
