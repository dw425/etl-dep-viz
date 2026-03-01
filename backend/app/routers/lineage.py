"""Lineage router — cross-session table lineage graph and path finding.

Provides API endpoints for:
  - Table lineage graph (which tables flow through which sessions)
  - Forward/backward trace from a table or session
  - Column-level lineage from CONNECTOR/TRANSFORMFIELD data
  - Impact analysis (forward trace with affected sessions)
  - Path finding between two nodes
"""

import logging
from collections import defaultdict, deque
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query

logger = logging.getLogger(__name__)

router = APIRouter()


def _build_lineage_graph(tier_data: dict) -> dict:
    """Build a directed lineage graph from tier_data.

    Returns {
        'nodes': [{'id', 'name', 'type', 'tier'}],
        'edges': [{'from', 'to', 'type', 'via_session'}],
        'table_sessions': {table_name: {'readers': [...], 'writers': [...], 'lookups': [...]}},
    }
    """
    nodes = []
    edges = []
    table_sessions: dict[str, dict[str, list]] = defaultdict(lambda: {'readers': [], 'writers': [], 'lookups': []})

    # Index sessions
    session_map = {}
    for s in tier_data.get('sessions', []):
        session_map[s['id']] = s
        nodes.append({
            'id': s['id'], 'name': s.get('name', s['id']),
            'type': 'session', 'tier': s.get('tier', 1),
        })

    # Index tables
    table_map = {}
    for t in tier_data.get('tables', []):
        table_map[t['id']] = t
        nodes.append({
            'id': t['id'], 'name': t['name'],
            'type': 'table', 'tier': t.get('tier', 0),
        })

    # Build table→session relationships from connections
    for conn in tier_data.get('connections', []):
        frm = conn['from']
        to = conn['to']
        ctype = conn.get('type', 'unknown')

        if frm.startswith('S') and to.startswith('T_'):
            # Session writes to table
            table_name = table_map.get(to, {}).get('name', to)
            table_sessions[table_name]['writers'].append(frm)
        elif frm.startswith('T_') and to.startswith('S'):
            # Table read by session
            table_name = table_map.get(frm, {}).get('name', frm)
            if ctype == 'lookup_stale':
                table_sessions[table_name]['lookups'].append(to)
            else:
                table_sessions[table_name]['readers'].append(to)

        edges.append({
            'from': frm, 'to': to, 'type': ctype,
        })

    # Build cross-session lineage edges (session A writes table → session B reads table)
    lineage_edges = []
    for table_name, info in table_sessions.items():
        for writer in info['writers']:
            for reader in info['readers']:
                if writer != reader:
                    lineage_edges.append({
                        'from': writer, 'to': reader,
                        'type': 'data_flow', 'via_table': table_name,
                    })
            for looker in info['lookups']:
                if writer != looker:
                    lineage_edges.append({
                        'from': writer, 'to': looker,
                        'type': 'lookup_dependency', 'via_table': table_name,
                    })

    return {
        'nodes': nodes,
        'edges': edges,
        'lineage_edges': lineage_edges,
        'table_sessions': dict(table_sessions),
    }


def _trace_forward(graph: dict, start_id: str, max_hops: int = 20) -> dict:
    """Trace data flow forward from a node (impact analysis)."""
    edges = graph['edges'] + graph.get('lineage_edges', [])
    adjacency: dict[str, list] = defaultdict(list)
    for e in edges:
        adjacency[e['from']].append(e)

    visited = set()
    queue = deque([(start_id, 0)])
    trace_nodes = []
    trace_edges = []

    while queue:
        node_id, depth = queue.popleft()
        if node_id in visited or depth > max_hops:
            continue
        visited.add(node_id)
        trace_nodes.append({'id': node_id, 'depth': depth})

        for edge in adjacency.get(node_id, []):
            target = edge['to']
            if target not in visited:
                trace_edges.append({**edge, 'depth': depth})
                queue.append((target, depth + 1))

    return {'nodes': trace_nodes, 'edges': trace_edges, 'start': start_id, 'direction': 'forward'}


