"""Algorithm Lab Engine — extended clustering for the interactive playground.

Wraps the constellation engine's 6-phase pipeline with 10 clustering algorithms
(2 existing + 8 new) and quality metrics computation.

Algorithms:
  1. louvain         — Modularity-based (existing, resolution sweep)
  2. table_gravity   — Anchor-table clustering (existing)
  3. leiden          — Improved Louvain via leidenalg (optional dep, fallback to louvain)
  4. fluid           — Async fluid communities (networkx, user-specified k)
  5. walktrap        — Random walk distances + Ward linkage (scipy)
  6. infomap         — Information-theoretic flow-based (optional dep, fallback to louvain)
  7. chinese_whispers — Randomized weighted-vote label propagation
  8. sbm             — Spectral modularity matrix + KMeans
  9. ppr_cluster     — Personalized PageRank vectors + KMeans
  10. node2vec_kmeans — Random walk embeddings + SVD + KMeans
"""

from __future__ import annotations

import logging
import math
import random
import time as _time
from collections import defaultdict
from typing import Any

import networkx as nx
import numpy as np

from app.engines.constellation_engine import (
    _build_fingerprints,
    _build_similarity_graph,
    _compute_layout,
    _build_chunk_metadata,
    _find_cross_chunk_edges,
    _build_points,
    _merge_singletons,
    _assign_orphans,
    _cluster_louvain,
    _cluster_table_gravity,
)

logger = logging.getLogger(__name__)

# ── Algorithm registry ────────────────────────────────────────────────────────

LAB_ALGORITHMS: dict[str, dict[str, Any]] = {
    'louvain': {
        'name': 'Louvain',
        'desc': 'Modularity-based community detection with resolution sweep',
        'speed': 'fast',
        'deterministic': False,
        'category': 'modularity',
        'params': {
            'resolution': {'type': 'float', 'default': 1.0, 'min': 0.1, 'max': 5.0},
        },
    },
    'table_gravity': {
        'name': 'Table Gravity',
        'desc': 'Cluster sessions around most-referenced anchor tables',
        'speed': 'medium',
        'deterministic': True,
        'category': 'domain',
        'params': {
            'max_anchors': {'type': 'int', 'default': 100, 'min': 5, 'max': 500},
        },
    },
    'leiden': {
        'name': 'Leiden',
        'desc': 'Improved Louvain with guaranteed connected communities',
        'speed': 'fast',
        'deterministic': False,
        'category': 'modularity',
        'requires': 'leidenalg',
        'params': {
            'resolution': {'type': 'float', 'default': 1.0, 'min': 0.1, 'max': 5.0},
        },
    },
    'fluid': {
        'name': 'Fluid Communities',
        'desc': 'Async propagation with user-specified target cluster count',
        'speed': 'fast',
        'deterministic': False,
        'category': 'propagation',
        'params': {
            'k': {'type': 'int', 'default': 10, 'min': 2, 'max': 200},
        },
    },
    'walktrap': {
        'name': 'Walktrap',
        'desc': 'Random walk distances + Ward hierarchical linkage',
        'speed': 'medium',
        'deterministic': True,
        'category': 'hierarchical',
        'params': {
            't': {'type': 'int', 'default': 4, 'min': 1, 'max': 10},
            'n_clusters': {'type': 'int', 'default': 15, 'min': 2, 'max': 200},
        },
    },
    'infomap': {
        'name': 'Infomap',
        'desc': 'Information-theoretic flow-based community detection',
        'speed': 'fast',
        'deterministic': False,
        'category': 'information',
        'requires': 'infomap',
        'params': {},
    },
    'chinese_whispers': {
        'name': 'Chinese Whispers',
        'desc': 'Fully randomized weighted-vote label propagation',
        'speed': 'fast',
        'deterministic': False,
        'category': 'propagation',
        'params': {
            'iterations': {'type': 'int', 'default': 20, 'min': 5, 'max': 100},
        },
    },
    'sbm': {
        'name': 'Stochastic Block Model',
        'desc': 'Spectral modularity matrix + KMeans inference',
        'speed': 'slow',
        'deterministic': False,
        'category': 'inference',
        'params': {
            'n_clusters': {'type': 'int', 'default': 10, 'min': 2, 'max': 100},
        },
    },
    'ppr_cluster': {
        'name': 'PageRank Clustering',
        'desc': 'Personalized PageRank vectors per node + KMeans',
        'speed': 'medium',
        'deterministic': False,
        'category': 'spectral',
        'params': {
            'n_clusters': {'type': 'int', 'default': 10, 'min': 2, 'max': 200},
            'alpha': {'type': 'float', 'default': 0.85, 'min': 0.5, 'max': 0.99},
        },
    },
    'node2vec_kmeans': {
        'name': 'Node2Vec + KMeans',
        'desc': 'Random walk embeddings + SVD dimensionality reduction + KMeans',
        'speed': 'slow',
        'deterministic': False,
        'category': 'embedding',
        'params': {
            'dimensions': {'type': 'int', 'default': 32, 'min': 8, 'max': 128},
            'walk_length': {'type': 'int', 'default': 10, 'min': 3, 'max': 40},
            'n_clusters': {'type': 'int', 'default': 10, 'min': 2, 'max': 200},
        },
    },
}


