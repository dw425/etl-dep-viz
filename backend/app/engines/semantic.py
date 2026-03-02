"""Semantic Layer — business terminology translation for technical ETL objects.

Provides a toggle between technical names and business-friendly labels
for sessions, tables, and domains across all 6 navigation layers.

Usage:
  1. Load mappings from a JSON upload or API call into SemanticConfig.
  2. Create SemanticToggle(config).
  3. Call translate_session/translate_table/translate_domain for individual lookups,
     or apply_to_tier_data() to enrich an entire tier_data dict with business_name
     fields (non-destructive: adds fields, does not replace technical names).

Mapping Categories:
  - domain_labels:        V2 hierarchical domain IDs -> business domain names
  - table_glossary:       table names (case-insensitive) -> business descriptions
  - session_descriptions: session names -> business process descriptions
  - system_labels:        system IDs (from infrastructure.py) -> display names

Unmapped names pass through unchanged (identity translation).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SemanticConfig:
    """Business terminology mappings loaded from JSON or API upload."""

    domain_labels: dict[str, str] = field(default_factory=dict)
    table_glossary: dict[str, str] = field(default_factory=dict)
    session_descriptions: dict[str, str] = field(default_factory=dict)
    system_labels: dict[str, str] = field(default_factory=dict)


class SemanticToggle:
    """Translate technical names to business-friendly labels."""

    def __init__(self, config: SemanticConfig | None = None):
        self.config = config or SemanticConfig()

    def translate_session(self, session_name: str) -> str:
        """Translate session name to business description."""
        return self.config.session_descriptions.get(session_name, session_name)

    def translate_table(self, table_name: str) -> str:
        """Translate table name to business glossary term."""
        return self.config.table_glossary.get(table_name.upper(), table_name)

    def translate_domain(self, domain_id: str) -> str:
        """Translate domain ID to business domain label."""
        return self.config.domain_labels.get(str(domain_id), f"Domain {domain_id}")

    def translate_system(self, system_id: str) -> str:
        """Translate system ID to business system name."""
        return self.config.system_labels.get(system_id, system_id.replace("_", " ").title())

    def apply_to_tier_data(self, tier_data: dict[str, Any]) -> dict[str, Any]:
        """Create a copy of tier_data with translated labels."""
        result = dict(tier_data)

        sessions = []
        for s in tier_data.get("sessions", []):
            sc = dict(s)
            translated = self.translate_session(sc.get("name", ""))
            if translated != sc.get("name", ""):
                sc["business_name"] = translated
            sessions.append(sc)
        result["sessions"] = sessions

        tables = []
        for t in tier_data.get("tables", []):
            tc = dict(t)
            translated = self.translate_table(tc.get("name", ""))
            if translated != tc.get("name", ""):
                tc["business_name"] = translated
            tables.append(tc)
        result["tables"] = tables

        return result

    def to_dict(self) -> dict[str, Any]:
        return {
            "domain_labels": self.config.domain_labels,
            "table_glossary": self.config.table_glossary,
            "session_descriptions": self.config.session_descriptions,
            "system_labels": self.config.system_labels,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SemanticToggle":
        config = SemanticConfig(
            domain_labels=data.get("domain_labels", {}),
            table_glossary=data.get("table_glossary", {}),
            session_descriptions=data.get("session_descriptions", {}),
            system_labels=data.get("system_labels", {}),
        )
        return cls(config)
