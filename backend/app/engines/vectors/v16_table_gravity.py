"""V16 Table Gravity Score — identifies hub tables via reader/writer/lookup gravity.

Gravity = reader_count * writer_count * (1 + lookup_count).
Hub tables (top 5%) need special migration attention.
"""

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class TableGravityResult:
    tables: list[dict] = field(default_factory=list)
    hub_tables: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"assignments": self.tables, "hub_tables": self.hub_tables}


class TableGravityVector:
    def run(self, features, tier_data, **kwargs) -> TableGravityResult:
        result = TableGravityResult()
        # Count readers, writers, lookups per table
        table_readers: dict[str, int] = {}
        table_writers: dict[str, int] = {}
        table_lookups: dict[str, int] = {}
        for f in features:
            for t in f.source_tables:
                table_readers[t] = table_readers.get(t, 0) + 1
            for t in f.target_tables:
                table_writers[t] = table_writers.get(t, 0) + 1
            for t in f.lookup_tables:
                table_lookups[t] = table_lookups.get(t, 0) + 1
        all_tables = set(table_readers) | set(table_writers) | set(table_lookups)
        gravity_scores = []
        for t in all_tables:
            r = table_readers.get(t, 0)
            w = table_writers.get(t, 0)
            l = table_lookups.get(t, 0)
            gravity = r * w * (1 + l)
            gravity_scores.append({
                "session_id": t,  # using table name as ID
                "cluster_id": 0,
                "table_name": t,
                "reader_count": r,
                "writer_count": w,
                "lookup_count": l,
                "gravity_score": gravity,
            })
        gravity_scores.sort(key=lambda x: x["gravity_score"], reverse=True)
        # Mark top 5% as hubs
        hub_count = max(1, len(gravity_scores) // 20)
        for i, gs in enumerate(gravity_scores):
            gs["is_hub"] = i < hub_count
            gs["cluster_id"] = 0 if gs["is_hub"] else 1
        result.tables = gravity_scores
        result.hub_tables = [gs["table_name"] for gs in gravity_scores[:hub_count]]
        logger.info("V16 Table Gravity: %d tables, %d hubs", len(gravity_scores), hub_count)
        return result
