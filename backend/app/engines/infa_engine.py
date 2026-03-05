"""Informatica XML Engine — parses PowerCenter XML files and returns tier diagram data.

Single-file engine: parse -> normalise -> detect conflicts -> assign tiers -> return JSON.
All sessions, all writes, all reads, all lookups, no tier cap, unlimited depth.

Data Flow:
  1. _parse_file()       — XML -> raw session dicts per file
  2. _process_folder()   — extract SOURCE/TARGET/MAPPING/SESSION/WORKFLOW per folder
  3. analyze()           — merge all files, detect conflicts, assign tiers via DAG/BFS,
                           build output nodes (sessions + tables + connections + stats)

Output Format (matches nifi_tier_engine.analyze):
  {sessions: [...], tables: [...], connections: [...], stats: {...}, warnings: [...]}

Tier Assignment Algorithm:
  - Build a directed graph from session-to-session dependencies (via shared tables)
  - Topological sort (NetworkX) or BFS fallback assigns each session a tier depth
  - Tables are placed at tier = max(writer_tiers) + 0.5

KEY FIX: In Informatica XML, <TABLEATTRIBUTE NAME="Lookup table name"> lives on
<TRANSFORMATION TYPE="Lookup Procedure"> elements, NOT on <INSTANCE> elements inside MAPPING.
We build a lkp_map from TRANSFORMATION elements first, then look up by instance TRANSFORMATION_NAME.
"""

from __future__ import annotations

import json
import logging
import re
from collections import defaultdict, deque
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

try:
    from lxml import etree as _ET
    _LXML = True
except ImportError:
    import xml.etree.ElementTree as _ET  # type: ignore
    _LXML = False

try:
    import networkx as _nx
    _NX = True
except ImportError:
    _NX = False

logger = logging.getLogger(__name__)


# Threshold for switching to iterparse (20MB — lowered from 50MB for better memory)
_ITERPARSE_THRESHOLD = 20 * 1024 * 1024


# ── XML schema pre-validation (Item 6) ────────────────────────────────────────

# Expected root-level elements for Informatica PowerCenter XML
_INFA_ROOT_TAGS = frozenset({'POWERMART', 'REPOSITORY', 'FOLDER'})
_INFA_REQUIRED_CHILD_TAGS = frozenset({'FOLDER', 'SOURCE', 'TARGET', 'MAPPING', 'SESSION', 'WORKFLOW', 'TRANSFORMATION'})


def validate_xml_schema(content: bytes) -> dict:
    """Pre-validate XML structure before full parse.

    Returns dict with 'valid' bool, 'root_tag', 'warnings' list, 'element_counts'.
    Fast check — reads only enough to verify structure.
    """
    warnings: list[str] = []
    element_counts: dict[str, int] = {}

    try:
        # Quick peek at first 10KB to detect root structure
        head = content[:10240]
        try:
            head_str = head.decode('utf-8', errors='replace')
        except Exception:
            head_str = head.decode('latin-1', errors='replace')

        # Check for XML declaration
        if not head_str.strip().startswith('<?xml') and not head_str.strip().startswith('<'):
            return {'valid': False, 'root_tag': None, 'warnings': ['Not an XML file'], 'element_counts': {}}

        # Parse root element
        import io
        if _LXML:
            parser = _ET.XMLParser(recover=True, remove_comments=True)
            try:
                tree = _ET.parse(io.BytesIO(content), parser=parser)
                root = tree.getroot()
            except Exception as e:
                return {'valid': False, 'root_tag': None, 'warnings': [f'XML parse error: {e}'], 'element_counts': {}}
        else:
            try:
                root = _ET.fromstring(content)
            except Exception as e:
                return {'valid': False, 'root_tag': None, 'warnings': [f'XML parse error: {e}'], 'element_counts': {}}

        root_tag = root.tag.upper() if root.tag else ''

        # Check root tag is expected
        if root_tag not in _INFA_ROOT_TAGS:
            warnings.append(f'Unexpected root element <{root.tag}>; expected one of {sorted(_INFA_ROOT_TAGS)}')

        # Count key child elements (just direct children + one level deep)
        for child in root:
            tag = (child.tag or '').upper()
            element_counts[tag] = element_counts.get(tag, 0) + 1
            for grandchild in child:
                gtag = (grandchild.tag or '').upper()
                element_counts[gtag] = element_counts.get(gtag, 0) + 1

        # Check for expected child elements
        found_tags = set(element_counts.keys())
        expected_found = found_tags & _INFA_REQUIRED_CHILD_TAGS
        if not expected_found:
            warnings.append(f'No expected Informatica elements found; expected at least one of {sorted(_INFA_REQUIRED_CHILD_TAGS)}')

        return {
            'valid': len(warnings) == 0 or bool(expected_found),
            'root_tag': root_tag,
            'warnings': warnings,
            'element_counts': element_counts,
        }
    except Exception as exc:
        return {'valid': False, 'root_tag': None, 'warnings': [f'Validation error: {exc}'], 'element_counts': {}}


# ── XML helpers ────────────────────────────────────────────────────────────────

def _parse_xml(content: bytes) -> Any:
    """Parse XML bytes into an element tree, preferring lxml for error recovery."""
    if _LXML:
        parser = _ET.XMLParser(recover=True, remove_comments=True)  # type: ignore[call-arg]
        return _ET.fromstring(content, parser=parser)
    return _ET.fromstring(content)


def _parse_xml_iterparse(content: bytes):
    """Parse large XML using iterparse for reduced memory usage.

    Yields FOLDER elements one at a time. Caller should clear each
    element after processing to free memory.

    Handles truncated XML gracefully: if the parser hits premature EOF,
    it stops yielding but does NOT raise — any FOLDERs already yielded
    are still valid.
    """
    import io
    source = io.BytesIO(content)
    if _LXML:
        context = _ET.iterparse(source, events=('end',), tag='FOLDER',
                                recover=True, remove_comments=True)
    else:
        context = _ET.iterparse(source, events=('end',))

    try:
        for event, elem in context:
            tag = elem.tag if hasattr(elem, 'tag') else ''
            if tag == 'FOLDER':
                yield elem
                # Clear processed element and predecessors to free memory
                elem.clear()
                # Also clear preceding siblings from parent to reduce memory
                while elem.getprevious() is not None:
                    try:
                        del elem.getparent()[0]
                    except (TypeError, AttributeError):
                        break
    except _ET.XMLSyntaxError as exc:
        # Truncated XML — stop gracefully, caller keeps sessions from folders already yielded
        logger.info("Iterparse stopped at truncated XML (recovered partial data): %s", exc)


def _attr(el: Any, name: str) -> str:
    """Get XML attribute with case-insensitive fallback. Returns '' if missing."""
    v = el.get(name)
    if v is not None:
        return v
    v = el.get(name.upper())
    return v if v is not None else ''


def _iter(root: Any, tag: str):
    """Yield all descendant elements matching tag (case-insensitive fallback)."""
    yield from root.iter(tag)
    if tag != tag.upper():
        yield from root.iter(tag.upper())


# Keep _all as alias for backward compat
_all = _iter


# ── Name helpers ───────────────────────────────────────────────────────────────

_PREFIX = re.compile(r'^(s_m_|s_|m_|wf_|wkf_|sess_|SQ_|sq_)', re.I)
_FROM_RE = re.compile(r'\bFROM\s+([\w\$#\.@]+)', re.I)


def _short(name: str) -> str:
    """Display name according to EDV_SESSION_DISPLAY_MODE setting.

    - "full":  return the original name unchanged (default)
    - "smart": strip common prefixes only, keep all remaining parts
    - "short": strip prefixes and keep last 3 underscore parts (legacy)
    """
    from app.config import settings
    mode = settings.session_display_mode

    if mode == "full":
        return name

    s = _PREFIX.sub('', name)
    if mode == "smart":
        return s

    # Legacy "short" mode: keep last 3 underscore parts
    parts = s.split('_')
    return '_'.join(parts[-3:]) if len(parts) > 3 else s


def _norm(name: str) -> str:
    """Canonical uppercase table name. Strips owner/schema prefix, connection string prefix."""
    s = name.strip().upper()
    # Remove connection string prefix like "ORACLESTG/" or "DBNAME:"
    if '/' in s:
        s = s.rsplit('/', 1)[-1]
    if ':' in s:
        s = s.rsplit(':', 1)[-1]
    # Strip owner.table → table
    if '.' in s:
        s = s.rsplit('.', 1)[-1]
    # Strip surrounding brackets/quotes
    s = s.strip('[]"\'`')
    return s


def _norm_lkp(raw: str) -> str:
    """Normalize a lookup table value which may include DB link or schema prefix."""
    s = raw.strip().upper()
    # Handle Oracle DB link: TABLE@DBLINK
    if '@' in s:
        s = s.split('@')[0]
    return _norm(s)


# ── Lookup map builder ─────────────────────────────────────────────────────────

def _build_lookup_map(folder: Any) -> Dict[str, str]:
    """Return {TRANSFORMATION_NAME_UPPER: lookup_table_name} for every
    Lookup Procedure TRANSFORMATION in this folder.

    CRITICAL: In Informatica PowerCenter XML, the TABLEATTRIBUTE element
    containing "Lookup table name" is a child of the <TRANSFORMATION> element,
    NOT a child of <INSTANCE> elements. This function reads from the correct place.

    Falls back to SQL override FROM clause if no explicit table name attribute exists.
    """
    lkp: Dict[str, str] = {}

    for xf in _iter(folder, 'TRANSFORMATION'):
        try:
            xtype = _attr(xf, 'TYPE').lower()
            if 'lookup' not in xtype:
                continue
            xname = _attr(xf, 'NAME').strip().upper()
            if not xname:
                continue

            table = ''
            sql_fallback = ''

            for ta in _iter(xf, 'TABLEATTRIBUTE'):
                aname = _attr(ta, 'NAME').lower()
                aval  = _attr(ta, 'VALUE').strip()
                if not aval:
                    continue

                if 'lookup table name' in aname or 'lookup source row' in aname:
                    # Skip parameter references like $LkpTableName
                    if not aval.startswith('$') and len(aval) > 2:
                        table = _norm_lkp(aval)
                        break  # explicit table name wins; stop scanning
                elif ('sql override' in aname or 'lookup sql override' in aname) and not sql_fallback:
                    m = _FROM_RE.search(aval)
                    if m:
                        candidate = m.group(1).strip().upper()
                        # Reject obvious SQL keywords that follow FROM but are not table names
                        if candidate not in ('DUAL', 'SELECT', 'WHERE', 'AND', 'OR'):
                            sql_fallback = _norm_lkp(candidate)

            resolved = table or sql_fallback
            if resolved and len(resolved) > 2:
                lkp[xname] = resolved
        except Exception as exc:
            logger.warning("Skipping malformed TRANSFORMATION in lookup map: %s", exc)
            continue

    return lkp


