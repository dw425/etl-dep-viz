"""Delta Live Tables (DLT) pipeline parser.

Parses DLT pipeline definitions from Python/SQL source files. Extracts:
  - @dlt.table / @dlt.view decorator-defined tables
  - dlt.read / dlt.read_stream source references
  - Expectations: @dlt.expect, @dlt.expect_or_drop, @dlt.expect_or_fail
  - LIVE.table_name and STREAMING LIVE.table_name SQL references

Usage:
    parser = DLTParser()
    result = parser.parse_file("/path/to/pipeline.py")
    # or
    result = parser.parse_text(source_code, language="python")
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger("edv.dlt_parser")

# Python DLT patterns
_DLT_TABLE = re.compile(r'@dlt\.(?:table|view)\s*\(([^)]*)\)', re.MULTILINE)
_DLT_TABLE_NAME = re.compile(r'''name\s*=\s*['"]([\w.]+)['"]''')
_DLT_READ = re.compile(r'''dlt\.read\(['"]([\w.]+)['"]''')
_DLT_READ_STREAM = re.compile(r'''dlt\.read_stream\(['"]([\w.]+)['"]''')
_DLT_EXPECT = re.compile(r'''@dlt\.(expect|expect_or_drop|expect_or_fail)\s*\(\s*['"]([\w\s]+)['"]''')
_SPARK_TABLE = re.compile(r'''spark\.table\(['"]([\w.]+)['"]''')

# SQL DLT patterns
_SQL_CREATE_LIVE = re.compile(
    r'CREATE\s+(?:OR\s+REFRESH\s+)?(?:STREAMING\s+)?LIVE\s+TABLE\s+([\w.]+)',
    re.IGNORECASE,
)
_SQL_LIVE_REF = re.compile(r'(?:STREAMING\s+)?LIVE\.([\w.]+)', re.IGNORECASE)
_SQL_FROM = re.compile(r'FROM\s+([\w.]+)', re.IGNORECASE)


@dataclass
class DLTParseResult:
    """Parsed DLT pipeline in TierMapResult-compatible format."""
    sessions: list[dict] = field(default_factory=list)
    tables: list[dict] = field(default_factory=list)
    connections: list[dict] = field(default_factory=list)
    expectations: list[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


class DLTParser:
    """Parse DLT pipeline definitions into ETL dependency graph."""

    def parse_file(self, filepath: str) -> DLTParseResult:
        """Parse a DLT pipeline file (Python or SQL)."""
        with open(filepath, "r") as f:
            text = f.read()
        lang = "sql" if filepath.endswith(".sql") else "python"
        return self.parse_text(text, language=lang, source_file=filepath)

    def parse_text(
        self, text: str, language: str = "python", source_file: str = ""
    ) -> DLTParseResult:
        """Parse DLT pipeline source code.

        Args:
            text: Source code to parse.
            language: "python" or "sql".
            source_file: Optional source file path for identification.

        Returns:
            DLTParseResult with sessions, tables, connections, expectations.
        """
        if language == "sql":
            return self._parse_sql(text, source_file)
        return self._parse_python(text, source_file)

    def _parse_python(self, text: str, source_file: str) -> DLTParseResult:
        """Parse Python DLT definitions."""
        result = DLTParseResult()
        tables_seen: dict[str, dict] = {}
        connections: list[dict] = []

        # Find @dlt.table/@dlt.view definitions
        # Split text by function definitions to associate reads with tables
        lines = text.split("\n")
        current_table: str | None = None
        current_sources: list[str] = []

        for line in lines:
            # Check for @dlt.table or @dlt.view decorator
            table_match = _DLT_TABLE.search(line)
            if table_match:
                args = table_match.group(1)
                name_match = _DLT_TABLE_NAME.search(args)
                if name_match:
                    current_table = name_match.group(1)
                continue

            # Check for function def after decorator — use function name if no explicit name
            if current_table is None:
                func_match = re.match(r'\s*def\s+(\w+)\s*\(', line)
                if func_match and any(d in lines[max(0, lines.index(line) - 3):lines.index(line)]
                                      for d in ['@dlt.table', '@dlt.view']):
                    current_table = func_match.group(1)

            # Find dlt.read / dlt.read_stream / spark.table references
            for pattern in (_DLT_READ, _DLT_READ_STREAM, _SPARK_TABLE):
                for match in pattern.finditer(line):
                    ref = match.group(1)
                    current_sources.append(ref)
                    if ref not in tables_seen:
                        tables_seen[ref] = {
                            "id": ref, "name": ref.split(".")[-1],
                            "type": "delta", "tier": 0,
                        }

            # Find expectations
            for match in _DLT_EXPECT.finditer(line):
                result.expectations.append({
                    "type": match.group(1),
                    "name": match.group(2),
                    "table": current_table or "",
                })

            # Detect end of function (next def or class at same indentation)
            if current_table and re.match(r'^(?:def |class |\Z)', line):
                # Finalize current table definition
                session_id = f"dlt_{current_table}"
                if current_table not in tables_seen:
                    tables_seen[current_table] = {
                        "id": current_table, "name": current_table.split(".")[-1],
                        "type": "delta", "tier": 0,
                    }

                result.sessions.append({
                    "id": session_id,
                    "name": current_table,
                    "full": f"dlt.{current_table}",
                    "tier": 0,
                    "transforms": 1,
                    "sources": list(set(current_sources)),
                    "targets": [current_table],
                    "lookups": [],
                    "source_file": source_file,
                })

                for src in set(current_sources):
                    connections.append({"from": src, "to": session_id, "type": "source_read"})
                connections.append({"from": session_id, "to": current_table, "type": "write_clean"})

                current_table = None
                current_sources = []

        result.tables = list(tables_seen.values())
        result.connections = connections
        result.stats = {
            "tables_defined": len(result.sessions),
            "tables_referenced": len(tables_seen),
            "expectations": len(result.expectations),
            "connections": len(connections),
        }
        logger.info("DLT Python: %d tables, %d refs, %d expectations",
                     len(result.sessions), len(tables_seen), len(result.expectations))
        return result

    def _parse_sql(self, text: str, source_file: str) -> DLTParseResult:
        """Parse SQL DLT definitions."""
        result = DLTParseResult()
        tables_seen: dict[str, dict] = {}
        connections: list[dict] = []

        # Split by CREATE LIVE TABLE statements
        statements = re.split(r'(?=CREATE\s)', text, flags=re.IGNORECASE)

        for stmt in statements:
            create_match = _SQL_CREATE_LIVE.search(stmt)
            if not create_match:
                continue

            table_name = create_match.group(1)
            session_id = f"dlt_{table_name}"

            # Find LIVE.* references (source tables)
            sources = []
            for ref_match in _SQL_LIVE_REF.finditer(stmt):
                ref = ref_match.group(1)
                if ref != table_name:
                    sources.append(ref)
                    if ref not in tables_seen:
                        tables_seen[ref] = {
                            "id": ref, "name": ref.split(".")[-1],
                            "type": "delta", "tier": 0,
                        }

            # Also check FROM clauses for external tables
            for from_match in _SQL_FROM.finditer(stmt):
                ref = from_match.group(1)
                if ref != table_name and "LIVE" not in ref:
                    sources.append(ref)
                    if ref not in tables_seen:
                        tables_seen[ref] = {
                            "id": ref, "name": ref.split(".")[-1],
                            "type": "external", "tier": 0,
                        }

            if table_name not in tables_seen:
                tables_seen[table_name] = {
                    "id": table_name, "name": table_name.split(".")[-1],
                    "type": "delta", "tier": 0,
                }

            result.sessions.append({
                "id": session_id,
                "name": table_name,
                "full": f"dlt.{table_name}",
                "tier": 0,
                "transforms": 1,
                "sources": list(set(sources)),
                "targets": [table_name],
                "lookups": [],
                "source_file": source_file,
                "is_streaming": "STREAMING" in stmt.upper(),
            })

            for src in set(sources):
                connections.append({"from": src, "to": session_id, "type": "source_read"})
            connections.append({"from": session_id, "to": table_name, "type": "write_clean"})

        result.tables = list(tables_seen.values())
        result.connections = connections
        result.stats = {
            "tables_defined": len(result.sessions),
            "tables_referenced": len(tables_seen),
            "connections": len(connections),
        }
        logger.info("DLT SQL: %d tables, %d refs", len(result.sessions), len(tables_seen))
        return result
