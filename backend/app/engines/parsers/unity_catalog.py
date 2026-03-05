"""Unity Catalog lineage ingestion parser.

Connects to Databricks system.access.table_lineage and system.access.column_lineage
tables via Databricks SDK or REST API. Maps UC lineage entries to the ETL Dependency
Visualizer's session/table/connection model.

Usage:
    parser = UnityCatalogParser(workspace_host, token)
    result = parser.parse(catalog="my_catalog")  # returns TierMapResult-compatible dict
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass, field

logger = logging.getLogger("edv.uc_parser")


@dataclass
class UCLineageResult:
    """Parsed Unity Catalog lineage data in TierMapResult-compatible format."""
    sessions: list[dict] = field(default_factory=list)
    tables: list[dict] = field(default_factory=list)
    connections: list[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


class UnityCatalogParser:
    """Parse Unity Catalog lineage into ETL dependency graph.

    Maps UC concepts to our model:
      - Notebook/Job task → Session
      - Table (catalog.schema.table) → Table
      - Lineage entry (source→target) → Connection (type=uc_lineage)
    """

    def __init__(self, workspace_host: str | None = None, token: str | None = None):
        self.workspace_host = workspace_host
        self.token = token

    def _get_credentials(self) -> tuple[str, str]:
        """Get workspace host and token, falling back to Databricks auth."""
        if self.workspace_host and self.token:
            return self.workspace_host, self.token
        from app.engines.databricks_auth import get_databricks_token
        return get_databricks_token()

    def _query_sql(self, sql: str) -> list[dict]:
        """Execute SQL via Databricks SQL Statement API."""
        host, token = self._get_credentials()
        url = f"{host}/api/2.0/sql/statements"
        payload = json.dumps({
            "statement": sql,
            "wait_timeout": "30s",
            "disposition": "INLINE",
        }).encode()
        req = urllib.request.Request(
            url, data=payload, method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
        )
        try:
            resp = urllib.request.urlopen(req, timeout=60)
            result = json.loads(resp.read())
            # Extract columns and data rows
            manifest = result.get("manifest", {})
            columns = [c["name"] for c in manifest.get("schema", {}).get("columns", [])]
            data_array = result.get("result", {}).get("data_array", [])
            return [dict(zip(columns, row)) for row in data_array]
        except Exception as exc:
            logger.error("UC SQL query failed: %s", exc)
            return []

    def parse(self, catalog: str | None = None, days: int = 30) -> UCLineageResult:
        """Fetch and parse Unity Catalog lineage data.

        Args:
            catalog: Filter to specific catalog (None = all).
            days: Look back N days for lineage events.

        Returns:
            UCLineageResult with sessions, tables, and connections.
        """
        result = UCLineageResult()

        # Query table-level lineage
        where = f"AND source_table_catalog = '{catalog}'" if catalog else ""
        sql = f"""
        SELECT DISTINCT
            source_table_catalog, source_table_schema, source_table_name,
            target_table_catalog, target_table_schema, target_table_name,
            source_type, target_type
        FROM system.access.table_lineage
        WHERE event_time > current_timestamp() - INTERVAL {days} DAYS
        {where}
        """
        rows = self._query_sql(sql)
        if not rows:
            logger.warning("No lineage data found (catalog=%s, days=%d)", catalog, days)
            return result

        # Build unique tables and connections
        tables_seen: dict[str, dict] = {}
        sessions_seen: dict[str, dict] = {}
        connections: list[dict] = []

        for row in rows:
            src_fqn = f"{row.get('source_table_catalog', '')}.{row.get('source_table_schema', '')}.{row.get('source_table_name', '')}"
            tgt_fqn = f"{row.get('target_table_catalog', '')}.{row.get('target_table_schema', '')}.{row.get('target_table_name', '')}"

            # Register tables
            for fqn in (src_fqn, tgt_fqn):
                if fqn not in tables_seen:
                    parts = fqn.split(".")
                    tables_seen[fqn] = {
                        "id": fqn,
                        "name": parts[-1] if parts else fqn,
                        "type": "delta",
                        "tier": 0,
                        "catalog": parts[0] if len(parts) > 0 else "",
                        "schema": parts[1] if len(parts) > 1 else "",
                    }

            # Create a synthetic session representing the lineage flow
            flow_id = f"uc_flow_{src_fqn}_to_{tgt_fqn}"
            if flow_id not in sessions_seen:
                sessions_seen[flow_id] = {
                    "id": flow_id,
                    "name": f"{row.get('source_table_name', '')}→{row.get('target_table_name', '')}",
                    "full": flow_id,
                    "tier": 0,
                    "transforms": 1,
                    "sources": [src_fqn],
                    "targets": [tgt_fqn],
                    "lookups": [],
                    "source_type": row.get("source_type", ""),
                    "target_type": row.get("target_type", ""),
                }

            # Source read connection
            connections.append({
                "from": src_fqn,
                "to": flow_id,
                "type": "source_read",
            })
            # Write connection
            connections.append({
                "from": flow_id,
                "to": tgt_fqn,
                "type": "write_clean",
            })

        result.sessions = list(sessions_seen.values())
        result.tables = list(tables_seen.values())
        result.connections = connections
        result.stats = {
            "lineage_rows": len(rows),
            "tables": len(tables_seen),
            "sessions": len(sessions_seen),
            "connections": len(connections),
        }
        logger.info("UC lineage: %d flows, %d tables from %d lineage rows",
                     len(sessions_seen), len(tables_seen), len(rows))
        return result