# ── Connection profile extraction ─────────────────────────────────────────────

def _extract_connection_profiles(root: Any) -> List[Dict[str, str]]:
    """Extract DBCONNECTION elements from the XML root into connection profiles.

    Returns a list of dicts with keys: name, dbtype, dbsubtype, connection_string.
    """
    profiles: List[Dict[str, str]] = []
    seen: Set[str] = set()
    for conn in _iter(root, 'DBCONNECTION'):
        name = _attr(conn, 'NAME').strip()
        if not name or name.upper() in seen:
            continue
        seen.add(name.upper())
        dbtype = _attr(conn, 'DBTYPE').strip()
        dbsubtype = _attr(conn, 'DBSUBTYPE').strip()
        connstr = _attr(conn, 'CONNECTIONSTRING').strip() or _attr(conn, 'CONNECTSTRING').strip()
        profiles.append({
            'name': name,
            'dbtype': dbtype or 'Unknown',
            'dbsubtype': dbsubtype,
            'connection_string': connstr,
        })
    return profiles


def _extract_session_connections(root: Any) -> Dict[str, List[Dict[str, str]]]:
    """Map session names to their connection references from SESSIONEXTENSION elements.

    Returns {SESSION_NAME_UPPER: [{connection_name, dbtype}]}.
    """
    session_conns: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for sess_ext in _iter(root, 'SESSIONEXTENSION'):
        sess_name = _attr(sess_ext, 'SINSTANCENAME').strip().upper() or _attr(sess_ext, 'TRANSFORMATIONNAME').strip().upper()
        conn_name = _attr(sess_ext, 'CONNECTIONNAME').strip()
        dbtype = _attr(sess_ext, 'CONNECTIONSUBTYPE').strip() or _attr(sess_ext, 'CONNECTIONTYPE').strip()
        if sess_name and conn_name:
            existing = [c['connection_name'] for c in session_conns[sess_name]]
            if conn_name not in existing:
                session_conns[sess_name].append({
                    'connection_name': conn_name,
                    'dbtype': dbtype or 'Unknown',
                })
    return dict(session_conns)


# ── Code Analysis — function/language classification ──────────────────────────

# Regex to extract function calls from Informatica expressions and SQL
_FUNCTION_RE = re.compile(r'\b([A-Z_][A-Z_0-9]*)\s*\(', re.IGNORECASE)

# Known Informatica function categories
_KNOWN_FUNCTIONS: Dict[str, str] = {
    # Aggregate
    'SUM': 'aggregate', 'AVG': 'aggregate', 'COUNT': 'aggregate',
    'MIN': 'aggregate', 'MAX': 'aggregate', 'FIRST': 'aggregate',
    'LAST': 'aggregate', 'MEDIAN': 'aggregate', 'STDDEV': 'aggregate',
    'VARIANCE': 'aggregate', 'PERCENTILE': 'aggregate',
    # String
    'CONCAT': 'string', 'SUBSTR': 'string', 'LTRIM': 'string',
    'RTRIM': 'string', 'LPAD': 'string', 'RPAD': 'string',
    'UPPER': 'string', 'LOWER': 'string', 'INITCAP': 'string',
    'INSTR': 'string', 'LENGTH': 'string', 'REPLACE': 'string',
    'REPLACESTR': 'string', 'REPLACECHR': 'string', 'REG_EXTRACT': 'string',
    'REG_MATCH': 'string', 'REG_REPLACE': 'string', 'REVERSE': 'string',
    'METAPHONE': 'string', 'SOUNDEX': 'string', 'TRIM': 'string',
    'CHR': 'string', 'ASCII': 'string',
    # Date
    'TO_DATE': 'date', 'ADD_TO_DATE': 'date', 'DATE_DIFF': 'date',
    'DATE_COMPARE': 'date', 'GET_DATE_PART': 'date', 'TRUNC': 'date',
    'ROUND': 'date', 'LAST_DAY': 'date', 'NEXT_DAY': 'date',
    'SYSDATE': 'date', 'SYSTIMESTAMP': 'date', 'SET_DATE_PART': 'date',
    'IS_DATE': 'date', 'MAKE_DATE_TIME': 'date',
    # Math
    'ABS': 'math', 'CEIL': 'math', 'FLOOR': 'math', 'MOD': 'math',
    'POWER': 'math', 'SQRT': 'math', 'LOG': 'math', 'EXP': 'math',
    'SIGN': 'math', 'RAND': 'math', 'CUME': 'math', 'MOVINGAVG': 'math',
    'MOVINGSUM': 'math',
    # Conversion
    'TO_CHAR': 'conversion', 'TO_INTEGER': 'conversion', 'TO_DECIMAL': 'conversion',
    'TO_FLOAT': 'conversion', 'TO_BIGINT': 'conversion',
    'CAST': 'conversion', 'IS_NUMBER': 'conversion', 'IS_SPACES': 'conversion',
    # Conditional
    'IIF': 'conditional', 'DECODE': 'conditional', 'CASE': 'conditional',
    'NVL': 'conditional', 'NVL2': 'conditional', 'COALESCE': 'conditional',
    'NULLIF': 'conditional', 'GREATEST': 'conditional', 'LEAST': 'conditional',
    # Lookup
    'LOOKUP': 'lookup', 'LKP': 'lookup',
    # System
    'ERROR': 'system', 'ABORT': 'system', 'SETCOUNTVARIABLE': 'system',
    'SETVARIABLE': 'system', 'GETVAR': 'system',
    'MD5': 'system', 'CRC32': 'system', 'SHA256': 'system',
}

# SQL DML/DDL keywords for classification
_DML_RE = re.compile(r'\b(INSERT|UPDATE|DELETE|MERGE)\b', re.IGNORECASE)
_DDL_RE = re.compile(r'\b(CREATE|ALTER|DROP|TRUNCATE)\b', re.IGNORECASE)
_SQL_KEYWORDS_RE = re.compile(
    r'\b(SELECT|INSERT|UPDATE|DELETE|CREATE|JOIN|WHERE|FROM|INTO|GROUP\s+BY|ORDER\s+BY|HAVING|UNION)\b',
    re.IGNORECASE,
)
_PLSQL_RE = re.compile(r'\b(BEGIN|END|DECLARE|EXCEPTION|CURSOR|LOOP|PROCEDURE|FUNCTION|PACKAGE)\b', re.IGNORECASE)
_TABLE_IN_SQL_RE = re.compile(
    r'\b(?:FROM|JOIN|INTO|UPDATE|TABLE|MERGE\s+INTO|USING)\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)',
    re.IGNORECASE,
)
# SQL keywords that should never be treated as table names
_NOT_TABLE_NAMES = frozenset({
    'SELECT', 'SET', 'VALUES', 'WHERE', 'ON', 'AND', 'OR', 'NOT', 'NULL',
    'AS', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'CASE', 'WHEN', 'THEN', 'ELSE',
    'END', 'IS', 'BY', 'ASC', 'DESC', 'ALL', 'ANY', 'TOP', 'DISTINCT',
})


def _classify_code_language(text: str, context_type: str = '') -> Tuple[str, float]:
    """Classify code text into a language type.

    Returns (code_type, confidence).
    """
    if not text or not text.strip():
        return ('informatica_expression', 0.5)

    upper = text.upper()

    # Check for PL/SQL markers first (more specific than plain SQL)
    plsql_hits = len(_PLSQL_RE.findall(text))
    if plsql_hits >= 2:
        return ('plsql', min(0.7 + plsql_hits * 0.05, 1.0))

    # Check for SQL
    sql_hits = len(_SQL_KEYWORDS_RE.findall(text))
    if sql_hits >= 2:
        return ('sql', min(0.6 + sql_hits * 0.05, 1.0))

    # Java indicators
    if any(kw in upper for kw in ('PUBLIC CLASS', 'PRIVATE ', 'IMPORT JAVA', '.GETCLASS()', 'THROWS ')):
        return ('java', 0.85)

    # Python indicators
    if any(kw in text for kw in ('import ', 'def ', 'class ', 'print(', 'self.')):
        return ('python', 0.8)

    # Shell indicators
    if any(kw in text for kw in ('#!/bin/', 'echo ', 'export ', '| grep', '$HOME', '$PATH')):
        return ('shell', 0.8)

    # R indicators
    if any(kw in text for kw in ('<- ', 'library(', 'data.frame', 'ggplot')):
        return ('r', 0.8)

    # JavaScript indicators
    if any(kw in text for kw in ('function(', 'var ', 'const ', 'let ', '=>', 'console.log')):
        return ('javascript', 0.75)

    # Default: if it's from an expression context, it's Informatica expression language
    if context_type in ('expression', 'filter', 'router', 'joiner', 'lookup_condition'):
        return ('informatica_expression', 0.9)

    # If it has SQL keywords but only a few, still likely SQL
    if sql_hits >= 1:
        return ('sql', 0.5)

    return ('informatica_expression', 0.5)