# ── Public API ────────────────────────────────────────────────────────────────


def run_lab_algorithm(
    tier_data: dict[str, Any],
    algorithm: str = 'louvain',
    params: dict[str, Any] | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    """Run a clustering algorithm and return constellation + quality metrics.

    Reuses the constellation engine's 6-phase pipeline (fingerprints, similarity
    graph, layout, chunk metadata, cross-chunk edges) but dispatches to the
    extended set of lab algorithms for the clustering phase.

    Args:
        tier_data: Parsed tier data with sessions, tables, connections.
        algorithm: Algorithm key from LAB_ALGORITHMS.
        params: Algorithm-specific parameters (merged with defaults).
        seed: Random seed for reproducibility. None = random.

    Returns:
        Dict with constellation, quality_metrics, and run_meta.
    """
    sessions = tier_data.get('sessions', [])
    if not sessions:
        return {
            'constellation': _empty_constellation(),
            'quality_metrics': {'modularity': 0, 'silhouette': 0, 'n_clusters': 0, 'entropy': 0, 'duration_ms': 0},
            'run_meta': {'algorithm': algorithm, 'params': params or {}, 'seed': seed, 'timestamp': _iso_now()},
        }

    algo = algorithm if algorithm in LAB_ALGORITHMS else 'louvain'
    merged_params = _merge_params(algo, params or {})

    if seed is not None:
        random.seed(seed)
        np.random.seed(seed)

    logger.info("Lab: %d sessions, algorithm=%s, params=%s, seed=%s",
                len(sessions), algo, merged_params, seed)
    t0 = _time.monotonic()

    # Phase A: fingerprints
    fingerprints = _build_fingerprints(sessions)

    # Phase B: similarity graph
    G = _build_similarity_graph(fingerprints)

    # Phase C: clustering (lab dispatch)
    communities = _lab_cluster(algo, G, sessions, fingerprints, merged_params)

    # Assign orphans
    all_ids = [s['id'] for s in sessions]
    communities = _assign_orphans(all_ids, communities, fingerprints)

    # Phase D: layout
    coords = _compute_layout(G, communities, all_ids)

    # Phase E: chunk metadata
    session_map = {s['id']: s for s in sessions}
    tables = tier_data.get('tables', [])
    connections = tier_data.get('connections', [])
    chunks = _build_chunk_metadata(communities, session_map, fingerprints, tables)

    # Phase F: cross-chunk edges
    cross_chunk_edges = _find_cross_chunk_edges(connections, communities, session_map, tables)

    # Points
    points = _build_points(all_ids, coords, communities, session_map)

    duration_ms = int((_time.monotonic() - t0) * 1000)

    constellation = {
        'algorithm': algo,
        'chunks': chunks,
        'points': points,
        'cross_chunk_edges': cross_chunk_edges,
        'stats': {
            'total_sessions': len(sessions),
            'total_chunks': len(chunks),
            'largest_chunk': max((len(c['session_ids']) for c in chunks), default=0),
            'smallest_chunk': min((len(c['session_ids']) for c in chunks), default=0),
            'orphan_sessions': sum(1 for c in chunks if len(c['session_ids']) == 1),
            'cross_chunk_edge_count': sum(e['count'] for e in cross_chunk_edges),
        },
    }

    quality = compute_quality_metrics(G, communities, coords)
    quality['duration_ms'] = duration_ms

    return {
        'constellation': constellation,
        'quality_metrics': quality,
        'run_meta': {
            'algorithm': algo,
            'params': merged_params,
            'seed': seed,
            'timestamp': _iso_now(),
        },
    }


# ── Lab clustering dispatch ───────────────────────────────────────────────────


def _lab_cluster(
    algo: str,
    G: nx.Graph,
    sessions: list[dict],
    fingerprints: dict[str, frozenset],
    params: dict[str, Any],
) -> list[set[str]]:
    """Dispatch to the selected lab algorithm."""
    dispatch = {
        'louvain': lambda: _cluster_louvain(G, sessions, fingerprints),
        'table_gravity': lambda: _cluster_table_gravity(G, sessions, fingerprints),
        'leiden': lambda: _cluster_leiden(G, sessions, fingerprints, params),
        'fluid': lambda: _cluster_fluid(G, sessions, fingerprints, params),
        'walktrap': lambda: _cluster_walktrap(G, sessions, fingerprints, params),
        'infomap': lambda: _cluster_infomap(G, sessions, fingerprints, params),
        'chinese_whispers': lambda: _cluster_chinese_whispers(G, sessions, fingerprints, params),
        'sbm': lambda: _cluster_sbm(G, sessions, fingerprints, params),
        'ppr_cluster': lambda: _cluster_ppr(G, sessions, fingerprints, params),
        'node2vec_kmeans': lambda: _cluster_node2vec(G, sessions, fingerprints, params),
    }
    fn = dispatch.get(algo, dispatch['louvain'])
    return fn()


# ── New algorithm implementations ─────────────────────────────────────────────


def _cluster_leiden(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
    params: dict[str, Any],
) -> list[set[str]]:
    """Leiden algorithm via leidenalg + igraph. Falls back to Louvain if unavailable."""
    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]

    try:
        import igraph as ig
        import leidenalg
    except ImportError:
        logger.warning("leidenalg/igraph not installed, falling back to Louvain")
        return _cluster_louvain(G, sessions, fingerprints)

    resolution = params.get('resolution', 1.0)

    # Convert networkx graph to igraph
    node_list = list(G.nodes())
    node_idx = {n: i for i, n in enumerate(node_list)}
    ig_edges = [(node_idx[u], node_idx[v]) for u, v in G.edges()]
    weights = [G[u][v].get('weight', 1.0) for u, v in G.edges()]

    ig_graph = ig.Graph(n=len(node_list), edges=ig_edges, directed=False)
    ig_graph.es['weight'] = weights

    partition = leidenalg.find_partition(
        ig_graph,
        leidenalg.RBConfigurationVertexPartition,
        weights='weight',
        resolution_parameter=resolution,
    )

    communities: list[set[str]] = []
    for members in partition:
        comm = {node_list[i] for i in members}
        if comm:
            communities.append(comm)

    return _merge_singletons(communities, G) if communities else [{n} for n in G.nodes()]