def _trace_backward(graph: dict, start_id: str, max_hops: int = 20) -> dict:
    """Trace data flow backward from a node (dependency analysis)."""
    edges = graph['edges'] + graph.get('lineage_edges', [])
    reverse_adj: dict[str, list] = defaultdict(list)
    for e in edges:
        reverse_adj[e['to']].append(e)

    visited = set()
    queue = deque([(start_id, 0)])
    trace_nodes = []
    trace_edges = []

    while queue:
        node_id, depth = queue.popleft()
        if node_id in visited or depth > max_hops:
            continue
        visited.add(node_id)
        trace_nodes.append({'id': node_id, 'depth': depth})

        for edge in reverse_adj.get(node_id, []):
            source = edge['from']
            if source not in visited:
                trace_edges.append({**edge, 'depth': depth})
                queue.append((source, depth + 1))

    return {'nodes': trace_nodes, 'edges': trace_edges, 'start': start_id, 'direction': 'backward'}


# ── API Endpoints ─────────────────────────────────────────────────────────────

@router.post('/lineage/graph')
async def get_lineage_graph(tier_data: dict = Body(...)):
    """Build and return the full lineage graph for the uploaded data."""
    if not tier_data.get('sessions'):
        raise HTTPException(status_code=422, detail='tier_data must contain sessions.')
    graph = _build_lineage_graph(tier_data)
    logger.info("lineage_graph built nodes=%d edges=%d", len(graph['nodes']), len(graph['edges']))
    return graph


@router.post('/lineage/trace/forward/{node_id}')
async def trace_forward(
    node_id: str,
    tier_data: dict = Body(...),
    max_hops: int = Query(20, ge=1, le=100),
):
    """Trace data flow forward from a node (impact analysis)."""
    graph = _build_lineage_graph(tier_data)
    result = _trace_forward(graph, node_id, max_hops)
    logger.info("trace_forward node=%s hops=%d reached=%d", node_id, max_hops, len(result['nodes']))
    return result


@router.post('/lineage/trace/backward/{node_id}')
async def trace_backward(
    node_id: str,
    tier_data: dict = Body(...),
    max_hops: int = Query(20, ge=1, le=100),
):
    """Trace data flow backward from a node (dependency analysis)."""
    graph = _build_lineage_graph(tier_data)
    result = _trace_backward(graph, node_id, max_hops)
    logger.info("trace_backward node=%s hops=%d reached=%d", node_id, max_hops, len(result['nodes']))
    return result


@router.post('/lineage/table/{table_name}')
async def get_table_lineage(
    table_name: str,
    tier_data: dict = Body(...),
):
    """Get all sessions that read/write/lookup a specific table."""
    graph = _build_lineage_graph(tier_data)
    table_info = graph['table_sessions'].get(table_name.upper())
    if not table_info:
        raise HTTPException(status_code=404, detail=f'Table {table_name} not found in lineage.')
    return {
        'table': table_name.upper(),
        'writers': table_info['writers'],
        'readers': table_info['readers'],
        'lookups': table_info['lookups'],
    }


# ── Column-level lineage (Item 53) ────────────────────────────────────────


