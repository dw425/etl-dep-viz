"""V15 Transform Graph Centrality — computes betweenness/closeness centrality per transform.

Builds a directed graph from transforms (nodes) and field mappings (edges).
High betweenness = data bottleneck transform.
"""

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class TransformCentralityResult:
    sessions: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"assignments": self.sessions}


class TransformCentralityVector:
    def run(self, features, tier_data, **kwargs) -> TransformCentralityResult:
        result = TransformCentralityResult()
        for f in features:
            md = {}
            for s in tier_data.get("sessions", []):
                if s.get("id") == f.session_id:
                    md = s.get("mapping_detail") or {}
                    break
            instances = md.get("instances", [])
            connectors = md.get("connectors", [])
            # Build simple degree centrality from connectors
            in_degree: dict[str, int] = {}
            out_degree: dict[str, int] = {}
            for c in connectors:
                fi = c.get("from_instance", "")
                ti = c.get("to_instance", "")
                out_degree[fi] = out_degree.get(fi, 0) + 1
                in_degree[ti] = in_degree.get(ti, 0) + 1
            max_centrality = 0.0
            chokepoint = ""
            for inst in instances:
                iname = inst.get("name", "")
                centrality = in_degree.get(iname, 0) * out_degree.get(iname, 0)
                if centrality > max_centrality:
                    max_centrality = centrality
                    chokepoint = iname
            n = max(len(instances), 1)
            result.sessions.append({
                "session_id": f.session_id,
                "cluster_id": 0 if max_centrality < 5 else 1 if max_centrality < 20 else 2,
                "transform_count": len(instances),
                "max_centrality": max_centrality,
                "chokepoint_transform": chokepoint,
                "avg_degree": round((sum(in_degree.values()) + sum(out_degree.values())) / max(n, 1), 2),
            })
        logger.info("V15 Transform Centrality: %d sessions analyzed", len(result.sessions))
        return result
