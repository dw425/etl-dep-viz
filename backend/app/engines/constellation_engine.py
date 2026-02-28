"""Constellation Engine — cluster sessions with selectable algorithms.

Produces 2D layout coordinates + chunk metadata for the constellation map view.
Supports 6 clustering algorithms selectable at runtime.
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from typing import Any

import networkx as nx


# 12-color palette for chunk coloring (visually distinct on dark background)
CHUNK_PALETTE = [
    '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4',
    '#EC4899', '#84CC16', '#F97316', '#8B5CF6', '#14B8A6', '#FB923C',
]

# Available algorithms with display metadata
ALGORITHMS = {
    'louvain':      {'name': 'Louvain',              'desc': 'Modularity-based community detection — best for finding densely connected table groups'},
    'tier':         {'name': 'Tier Groups',           'desc': 'Group sessions by execution tier — shows pipeline depth layers'},
    'components':   {'name': 'Connected Components',  'desc': 'Natural graph islands — sessions with zero table overlap become separate clusters'},
    'label_prop':   {'name': 'Label Propagation',     'desc': 'Fast iterative label spreading — good for loosely connected graphs'},
    'greedy_mod':   {'name': 'Greedy Modularity',     'desc': 'Agglomerative merge by modularity gain — produces fewer, larger clusters'},
    'process_group':{'name': 'Process Group',         'desc': 'Group by NiFi process group / Informatica workflow — preserves original structure'},
    'table_gravity':{'name': 'Table Gravity',          'desc': 'Cluster sessions around their most commonly referenced tables — reveals critical shared dependencies'},
}


# ── Public API ──────────────────────────────────────────────────────────────


def build_constellation(
    tier_data: dict[str, Any],
    algorithm: str = 'louvain',
) -> dict[str, Any]:
    """Build constellation map data from tier_data.

    Args:
        tier_data: Output of infa_engine.analyze() or nifi_tier_engine.analyze().
        algorithm: One of 'louvain', 'tier', 'components', 'label_prop',
                   'greedy_mod', 'process_group'.
    """
    sessions = tier_data.get('sessions', [])
    if not sessions:
        return _empty_result()

    algo = algorithm if algorithm in ALGORITHMS else 'louvain'

    # Phase A: build table fingerprints per session
    fingerprints = _build_fingerprints(sessions)

    # Phase B: build similarity graph via inverted index
    G = _build_similarity_graph(fingerprints)

    # Phase C: clustering (algorithm-dependent)
    communities = _cluster(algo, G, sessions, fingerprints)

    # Assign orphans (nodes not in any community)
    all_session_ids = [s['id'] for s in sessions]
    communities = _assign_orphans(all_session_ids, communities, fingerprints)

    # Phase D: layout → 2D coordinates
    coords = _compute_layout(G, communities, all_session_ids)

    # Build lookup maps
    session_map = {s['id']: s for s in sessions}
    tables = tier_data.get('tables', [])
    connections = tier_data.get('connections', [])

    # Phase E: assemble chunk metadata
    chunks = _build_chunk_metadata(communities, session_map, fingerprints, tables)

    # Phase F: cross-chunk edges
    cross_chunk_edges = _find_cross_chunk_edges(connections, communities, session_map, tables)

    # Assemble points
    points = _build_points(all_session_ids, coords, communities, session_map)

    result = {
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

    # Enrich for table_gravity algorithm
    if algo == 'table_gravity':
        _enrich_table_gravity(result, sessions, fingerprints, communities)

    return result


# ── Phase A: Table fingerprints ────────────────────────────────────────────


def _build_fingerprints(sessions: list[dict]) -> dict[str, frozenset]:
    """Build frozenset of all tables (sources + targets + lookups) per session."""
    fp: dict[str, frozenset] = {}
    for s in sessions:
        tables: set[str] = set()
        for field in ('sources', 'targets', 'lookups'):
            for t in (s.get(field) or []):
                if isinstance(t, str) and t.strip():
                    tables.add(t.strip().upper())
        fp[s['id']] = frozenset(tables)
    return fp


# ── Phase B: Similarity graph via inverted index ──────────────────────────


def _build_similarity_graph(fingerprints: dict[str, frozenset]) -> nx.Graph:
    """Build undirected similarity graph. Edge if Jaccard >= 0.1."""
    inv: dict[str, set[str]] = defaultdict(set)
    for sid, tables in fingerprints.items():
        for t in tables:
            inv[t].add(sid)

    max_share = min(500, len(fingerprints) // 2 + 1)

    pair_shared: dict[tuple[str, str], int] = defaultdict(int)
    for table, sids in inv.items():
        if len(sids) > max_share:
            continue
        sid_list = sorted(sids)
        for i in range(len(sid_list)):
            for j in range(i + 1, len(sid_list)):
                pair_shared[(sid_list[i], sid_list[j])] += 1

    G = nx.Graph()
    G.add_nodes_from(fingerprints.keys())

    for (a, b), shared_count in pair_shared.items():
        fa, fb = fingerprints[a], fingerprints[b]
        union_size = len(fa | fb)
        if union_size == 0:
            continue
        jaccard = shared_count / union_size
        if jaccard >= 0.1:
            G.add_edge(a, b, weight=jaccard)

    return G


# ── Phase C: Clustering algorithms ───────────────────────────────────────


def _cluster(
    algo: str,
    G: nx.Graph,
    sessions: list[dict],
    fingerprints: dict[str, frozenset],
) -> list[set[str]]:
    """Dispatch to the selected clustering algorithm."""
    dispatch = {
        'louvain':       _cluster_louvain,
        'tier':          _cluster_tier,
        'components':    _cluster_components,
        'label_prop':    _cluster_label_prop,
        'greedy_mod':    _cluster_greedy_mod,
        'process_group': _cluster_process_group,
        'table_gravity': _cluster_table_gravity,
    }
    fn = dispatch.get(algo, _cluster_louvain)
    return fn(G, sessions, fingerprints)


# ── 1. Louvain (original) ────────────────────────────────────────────────


def _cluster_louvain(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
) -> list[set[str]]:
    """Louvain community detection with auto-tuned resolution."""
    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]

    target_min, target_max = 8, 200
    best_communities = None

    for resolution in [0.5, 0.8, 1.0, 1.3, 1.8, 2.5, 4.0]:
        try:
            comms = nx.community.louvain_communities(G, resolution=resolution, seed=42)
            comms = [c for c in comms if len(c) > 0]
            n_chunks = len(comms)
            if target_min <= n_chunks <= target_max:
                best_communities = comms
                break
            if best_communities is None or abs(n_chunks - 50) < abs(len(best_communities) - 50):
                best_communities = comms
        except Exception:
            continue

    if best_communities is None:
        best_communities = [{n} for n in G.nodes()]

    return _merge_singletons(best_communities, G)


# ── 2. Tier Groups ───────────────────────────────────────────────────────


def _cluster_tier(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
) -> list[set[str]]:
    """Group sessions by their execution tier number."""
    tier_groups: dict[int, set[str]] = defaultdict(set)
    for s in sessions:
        tier = s.get('tier', 1)
        tier_groups[tier].add(s['id'])
    return [g for g in tier_groups.values() if g]


# ── 3. Connected Components ──────────────────────────────────────────────


def _cluster_components(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
) -> list[set[str]]:
    """Use natural connected components of the similarity graph."""
    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]
    return [set(c) for c in nx.connected_components(G)]


# ── 4. Label Propagation ────────────────────────────────────────────────


def _cluster_label_prop(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
) -> list[set[str]]:
    """Asynchronous label propagation — fast, semi-random communities."""
    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]
    try:
        comms = nx.community.asyn_lpa_communities(G, weight='weight', seed=42)
        result = [set(c) for c in comms if c]
        return result if result else [{n} for n in G.nodes()]
    except Exception:
        return [{n} for n in G.nodes()]


# ── 5. Greedy Modularity ────────────────────────────────────────────────


def _cluster_greedy_mod(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
) -> list[set[str]]:
    """Agglomerative greedy modularity maximization — fewer, larger clusters."""
    if G.number_of_edges() == 0:
        return [{n} for n in G.nodes()]
    try:
        comms = nx.community.greedy_modularity_communities(G, weight='weight')
        result = [set(c) for c in comms if c]
        return result if result else [{n} for n in G.nodes()]
    except Exception:
        return [{n} for n in G.nodes()]


# ── 6. Process Group ────────────────────────────────────────────────────


def _cluster_process_group(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
) -> list[set[str]]:
    """Group by source process group / workflow name from 'full' field."""
    groups: dict[str, set[str]] = defaultdict(set)
    for s in sessions:
        # Extract group name from full name: "name (Type)" → use prefix or workflow
        full = s.get('full', '')
        name = s.get('name', '')
        # Try to extract a prefix group: anything before the last underscore segment
        parts = name.split('_')
        if len(parts) >= 3:
            group_key = '_'.join(parts[:-1])
        elif '(' in full:
            # Use the type in parentheses as group: "name (PutS3Object)" → PutS3Object
            group_key = full.split('(')[-1].rstrip(')')
        else:
            group_key = name
        groups[group_key].add(s['id'])

    # If we got too many groups (>500), merge small ones by prefix
    if len(groups) > 500:
        merged: dict[str, set[str]] = defaultdict(set)
        for gname, sids in groups.items():
            prefix = gname.split('_')[0] if '_' in gname else gname
            merged[prefix].update(sids)
        return [g for g in merged.values() if g]

    return [g for g in groups.values() if g]


# ── 7. Table Gravity ──────────────────────────────────────────────────


def _cluster_table_gravity(
    G: nx.Graph, sessions: list[dict], fingerprints: dict[str, frozenset],
) -> list[set[str]]:
    """Cluster sessions around the most commonly referenced tables (gravity anchors)."""
    from collections import Counter

    # Step 1: Count global table references across all sessions
    table_counts: Counter = Counter()
    for sid, tables in fingerprints.items():
        for t in tables:
            table_counts[t] += 1

    if not table_counts:
        return [{s['id']} for s in sessions]

    # Step 2: Rank tables by reference count descending
    ranked = table_counts.most_common()

    # Step 3: Select anchor tables
    total_sessions = len(sessions)
    min_refs = max(2, int(total_sessions * 0.005))
    anchors = [t for t, c in ranked if c >= min_refs][:100]

    if not anchors:
        # Fallback: use top 20 tables with count >= 2
        anchors = [t for t, c in ranked if c >= 2][:20]
    if not anchors:
        return [{s['id']} for s in sessions]

    anchor_set = frozenset(anchors)
    anchor_rank = {t: i for i, t in enumerate(anchors)}

    # Step 4: Assign sessions to their strongest anchor
    clusters: dict[str, set[str]] = defaultdict(set)
    unassigned: list[str] = []
    for s in sessions:
        sid = s['id']
        fp = fingerprints.get(sid, frozenset())
        anchor_tables = fp & anchor_set
        if anchor_tables:
            # Pick the anchor with the highest global ref count (lowest rank index)
            best = min(anchor_tables, key=lambda t: anchor_rank[t])
            clusters[best].add(sid)
        else:
            unassigned.append(sid)

    # Step 5: Handle unassigned — find cluster with most table overlap
    for sid in unassigned:
        fp = fingerprints.get(sid, frozenset())
        best_cluster: str | None = None
        best_overlap = 0
        for anchor, sids in clusters.items():
            cluster_tables: set[str] = set()
            for s in sids:
                cluster_tables.update(fingerprints.get(s, frozenset()))
            overlap = len(fp & cluster_tables)
            if overlap > best_overlap:
                best_overlap = overlap
                best_cluster = anchor
        if best_cluster:
            clusters[best_cluster].add(sid)
        else:
            clusters['__other__'].add(sid)

    # Step 6: Merge tiny clusters (< 3 sessions) into nearest large cluster
    small_keys = [k for k, v in clusters.items() if len(v) < 3 and k != '__other__']
    large_keys = [k for k, v in clusters.items() if len(v) >= 3]
    for sk in small_keys:
        small_fp: set[str] = set()
        for sid in clusters[sk]:
            small_fp.update(fingerprints.get(sid, frozenset()))
        best_target: str | None = None
        best_overlap = 0
        for lk in large_keys:
            large_fp: set[str] = set()
            for sid in clusters[lk]:
                large_fp.update(fingerprints.get(sid, frozenset()))
            overlap = len(small_fp & large_fp)
            if overlap > best_overlap:
                best_overlap = overlap
                best_target = lk
        if best_target:
            clusters[best_target].update(clusters[sk])
            del clusters[sk]
        # If no overlap found, keep as its own cluster

    return [sids for sids in clusters.values() if sids]


# ── Shared helpers ───────────────────────────────────────────────────────


def _merge_singletons(communities: list[set[str]], G: nx.Graph) -> list[set[str]]:
    """Merge singleton communities into their nearest neighbor's community."""
    node_comm: dict[str, int] = {}
    for i, comm in enumerate(communities):
        for n in comm:
            node_comm[n] = i

    merged = [set(c) for c in communities]
    singletons = [i for i, c in enumerate(merged) if len(c) == 1]

    for si in singletons:
        node = next(iter(merged[si]))
        neighbors = list(G.neighbors(node))
        if not neighbors:
            continue
        best_comm = None
        best_weight = -1
        for nb in neighbors:
            ci = node_comm.get(nb)
            if ci is not None and ci != si:
                w = G[node][nb].get('weight', 0)
                if w > best_weight:
                    best_weight = w
                    best_comm = ci
        if best_comm is not None and len(merged[si]) == 1:
            merged[best_comm].add(node)
            merged[si].discard(node)
            node_comm[node] = best_comm

    return [c for c in merged if len(c) > 0]