def _extract_functions_from_text(text: str) -> List[Dict[str, Any]]:
    """Extract function calls from expression or SQL text.

    Returns list of {function_name, function_category, nested_depth}.
    """
    if not text:
        return []

    results: List[Dict[str, Any]] = []
    seen: Dict[str, int] = {}  # function_name -> count

    for match in _FUNCTION_RE.finditer(text):
        fname = match.group(1).upper()
        # Skip common SQL keywords that look like functions
        if fname in ('SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE',
                     'CREATE', 'ALTER', 'DROP', 'INTO', 'VALUES', 'SET',
                     'AND', 'NOT', 'EXISTS', 'BETWEEN', 'LIKE', 'TABLE',
                     'INDEX', 'VIEW', 'HAVING', 'GROUP', 'ORDER', 'UNION'):
            continue

        category = _KNOWN_FUNCTIONS.get(fname, 'custom_udf')

        # Estimate nesting depth by counting open parens before this position
        prefix = text[:match.start()]
        depth = prefix.count('(') - prefix.count(')')

        if fname in seen:
            seen[fname] += 1
        else:
            seen[fname] = 1
            results.append({
                'function_name': fname,
                'function_category': category,
                'nested_depth': max(0, depth),
                'call_count': 1,
            })

    # Update call counts for duplicates
    for r in results:
        r['call_count'] = seen[r['function_name']]

    return results


def _count_loc(text: str) -> int:
    """Count lines of code, excluding blank lines."""
    if not text:
        return 0
    return len([line for line in text.strip().split('\n') if line.strip()])


def _extract_tables_from_sql(sql: str) -> List[str]:
    """Extract table names referenced in SQL text."""
    if not sql:
        return []
    return list(set(m.upper() for m in _TABLE_IN_SQL_RE.findall(sql) if len(m) > 1 and m.upper() not in _NOT_TABLE_NAMES))


def _classify_session_intent(session_data: Dict[str, Any]) -> Tuple[str, float, Dict]:
    """Classify the core intent of a session based on its transform composition.

    Returns (intent, confidence, details_dict).
    """
    tx_detail = session_data.get('tx_detail', {})
    sources = session_data.get('sources', [])
    targets = session_data.get('targets', [])
    lookups = session_data.get('lookups', [])
    tx_count = session_data.get('tx_count', 0)
    mapping_detail = session_data.get('mapping_detail', {})

    signals: Dict[str, float] = {}

    # Check for aggregator transforms
    for ttype, count in tx_detail.items():
        ttype_l = ttype.lower()
        if 'aggregat' in ttype_l:
            signals['aggregate'] = signals.get('aggregate', 0) + count * 2
        if 'filter' in ttype_l:
            signals['filter'] = signals.get('filter', 0) + count
        if 'router' in ttype_l:
            signals['route'] = signals.get('route', 0) + count * 2
        if 'lookup' in ttype_l:
            signals['lookup_enrich'] = signals.get('lookup_enrich', 0) + count
        if 'update strategy' in ttype_l:
            signals['scd'] = signals.get('scd', 0) + count * 3
        if 'expression' in ttype_l:
            signals['transform'] = signals.get('transform', 0) + count * 0.5
        if 'joiner' in ttype_l:
            signals['transform'] = signals.get('transform', 0) + count

    # Check for mapping variables (SCD indicator)
    if session_data.get('mapping_variables'):
        signals['scd'] = signals.get('scd', 0) + 2

    # Lookup enrichment signal
    if len(lookups) >= 2:
        signals['lookup_enrich'] = signals.get('lookup_enrich', 0) + len(lookups)

    # Audit/logging targets
    for t in targets:
        t_lower = t.lower()
        if any(kw in t_lower for kw in ('audit', 'log', 'error', 'reject')):
            signals['audit'] = signals.get('audit', 0) + 2

    # Replicate: same source and target tables
    if sources and targets:
        overlap = set(s.upper() for s in sources) & set(t.upper() for t in targets)
        if overlap:
            signals['replicate'] = signals.get('replicate', 0) + len(overlap) * 3

    # Load: minimal transforms, mostly source→target
    if tx_count <= 3 and not signals:
        signals['load'] = 3.0

    # Default to transform if heavy expression/derived work
    if not signals:
        signals['transform'] = 1.0

    # Pick the strongest signal

    best_intent = max(signals, key=lambda k: signals[k])
    total = sum(signals.values())
    confidence = min(signals[best_intent] / max(total, 1), 1.0)

    return (best_intent, round(confidence, 2), signals)


def _enrich_session_code_analysis(sessions: Dict[str, Dict[str, Any]]) -> None:
    """Post-process sessions to extract embedded code, functions, and intent.

    Adds 'embedded_code', 'function_usage', 'code_profile' keys to each session dict.
    """
    for sname, sdata in sessions.items():
        embedded_code: List[Dict] = []
        all_functions: List[Dict] = []
        mapping_detail = sdata.get('mapping_detail', {})

        # ── Scan SQL overrides ──────────────────────────────────────
        for sql_override in mapping_detail.get('sql_overrides', []):
            sql_text = sql_override.get('sql', '')
            if not sql_text or not sql_text.strip():
                continue
            code_type, confidence = _classify_code_language(sql_text, 'sql_override')
            loc = _count_loc(sql_text)
            embedded_code.append({
                'transform_name': sql_override.get('transform', ''),
                'code_type': code_type,
                'code_subtype': 'sql_override',
                'code_text': sql_text,
                'line_count': loc,
                'char_count': len(sql_text),
                'language_confidence': confidence,
                'contains_dml': 1 if _DML_RE.search(sql_text) else 0,
                'contains_ddl': 1 if _DDL_RE.search(sql_text) else 0,
                'referenced_tables': _extract_tables_from_sql(sql_text),
                'referenced_functions': [f['function_name'] for f in _extract_functions_from_text(sql_text)],
            })
            all_functions.extend(_extract_functions_from_text(sql_text))

        # ── Scan Pre/Post SQL ──────────────────────────────────────
        for subtype, sql_list in [('pre_sql', mapping_detail.get('pre_sql', [])),
                                  ('post_sql', mapping_detail.get('post_sql', []))]:
            for sql_text in sql_list:
                if not sql_text or not sql_text.strip():
                    continue
                code_type, confidence = _classify_code_language(sql_text, subtype)
                loc = _count_loc(sql_text)
                embedded_code.append({
                    'transform_name': '',
                    'code_type': code_type,
                    'code_subtype': subtype,
                    'code_text': sql_text,
                    'line_count': loc,
                    'char_count': len(sql_text),
                    'language_confidence': confidence,
                    'contains_dml': 1 if _DML_RE.search(sql_text) else 0,
                    'contains_ddl': 1 if _DDL_RE.search(sql_text) else 0,
                    'referenced_tables': _extract_tables_from_sql(sql_text),
                    'referenced_functions': [f['function_name'] for f in _extract_functions_from_text(sql_text)],
                })
                all_functions.extend(_extract_functions_from_text(sql_text))

        # ── Scan join conditions ──────────────────────────────────
        for jc in mapping_detail.get('join_conditions', []):
            cond = jc.get('condition', '')
            if cond:
                funcs = _extract_functions_from_text(cond)
                for f in funcs:
                    f['transform_name'] = jc.get('joiner', '')
                    f['field_name'] = ''
                all_functions.extend(funcs)

        # ── Scan filter conditions ────────────────────────────────
        for fc in mapping_detail.get('filter_conditions', []):
            cond = fc.get('condition', '')
            if cond:
                funcs = _extract_functions_from_text(cond)
                for f in funcs:
                    f['transform_name'] = fc.get('filter', '')
                all_functions.extend(funcs)

        # ── Scan lookup conditions ────────────────────────────────
        for lc in mapping_detail.get('lookup_configs', []):
            cond = lc.get('condition', '')
            if cond:
                code_type, confidence = _classify_code_language(cond, 'lookup_condition')
                if code_type == 'sql' and _count_loc(cond) >= 2:
                    embedded_code.append({
                        'transform_name': lc.get('lookup', ''),
                        'code_type': code_type,
                        'code_subtype': 'lookup_condition',
                        'code_text': cond,
                        'line_count': _count_loc(cond),
                        'char_count': len(cond),
                        'language_confidence': confidence,
                        'contains_dml': 1 if _DML_RE.search(cond) else 0,
                        'contains_ddl': 0,
                        'referenced_tables': _extract_tables_from_sql(cond),
                        'referenced_functions': [f['function_name'] for f in _extract_functions_from_text(cond)],
                    })
                funcs = _extract_functions_from_text(cond)
                for f in funcs:
                    f['transform_name'] = lc.get('lookup', '')
                all_functions.extend(funcs)

        # ── Scan router group expressions ─────────────────────────
        for rg in mapping_detail.get('router_groups', []):
            for grp in rg.get('groups', []):
                cond = grp.get('condition', '')
                if cond:
                    funcs = _extract_functions_from_text(cond)
                    for f in funcs:
                        f['transform_name'] = rg.get('router', '')
                    all_functions.extend(funcs)

        # ── Scan TRANSFORMFIELD expressions ───────────────────────
        for field in mapping_detail.get('fields', []):
            expr = field.get('expression', '')
            if not expr or field.get('expression_type') == 'passthrough':
                continue
            funcs = _extract_functions_from_text(expr)
            for f in funcs:
                f['transform_name'] = field.get('transform', '')
                f['field_name'] = field.get('name', '')
            all_functions.extend(funcs)

        # ── Check for Java / Custom transforms (from instances) ──
        for inst in mapping_detail.get('instances', []):
            itype = (inst.get('transformation_type') or '').lower()
            if 'custom transformation' in itype or itype == 'java':
                embedded_code.append({
                    'transform_name': inst.get('name', ''),
                    'code_type': 'java',
                    'code_subtype': 'custom_transform',
                    'code_text': '',
                    'line_count': 0,
                    'char_count': 0,
                    'language_confidence': 0.7,
                    'contains_dml': 0,
                    'contains_ddl': 0,
                    'referenced_tables': [],
                    'referenced_functions': [],
                })

        # ── Build code profile ────────────────────────────────────
        code_types = set(ec['code_type'] for ec in embedded_code)
        code_subtypes = set(ec['code_subtype'] for ec in embedded_code)
        func_names = set(f['function_name'] for f in all_functions)
        func_categories: Dict[str, int] = {}
        for f in all_functions:
            cat = f.get('function_category', 'custom_udf')
            func_categories[cat] = func_categories.get(cat, 0) + f.get('call_count', 1)

        total_loc = sum(ec['line_count'] for ec in embedded_code)
        total_expressions = len([f for f in mapping_detail.get('fields', [])
                                 if f.get('expression_type') != 'passthrough' and f.get('expression')])

        # Classify intent
        intent, intent_confidence, intent_details = _classify_session_intent(sdata)

        code_profile = {
            'has_sql': 1 if 'sql' in code_types else 0,
            'has_plsql': 1 if 'plsql' in code_types else 0,
            'has_java': 1 if 'java' in code_types else 0,
            'has_python': 1 if 'python' in code_types else 0,
            'has_r_code': 1 if 'r' in code_types else 0,
            'has_shell': 1 if 'shell' in code_types else 0,
            'has_javascript': 1 if 'javascript' in code_types else 0,
            'has_stored_procedure': 1 if 'stored_proc' in code_subtypes else 0,
            'has_custom_transform': 1 if 'custom_transform' in code_subtypes else 0,
            'has_pre_post_sql': 1 if ('pre_sql' in code_subtypes or 'post_sql' in code_subtypes) else 0,
            'total_code_blocks': len(embedded_code),
            'total_loc': total_loc,
            'total_functions_used': sum(f.get('call_count', 1) for f in all_functions),
            'distinct_functions_used': len(func_names),
            'total_expressions': total_expressions,
            'aggregate_function_count': func_categories.get('aggregate', 0),
            'string_function_count': func_categories.get('string', 0),
            'date_function_count': func_categories.get('date', 0),
            'math_function_count': func_categories.get('math', 0),
            'conversion_function_count': func_categories.get('conversion', 0),
            'conditional_function_count': func_categories.get('conditional', 0),
            'lookup_function_count': func_categories.get('lookup', 0),
            'custom_udf_count': func_categories.get('custom_udf', 0),
            'core_intent': intent,
            'intent_confidence': intent_confidence,
            'intent_details': intent_details,
        }

        # Store on session dict
        sdata['embedded_code'] = embedded_code
        sdata['function_usage'] = all_functions
        sdata['code_profile'] = code_profile