def _cluster_fluid(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
    params: dict[str, Any],
) -> list[set[str]]:
    """Fluid communities — async propagation on largest connected component."""
    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]

    k = params.get('k', 10)

    # Fluid requires connected graph; work on largest component
    components = list(nx.connected_components(G))
    largest = max(components, key=len)

    # k cannot exceed number of nodes in the component
    k = min(k, len(largest))
    if k < 2:
        return [largest] + [{n} for c in components if c != largest for n in c]

    subgraph = G.subgraph(largest)
    try:
        comms = list(nx.community.asyn_fluidc(subgraph, k=k))
        result = [set(c) for c in comms if c]
    except Exception:
        result = [largest]

    # Add remaining components as their own clusters
    for comp in components:
        if comp != largest:
            result.append(set(comp))

    return result


def _cluster_walktrap(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
    params: dict[str, Any],
) -> list[set[str]]:
    """Walktrap — random walk transition matrix + Ward hierarchical linkage."""
    from scipy.cluster.hierarchy import ward, fcluster
    from scipy.spatial.distance import pdist

    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]

    t = params.get('t', 4)
    n_clusters = params.get('n_clusters', 15)

    node_list = list(G.nodes())
    n = len(node_list)

    if n < 3:
        return [{nd} for nd in node_list]

    node_idx = {nd: i for i, nd in enumerate(node_list)}

    # Build transition matrix
    A = np.zeros((n, n))
    for u, v, d in G.edges(data=True):
        w = d.get('weight', 1.0)
        i, j = node_idx[u], node_idx[v]
        A[i, j] = w
        A[j, i] = w

    # Row-normalize to get transition matrix
    row_sums = A.sum(axis=1, keepdims=True)
    row_sums[row_sums == 0] = 1.0
    P = A / row_sums

    # t-step transition matrix
    Pt = np.linalg.matrix_power(P, t)

    # Distance matrix from walk probabilities
    distances = pdist(Pt, metric='euclidean')

    # Ward linkage + flat clusters
    n_clusters = min(n_clusters, n - 1)
    Z = ward(distances)
    labels = fcluster(Z, t=n_clusters, criterion='maxclust')

    communities: dict[int, set[str]] = defaultdict(set)
    for i, label in enumerate(labels):
        communities[label].add(node_list[i])

    return [c for c in communities.values() if c]