def _assign_orphans(
    all_ids: list[str],
    communities: list[set[str]],
    fingerprints: dict[str, frozenset],
) -> list[set[str]]:
    """Assign sessions not in any community to nearest community by table overlap."""
    assigned = set()
    for c in communities:
        assigned.update(c)

    orphans = [sid for sid in all_ids if sid not in assigned]
    if not orphans:
        return communities

    comm_tables: list[frozenset] = []
    for comm in communities:
        tables: set[str] = set()
        for sid in comm:
            tables.update(fingerprints.get(sid, frozenset()))
        comm_tables.append(frozenset(tables))

    for sid in orphans:
        fp = fingerprints.get(sid, frozenset())
        if not fp:
            communities.append({sid})
            comm_tables.append(fp)
            continue

        best_idx = -1
        best_overlap = 0
        for i, ct in enumerate(comm_tables):
            overlap = len(fp & ct)
            if overlap > best_overlap:
                best_overlap = overlap
                best_idx = i

        if best_idx >= 0 and best_overlap > 0:
            communities[best_idx].add(sid)
            comm_tables[best_idx] = frozenset(
                set(comm_tables[best_idx]) | set(fp)
            )
        else:
            communities.append({sid})
            comm_tables.append(fp)

    return [c for c in communities if len(c) > 0]