def _build_column_lineage(tier_data: dict, session_id: str) -> dict:
    """Build column-level lineage from CONNECTOR data in mapping_detail.

    Traces field-to-field connections through transformation instances
    to produce a column flow graph.
    """
    sessions = tier_data.get('sessions', [])
    session = None
    for s in sessions:
        if s['id'] == session_id:
            session = s
            break
    if not session:
        raise HTTPException(404, f'Session {session_id} not found')

    # Get mapping detail with CONNECTOR data
    detail = session.get('mapping_detail', {})
    connectors = detail.get('connectors', [])
    instances = detail.get('instances', [])
    fields = detail.get('fields', [])

    if not connectors:
        return {
            'session_id': session_id,
            'columns': [],
            'flows': [],
            'message': 'No CONNECTOR data available for this session',
        }

    # Build instance type map
    inst_type_map = {}
    for inst in instances:
        inst_type_map[inst.get('name', '')] = {
            'type': inst.get('type', ''),
            'transformation_type': inst.get('transformation_type', ''),
            'transformation_name': inst.get('transformation_name', ''),
        }

    # Build column flow graph from connectors
    column_nodes = set()
    flows = []
    for conn in connectors:
        from_inst = conn.get('from_instance', '')
        from_field = conn.get('from_field', '')
        to_inst = conn.get('to_instance', '')
        to_field = conn.get('to_field', '')

        from_key = f"{from_inst}.{from_field}"
        to_key = f"{to_inst}.{to_field}"
        column_nodes.add(from_key)
        column_nodes.add(to_key)
        flows.append({
            'from': from_key,
            'to': to_key,
            'from_instance': from_inst,
            'from_field': from_field,
            'to_instance': to_inst,
            'to_field': to_field,
            'from_type': inst_type_map.get(from_inst, {}).get('transformation_type', ''),
            'to_type': inst_type_map.get(to_inst, {}).get('transformation_type', ''),
        })

    # Build field expression info
    field_exprs = {}
    for f in fields:
        key = f"{f.get('transform', '')}.{f.get('name', '')}"
        field_exprs[key] = {
            'expression': f.get('expression', ''),
            'expression_type': f.get('expression_type', 'passthrough'),
            'datatype': f.get('datatype', ''),
        }

    # Annotate column nodes
    columns = []
    for node in sorted(column_nodes):
        inst_name, field_name = node.split('.', 1) if '.' in node else (node, '')
        inst_info = inst_type_map.get(inst_name, {})
        expr_info = field_exprs.get(node, {})
        columns.append({
            'id': node,
            'instance': inst_name,
            'field': field_name,
            'instance_type': inst_info.get('type', ''),
            'transformation_type': inst_info.get('transformation_type', ''),
            'expression': expr_info.get('expression', ''),
            'expression_type': expr_info.get('expression_type', ''),
            'datatype': expr_info.get('datatype', ''),
        })

    return {
        'session_id': session_id,
        'session_name': session.get('name', session_id),
        'columns': columns,
        'flows': flows,
        'instance_count': len(instances),
        'connector_count': len(connectors),
    }


@router.post('/lineage/columns/{session_id}')
async def get_column_lineage(
    session_id: str,
    tier_data: dict = Body(...),
):
    """Get column-level lineage for a session from CONNECTOR/TRANSFORMFIELD data."""
    return _build_column_lineage(tier_data, session_id)


# ── Impact analysis (Item 55) ─────────────────────────────────────────────


@router.post('/lineage/impact/{session_id}')
async def impact_analysis(
    session_id: str,
    tier_data: dict = Body(...),
    max_hops: int = Query(10, ge=1, le=50),
):
    """Run forward impact analysis from a session.

    Returns all downstream sessions, tables, and the cascading impact chain.
    """
    graph = _build_lineage_graph(tier_data)
    trace = _trace_forward(graph, session_id, max_hops)

    # Enrich with session/table metadata
    session_map = {s['id']: s for s in tier_data.get('sessions', [])}
    table_map = {t['id']: t for t in tier_data.get('tables', [])}

    impacted_sessions = []
    impacted_tables = []
    for node in trace['nodes']:
        nid = node['id']
        if nid.startswith('S') and nid in session_map:
            s = session_map[nid]
            impacted_sessions.append({
                'id': nid,
                'name': s.get('name', nid),
                'tier': s.get('tier', 0),
                'depth': node['depth'],
            })
        elif nid.startswith('T_') and nid in table_map:
            t = table_map[nid]
            impacted_tables.append({
                'id': nid,
                'name': t.get('name', nid),
                'tier': t.get('tier', 0),
                'depth': node['depth'],
            })

    return {
        'source_session': session_id,
        'source_name': session_map.get(session_id, {}).get('name', session_id),
        'impacted_sessions': impacted_sessions,
        'impacted_tables': impacted_tables,
        'total_impacted': len(impacted_sessions) + len(impacted_tables),
        'max_depth': max(n['depth'] for n in trace['nodes']) if trace['nodes'] else 0,
        'edges': trace['edges'],
    }