def _cluster_infomap(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
    params: dict[str, Any],
) -> list[set[str]]:
    """Infomap — information-theoretic community detection. Falls back to Louvain."""
    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]

    try:
        from infomap import Infomap
    except ImportError:
        logger.warning("infomap not installed, falling back to Louvain")
        return _cluster_louvain(G, sessions, fingerprints)

    node_list = list(G.nodes())
    node_idx = {n: i for i, n in enumerate(node_list)}

    im = Infomap(silent=True)
    for u, v, d in G.edges(data=True):
        w = d.get('weight', 1.0)
        im.add_link(node_idx[u], node_idx[v], w)

    im.run()

    communities: dict[int, set[str]] = defaultdict(set)
    for node_id in im.tree:
        if node_id.is_leaf:
            communities[node_id.module_id].add(node_list[node_id.node_id])

    result = [c for c in communities.values() if c]
    return result if result else [{n} for n in G.nodes()]


def _cluster_chinese_whispers(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
    params: dict[str, Any],
) -> list[set[str]]:
    """Chinese Whispers — randomized weighted-vote label propagation."""
    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]

    iterations = params.get('iterations', 20)
    nodes = list(G.nodes())

    # Initialize: each node in its own class
    labels = {n: i for i, n in enumerate(nodes)}

    for _ in range(iterations):
        random.shuffle(nodes)
        for node in nodes:
            neighbors = list(G.neighbors(node))
            if not neighbors:
                continue

            # Weighted vote: sum edge weights per neighbor label
            votes: dict[int, float] = defaultdict(float)
            for nb in neighbors:
                w = G[node][nb].get('weight', 1.0)
                votes[labels[nb]] += w

            # Assign the label with the highest vote (random tiebreak)
            max_vote = max(votes.values())
            best_labels = [lbl for lbl, v in votes.items() if v == max_vote]
            labels[node] = random.choice(best_labels)

    # Group nodes by label
    communities: dict[int, set[str]] = defaultdict(set)
    for node, lbl in labels.items():
        communities[lbl].add(node)

    return [c for c in communities.values() if c]