# ── Per-file parsing ───────────────────────────────────────────────────────────

def _parse_file(content: bytes, fname: str) -> Dict[str, Any]:
    """Return raw session data extracted from one XML file.

    For files > 20MB, uses streaming iterparse to reduce peak memory.
    Each folder is processed and then cleared from memory.
    """
    if not content or not content.strip():
        return {'_error': 'Empty file content', '_file': fname}

    # Try UTF-8 first, fall back to Latin-1
    try:
        content_decoded = content
        root = _parse_xml(content)
    except Exception:
        try:
            text = content.decode('latin-1')
            content_decoded = text.encode('utf-8')
            root = _parse_xml(content_decoded)
            content = content_decoded
            logger.info("Re-encoded %s from Latin-1 to UTF-8", fname)
        except Exception as exc:
            if _LXML and hasattr(_ET, 'XMLSyntaxError') and isinstance(exc, _ET.XMLSyntaxError):
                return {'_error': f'XML syntax error: {exc}', '_file': fname}
            return {'_error': str(exc), '_file': fname}

    # Log file size for performance tracking
    size_mb = len(content) / (1024 * 1024)
    if size_mb > 10:
        logger.info("Parsing large file %s (%.1fMB)", fname, size_mb)

    sessions: Dict[str, Dict[str, Any]] = {}

    # For large files, use iterparse to process folders with memory cleanup.
    # Recovers partial data: if XML is truncated, keeps sessions from folders parsed before the error.
    if len(content) > _ITERPARSE_THRESHOLD:
        logger.info("Using iterparse for large file %s (%.1fMB)", fname, size_mb)
        folder_count = 0
        try:
            for folder in _parse_xml_iterparse(content):
                folder_count += 1
                before = len(sessions)
                _process_folder(folder, fname, sessions, deep=True)
                after = len(sessions)
                logger.info("  %s folder %d: +%d sessions (total %d)",
                            fname, folder_count, after - before, after)
            if sessions:
                return sessions
            # iterparse yielded no folders or no sessions — fall through to standard parse
            logger.info("Iterparse yielded 0 sessions for %s, falling back to full parse", fname)
        except Exception as exc:
            # Salvage whatever sessions were extracted before the error
            if sessions:
                logger.warning("Iterparse partial success for %s: %d sessions recovered before error: %s",
                               fname, len(sessions), exc)
                return sessions
            logger.warning("Iterparse failed for %s with no sessions recovered, falling back to full parse: %s",
                           fname, exc)
            # Fall through to standard parse

    folders = list(_iter(root, 'FOLDER'))
    if not folders:
        # No FOLDER elements — check if root itself has sessions
        if not list(_iter(root, 'SESSION')):
            return {'_error': f'No FOLDER or SESSION elements found in {fname}', '_file': fname}
        folders = [root]

    for i, folder in enumerate(folders, 1):
        before = len(sessions)
        _process_folder(folder, fname, sessions, deep=True)
        logger.info("  %s folder %d/%d: +%d sessions (total %d)",
                     fname, i, len(folders), len(sessions) - before, len(sessions))

    return sessions


