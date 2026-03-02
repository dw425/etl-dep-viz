"""Centrality metrics — PageRank, betweenness, degree, k-core.

Computes composite importance scores for semantic zoom filtering.
Used to rank sessions by structural importance in the dependency graph,
enabling the frontend to progressively reveal nodes as users zoom in.

Composite Score Formula (weighted average of 4 normalized metrics):
  0.35 * PageRank        — probability of random walk visiting this node
  0.25 * Betweenness     — fraction of shortest paths passing through this node
  0.20 * Degree          — fraction of total nodes this node connects to
  0.20 * K-Core          — deepest core decomposition layer containing this node
"""

from __future__ import annotations

from typing import Any

import networkx as nx

try:
    from scipy import sparse
except ImportError:
    sparse = None


def compute_centrality_metrics(
    adjacency,
    session_ids: list[str],
) -> dict[str, Any]:
    """Compute centrality metrics for each session.

    Args:
        adjacency: Sparse CSR adjacency matrix from FeatureMatrixBuilder.
        session_ids: Ordered session ID list matching matrix row indices.

    Returns:
        Dict with 'metrics' (per-metric raw scores keyed by session_id)
        and 'composite' (weighted importance score per session_id, 0-1 range).
    """
    if sparse is None:
        raise ImportError("scipy is required for compute_centrality_metrics. Install it with: pip install scipy")
    n = len(session_ids)
    if n == 0:
        return {"metrics": {}, "composite": {}}

    # Build directed graph
    G = nx.DiGraph()
    G.add_nodes_from(range(n))
    cx = adjacency.tocoo()
    for i, j, w in zip(cx.row, cx.col, cx.data):
        if i != j:
            G.add_edge(i, j, weight=float(w))

    # PageRank
    try:
        pr = nx.pagerank(G, weight="weight")
    except (nx.NetworkXError, ZeroDivisionError):
        pr = {i: 1.0 / n for i in range(n)}

    # Betweenness (normalized)
    try:
        bc = nx.betweenness_centrality(G, weight="weight", normalized=True)
    except nx.NetworkXError:
        bc = {i: 0.0 for i in range(n)}

    # Degree centrality
    dc = nx.degree_centrality(G)

    # K-core
    G_undir = G.to_undirected()
    try:
        kcore = nx.core_number(G_undir)
    except nx.NetworkXError:
        kcore = {i: 0 for i in range(n)}

    # Normalize each metric to [0, 1]
    def _normalize(d: dict[int, float]) -> dict[int, float]:
        vals = list(d.values())
        vmin, vmax = min(vals), max(vals)
        rng = vmax - vmin
        if rng == 0:
            return {k: 0.5 for k in d}
        return {k: (v - vmin) / rng for k, v in d.items()}

    pr_norm = _normalize(pr)
    bc_norm = _normalize(bc)
    dc_norm = _normalize(dc)
    kc_norm = _normalize({k: float(v) for k, v in kcore.items()})

    # Composite importance: weighted average
    composite = {}
    for i in range(n):
        score = (
            0.35 * pr_norm.get(i, 0)
            + 0.25 * bc_norm.get(i, 0)
            + 0.20 * dc_norm.get(i, 0)
            + 0.20 * kc_norm.get(i, 0)
        )
        composite[session_ids[i]] = round(score, 4)

    metrics = {
        "pagerank": {session_ids[i]: round(pr.get(i, 0), 6) for i in range(n)},
        "betweenness": {session_ids[i]: round(bc.get(i, 0), 6) for i in range(n)},
        "degree": {session_ids[i]: round(dc.get(i, 0), 6) for i in range(n)},
        "kcore": {session_ids[i]: kcore.get(i, 0) for i in range(n)},
    }

    return {
        "metrics": metrics,
        "composite": composite,
    }