def _cluster_sbm(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
    params: dict[str, Any],
) -> list[set[str]]:
    """Stochastic Block Model — spectral modularity matrix + KMeans."""
    from scipy.sparse.linalg import eigsh
    from sklearn.cluster import KMeans

    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]

    n_clusters = params.get('n_clusters', 10)
    node_list = list(G.nodes())
    n = len(node_list)

    if n < 3:
        return [{nd} for nd in node_list]

    n_clusters = min(n_clusters, n - 1)
    node_idx = {nd: i for i, nd in enumerate(node_list)}

    # Build adjacency matrix
    A = np.zeros((n, n))
    for u, v, d in G.edges(data=True):
        w = d.get('weight', 1.0)
        i, j = node_idx[u], node_idx[v]
        A[i, j] = w
        A[j, i] = w

    # Modularity matrix: B = A - (d_i * d_j) / (2m)
    degrees = A.sum(axis=1)
    m2 = degrees.sum()
    if m2 == 0:
        return [{nd} for nd in node_list]

    B = A - np.outer(degrees, degrees) / m2

    # Top-k eigenvectors of modularity matrix
    k = min(n_clusters, n - 2)
    if k < 1:
        return [{nd} for nd in node_list]

    try:
        eigenvalues, eigenvectors = eigsh(B, k=k, which='LA')
    except Exception:
        return [{nd} for nd in node_list]

    # KMeans on eigenvector embedding
    kmeans = KMeans(n_clusters=n_clusters, n_init=10, random_state=42)
    labels = kmeans.fit_predict(eigenvectors)

    communities: dict[int, set[str]] = defaultdict(set)
    for i, label in enumerate(labels):
        communities[label].add(node_list[i])

    return [c for c in communities.values() if c]


def _cluster_ppr(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
    params: dict[str, Any],
) -> list[set[str]]:
    """PageRank Clustering — PPR vectors per landmark node + KMeans."""
    from sklearn.cluster import KMeans

    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]

    n_clusters = params.get('n_clusters', 10)
    alpha = params.get('alpha', 0.85)
    node_list = list(G.nodes())
    n = len(node_list)

    if n < 3:
        return [{nd} for nd in node_list]

    n_clusters = min(n_clusters, n - 1)

    # Select landmark nodes (sample for large graphs)
    max_landmarks = min(500, n)
    if n <= max_landmarks:
        landmarks = node_list
    else:
        landmarks = random.sample(node_list, max_landmarks)

    # Compute PPR vector for each landmark
    ppr_matrix = np.zeros((n, len(landmarks)))
    node_idx = {nd: i for i, nd in enumerate(node_list)}

    for j, landmark in enumerate(landmarks):
        ppr = nx.pagerank(G, alpha=alpha, personalization={landmark: 1.0}, max_iter=50)
        for nd, score in ppr.items():
            ppr_matrix[node_idx[nd], j] = score

    # KMeans on PPR feature vectors
    kmeans = KMeans(n_clusters=n_clusters, n_init=10, random_state=42)
    labels = kmeans.fit_predict(ppr_matrix)

    communities: dict[int, set[str]] = defaultdict(set)
    for i, label in enumerate(labels):
        communities[label].add(node_list[i])

    return [c for c in communities.values() if c]


def _cluster_node2vec(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
    params: dict[str, Any],
) -> list[set[str]]:
    """Node2Vec + KMeans — random walk embeddings + SVD + KMeans."""
    from sklearn.cluster import KMeans
    from scipy.sparse.linalg import svds
    from scipy.sparse import lil_matrix

    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]

    dimensions = params.get('dimensions', 32)
    walk_length = params.get('walk_length', 10)
    n_clusters = params.get('n_clusters', 10)
    num_walks = 10

    node_list = list(G.nodes())
    n = len(node_list)

    if n < 3:
        return [{nd} for nd in node_list]

    n_clusters = min(n_clusters, n - 1)
    dimensions = min(dimensions, n - 2)
    if dimensions < 1:
        return [{nd} for nd in node_list]

    node_idx = {nd: i for i, nd in enumerate(node_list)}

    # Precompute weighted neighbor lists for fast sampling
    neighbors: dict[str, list[tuple[str, float]]] = {}
    for nd in node_list:
        nbs = list(G.neighbors(nd))
        if nbs:
            weights = [G[nd][nb].get('weight', 1.0) for nb in nbs]
            total = sum(weights)
            neighbors[nd] = [(nb, w / total) for nb, w in zip(nbs, weights)]
        else:
            neighbors[nd] = []

    # Generate random walks
    walks: list[list[str]] = []
    for _ in range(num_walks):
        for start in node_list:
            walk = [start]
            for _ in range(walk_length - 1):
                cur = walk[-1]
                nbs = neighbors[cur]
                if not nbs:
                    break
                nodes_list, probs = zip(*nbs)
                walk.append(random.choices(nodes_list, weights=probs, k=1)[0])
            walks.append(walk)

    # Build co-occurrence matrix (window=5)
    window = 5
    cooccur = lil_matrix((n, n))
    for walk in walks:
        for i, node in enumerate(walk):
            ni = node_idx[node]
            for j in range(max(0, i - window), min(len(walk), i + window + 1)):
                if i != j:
                    nj = node_idx[walk[j]]
                    cooccur[ni, nj] += 1.0

    cooccur = cooccur.tocsc()

    # SVD for dimensionality reduction
    try:
        U, S, _ = svds(cooccur.astype(float), k=dimensions)
        embeddings = U * np.sqrt(S)
    except Exception:
        return [{nd} for nd in node_list]

    # KMeans on embeddings
    kmeans = KMeans(n_clusters=n_clusters, n_init=10, random_state=42)
    labels = kmeans.fit_predict(embeddings)

    communities: dict[int, set[str]] = defaultdict(set)
    for i, label in enumerate(labels):
        communities[label].add(node_list[i])

    return [c for c in communities.values() if c]