def _process_folder(
    folder: Any,
    fname: str,
    sessions: Dict[str, Dict[str, Any]],
    deep: bool = True,
) -> None:
    """Process a single FOLDER element, extracting sessions into the sessions dict.

    Args:
        deep: If True, extract full L5/L6 metadata (mapping detail, field expressions,
              SQL overrides, connectors). If False (fast mode), only extract essential
              data needed for tier diagram: sessions, sources, targets, lookups, workflows.
              Fast mode is ~3-5x faster for large files.
    """
    folder_name = _attr(folder, 'NAME')

    # ── Collect source/target name→table mappings for this folder ──────
    src_tables: Dict[str, str] = {}   # SOURCE element name (upper) → table name
    tgt_tables: Dict[str, str] = {}   # TARGET element name (upper) → table name

    for src in _iter(folder, 'SOURCE'):
        n = _attr(src, 'NAME').strip().upper()
        db_tbl = _attr(src, 'DATABASENAME').strip().upper() or n
        if n:
            src_tables[n] = db_tbl or n

    for tgt in _iter(folder, 'TARGET'):
        n = _attr(tgt, 'NAME').strip().upper()
        db_tbl = _attr(tgt, 'DATABASENAME').strip().upper() or n
        if n:
            tgt_tables[n] = db_tbl or n

    # ── Informatica alias deduplication ────────────────────────────────
    # When the same source table appears multiple times in a mapping,
    # Informatica appends a numeric suffix to the SOURCE element NAME:
    # CUSTOMER_ORDER_PRODUCT, CUSTOMER_ORDER_PRODUCT1, CUSTOMER_ORDER_PRODUCT11.
    # If a suffixed name's base (digits stripped) exists in src_tables,
    # remap the suffixed key → same table as the base name.
    _SUFFIX_RE = re.compile(r'^(.+?)(\d+)$')
    for n in list(src_tables.keys()):
        m = _SUFFIX_RE.match(n)
        if m:
            base = m.group(1)
            if base in src_tables:
                # The base exists: this is an alias — point it to the same table
                src_tables[n] = src_tables[base]

    # ── Build lookup table map from TRANSFORMATION elements (THE FIX) ──
    # TABLEATTRIBUTE "Lookup table name" lives on <TRANSFORMATION TYPE="Lookup Procedure">
    # elements, NOT on INSTANCE elements. Build the map once per folder.
    # folder.iter() finds them recursively inside MAPPLET and MAPPING elements too.
    lkp_map: Dict[str, str] = _build_lookup_map(folder)

    # ── Pre-parse MAPPLET definitions → resolve their sources/lookups ──
    # When a MAPPING uses a MAPPLET instance (TYPE='MAPPLET'), we need to
    # extract the sources/targets/lookups that the MAPPLET internally uses.
    mapplet_data: Dict[str, Dict] = {}
    for mlt in folder.iter('MAPPLET'):
        mlt_name = _attr(mlt, 'NAME').strip().upper()
        if not mlt_name:
            continue
        ml_src: List[str] = []
        ml_tgt: List[str] = []
        ml_lkp: List[str] = []
        for inst in mlt.iter('INSTANCE'):
            itype     = _attr(inst, 'TYPE').lower()
            inst_name = _attr(inst, 'NAME').strip().upper()
            tname     = _attr(inst, 'TRANSFORMATION_NAME').strip().upper() or inst_name
            ttype     = _attr(inst, 'TRANSFORMATION_TYPE').lower()
            if itype == 'source':
                t = src_tables.get(tname, tname)
                if t and t not in ml_src:
                    ml_src.append(t)
                for asi in inst.iter('ASSOCIATED_SOURCE_INSTANCE'):
                    asi_n = _attr(asi, 'NAME').strip().upper()
                    t2 = src_tables.get(asi_n, asi_n)
                    if t2 and t2 not in ml_src:
                        ml_src.append(t2)
            elif itype == 'target':
                t = tgt_tables.get(tname, tname)
                if t and t not in ml_tgt:
                    ml_tgt.append(t)
            elif 'lookup' in ttype:
                tbl = lkp_map.get(tname) or lkp_map.get(inst_name)
                if tbl and tbl not in ml_lkp:
                    ml_lkp.append(tbl)
        mapplet_data[mlt_name] = {
            'sources': ml_src, 'targets': ml_tgt, 'lookups': ml_lkp,
        }

    # ── Parse mappings: source/target/lookup lists + transform counts ──
    mapping_data: Dict[str, Dict] = {}
    for m_el in _iter(folder, 'MAPPING'):
        mname = _attr(m_el, 'NAME')
        if not mname:
            continue
        m_src: List[str] = []
        m_tgt: List[str] = []
        m_lkp: List[str] = []
        tx_detail: Dict[str, int] = {}
        # Track instance names that are lookups (for SESSTRANSFORMATIONINST matching)
        lookup_instance_names: Set[str] = set()

        for inst in _iter(m_el, 'INSTANCE'):
            itype      = _attr(inst, 'TYPE').lower()
            inst_name  = _attr(inst, 'NAME').strip().upper()
            trans_name = _attr(inst, 'TRANSFORMATION_NAME').strip().upper()
            trans_type = _attr(inst, 'TRANSFORMATION_TYPE').lower()

            if itype == 'mapplet':
                # MAPPLET instance — merge all sources/targets/lookups from the
                # pre-resolved MAPPLET definition
                mlt_key = trans_name or inst_name
                mlt_info = mapplet_data.get(mlt_key, {})
                for s in mlt_info.get('sources', []):
                    if s not in m_src:
                        m_src.append(s)
                for t in mlt_info.get('targets', []):
                    if t not in m_tgt:
                        m_tgt.append(t)
                for lk in mlt_info.get('lookups', []):
                    if lk not in m_lkp:
                        m_lkp.append(lk)

            elif itype == 'source':
                # Direct SOURCE instance
                t = src_tables.get(trans_name, trans_name)
                if t and t not in m_src:
                    m_src.append(t)
                # Source Qualifier instances often have ASSOCIATED_SOURCE_INSTANCE children
                # that list the actual source tables connected to them
                for asi in _iter(inst, 'ASSOCIATED_SOURCE_INSTANCE'):
                    asi_name = _attr(asi, 'NAME').strip().upper()
                    t2 = src_tables.get(asi_name, asi_name)
                    if t2 and t2 not in m_src:
                        m_src.append(t2)

            elif itype == 'target':
                t = tgt_tables.get(trans_name, trans_name)
                if t and t not in m_tgt:
                    m_tgt.append(t)

            else:
                # Transformation instance — count by type
                tt = trans_type or itype
                if tt and tt not in ('source', 'target', ''):
                    tx_detail[tt] = tx_detail.get(tt, 0) + 1

                # ── Lookup table resolution (THE CRITICAL FIX) ──────────
                # Look up by TRANSFORMATION_NAME in the lkp_map built from
                # TRANSFORMATION elements — NOT by scanning INSTANCE children.
                if 'lookup' in trans_type:
                    lookup_instance_names.add(inst_name)
                    lookup_instance_names.add(trans_name)

                    # Primary: lkp_map keyed by TRANSFORMATION_NAME
                    tbl = lkp_map.get(trans_name)
                    if not tbl and inst_name:
                        tbl = lkp_map.get(inst_name)
                    if tbl and tbl not in m_lkp:
                        m_lkp.append(tbl)

                    # Fallback: TABLEATTRIBUTE directly on this INSTANCE element
                    # (some embedded lookup definitions store it inline)
                    for ta in _iter(inst, 'TABLEATTRIBUTE'):
                        aname = _attr(ta, 'NAME').lower()
                        if 'lookup table name' in aname or 'lookup source row' in aname:
                            lval = _norm_lkp(_attr(ta, 'VALUE'))
                            if lval and len(lval) > 2 and lval not in m_lkp:
                                m_lkp.append(lval)

                # Source Qualifier inside MAPPING (TYPE="TRANSFORMATION" but
                # TRANSFORMATION_TYPE="Source Qualifier") — check ASSOCIATED_SOURCE_INSTANCE
                elif 'source qualifier' in trans_type:
                    for asi in _iter(inst, 'ASSOCIATED_SOURCE_INSTANCE'):
                        asi_name = _attr(asi, 'NAME').strip().upper()
                        t2 = src_tables.get(asi_name, asi_name)
                        if t2 and t2 not in m_src:
                            m_src.append(t2)

        mapping_data[mname] = {
            'sources':              m_src,
            'targets':              m_tgt,
            'lookups':              m_lkp,
            'tx_detail':            tx_detail,
            'tx_count':             sum(tx_detail.values()),
            'lookup_instance_names': lookup_instance_names,
        }

    # ── Parse sessions ─────────────────────────────────────────────────
    for sess_el in _iter(folder, 'SESSION'):
        sname = _attr(sess_el, 'NAME')
        if not sname:
            continue
        mname = _attr(sess_el, 'MAPPINGNAME')
        m = mapping_data.get(mname, {})

        sources = list(m.get('sources', []))
        targets = list(m.get('targets', []))
        lookups = list(m.get('lookups', []))
        lookup_inst_names: Set[str] = m.get('lookup_instance_names', set())

        # Session-level overrides via SESSTRANSFORMATIONINST/ATTRIBUTE
        # These can override table names with runtime-resolved values
        for sti in _iter(sess_el, 'SESSTRANSFORMATIONINST'):
            sti_name = _attr(sti, 'TRANSFORMATIONNAME').strip().upper()
            sti_type = _attr(sti, 'TRANSFORMATIONTYPE').lower()
            is_lkp   = 'lookup' in sti_type or sti_name in lookup_inst_names

            for attr_el in _iter(sti, 'ATTRIBUTE'):
                aname = _attr(attr_el, 'NAME').lower()
                aval  = _attr(attr_el, 'VALUE').strip()
                if not aval or aval.startswith('$'):
                    continue
                aval_n = _norm(aval)
                if not aval_n or len(aval_n) < 2:
                    continue

                if 'source table name' in aname:
                    if aval_n not in sources:
                        sources.append(aval_n)
                elif 'target table name' in aname or 'table name prefix' in aname:
                    if aval_n not in targets:
                        targets.append(aval_n)
                elif is_lkp and ('lookup table' in aname or 'lookup source' in aname):
                    lval = _norm_lkp(aval)
                    if lval and len(lval) > 2 and lval not in lookups:
                        lookups.append(lval)

        sessions[sname] = {
            'file':     fname,
            'folder':   folder_name,
            'mapping':  mname,
            'sources':  sources,
            'targets':  targets,
            'lookups':  lookups,
            'tx_count': m.get('tx_count', 0),
            'tx_detail':m.get('tx_detail', {}),
            'workflow': '',
            'step':     0,
        }

    # ── Parse workflow execution order ─────────────────────────────────
    # ── Pre-parse WORKLET definitions ────────────────────────────────────
    # WORKLETs contain nested TASKINSTANCEs referencing sessions.
    # Build worklet_name → [session_names] map for resolving worklet references.
    worklet_sessions: Dict[str, List[str]] = {}
    _worklet_visited: set = set()  # cycle detection

    def _resolve_worklet(wklt_el: Any, visited: set) -> List[str]:
        wk_name = _attr(wklt_el, 'NAME')
        if wk_name in visited:
            return []  # cycle detected
        visited.add(wk_name)
        result: List[str] = []
        for ti in _iter(wklt_el, 'TASKINSTANCE'):
            tt = _attr(ti, 'TASKTYPE').lower()
            ref = _attr(ti, 'REFERENCETASKNAME')
            if not ref:
                continue
            if tt == 'session':
                result.append(ref)
            elif tt == 'worklet':
                # Nested worklet — find its definition and recurse
                for nested in folder.iter('WORKLET'):
                    if _attr(nested, 'NAME') == ref:
                        result.extend(_resolve_worklet(nested, visited))
                        break
        return result

    for wklt in _iter(folder, 'WORKLET'):
        wk_name = _attr(wklt, 'NAME')
        if wk_name:
            worklet_sessions[wk_name] = _resolve_worklet(wklt, set())

    for wf in _iter(folder, 'WORKFLOW'):
        wf_name = _attr(wf, 'NAME')

        task_names: List[str] = []
        for ti in _iter(wf, 'TASKINSTANCE'):
            tt = _attr(ti, 'TASKTYPE').lower()
            ref = _attr(ti, 'REFERENCETASKNAME')
            if not ref:
                continue
            if tt in ('session', 'command', 'eventwaittask'):
                task_names.append(ref)
            elif tt == 'worklet':
                # Expand worklet reference to its contained sessions
                task_names.extend(worklet_sessions.get(ref, []))

        # Build topological order from WORKFLOWLINK edges
        succ: Dict[str, List[str]] = defaultdict(list)
        pred: Dict[str, int] = defaultdict(int)
        for wfl in _iter(wf, 'WORKFLOWLINK'):
            frm = _attr(wfl, 'FROMTASK')
            to  = _attr(wfl, 'TOTASK')
            if not frm or not to or frm.upper() == 'START':
                continue
            succ[frm].append(to)
            pred[to] += 1

        roots = [t for t in task_names if pred[t] == 0]
        order: List[str] = []
        q = deque(roots)
        while q:
            n = q.popleft()
            order.append(n)
            for nxt in succ[n]:
                pred[nxt] -= 1
                if pred[nxt] == 0:
                    q.append(nxt)
        seen = set(order)
        for t in task_names:
            if t not in seen:
                order.append(t)

        for step, tname in enumerate(order, start=1):
            if tname in sessions:
                sessions[tname]['workflow'] = wf_name
                if sessions[tname]['step'] == 0:
                    sessions[tname]['step'] = step

    # ── Parse MAPPINGVARIABLE elements ────────────────────────────────
    # MAPPINGVARIABLEs store SCD/incremental state (e.g. $$LAST_LOAD_DATE).
    # Attach to sessions that use the parent MAPPING.
    for m_el in _iter(folder, 'MAPPING'):
        mname = _attr(m_el, 'NAME')
        if not mname:
            continue
        mvars = []
        for mv in _iter(m_el, 'MAPPINGVARIABLE'):
            mv_name = _attr(mv, 'NAME')
            if mv_name:
                mvars.append({
                    'name': mv_name,
                    'datatype': _attr(mv, 'DATATYPE'),
                    'default_value': _attr(mv, 'DEFAULTVALUE'),
                    'aggregate_type': _attr(mv, 'AGGREGATETYPE'),
                })
        if mvars:
            # Attach to all sessions that use this mapping
            for sname, sd in sessions.items():
                if sd.get('mapping', '').upper() == mname.upper():
                    sd.setdefault('mapping_variables', []).extend(mvars)

    # ── Parse SCHEDULER elements ──────────────────────────────────────
    # SCHEDULERs define execution timing. Attach schedule info to workflows,
    # then propagate to sessions.
    scheduler_map: Dict[str, Dict] = {}
    for sched in _iter(folder, 'SCHEDULER'):
        sched_name = _attr(sched, 'NAME')
        if sched_name:
            scheduler_map[sched_name] = {
                'name': sched_name,
                'scheduler_type': _attr(sched, 'SCHEDULERTYPE') or _attr(sched, 'TYPE'),
                'run_options': _attr(sched, 'RUNOPTIONS'),
                'repeat_interval': _attr(sched, 'REPEATINTERVAL'),
            }

    # ── Parse CONFIGREFERENCE (CONFIG) elements ───────────────────────
    # CONFIGREFERENCEs define buffer sizes, commit intervals, error handling.
    for sess_el in _iter(folder, 'SESSION'):
        sname = _attr(sess_el, 'NAME')
        if sname not in sessions:
            continue
        # Config reference
        config_name = _attr(sess_el, 'CONFIGREFERENCE')
        if config_name:
            sessions[sname]['config_reference'] = config_name
        # Scheduler reference (from workflow TASKINSTANCE)
        scheduler_name = _attr(sess_el, 'SCHEDULERREFERENCE')
        if scheduler_name and scheduler_name in scheduler_map:
            sessions[sname]['scheduler'] = scheduler_map[scheduler_name]

    # Propagate scheduler from workflow to sessions
    for wf in _iter(folder, 'WORKFLOW'):
        wf_sched = _attr(wf, 'SCHEDULERREFERENCE') or _attr(wf, 'SCHEDULER')
        if wf_sched and wf_sched in scheduler_map:
            wf_name = _attr(wf, 'NAME')
            for sname, sd in sessions.items():
                if sd.get('workflow') == wf_name and 'scheduler' not in sd:
                    sd['scheduler'] = scheduler_map[wf_sched]

    # ── Parse mapping detail for L5/L6 drill-down (ENHANCED) ─────────
    # Skipped in fast mode (deep=False) for ~3-5x speedup on large files.
    # Deep metadata can be loaded on-demand per session via /api/lineage/columns/{session_id}.
    if not deep:
        return

    _PARAM_RE = re.compile(r'(\$\$\w+|\$PM\w+)')

    for m_el in _iter(folder, 'MAPPING'):
        mname = _attr(m_el, 'NAME')
        if not mname:
            continue

        instances = []
        for inst in _iter(m_el, 'INSTANCE'):
            instances.append({
                'name': _attr(inst, 'NAME'),
                'type': _attr(inst, 'TYPE'),
                'transformation_name': _attr(inst, 'TRANSFORMATION_NAME'),
                'transformation_type': _attr(inst, 'TRANSFORMATION_TYPE'),
            })

        connectors = []
        for conn in _iter(m_el, 'CONNECTOR'):
            connectors.append({
                'from_instance': _attr(conn, 'FROMINSTANCE'),
                'from_field': _attr(conn, 'FROMFIELD'),
                'to_instance': _attr(conn, 'TOINSTANCE'),
                'to_field': _attr(conn, 'TOFIELD'),
                'from_type': _attr(conn, 'FROMINSTANCETYPE'),
                'to_type': _attr(conn, 'TOINSTANCETYPE'),
            })

        fields = []
        sql_overrides = []
        join_conditions = []
        filter_conditions = []
        router_groups = []
        lookup_configs = []
        parameters_found: Set[str] = set()

        for xf in _iter(m_el, 'TRANSFORMATION'):
            xf_name = _attr(xf, 'NAME')
            xf_type = _attr(xf, 'TYPE').lower()

            # Extract TRANSFORMFIELD with expression classification
            for tf in _iter(xf, 'TRANSFORMFIELD'):
                expr = _attr(tf, 'EXPRESSION')
                expr_type = 'passthrough'
                if expr:
                    expr_upper = expr.upper().strip()
                    if not expr_upper or expr_upper == _attr(tf, 'NAME').upper():
                        expr_type = 'passthrough'
                    elif any(fn in expr_upper for fn in ('SUM(', 'AVG(', 'COUNT(', 'MIN(', 'MAX(')):
                        expr_type = 'aggregated'
                    elif any(fn in expr_upper for fn in ('IIF(', 'DECODE(', 'CASE ', 'CONCAT(', 'SUBSTR(', 'TO_DATE(', 'LTRIM(', 'RTRIM(', 'LPAD(', 'RPAD(')):
                        expr_type = 'derived'
                    elif 'LOOKUP(' in expr_upper or 'LKP(' in expr_upper:
                        expr_type = 'lookup'
                    elif any(c in expr_upper for c in ('+', '-', '*', '/', '||')):
                        expr_type = 'derived'
                    elif expr_upper.startswith("'") or expr_upper.replace('.', '').isdigit():
                        expr_type = 'constant'
                    else:
                        expr_type = 'derived'
                    for pm in _PARAM_RE.findall(expr):
                        parameters_found.add(pm)
                fields.append({
                    'transform': xf_name,
                    'name': _attr(tf, 'NAME'),
                    'datatype': _attr(tf, 'DATATYPE'),
                    'precision': _attr(tf, 'PRECISION'),
                    'expression': expr,
                    'porttype': _attr(tf, 'PORTTYPE'),
                    'expression_type': expr_type,
                })

            # Build TABLEATTRIBUTE dict once per transformation (O(n) instead of O(n²))
            ta_dict: Dict[str, str] = {}
            for ta in _iter(xf, 'TABLEATTRIBUTE'):
                aname = _attr(ta, 'NAME').lower()
                aval = _attr(ta, 'VALUE').strip()
                if aval:
                    ta_dict[aname] = aval
                    for pm in _PARAM_RE.findall(aval):
                        parameters_found.add(pm)

            # Extract SQL overrides, join/filter/router/lookup conditions from cached dict
            for aname, aval in ta_dict.items():
                if 'sql query' in aname or 'sql override' in aname:
                    sql_overrides.append({'transform': xf_name, 'sql': aval})
                elif 'join condition' in aname:
                    jtype = ta_dict.get('join type', '')
                    join_conditions.append({'joiner': xf_name, 'condition': aval, 'type': jtype})
                elif 'filter condition' in aname and 'filter' in xf_type:
                    filter_conditions.append({'filter': xf_name, 'condition': aval})
                elif 'lookup condition' in aname or 'lookup sql override' in aname:
                    conn_info = ''
                    tbl_name = ''
                    for k2, v2 in ta_dict.items():
                        if 'connection information' in k2:
                            conn_info = v2
                        elif 'lookup table name' in k2:
                            tbl_name = v2
                    lookup_configs.append({
                        'lookup': xf_name, 'condition': aval,
                        'table': tbl_name, 'connection': conn_info,
                    })

            # Router group conditions
            if 'router' in xf_type:
                groups = []
                for grp in _iter(xf, 'GROUP'):
                    gname = _attr(grp, 'NAME')
                    gexpr = _attr(grp, 'EXPRESSION')
                    if gname:
                        groups.append({'name': gname, 'condition': gexpr})
                if groups:
                    router_groups.append({'router': xf_name, 'groups': groups})

        # ── Source definition fields ──
        source_fields = []
        for src in _iter(folder, 'SOURCE'):
            sname = _attr(src, 'NAME')
            src_flds = []
            for sf in _iter(src, 'SOURCEFIELD'):
                src_flds.append({
                    'name': _attr(sf, 'NAME'),
                    'datatype': _attr(sf, 'DATATYPE'),
                    'precision': _attr(sf, 'PRECISION'),
                    'scale': _attr(sf, 'SCALE'),
                    'keytype': _attr(sf, 'KEYTYPE'),
                    'nullable': _attr(sf, 'NULLABLE'),
                    'description': _attr(sf, 'DESCRIPTION') or _attr(sf, 'BUSINESSNAME'),
                })
            if src_flds:
                source_fields.append({'source': sname, 'fields': src_flds})

        # ── Target definition fields ──
        target_fields = []
        for tgt in _iter(folder, 'TARGET'):
            tname = _attr(tgt, 'NAME')
            tgt_flds = []
            for tf_el in _iter(tgt, 'TARGETFIELD'):
                tgt_flds.append({
                    'name': _attr(tf_el, 'NAME'),
                    'datatype': _attr(tf_el, 'DATATYPE'),
                    'precision': _attr(tf_el, 'PRECISION'),
                    'scale': _attr(tf_el, 'SCALE'),
                    'keytype': _attr(tf_el, 'KEYTYPE'),
                    'nullable': _attr(tf_el, 'NULLABLE'),
                })
            if tgt_flds:
                target_fields.append({'target': tname, 'fields': tgt_flds})

        detail: Dict[str, Any] = {
            'instances': instances,
            'connectors': connectors,
            'fields': fields,
        }
        if sql_overrides:
            detail['sql_overrides'] = sql_overrides
        if join_conditions:
            detail['join_conditions'] = join_conditions
        if filter_conditions:
            detail['filter_conditions'] = filter_conditions
        if router_groups:
            detail['router_groups'] = router_groups
        if lookup_configs:
            detail['lookup_configs'] = lookup_configs
        if source_fields:
            detail['source_fields'] = source_fields
        if target_fields:
            detail['target_fields'] = target_fields
        if parameters_found:
            detail['parameters'] = sorted(parameters_found)

        # Attach to all sessions that use this mapping
        for sname, sdata in sessions.items():
            if sdata.get('mapping') == mname:
                sdata['mapping_detail'] = detail

    # ── Extract Pre/Post SQL from SESSION elements ────────────────────
    for sess_el in _iter(folder, 'SESSION'):
        sname = _attr(sess_el, 'NAME')
        if sname not in sessions:
            continue
        pre_sql_list = []
        post_sql_list = []
        for sti in _iter(sess_el, 'SESSTRANSFORMATIONINST'):
            for attr_el in _iter(sti, 'ATTRIBUTE'):
                aname = _attr(attr_el, 'NAME').lower()
                aval = _attr(attr_el, 'VALUE').strip()
                if not aval:
                    continue
                if 'pre sql' in aname or 'pre-session sql' in aname:
                    pre_sql_list.append(aval)
                elif 'post sql' in aname or 'post-session sql' in aname:
                    post_sql_list.append(aval)
        if pre_sql_list or post_sql_list:
            md = sessions[sname].get('mapping_detail', {})
            if pre_sql_list:
                md['pre_sql'] = pre_sql_list
            if post_sql_list:
                md['post_sql'] = post_sql_list
            sessions[sname]['mapping_detail'] = md

    # ── Code analysis enrichment ──────────────────────────────────
    # Extract embedded code, function usage, and classify intent for each session
    _enrich_session_code_analysis(sessions)


