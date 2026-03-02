"""NiFi XML Tier Engine — parses NiFi flow XML files and returns tier diagram data.

Mirrors the output format of infa_engine.analyze() so the constellation map,
tier diagram, and galaxy map all work identically for NiFi flows.

Concept mapping:
  Informatica SESSION  ->  NiFi Process Group (or top-level processor cluster)
  Informatica TABLE    ->  NiFi external resource (DB table, Kafka topic, S3 bucket, etc.)
  Informatica MAPPING  ->  NiFi connection graph within a process group

Data Flow:
  1. _parse_nifi_xml()   — delegates to parsers/nifi_xml.py for raw processor/connection extraction
  2. _classify()         — categorize each processor as source/sink/transform
  3. _extract_resource() — identify external resources from processor properties
  4. analyze()           — 8-phase pipeline matching infa_engine output format:
     Phase 1: parse all files
     Phase 2: build connection graph
     Phase 3: build table usage maps (resource -> processors)
     Phase 4: assign tiers via topological sort (NetworkX) or BFS fallback
     Phase 5-7: build output nodes/edges
     Phase 8: compute stats

Processor Classification Strategy:
  - Known types matched against _SOURCE_TYPES / _SINK_TYPES lookup sets
  - Heuristic fallback: prefix-based (Get*/Fetch* -> source, Put*/Publish* -> sink)
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict, deque
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

try:
    import networkx as _nx
    _NX = True
except ImportError:
    _NX = False

logger = logging.getLogger(__name__)


# ── Processor classification ─────────────────────────────────────────────────

_SOURCE_TYPES = {
    'getfile', 'getftp', 'getsftp', 'gets3object', 'gethdfs',
    'fetchfile', 'fetchftp', 'fetchsftp', 'fetchs3object', 'fetchhdfs',
    'consumekafka', 'consumekafka_2_6', 'consumekafkarecord_2_6',
    'consumekafka_0_10', 'consumekafkarecord',
    'consumemqtt', 'consumejms', 'consumeamqp',
    'gethttp', 'invokehttp',  # can be source or sink
    'listenhttp', 'listentcp', 'listenudp', 'listensyslog',
    'listenrelp', 'listengelf',
    'querydatabasetable', 'querydatabasetablerecord',
    'executesqldatabasetable',
    'executesql', 'executesqlrecord',
    'generategenerateflowfile', 'generateflowfile', 'generatetablefletch',
    'listfile', 'listftp', 'listsftp', 'lists3', 'listhdfs',
    'listdatabasetables', 'listazureblobstorage',
    'tailfile', 'getazureeventhub', 'consumewindowseventlog',
    'getmongo', 'getsqs', 'getjmsqueue',
}

_SINK_TYPES = {
    'putfile', 'putftp', 'putsftp', 'puts3object', 'puthdfs',
    'putdatabaserecord', 'putdatabase',
    'publishkafka', 'publishkafka_2_6', 'publishkafkarecord_2_6',
    'publishkafka_0_10', 'publishkafkarecord',
    'publishmqtt', 'publishjms', 'publishamqp',
    'puthiveql', 'puthivestreaming', 'putparquet',
    'putkudu', 'putmongo', 'putcassandraql', 'putcassandrarecord',
    'putelasticsearch', 'putelasticsearchhttp', 'putelasticsearchjson',
    'putelasticsearchrecord',
    'putbigquerybatch', 'putbigquerystreaming',
    'putgcsstorage', 'putgcpubsub', 'putazureblobstorage',
    'putsqs', 'putsns', 'putkinesis', 'putdynamodb',
    'putemail', 'putslack',
    'puthttps', 'posthttps',
    'putsolrcontentstream', 'putsolrrecord',
}

_RESOURCE_PROPERTY_KEYS = {
    # Database
    'table name': 'db_table',
    'Table Name': 'db_table',
    'put-db-record-table-name': 'db_table',
    'SQL select query': 'sql_query',
    'sql-select-query': 'sql_query',
    'Database Connection URL': 'jdbc_url',
    # Kafka
    'topic': 'kafka_topic',
    'Topic Name(s)': 'kafka_topic',
    'topic_name': 'kafka_topic',
    # S3/GCS
    'Bucket': 's3_bucket',
    'bucket': 's3_bucket',
    's3-bucket': 's3_bucket',
    'gcs-bucket': 'gcs_bucket',
    # HDFS
    'Directory': 'directory',
    'directory': 'directory',
    'HDFS Directory': 'hdfs_dir',
    # HTTP
    'Remote URL': 'http_url',
    'HTTP URL': 'http_url',
    'url': 'http_url',
    # Elasticsearch
    'Index': 'es_index',
    'elasticsearch-index': 'es_index',
    # MongoDB
    'Mongo Collection': 'mongo_collection',
    'mongo-collection-name': 'mongo_collection',
    'Mongo Database Name': 'mongo_db',
}

_FROM_RE = re.compile(r'\bFROM\s+([\w\$#\.@]+)', re.I)
_PREFIX_RE = re.compile(r'^(Get|Put|Fetch|List|Consume|Publish|Execute|Query|Generate|Listen|Tail)', re.I)


def _classify(proc_type: str) -> str:
    """Classify a processor as 'source', 'sink', or 'transform'."""
    t = proc_type.lower().replace('.', '').split('.')[-1]
    if t in _SOURCE_TYPES:
        return 'source'
    if t in _SINK_TYPES:
        return 'sink'
    # Heuristic fallback
    tl = t.lower()
    if tl.startswith('get') or tl.startswith('fetch') or tl.startswith('consume') or tl.startswith('listen') or tl.startswith('list'):
        return 'source'
    if tl.startswith('put') or tl.startswith('publish'):
        return 'sink'
    return 'transform'


def _extract_resource(proc_type: str, properties: Dict[str, str]) -> str:
    """Extract the external resource name from processor properties."""
    # Try known property keys
    for key, rtype in _RESOURCE_PROPERTY_KEYS.items():
        val = properties.get(key, '').strip()
        if val and not val.startswith('${'):
            # For SQL queries, extract table from FROM clause
            if rtype == 'sql_query':
                m = _FROM_RE.search(val)
                if m:
                    return m.group(1).upper().rsplit('.', 1)[-1]
                continue
            # For JDBC URLs, extract database name
            if rtype == 'jdbc_url':
                continue  # skip — not a table name
            # Clean up the value
            val = val.strip('/').rsplit('/', 1)[-1] if '/' in val else val
            return val.upper() if val else ''

    return ''


def _short_name(name: str) -> str:
    """Create abbreviated display name from processor name."""
    parts = name.replace('-', '_').split('_')
    return '_'.join(parts[-3:]) if len(parts) > 3 else name


def _parse_nifi_xml(content: bytes) -> Dict[str, Any]:
    """Parse a single NiFi XML file and extract processors + connections.

    Returns {'processors': [...], 'connections': [...], 'process_groups': [...]}
    """
    if not content or not content.strip():
        return {'_error': 'Empty file content', 'processors': [], 'connections': [], 'process_groups': []}

    try:
        from app.engines.parsers.nifi_xml import parse_nifi_xml
        result = parse_nifi_xml(content, 'tier_map_input.xml')
        procs = []
        for p in result.processors:
            pname = p.name
            if not pname or not isinstance(pname, str) or not pname.strip():
                logger.warning("Skipping processor with empty name in NiFi XML")
                continue
            procs.append({
                'name': pname,
                'type': p.type,
                'group': p.group,
                'properties': p.properties or {},
                'classification': _classify(p.type),
            })
        conns = []
        for c in result.connections:
            src, dst = c.source_name, c.destination_name
            if not src or not dst:
                logger.warning("Skipping connection with unresolved endpoint: %s -> %s", src, dst)
                continue
            conns.append({
                'source': src,
                'destination': dst,
                'relationship': c.relationship,
            })
        groups = []
        for g in result.process_groups:
            groups.append({
                'name': g.name,
                'processors': g.processors,
            })
        return {'processors': procs, 'connections': conns, 'process_groups': groups}
    except ValueError as exc:
        logger.warning("ValueError parsing NiFi XML: %s", exc)
        return {'_error': str(exc), 'processors': [], 'connections': [], 'process_groups': []}
    except Exception as exc:
        logger.error("Error parsing NiFi XML: %s", exc)
        return {'_error': str(exc), 'processors': [], 'connections': [], 'process_groups': []}


# ── Main entry point ───────────────────────────────────────────────────────

def analyze(
    xml_contents: List[bytes],
    filenames: List[str],
    progress_fn: Optional[Callable[[int, int, str], None]] = None,
) -> Dict[str, Any]:
    """Parse NiFi XML files and return tier diagram data matching infa_engine output format.

    Each NiFi processor becomes a "session" in the tier map.
    External resources (tables, topics, buckets) become "tables".
    """

    # ── Phase 1: parse all files ──────────────────────────────────────────
    all_procs: Dict[str, Dict[str, Any]] = {}  # name → proc data
    all_conns: List[Dict[str, str]] = []
    warnings: List[str] = []
    total = len(xml_contents)

    for i, (content, fname) in enumerate(zip(xml_contents, filenames)):
        result = _parse_nifi_xml(content)
        if result.get('_error'):
            warnings.append(f"{fname}: {result['_error']}")
        for p in result['processors']:
            pname = p['name']
            if pname not in all_procs:
                all_procs[pname] = {
                    'name': pname,
                    'type': p['type'],
                    'group': p['group'],
                    'classification': p['classification'],
                    'properties': p['properties'],
                    'file': fname,
                    'sources': [],
                    'targets': [],
                    'lookups': [],
                }
            resource = _extract_resource(p['type'], p['properties'])
            if resource:
                cls = p['classification']
                pd = all_procs[pname]
                if cls == 'source' and resource not in pd['sources']:
                    pd['sources'].append(resource)
                elif cls == 'sink' and resource not in pd['targets']:
                    pd['targets'].append(resource)
        all_conns.extend(result['connections'])
        if progress_fn is not None:
            progress_fn(i + 1, total, fname)

    if not all_procs:
        return {
            'sessions': [], 'tables': [], 'connections': [],
            'stats': {'session_count': 0, 'write_conflicts': 0, 'dep_chains': 0,
                      'staleness_risks': 0, 'source_tables': 0, 'max_tier': 0},
            'warnings': warnings or ['No processors found in uploaded NiFi files.'],
        }

    # ── Phase 2: build connection graph and derive source/target tables ────
    # Build adjacency from NiFi connections
    successors: Dict[str, List[str]] = defaultdict(list)
    predecessors: Dict[str, List[str]] = defaultdict(list)
    for conn in all_conns:
        src, dst = conn['source'], conn['destination']
        if src in all_procs and dst in all_procs:
            if dst not in successors[src]:
                successors[src].append(dst)
            if src not in predecessors[dst]:
                predecessors[dst].append(src)

    # Propagate resources through the graph:
    # Source processor reads from external → all downstream processors depend on that resource
    # Sink processor writes to external → its upstream processors contribute to that resource

    # ── Phase 3: build table usage maps ───────────────────────────────────
    all_targets: Dict[str, List[str]] = defaultdict(list)   # resource → [proc_names that WRITE]
    all_sources: Dict[str, List[str]] = defaultdict(list)   # resource → [proc_names that READ]

    for pname, pd in all_procs.items():
        for s in pd['sources']:
            if pname not in all_sources[s]:
                all_sources[s].append(pname)
        for t in pd['targets']:
            if pname not in all_targets[t]:
                all_targets[t].append(pname)

    conflict_tables: Set[str] = {t for t, w in all_targets.items() if len(w) > 1}

    source_only_tables: Set[str] = set()
    for t in all_sources:
        if t and t not in all_targets:
            source_only_tables.add(t)

    # ── Phase 4: assign tiers via connection graph (DAG) ──────────────────
    proc_names = list(all_procs.keys())

    if _NX:
        G = _nx.DiGraph()
        G.add_nodes_from(proc_names)
        for conn in all_conns:
            src, dst = conn['source'], conn['destination']
            if src in all_procs and dst in all_procs and src != dst:
                G.add_edge(src, dst)
        # Remove cycles
        try:
            while True:
                cycle = _nx.find_cycle(G)
                G.remove_edge(cycle[0][0], cycle[0][1])
        except _nx.NetworkXNoCycle:
            pass
        order = list(_nx.topological_sort(G))
        dist: Dict[str, int] = {n: 0 for n in G.nodes()}
        for n in order:
            for s in G.successors(n):
                if dist[n] + 1 > dist[s]:
                    dist[s] = dist[n] + 1
        proc_tier: Dict[str, int] = {n: dist[n] + 1 for n in proc_names}
    else:
        # BFS fallback
        in_deg: Dict[str, int] = defaultdict(int)
        for conn in all_conns:
            if conn['destination'] in all_procs:
                in_deg[conn['destination']] += 1
        proc_tier = {}
        queue = [p for p in proc_names if in_deg[p] == 0]
        visited: Set[str] = set()
        tier = 1
        while queue:
            nxt = []
            for p in queue:
                if p not in visited:
                    visited.add(p)
                    proc_tier[p] = tier
                    nxt.extend(successors.get(p, []))
            queue = [p for p in nxt if p not in visited]
            tier += 1
        for p in proc_names:
            if p not in proc_tier:
                proc_tier[p] = tier

    # ── Phase 5: build output ─────────────────────────────────────────────
    def _sort_key(pn: str) -> Tuple[int, str]:
        return (proc_tier.get(pn, 1), pn)

    ordered = sorted(proc_names, key=_sort_key)

    sid_map: Dict[str, str] = {}
    sessions_out: List[Dict] = []
    critical_procs: Set[str] = set()
    for t in conflict_tables:
        for w in all_targets[t]:
            critical_procs.add(w)

    for i, pname in enumerate(ordered, start=1):
        sid = f'S{i}'
        sid_map[pname] = sid
        pd = all_procs[pname]
        sessions_out.append({
            'id':          sid,
            'step':        i,
            'name':        _short_name(pname),
            'full':        f"{pname} ({pd['type']})",
            'tier':        proc_tier.get(pname, 1),
            'transforms':  1,  # each processor = 1 transform
            'extReads':    len(pd['sources']),
            'lookupCount': len(pd['lookups']),
            'critical':    pname in critical_procs,
            'sources':     pd['sources'],
            'targets':     pd['targets'],
            'lookups':     pd['lookups'],
        })

    # ── Phase 6: build table nodes ─────────────────────────────────────────
    tid_map: Dict[str, str] = {}
    tables_out: List[Dict] = []
    t_idx = 0

    # Source-only tables at tier 0.5
    for table in sorted(source_only_tables):
        if not table.strip():
            continue
        readers = all_sources.get(table, [])
        tid = f'T_{t_idx}'
        tid_map[table] = tid
        t_idx += 1
        tables_out.append({
            'id':              tid,
            'name':            table,
            'type':            'source',
            'tier':            0.5,
            'conflictWriters': 0,
            'readers':         len(readers),
            'lookupUsers':     0,
        })

    # Written tables
    for table in sorted(all_targets.keys()):
        if not table.strip():
            continue
        writers = all_targets[table]
        readers = [r for r in all_sources.get(table, []) if r not in writers]
        is_conflict = table in conflict_tables
        has_downstream = bool(readers)
        ttype = 'conflict' if is_conflict else ('chain' if has_downstream else 'independent')
        writer_tiers = [proc_tier.get(w, 1) for w in writers]
        table_tier = float(max(writer_tiers)) + 0.5

        tid = f'T_{t_idx}'
        tid_map[table] = tid
        t_idx += 1
        tables_out.append({
            'id':              tid,
            'name':            table,
            'type':            ttype,
            'tier':            table_tier,
            'conflictWriters': len(writers) if is_conflict else 0,
            'readers':         len(readers),
            'lookupUsers':     0,
            'writers':         writers,
        })

    # ── Phase 7: build connections ─────────────────────────────────────────
    conns_out: List[Dict] = []
    conn_set: Set[str] = set()

    def _add(frm: str, to: str, ctype: str) -> None:
        key = f'{frm}|{to}|{ctype}'
        if key not in conn_set:
            conn_set.add(key)
            conns_out.append({'from': frm, 'to': to, 'type': ctype})

    # Source-only table → processor
    for table in sorted(source_only_tables):
        tid = tid_map.get(table)
        if not tid:
            continue
        for reader in all_sources.get(table, []):
            sid = sid_map.get(reader)
            if sid:
                _add(tid, sid, 'source_read')

    # Written table connections
    for table in sorted(all_targets.keys()):
        tid = tid_map.get(table)
        if not tid:
            continue
        writers = all_targets[table]
        readers = [r for r in all_sources.get(table, []) if r not in writers]
        is_conflict = table in conflict_tables
        has_downstream = bool(readers)

        for writer in writers:
            sid = sid_map.get(writer)
            if not sid:
                continue
            if is_conflict:
                _add(sid, tid, 'write_conflict')
            elif has_downstream:
                _add(sid, tid, 'chain')
            else:
                _add(sid, tid, 'write_clean')

        for reader in readers:
            sid = sid_map.get(reader)
            if not sid:
                continue
            _add(tid, sid, 'read_after_write' if is_conflict else 'chain')

    # NiFi processor-to-processor connections as chain edges
    for conn in all_conns:
        src_sid = sid_map.get(conn['source'])
        dst_sid = sid_map.get(conn['destination'])
        if src_sid and dst_sid and src_sid != dst_sid:
            _add(src_sid, dst_sid, 'chain')

    # ── Phase 8: stats ─────────────────────────────────────────────────────
    max_tier = max((proc_tier.get(p, 1) for p in proc_names), default=1)
    stats = {
        'session_count':   len(sessions_out),
        'write_conflicts': len(conflict_tables),
        'dep_chains':      sum(1 for t in tables_out if t['type'] == 'chain'),
        'staleness_risks': sum(1 for c in conns_out if c['type'] == 'lookup_stale'),
        'source_tables':   len(source_only_tables),
        'max_tier':        max_tier,
    }

    return {
        'sessions':    sessions_out,
        'tables':      tables_out,
        'connections': conns_out,
        'stats':       stats,
        'warnings':    warnings,
    }