# ── Phase D: Spring layout ────────────────────────────────────────────────


def _compute_layout(
    G: nx.Graph,
    communities: list[set[str]],
    all_ids: list[str],
) -> dict[str, tuple[float, float]]:
    """Fruchterman-Reingold layout normalized to [0,1]."""
    n = len(all_ids)
    iterations = 50 if n < 1000 else 30 if n < 5000 else 20

    if G.number_of_edges() > 0:
        pos = nx.spring_layout(G, k=1.5 / math.sqrt(max(n, 1)), iterations=iterations, seed=42)
    else:
        pos = {}
        cols = max(int(math.sqrt(n)), 1)
        for i, sid in enumerate(all_ids):
            pos[sid] = (float(i % cols) / max(cols, 1), float(i // cols) / max(cols, 1))

    for sid in all_ids:
        if sid not in pos:
            comm = None
            for c in communities:
                if sid in c:
                    comm = c
                    break
            if comm:
                xs = [pos[nd][0] for nd in comm if nd in pos]
                ys = [pos[nd][1] for nd in comm if nd in pos]
                if xs and ys:
                    cx = sum(xs) / len(xs) + (hash(sid) % 100) * 0.001
                    cy = sum(ys) / len(ys) + (hash(sid) % 97) * 0.001
                    pos[sid] = (cx, cy)
                else:
                    pos[sid] = (0.5 + (hash(sid) % 100) * 0.001, 0.5)
            else:
                pos[sid] = (0.5 + (hash(sid) % 100) * 0.001, 0.5)

    if not pos:
        return {}
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    rx = max_x - min_x if max_x != min_x else 1.0
    ry = max_y - min_y if max_y != min_y else 1.0

    return {
        sid: (
            0.05 + 0.9 * (p[0] - min_x) / rx,
            0.05 + 0.9 * (p[1] - min_y) / ry,
        )
        for sid, p in pos.items()
    }


# ── Phase E: Chunk metadata ──────────────────────────────────────────────


def _build_chunk_metadata(
    communities: list[set[str]],
    session_map: dict[str, dict],
    fingerprints: dict[str, frozenset],
    tables: list[dict],
) -> list[dict]:
    """Assemble chunk metadata."""
    table_type_map = {t['name']: t.get('type', 'independent') for t in tables}

    chunks = []
    for i, comm in enumerate(communities):
        session_ids = sorted(comm)
        chunk_tables: set[str] = set()
        for sid in session_ids:
            chunk_tables.update(fingerprints.get(sid, frozenset()))

        tiers = [session_map[sid]['tier'] for sid in session_ids if sid in session_map]
        min_tier = min(tiers) if tiers else 1
        max_tier = max(tiers) if tiers else 1

        table_counts: dict[str, int] = defaultdict(int)
        for sid in session_ids:
            for t in fingerprints.get(sid, frozenset()):
                table_counts[t] += 1
        pivot_tables = sorted(table_counts.keys(), key=lambda t: table_counts[t], reverse=True)[:5]

        conflict_count = sum(1 for t in chunk_tables if table_type_map.get(t) == 'conflict')
        chain_count = sum(1 for t in chunk_tables if table_type_map.get(t) == 'chain')
        critical_count = sum(
            1 for sid in session_ids
            if sid in session_map and session_map[sid].get('critical', False)
        )

        color = CHUNK_PALETTE[i % len(CHUNK_PALETTE)]
        label = f"Cluster {i + 1}: {pivot_tables[0]}" if pivot_tables else f"Cluster {i + 1}"

        chunks.append({
            'id': f'chunk_{i}',
            'label': label,
            'session_ids': session_ids,
            'table_names': sorted(chunk_tables),
            'session_count': len(session_ids),
            'table_count': len(chunk_tables),
            'tier_range': [min_tier, max_tier],
            'pivot_tables': pivot_tables,
            'conflict_count': conflict_count,
            'chain_count': chain_count,
            'critical_count': critical_count,
            'color': color,
        })

    chunks.sort(key=lambda c: c['session_count'], reverse=True)
    return chunks


# ── Phase F: Cross-chunk edges ────────────────────────────────────────────


def _find_cross_chunk_edges(
    connections: list[dict],
    communities: list[set[str]],
    session_map: dict[str, dict],
    tables: list[dict],
) -> list[dict]:
    """Detect connections where endpoints are in different chunks."""
    node_chunk: dict[str, str] = {}
    for i, comm in enumerate(communities):
        chunk_id = f'chunk_{i}'
        for sid in comm:
            node_chunk[sid] = chunk_id

    table_chunk: dict[str, str] = {}
    for t in tables:
        writers = t.get('writers', [])
        if writers:
            for w in writers:
                for sid, s in session_map.items():
                    if s.get('name') == w or s.get('full') == w:
                        if sid in node_chunk:
                            table_chunk[t['id']] = node_chunk[sid]
                            break
                if t['id'] in table_chunk:
                    break

    cross: dict[tuple[str, str], int] = defaultdict(int)
    for conn in connections:
        from_chunk = node_chunk.get(conn['from']) or table_chunk.get(conn['from'])
        to_chunk = node_chunk.get(conn['to']) or table_chunk.get(conn['to'])
        if from_chunk and to_chunk and from_chunk != to_chunk:
            key = tuple(sorted([from_chunk, to_chunk]))
            cross[key] += 1

    return [
        {'from_chunk': k[0], 'to_chunk': k[1], 'count': v}
        for k, v in sorted(cross.items(), key=lambda x: x[1], reverse=True)
    ]


# ── Points assembly ──────────────────────────────────────────────────────


def _build_points(
    all_ids: list[str],
    coords: dict[str, tuple[float, float]],
    communities: list[set[str]],
    session_map: dict[str, dict],
) -> list[dict]:
    """Build point list for frontend rendering."""
    sid_chunk: dict[str, str] = {}
    for i, comm in enumerate(communities):
        for sid in comm:
            sid_chunk[sid] = f'chunk_{i}'

    points = []
    for sid in all_ids:
        s = session_map.get(sid, {})
        x, y = coords.get(sid, (0.5, 0.5))
        points.append({
            'session_id': sid,
            'x': round(x, 5),
            'y': round(y, 5),
            'chunk_id': sid_chunk.get(sid, 'chunk_0'),
            'tier': s.get('tier', 1),
            'critical': s.get('critical', False),
            'name': s.get('name', sid),
        })
    return points


# ── Table Gravity enrichment ──────────────────────────────────────────────


def _enrich_table_gravity(
    result: dict[str, Any],
    sessions: list[dict],
    fingerprints: dict[str, frozenset],
    communities: list[set[str]],
) -> None:
    """Enrich constellation result with anchor table info and global ranking."""
    from collections import Counter

    # Build global table reference counts
    table_counts: Counter = Counter()
    for sid, tables in fingerprints.items():
        for t in tables:
            table_counts[t] += 1

    total = len(sessions)

    # Build table_reference_ranking (top 50)
    ranked = table_counts.most_common(50)
    result['table_reference_ranking'] = [
        {
            'table': t,
            'ref_count': c,
            'pct': round(c / total, 4) if total else 0,
        }
        for t, c in ranked
    ]

    # For each chunk, detect which anchor table it's centered on
    # by finding the table with the highest global ref count among the chunk's tables
    for chunk in result['chunks']:
        chunk_tables: set[str] = set()
        for sid in chunk['session_ids']:
            chunk_tables.update(fingerprints.get(sid, frozenset()))

        if chunk_tables:
            best_table = max(chunk_tables, key=lambda t: table_counts.get(t, 0))
            best_count = table_counts.get(best_table, 0)
            chunk['anchor_table'] = best_table
            chunk['anchor_ref_count'] = best_count
            chunk['label'] = f"{best_table} ({best_count} refs)"
        else:
            chunk['anchor_table'] = None
            chunk['anchor_ref_count'] = 0


# ── Helpers ───────────────────────────────────────────────────────────────


def _empty_result() -> dict[str, Any]:
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