# ── Main entry point ───────────────────────────────────────────────────────────

def analyze(
    xml_contents: List[bytes],
    filenames: List[str],
    progress_fn: Optional[Callable[..., None]] = None,
) -> Dict[str, Any]:
    """Parse N Informatica XML files and return Lumen_Retro-compatible tier diagram data.

    Captures all sessions, all writes, all reads, all lookups.
    Tiers are unlimited — as deep as the actual dependency graph requires.
    External source tables (read-only, not written by any session) appear at tier 0.5.

    Uses parse_coordinator for parallel parsing, per-file fault isolation,
    and SHA-256 duplicate detection when processing multiple files.

    Args:
        progress_fn: Optional callback(current, total, filename) called after each file is parsed.
    """
    from app.engines.parse_coordinator import parse_files_parallel

    # ── Phase 1: collect all sessions across all files (with fault isolation) ──
    warnings: List[str] = []

    # Wrap progress_fn to match coordinator's 5-arg signature, forwarding session count
    coord_progress = None
    if progress_fn is not None:
        def coord_progress(current: int, total: int, fname: str, status: str, sessions_so_far: int = 0) -> None:
            progress_fn(current, total, fname, sessions_so_far)

    # Scale workers: up to 6 for large batches, 4 for medium, capped by CPU count
    import os
    total_size = sum(len(c) for c in xml_contents)
    cpu_count = os.cpu_count() or 4
    workers = min(max(4, cpu_count - 1), 6, len(xml_contents))
    logger.info("Parse plan: %d files, %.0fMB total, %d workers, fast mode (no deep extraction)",
                len(xml_contents), total_size / (1024 * 1024), workers)

    all_sessions, audit = parse_files_parallel(
        xml_contents, filenames, _parse_file,
        progress_fn=coord_progress,
        max_workers=workers,
        deduplicate=(len(xml_contents) > 1),
    )

    # Collect warnings from audit
    for fr in audit.file_results:
        if fr.status == 'error' and fr.error:
            warnings.append(f"{fr.filename}: {fr.error}")
        elif fr.status == 'skipped_duplicate':
            warnings.append(f"{fr.filename}: skipped (duplicate content)")

    if audit.duplicates_skipped:
        logger.info("Dedup: skipped %d duplicate files out of %d total",
                     audit.duplicates_skipped, audit.total_files)

    if not all_sessions:
        return {
            'sessions': [], 'tables': [], 'connections': [],
            'stats': {'session_count': 0, 'write_conflicts': 0, 'dep_chains': 0,
                      'staleness_risks': 0, 'source_tables': 0, 'max_tier': 0},
            'warnings': warnings or ['No sessions found in uploaded files.'],
        }

    # ── Phase 1b: extract connection profiles from raw XML ─────────────────
    connection_profiles: List[Dict[str, str]] = []
    session_connections: Dict[str, List[Dict[str, str]]] = {}
    try:
        for content in xml_contents:
            root = _parse_xml(content)
            profiles = _extract_connection_profiles(root)
            for p in profiles:
                if not any(ep['name'] == p['name'] for ep in connection_profiles):
                    connection_profiles.append(p)
            sc = _extract_session_connections(root)
            for sname, conns in sc.items():
                if sname not in session_connections:
                    session_connections[sname] = conns
                else:
                    existing_names = {c['connection_name'] for c in session_connections[sname]}
                    for c in conns:
                        if c['connection_name'] not in existing_names:
                            session_connections[sname].append(c)
            del root  # free memory
    except Exception as exc:
        logger.warning("Connection profile extraction failed: %s", exc)

    if connection_profiles:
        logger.info("Extracted %d connection profiles, %d session-connection mappings",
                     len(connection_profiles), len(session_connections))

    # ── Phase 2: normalise all table refs to canonical uppercase table names ─
    logger.info("Phase 2: normalizing table refs for %d sessions", len(all_sessions))
    import time as _time
    _phase_t0 = _time.monotonic()
    for sdata in all_sessions.values():
        # Preserve raw (pre-normalization) table names for schema-level grouping
        sdata['raw_sources'] = list(sdata['sources'])
        sdata['raw_targets'] = list(sdata['targets'])
        sdata['raw_lookups'] = list(sdata['lookups'])
        sdata['sources'] = list(dict.fromkeys(
            _norm(x) for x in sdata['sources'] if x.strip() and len(x.strip()) > 1
        ))
        sdata['targets'] = list(dict.fromkeys(
            _norm(x) for x in sdata['targets'] if x.strip() and len(x.strip()) > 1
        ))
        sdata['lookups'] = list(dict.fromkeys(
            _norm_lkp(x) for x in sdata['lookups'] if x.strip() and len(x.strip()) > 1
        ))

    logger.info("Phase 2 done in %dms", int((_time.monotonic() - _phase_t0) * 1000))

    # ── Phase 2b: session deduplication ────────────────────────────────────
    # Dedup key: (full_session_name, folder_name, mapping_name, sorted_targets)
    # Including folder_name prevents collision of same-named sessions in different folders.
    # On duplicate: keep the session with richer data (more sources/lookups)
    _phase_t0 = _time.monotonic()
    before_dedup = len(all_sessions)
    dedup_map: Dict[tuple, str] = {}  # dedup_key → session_name to keep
    dups_to_remove: List[str] = []
    for sname, sd in all_sessions.items():
        dedup_key = (
            sd.get('full', sname),
            sd.get('folder', ''),
            sd.get('mapping', ''),
            tuple(sorted(sd.get('targets', []))),
        )
        if dedup_key in dedup_map:
            # Keep the one with more data
            existing_name = dedup_map[dedup_key]
            existing = all_sessions[existing_name]
            existing_richness = len(existing.get('sources', [])) + len(existing.get('lookups', []))
            new_richness = len(sd.get('sources', [])) + len(sd.get('lookups', []))
            if new_richness > existing_richness:
                # New one is richer — merge into new, remove old
                sd['sources'] = list(dict.fromkeys(sd['sources'] + existing.get('sources', [])))
                sd['targets'] = list(dict.fromkeys(sd['targets'] + existing.get('targets', [])))
                sd['lookups'] = list(dict.fromkeys(sd['lookups'] + existing.get('lookups', [])))
                if existing.get('mapping_detail') and not sd.get('mapping_detail'):
                    sd['mapping_detail'] = existing['mapping_detail']
                dups_to_remove.append(existing_name)
                dedup_map[dedup_key] = sname
            else:
                # Existing is richer — merge into existing, remove new
                existing['sources'] = list(dict.fromkeys(existing['sources'] + sd.get('sources', [])))
                existing['targets'] = list(dict.fromkeys(existing['targets'] + sd.get('targets', [])))
                existing['lookups'] = list(dict.fromkeys(existing['lookups'] + sd.get('lookups', [])))
                if sd.get('mapping_detail') and not existing.get('mapping_detail'):
                    existing['mapping_detail'] = sd['mapping_detail']
                dups_to_remove.append(sname)
        else:
            dedup_map[dedup_key] = sname

    for dup_name in dups_to_remove:
        all_sessions.pop(dup_name, None)

    after_dedup = len(all_sessions)
    if before_dedup != after_dedup:
        logger.info("Deduplication: %d sessions → %d unique (removed %d duplicates) in %dms",
                     before_dedup, after_dedup, before_dedup - after_dedup,
                     int((_time.monotonic() - _phase_t0) * 1000))

    # ── Phase 3: build table usage maps ────────────────────────────────────
    logger.info("Phase 3: building table usage maps")
    _phase_t0 = _time.monotonic()
    all_targets: Dict[str, List[str]] = defaultdict(list)   # table → [session_names that WRITE]
    all_sources: Dict[str, List[str]] = defaultdict(list)   # table → [session_names that READ]
    all_lookups: Dict[str, List[str]] = defaultdict(list)   # table → [session_names that LOOKUP]

    for sname, sd in all_sessions.items():
        for t in sd['targets']:
            if sname not in all_targets[t]:
                all_targets[t].append(sname)
        for s in sd['sources']:
            if sname not in all_sources[s]:
                all_sources[s].append(sname)
        for lk in sd['lookups']:
            if sname not in all_lookups[lk]:
                all_lookups[lk].append(sname)

    # Written tables: appear in all_targets
    conflict_tables: Set[str] = {t for t, w in all_targets.items() if len(w) > 1}
    critical_sessions: Set[str] = {
        s for writers in [all_targets[t] for t in conflict_tables] for s in writers
    }

    # Source-only tables: in all_sources or all_lookups but NOT in all_targets
    source_only_tables: Set[str] = set()
    for t in all_sources:
        if t and t not in all_targets:
            source_only_tables.add(t)
    for t in all_lookups:
        if t and t not in all_targets:
            source_only_tables.add(t)

    logger.info("Phase 3 done in %dms: %d target tables, %d source tables, %d lookup tables, %d conflicts",
                int((_time.monotonic() - _phase_t0) * 1000),
                len(all_targets), len(all_sources), len(all_lookups), len(conflict_tables))

    # ── Phase 4: assign session tiers via NetworkX DAG ─────────────────────
    # NO TIER CAP — unlimited depth
    logger.info("Phase 4: building DAG and assigning tiers for %d sessions", len(all_sessions))
    _phase_t0 = _time.monotonic()
    session_names = list(all_sessions.keys())

    if _NX:
        G = _nx.DiGraph()
        G.add_nodes_from(session_names)
        # RAW edges: writer → reader (reader reads a table written by writer)
        for table, writers in all_targets.items():
            readers = [r for r in all_sources.get(table, []) if r not in writers]
            for w in writers:
                for r in readers:
                    if w != r:
                        G.add_edge(w, r)
        # Lookup-staleness edges: writer → lookup_user (lookup on a written table)
        for table, writers in all_targets.items():
            users = [u for u in all_lookups.get(table, []) if u not in writers]
            for w in writers:
                for u in users:
                    if w != u:
                        G.add_edge(w, u)
        # Remove cycles efficiently: collapse each SCC into one representative node.
        # The old approach (find_cycle in a loop) was O(V+E) per cycle and hung on 14K+ sessions.
        edges_before = G.number_of_edges()
        sccs = list(_nx.strongly_connected_components(G))
        cycles_broken = 0
        for scc in sccs:
            if len(scc) <= 1:
                continue
            # For each SCC, remove back-edges to break cycles
            scc_set = set(scc)
            for u, v in list(G.edges(scc_set)):
                if v in scc_set and u in scc_set:
                    # Keep edges that follow topological order within the SCC (by name sort)
                    # Remove the rest to break cycles
                    if u > v:
                        G.remove_edge(u, v)
                        cycles_broken += 1
        if cycles_broken:
            logger.info("Cycle removal: %d back-edges removed from %d SCCs (edges %d→%d)",
                        cycles_broken, sum(1 for s in sccs if len(s) > 1), edges_before, G.number_of_edges())
        # Longest-path depth (= tier - 1)
        order = list(_nx.topological_sort(G))
        dist: Dict[str, int] = {n: 0 for n in G.nodes()}
        for n in order:
            for s in G.successors(n):
                if dist[n] + 1 > dist[s]:
                    dist[s] = dist[n] + 1
        # Tier = depth + 1, NO cap
        session_tier: Dict[str, int] = {n: dist[n] + 1 for n in session_names}
    else:
        # BFS fallback — also no cap
        in_deg: Dict[str, int] = defaultdict(int)
        succ_map: Dict[str, List[str]] = defaultdict(list)
        for table, writers in all_targets.items():
            combined = list(all_sources.get(table, [])) + list(all_lookups.get(table, []))
            readers = [r for r in combined if r not in writers]
            for w in writers:
                for r in readers:
                    in_deg[r] += 1
                    succ_map[w].append(r)
        session_tier = {}
        queue = [s for s in session_names if in_deg[s] == 0]
        visited: Set[str] = set()
        tier = 1
        while queue:
            nxt = []
            for s in queue:
                if s not in visited:
                    visited.add(s)
                    session_tier[s] = tier
                    nxt.extend(succ_map[s])
            queue = [s for s in nxt if s not in visited]
            tier += 1
        for s in session_names:
            if s not in session_tier:
                session_tier[s] = tier

    logger.info("Phase 4 done in %dms: max_tier=%d, nodes=%d",
                int((_time.monotonic() - _phase_t0) * 1000),
                max(session_tier.values()) if session_tier else 0, len(session_names))

    # ── Phase 5: sort sessions by (tier, workflow_step) ────────────────────
    logger.info("Phase 5-8: building output structures")
    _phase_t0 = _time.monotonic()
    def _sort_key(sn: str) -> Tuple[int, int, str]:
        return (session_tier.get(sn, 1), all_sessions[sn].get('step', 999), sn)

    ordered = sorted(session_names, key=_sort_key)

    sid_map: Dict[str, str] = {}
    sessions_out: List[Dict] = []
    for i, sname in enumerate(ordered, start=1):
        sid = f'S{i}'
        sid_map[sname] = sid
        sd = all_sessions[sname]
        sess_entry: Dict[str, Any] = {
            'id':          sid,
            'step':        sd.get('step') or i,
            'name':        _short(sname),
            'full':        sname,
            'tier':        session_tier.get(sname, 1),
            'transforms':  sd.get('tx_count', 0),
            'extReads':    len(sd['sources']),
            'lookupCount': len(sd['lookups']),
            'critical':    sname in critical_sessions,
            'sources':     sd['sources'],
            'targets':     sd['targets'],
            'lookups':     sd['lookups'],
            'raw_sources': sd.get('raw_sources', sd['sources']),
            'raw_targets': sd.get('raw_targets', sd['targets']),
            'raw_lookups': sd.get('raw_lookups', sd['lookups']),
        }
        # Attach connection info if available
        conn_info = session_connections.get(sname.upper(), [])
        if conn_info:
            sess_entry['connections_used'] = conn_info
        # Carry forward deep-parse data for downstream consumers (data_populator)
        if sd.get('mapping_detail'):
            sess_entry['mapping_detail'] = sd['mapping_detail']
        if sd.get('code_profile'):
            sess_entry['code_profile'] = sd['code_profile']
        if sd.get('embedded_code'):
            sess_entry['embedded_code'] = sd['embedded_code']
        if sd.get('function_usage'):
            sess_entry['function_usage'] = sd['function_usage']
        # Workflow and folder metadata
        if sd.get('workflow'):
            sess_entry['workflow'] = sd['workflow']
        if sd.get('folder'):
            sess_entry['folder'] = sd['folder']
        if sd.get('mapping'):
            sess_entry['mapping'] = sd['mapping']
        sessions_out.append(sess_entry)

    # ── Phase 6: build table nodes ─────────────────────────────────────────
    tid_map: Dict[str, str] = {}
    tables_out: List[Dict] = []
    t_idx = 0

    # (a) External source-only tables — tier 0.5 (before any session)
    for table in sorted(source_only_tables):
        if not table.strip():
            continue
        readers  = all_sources.get(table, [])
        lk_users = all_lookups.get(table, [])
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
            'lookupUsers':     len(lk_users),
        })

    # (b) Written tables — tier = max(writer_tiers) + 0.5
    for table in sorted(all_targets.keys()):
        if not table.strip():
            continue
        writers  = all_targets[table]
        readers  = [r for r in all_sources.get(table, [])  if r not in writers]
        lk_users = [u for u in all_lookups.get(table, []) if u not in writers]

        is_conflict    = table in conflict_tables
        has_downstream = bool(readers or lk_users)

        if is_conflict:
            ttype = 'conflict'
        elif has_downstream:
            ttype = 'chain'
        else:
            ttype = 'independent'

        writer_tiers = [session_tier.get(w, 1) for w in writers]
        table_tier   = float(max(writer_tiers)) + 0.5

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
            'lookupUsers':     len(lk_users),
            'writers':         writers,
        })

    # ── Phase 7: build connections ─────────────────────────────────────────
    conns_out: List[Dict] = []
    conn_set:  Set[str]   = set()

    def _add(frm: str, to: str, ctype: str) -> None:
        key = f'{frm}|{to}|{ctype}'
        if key not in conn_set:
            conn_set.add(key)
            conns_out.append({'from': frm, 'to': to, 'type': ctype})

    # (a) Source-only table → session connections
    for table in sorted(source_only_tables):
        tid = tid_map.get(table)
        if not tid:
            continue
        for reader in all_sources.get(table, []):
            sid = sid_map.get(reader)
            if sid:
                _add(tid, sid, 'source_read')
        for lk_user in all_lookups.get(table, []):
            sid = sid_map.get(lk_user)
            if sid:
                _add(tid, sid, 'lookup_stale')

    # (b) Written table connections
    for table in sorted(all_targets.keys()):
        tid = tid_map.get(table)
        if not tid:
            continue
        writers  = all_targets[table]
        readers  = [r for r in all_sources.get(table, [])  if r not in writers]
        lk_users = [u for u in all_lookups.get(table, []) if u not in writers]
        is_conflict    = table in conflict_tables
        has_downstream = bool(readers or lk_users)

        # Session → Table (write)
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

        # Table → Session (read)
        for reader in readers:
            sid = sid_map.get(reader)
            if not sid:
                continue
            if is_conflict:
                _add(tid, sid, 'read_after_write')
            else:
                _add(tid, sid, 'chain')

        # Table → Session (lookup)
        for user in lk_users:
            sid = sid_map.get(user)
            if not sid:
                continue
            _add(tid, sid, 'lookup_stale')

    # ── Phase 8: stats ─────────────────────────────────────────────────────
    max_tier = max((session_tier.get(s, 1) for s in session_names), default=1)
    stats = {
        'session_count':   len(sessions_out),
        'write_conflicts': len(conflict_tables),
        'dep_chains':      sum(1 for t in tables_out if t['type'] == 'chain'),
        'staleness_risks': sum(1 for c in conns_out if c['type'] == 'lookup_stale'),
        'source_tables':   len(source_only_tables),
        'max_tier':        max_tier,
    }

    logger.info("Phase 5-8 done in %dms: %d sessions, %d tables, %d connections",
                int((_time.monotonic() - _phase_t0) * 1000),
                len(sessions_out), len(tables_out), len(conns_out))

    result: Dict[str, Any] = {
        'sessions':    sessions_out,
        'tables':      tables_out,
        'connections': conns_out,
        'stats':       stats,
        'warnings':    warnings,
    }
    if connection_profiles:
        result['connection_profiles'] = connection_profiles
    return result
