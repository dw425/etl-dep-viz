"""V9 Wave Function — BFS propagation with amplitude decay.

Simulates failure cascade propagation through the dependency graph.
Computes blast radius, criticality scores, and what-if analysis.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None

try:
    from scipy import sparse
except ImportError:
    sparse = None


@dataclass
class SessionCriticality:
    session_id: str
    blast_radius: int
    chain_depth: int
    criticality_score: float
    amplification_factor: float
    criticality_tier: int  # 1-5
    forward_reach: list[str] = field(default_factory=list)
    backward_reach: list[str] = field(default_factory=list)


@dataclass
class WaveFunctionResult:
    sessions: list[SessionCriticality] = field(default_factory=list)
    fluctuation_data: list[dict[str, Any]] = field(default_factory=list)
    max_blast_radius: int = 0
    avg_criticality: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "sessions": [
                {
                    "session_id": s.session_id,
                    "blast_radius": s.blast_radius,
                    "chain_depth": s.chain_depth,
                    "criticality_score": round(s.criticality_score, 3),
                    "amplification_factor": round(s.amplification_factor, 3),
                    "criticality_tier": s.criticality_tier,
                    "forward_reach": s.forward_reach[:20],
                    "backward_reach": s.backward_reach[:20],
                }
                for s in self.sessions
            ],
            "fluctuation_data": self.fluctuation_data,
            "max_blast_radius": self.max_blast_radius,
            "avg_criticality": round(self.avg_criticality, 3),
        }


class WaveFunctionVector:
    """V9: BFS cascade propagation for criticality analysis."""

    DECAY_FACTOR = 0.7
    CRITICALITY_TIERS = {1: (0, 20), 2: (20, 40), 3: (40, 60), 4: (60, 80), 5: (80, 100)}

    def run(
        self,
        adjacency,
        session_ids: list[str],
        complexity_scores: dict[str, float] | None = None,
    ) -> WaveFunctionResult:
        if np is None:
            raise ImportError("numpy is required for WaveFunctionVector. Install it with: pip install numpy")
        if sparse is None:
            raise ImportError("scipy is required for WaveFunctionVector. Install it with: pip install scipy")
        n = len(session_ids)
        if n == 0:
            return WaveFunctionResult()

        # Build forward and backward adjacency lists
        forward: dict[int, list[int]] = {i: [] for i in range(n)}
        backward: dict[int, list[int]] = {i: [] for i in range(n)}
        cx = adjacency.tocoo()
        for i, j in zip(cx.row, cx.col):
            if i != j:
                forward[int(i)].append(int(j))
                backward[int(j)].append(int(i))

        # Compute mass (complexity) per node
        mass = np.ones(n, dtype=np.float64)
        if complexity_scores:
            for i, sid in enumerate(session_ids):
                if sid in complexity_scores:
                    mass[i] = max(1.0, complexity_scores[sid] / 50.0)

        sessions = []
        all_fluctuation = []

        for i in range(n):
            # Forward BFS
            fwd_reach, fwd_depth, fwd_fluct = self._bfs_propagate(i, forward, mass, n)
            # Backward BFS
            bwd_reach, bwd_depth, _ = self._bfs_propagate(i, backward, mass, n)

            blast_radius = len(fwd_reach) + len(bwd_reach)
            chain_depth = max(fwd_depth, bwd_depth)

            # Criticality = weighted combination of blast radius + depth + mass
            crit_raw = (
                0.4 * (blast_radius / max(n, 1))
                + 0.3 * (chain_depth / max(n, 1))
                + 0.3 * (float(mass[i]) / max(float(mass.max()), 1.0))
            ) * 100.0

            # Amplification = ratio of blast radius to direct connections
            direct = len(forward[i]) + len(backward[i])
            amplification = blast_radius / max(direct, 1)

            tier = self._assign_tier(crit_raw)

            sessions.append(SessionCriticality(
                session_id=session_ids[i],
                blast_radius=blast_radius,
                chain_depth=chain_depth,
                criticality_score=min(100.0, crit_raw),
                amplification_factor=amplification,
                criticality_tier=tier,
                forward_reach=[session_ids[j] for j in fwd_reach],
                backward_reach=[session_ids[j] for j in bwd_reach],
            ))

            # Store fluctuation for top sessions (limit to avoid huge payloads)
            if blast_radius > n * 0.1 and len(all_fluctuation) < 50:
                all_fluctuation.append({
                    "session_id": session_ids[i],
                    "amplitudes": fwd_fluct,
                })

        max_br = max((s.blast_radius for s in sessions), default=0)
        avg_crit = sum(s.criticality_score for s in sessions) / max(len(sessions), 1)

        return WaveFunctionResult(
            sessions=sessions,
            fluctuation_data=all_fluctuation,
            max_blast_radius=max_br,
            avg_criticality=avg_crit,
        )

    def what_if_failure(
        self,
        session_id: str,
        adjacency,
        session_ids: list[str],
    ) -> dict[str, Any]:
        """Simulate failure of a specific session and return cascade impact."""
        if session_id not in session_ids:
            return {"error": f"Session {session_id} not found"}

        n = len(session_ids)
        idx = session_ids.index(session_id)

        forward: dict[int, list[int]] = {i: [] for i in range(n)}
        cx = adjacency.tocoo()
        for i, j in zip(cx.row, cx.col):
            if i != j:
                forward[int(i)].append(int(j))

        mass = np.ones(n, dtype=np.float64)
        reached, depth, fluct = self._bfs_propagate(idx, forward, mass, n)

        # Group reached by hop distance
        hop_groups: dict[int, list[str]] = {}
        visited = {idx: 0}
        queue = deque([(idx, 0)])
        while queue:
            node, dist = queue.popleft()
            for nxt in forward.get(node, []):
                if nxt not in visited:
                    visited[nxt] = dist + 1
                    queue.append((nxt, dist + 1))
                    hop_groups.setdefault(dist + 1, []).append(session_ids[nxt])

        return {
            "source_session": session_id,
            "blast_radius": len(reached),
            "max_depth": depth,
            "affected_sessions": [session_ids[j] for j in reached],
            "hop_breakdown": {str(k): v for k, v in sorted(hop_groups.items())},
            "amplitude_decay": fluct,
        }

    def _bfs_propagate(
        self,
        start: int,
        adj: dict[int, list[int]],
        mass,
        n: int,
    ) -> tuple[list[int], int, list[dict[str, float]]]:
        """BFS with amplitude decay. Returns (reached_nodes, max_depth, fluctuation)."""
        visited = {start}
        queue = deque([(start, 0, 1.0)])
        reached = []
        max_depth = 0
        fluctuation = [{"hop": 0, "amplitude": 1.0, "cumulative_nodes": 1}]

        while queue:
            node, depth, amplitude = queue.popleft()
            max_depth = max(max_depth, depth)

            for nxt in adj.get(node, []):
                if nxt not in visited:
                    visited.add(nxt)
                    reached.append(nxt)
                    new_amp = amplitude * self.DECAY_FACTOR * float(mass[nxt])
                    if new_amp > 0.01:
                        queue.append((nxt, depth + 1, new_amp))
                        fluctuation.append({
                            "hop": depth + 1,
                            "amplitude": round(new_amp, 4),
                            "cumulative_nodes": len(reached),
                        })

        return reached, max_depth, fluctuation

    def _assign_tier(self, score: float) -> int:
        for tier, (low, high) in self.CRITICALITY_TIERS.items():
            if low <= score < high:
                return tier
        return 5
