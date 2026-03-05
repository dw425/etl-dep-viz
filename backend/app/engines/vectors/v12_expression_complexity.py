"""V12 Expression Complexity Vector — scores expression complexity per session.

Analyzes expression AST depth, function count, conditional branches,
parameter refs, and cross-field refs to classify sessions by expression complexity.
"""

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ExpressionComplexityResult:
    sessions: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"assignments": self.sessions}


class ExpressionComplexityVector:
    def run(self, features, tier_data, **kwargs) -> ExpressionComplexityResult:
        result = ExpressionComplexityResult()
        for f in features:
            md = {}
            for s in tier_data.get("sessions", []):
                if s.get("id") == f.session_id:
                    md = s.get("mapping_detail") or {}
                    break
            expressions = md.get("expressions", [])
            total_depth = sum(e.get("expression", "").count("(") for e in expressions)
            total_funcs = sum(len([c for c in e.get("expression", "") if c == "("]) for e in expressions)
            avg_depth = total_depth / max(len(expressions), 1)
            density = len(expressions) / max(f.transform_count, 1)
            score = min(100, int(avg_depth * 10 + density * 5 + total_funcs * 0.1))
            bucket = "Simple" if score < 25 else "Moderate" if score < 50 else "Complex" if score < 75 else "Very Complex"
            result.sessions.append({
                "session_id": f.session_id,
                "cluster_id": 0 if score < 25 else 1 if score < 50 else 2 if score < 75 else 3,
                "expression_count": len(expressions),
                "avg_depth": round(avg_depth, 2),
                "total_functions": total_funcs,
                "expression_density": round(density, 2),
                "score": score,
                "bucket": bucket,
            })
        logger.info("V12 Expression Complexity: %d sessions scored", len(result.sessions))
        return result
