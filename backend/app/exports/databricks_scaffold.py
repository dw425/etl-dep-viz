"""Databricks notebook scaffolding export (Item 84).

Generates Python notebook cells for each session's ETL logic
based on the parsed tier data.
"""

from __future__ import annotations

from typing import Any


def generate_databricks_notebook(tier_data: dict) -> str:
    """Generate Databricks notebook Python script from tier data.

    Creates a cell-per-session structure with:
    - Source table reads
    - Transform placeholders
    - Target table writes
    """
    sessions = tier_data.get('sessions', [])
    lines = [
        '# Databricks notebook source',
        '# MAGIC %md',
        '# MAGIC # ETL Migration — Auto-Generated Notebook',
        f'# MAGIC Sessions: {len(sessions)}',
        '',
    ]

    # Sort by tier then step for execution order
    sorted_sessions = sorted(sessions, key=lambda s: (s.get('tier', 0), s.get('step', 0)))

    for s in sorted_sessions:
        sid = s.get('id', '')
        name = s.get('name', sid)
        tier = s.get('tier', 0)
        detail = s.get('mapping_detail', {})
        sources = detail.get('source_fields', [])
        targets = detail.get('target_fields', [])

        lines.append('# COMMAND ----------')
        lines.append('')
        lines.append(f'# MAGIC %md')
        lines.append(f'# MAGIC ## {name} (Tier {tier})')
        lines.append('')
        lines.append('# COMMAND ----------')
        lines.append('')

        # Source reads
        if sources:
            for src in sources:
                src_name = src.get('source', 'unknown_table')
                lines.append(f'# Read source: {src_name}')
                lines.append(f'df_{src_name.lower()} = spark.read.table("{src_name}")')
                lines.append('')
        else:
            lines.append(f'# TODO: Define source reads for {name}')
            lines.append(f'# df_source = spark.read.table("SOURCE_TABLE")')
            lines.append('')

        # Transform placeholder
        lines.append(f'# Transform logic for {name}')
        lines.append(f'# Transforms: {s.get("transforms", 0)} | Lookups: {s.get("lookupCount", 0)}')
        transform_count = s.get('transforms', 0)
        if transform_count > 5:
            lines.append(f'# WARNING: Complex session ({transform_count} transforms) — review carefully')
        lines.append(f'# df_result = df_source  # TODO: Implement transform logic')
        lines.append('')

        # Target writes
        if targets:
            for tgt in targets:
                tgt_name = tgt.get('target', 'unknown_table')
                lines.append(f'# Write target: {tgt_name}')
                lines.append(f'# df_result.write.mode("overwrite").saveAsTable("{tgt_name}")')
                lines.append('')
        else:
            lines.append(f'# TODO: Define target writes for {name}')
            lines.append(f'# df_result.write.mode("overwrite").saveAsTable("TARGET_TABLE")')
            lines.append('')

    return '\n'.join(lines)