# ── Quality metrics ───────────────────────────────────────────────────────────


def compute_quality_metrics(
    G: nx.Graph,
    communities: list[set[str]],
    coords: dict[str, tuple[float, float]],
) -> dict[str, float]:
    """Compute clustering quality metrics.

    Returns:
        Dict with modularity, silhouette, n_clusters, entropy.
    """
    n_clusters = len(communities)

    # Modularity
    modularity = 0.0
    if G.number_of_edges() > 0 and n_clusters > 0:
        try:
            modularity = round(nx.community.modularity(G, communities), 4)
        except Exception as exc:
            logger.warning("Modularity computation failed: %s", exc)
            pass

    # Silhouette score from layout coordinates
    silhouette = 0.0
    if n_clusters >= 2 and coords:
        try:
            from sklearn.metrics import silhouette_score
            node_list = []
            label_list = []
            coord_list = []
            for ci, comm in enumerate(communities):
                for nd in comm:
                    if nd in coords:
                        node_list.append(nd)
                        label_list.append(ci)
                        coord_list.append(coords[nd])
            if len(set(label_list)) >= 2 and len(coord_list) >= 3:
                silhouette = round(silhouette_score(coord_list, label_list), 4)
        except Exception as exc:
            logger.warning("Silhouette score computation failed: %s", exc)
            pass

    # Entropy of cluster size distribution
    entropy = 0.0
    if n_clusters > 0:
        total = sum(len(c) for c in communities)
        if total > 0:
            for c in communities:
                p = len(c) / total
                if p > 0:
                    entropy -= p * math.log2(p)
            entropy = round(entropy, 4)

    return {
        'modularity': modularity,
        'silhouette': silhouette,
        'n_clusters': n_clusters,
        'entropy': entropy,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────


def _merge_params(algo: str, user_params: dict[str, Any]) -> dict[str, Any]:
    """Merge user params with algorithm defaults."""
    algo_info = LAB_ALGORITHMS.get(algo, {})
    schema = algo_info.get('params', {})
    merged = {}
    for key, spec in schema.items():
        if key in user_params:
            val = user_params[key]
            # Clamp to min/max
            if spec['type'] == 'int':
                val = int(val)
                val = max(spec['min'], min(spec['max'], val))
            elif spec['type'] == 'float':
                val = float(val)
                val = max(spec['min'], min(spec['max'], val))
            merged[key] = val
        else:
            merged[key] = spec['default']
    return merged


def _empty_constellation() -> dict[str, Any]:
    return {
        'algorithm': 'louvain',
        'chunks': [],
        'points': [],
        'cross_chunk_edges': [],
        'stats': {
            'total_sessions': 0,
            'total_chunks': 0,
            'largest_chunk': 0,
            'smallest_chunk': 0,
            'orphan_sessions': 0,
            'cross_chunk_edge_count': 0,
        },
    }


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
