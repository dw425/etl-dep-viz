"""Lineage export — DOT, Mermaid, and JSON formats (Item 59)."""

from __future__ import annotations

from typing import Any


def lineage_to_dot(graph: dict) -> str:
    """Convert lineage graph to Graphviz DOT format."""
    lines = ['digraph lineage {', '  rankdir=LR;', '  node [shape=box, style=rounded];', '']

    # Add nodes
    for node in graph.get('nodes', []):
        nid = node['id'].replace('-', '_').replace(' ', '_')
        label = node.get('name', node['id'])
        shape = 'ellipse' if node.get('type') == 'table' else 'box'
        color = '#10B981' if node.get('type') == 'table' else '#3B82F6'
        lines.append(f'  {nid} [label="{label}", shape={shape}, color="{color}"];')

    lines.append('')

    # Add edges
    for edge in graph.get('edges', []) + graph.get('lineage_edges', []):
        frm = edge['from'].replace('-', '_').replace(' ', '_')
        to = edge['to'].replace('-', '_').replace(' ', '_')
        etype = edge.get('type', '')
        style = 'dashed' if 'lookup' in etype else 'solid'
        color = '#EF4444' if 'conflict' in etype else '#3B82F6'
        via = edge.get('via_table', '')
        label = via if via else etype
        lines.append(f'  {frm} -> {to} [label="{label}", style={style}, color="{color}"];')

    lines.append('}')
    return '\n'.join(lines)


def lineage_to_mermaid(graph: dict) -> str:
    """Convert lineage graph to Mermaid flowchart format."""
    lines = ['flowchart LR']

    # Add nodes
    for node in graph.get('nodes', []):
        nid = node['id']
        label = node.get('name', nid)
        if node.get('type') == 'table':
            lines.append(f'  {nid}[("{label}")]')
        else:
            lines.append(f'  {nid}["{label}"]')

    # Add edges
    seen = set()
    for edge in graph.get('lineage_edges', []):
        key = f"{edge['from']}->{edge['to']}"
        if key in seen:
            continue
        seen.add(key)
        via = edge.get('via_table', '')
        etype = edge.get('type', '')
        label = via or etype
        if 'lookup' in etype:
            lines.append(f'  {edge["from"]} -.->|{label}| {edge["to"]}')
        else:
            lines.append(f'  {edge["from"]} -->|{label}| {edge["to"]}')

    return '\n'.join(lines)


def lineage_to_json(graph: dict) -> dict:
    """Return lineage graph as clean JSON for external tools."""
    return {
        'nodes': graph.get('nodes', []),
        'edges': graph.get('edges', []),
        'lineage_edges': graph.get('lineage_edges', []),
        'table_sessions': graph.get('table_sessions', {}),
    }
