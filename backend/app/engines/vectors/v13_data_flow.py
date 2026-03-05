"""V13 Data Flow Volume Estimator — estimates data volume at each transform stage.

Uses field count heuristics and transform type effects to build a data funnel per session.
"""

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Transform effects on data volume (multipliers)
_TRANSFORM_EFFECTS = {
    "filter": 0.5, "aggregator": 0.1, "router": 1.0,
    "joiner": 1.5, "lookup procedure": 1.2, "expression": 1.0,
    "source qualifier": 1.0, "target": 1.0, "sequence generator": 1.0,
}


@dataclass
class DataFlowResult:
    sessions: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"assignments": self.sessions}


class DataFlowVector:
    def run(self, features, tier_data, **kwargs) -> DataFlowResult:
        result = DataFlowResult()
        for f in features:
            source_volume = len(f.source_tables) * 100  # heuristic
            volume = float(source_volume)
            bottleneck = ""
            md = {}
            for s in tier_data.get("sessions", []):
                if s.get("id") == f.session_id:
                    md = s.get("mapping_detail") or {}
                    break
            for inst in md.get("instances", []):
                itype = (inst.get("type", "")).lower()
                for key, mult in _TRANSFORM_EFFECTS.items():
                    if key in itype:
                        prev = volume
                        volume *= mult
                        if mult < 0.5 and not bottleneck:
                            bottleneck = inst.get("name", "")
                        break
            funnel_ratio = volume / max(source_volume, 1)
            result.sessions.append({
                "session_id": f.session_id,
                "cluster_id": 0 if funnel_ratio > 0.5 else 1 if funnel_ratio > 0.1 else 2,
                "source_volume": source_volume,
                "output_volume": round(volume, 1),
                "funnel_ratio": round(funnel_ratio, 3),
                "bottleneck_transform": bottleneck,
            })
        logger.info("V13 Data Flow: %d sessions estimated", len(result.sessions))
        return result
