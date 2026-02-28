"""NiFi XML parser — ported from nifi-xml-parser.js + nifi-xml-helpers.js.

Parses NiFi templates, flowController exports, and registry XML exports.
Uses lxml.etree for XML DOM traversal.
Includes Phase 1 enhancements: parameter contexts, controller service resolution,
FlowFile attribute tracking, and backpressure extraction.
"""

import logging
import re

from lxml import etree

from app.models.pipeline import ParameterContext, ParameterEntry, ParseResult, Warning
from app.models.processor import Connection, ControllerService, ProcessGroup, Processor

logger = logging.getLogger(__name__)


def _get_child_text(el: etree._Element, tag: str) -> str:
    """Get trimmed text of a direct child element (port of getChildText)."""
    child = el.find(tag)
    if child is not None and child.text:
        return child.text.strip()
    return ""


def _extract_properties(el: etree._Element) -> dict:
    """Extract key-value properties from a processor/service element.

    Handles multiple NiFi XML formats:
      - Template: config/properties/entry/key + value
      - Snippet: properties/entry/key + value
      - flowController: property/name + value
    """
    props: dict[str, str] = {}

    # Template format: config > properties > entry > key + value
    config = el.find("config")
    if config is not None:
        properties = config.find("properties")
        if properties is not None:
            for entry in properties.findall("entry"):
                key_el = entry.find("key")
                val_el = entry.find("value")
                # Accept entries with missing <value> (empty property) — NiFi
                # allows entries with just a <key> to represent empty properties
                if key_el is not None and key_el.text:
                    props[key_el.text] = (val_el.text or "") if val_el is not None else ""

    # Direct properties > entry (snippet level)
    if not props:
        properties = el.find("properties")
        if properties is not None:
            for entry in properties.findall("entry"):
                key_el = entry.find("key")
                val_el = entry.find("value")
                if key_el is not None and key_el.text:
                    props[key_el.text] = (val_el.text or "") if val_el is not None else ""

    # flowController format: direct property/name + value children
    if not props:
        for prop in el.findall("property"):
            name_el = prop.find("name")
            val_el = prop.find("value")
            if name_el is not None and name_el.text:
                props[name_el.text] = (val_el.text or "") if val_el is not None else ""

    return props


_DBCP_SERVICE_TYPES = {
    "DBCPConnectionPool",
    "DBCPConnectionPoolLookup",
    "HikariCPConnectionPool",
}

_JDBC_PROPERTY_KEYS = {
    "Database Connection URL",
    "Database Driver Class Name",
    "Database User",
    "Password",
    "database-connection-url",
    "database-driver-class-name",
    "db-user",
}


def _infer_parameter_type(key: str, value: str, sensitive: bool) -> str:
    """Infer parameter type: 'secret', 'numeric', or 'string'."""
    if sensitive:
        return "secret"
    lower_key = key.lower()
    if any(kw in lower_key for kw in ("password", "secret", "token", "key", "credential")):
        return "secret"
    stripped = value.strip()
    if stripped:
        try:
            float(stripped)
            return "numeric"
        except ValueError:
            pass
    return "string"


def _make_databricks_variable_name(context_name: str, param_key: str) -> str:
    """Generate a Databricks Asset Bundle variable name from a NiFi parameter."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", f"{context_name}_{param_key}").strip("_").lower()
    return slug


def _extract_parameter_contexts_xml(doc: etree._Element) -> list[ParameterContext]:
    """Extract parameterContexts from NiFi XML document."""
    contexts: list[ParameterContext] = []

    # Look for parameterContexts in multiple locations
    ctx_elements: list[etree._Element] = []
    for tag in [
        ".//parameterContexts/parameterContext",
        ".//parameterContext",
        ".//parameterContexts",
    ]:
        found = doc.findall(tag)
        if found:
            ctx_elements.extend(found)
            break

    seen_names: set[str] = set()
    for ctx_el in ctx_elements:
        ctx_name = _get_child_text(ctx_el, "name")
        if not ctx_name or ctx_name in seen_names:
            continue
        seen_names.add(ctx_name)

        params: list[ParameterEntry] = []
        for p_el in ctx_el.findall("parameters/parameter"):
            key = _get_child_text(p_el, "name") or _get_child_text(p_el, "key")
            value = _get_child_text(p_el, "value")
            sensitive_text = _get_child_text(p_el, "sensitive")
            sensitive = sensitive_text.lower() == "true" if sensitive_text else False
            if not key:
                continue
            inferred = _infer_parameter_type(key, value, sensitive)
            params.append(
                ParameterEntry(
                    key=key,
                    value="" if sensitive else value,
                    sensitive=sensitive,
                    inferred_type=inferred,
                    databricks_variable=_make_databricks_variable_name(ctx_name, key),
                )
            )

        # Also try flat parameter children (no wrapper)
        if not params:
            for p_el in ctx_el.findall("parameter"):
                key = _get_child_text(p_el, "name") or _get_child_text(p_el, "key")
                value = _get_child_text(p_el, "value")
                sensitive_text = _get_child_text(p_el, "sensitive")
                sensitive = sensitive_text.lower() == "true" if sensitive_text else False
                if not key:
                    continue
                inferred = _infer_parameter_type(key, value, sensitive)
                params.append(
                    ParameterEntry(
                        key=key,
                        value="" if sensitive else value,
                        sensitive=sensitive,
                        inferred_type=inferred,
                        databricks_variable=_make_databricks_variable_name(ctx_name, key),
                    )
                )

        contexts.append(ParameterContext(name=ctx_name, parameters=params))

    return contexts


def _build_cs_index(controller_services: list[ControllerService]) -> dict[str, dict]:
    """Build controller service name -> properties index."""
    index: dict[str, dict] = {}
    for cs in controller_services:
        index[cs.name] = {"type": cs.type, "properties": dict(cs.properties)}
    return index


def _resolve_processor_services(proc: Processor, cs_index: dict[str, dict]) -> dict | None:
    """Resolve controller service references in processor properties."""
    resolved: dict[str, dict] = {}
    for prop_key, prop_val in proc.properties.items():
        if not prop_val or not isinstance(prop_val, str):
            continue
        if prop_val in cs_index:
            cs_entry = cs_index[prop_val]
            service_info: dict = {"service_name": prop_val, "service_type": cs_entry["type"]}
            if cs_entry["type"] in _DBCP_SERVICE_TYPES:
                for jdbc_key in _JDBC_PROPERTY_KEYS:
                    if jdbc_key in cs_entry["properties"]:
                        safe_key = jdbc_key.lower().replace(" ", "_").replace("-", "_")
                        service_info[safe_key] = cs_entry["properties"][jdbc_key]
            else:
                for sk, sv in cs_entry["properties"].items():
                    if sv and "password" not in sk.lower() and "secret" not in sk.lower():
                        service_info[sk] = sv
            resolved[prop_key] = service_info
    return resolved if resolved else None


def parse_nifi_xml(content: bytes, filename: str) -> ParseResult:
    """Parse a NiFi XML document into a normalized ParseResult.

    For large files (>10MB), logs a performance warning.
    Uses lxml's DOM parser which handles multi-MB XML efficiently.
    """
    content_mb = len(content) / (1024 * 1024)
    if content_mb > 10:
        logger.warning(
            "Large XML file: %.1fMB (%s). Parsing may take extra time.",
            content_mb, filename,
        )

    try:
        doc = etree.fromstring(content)
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"Invalid XML: {exc}") from exc

    processors: list[Processor] = []
    connections: list[Connection] = []
    controller_services: list[ControllerService] = []
    process_groups: list[ProcessGroup] = []
    warnings: list[Warning] = []
    id_to_name: dict[str, str] = {}

    def _find_children(parent: etree._Element, plural: str, singular: str) -> list[etree._Element]:
        """Find child elements handling both plural wrapper and singular tags."""
        children = list(parent.findall(plural))
        if not children:
            children = list(parent.findall(singular))
        return children

    def _extract_from_group(group_el: etree._Element, group_name: str) -> None:
        contents = group_el.find("contents")
        if contents is None:
            contents = group_el

        # Processors
        proc_els = _find_children(contents, "processors", "processor")
        for proc in proc_els:
            name = _get_child_text(proc, "name")
            full_type = _get_child_text(proc, "type") or _get_child_text(proc, "class")
            short_type = full_type.rsplit(".", 1)[-1] if full_type else ""
            state = _get_child_text(proc, "state")
            props = _extract_properties(proc)
            proc_id = _get_child_text(proc, "id")

            # Scheduling
            config_el = proc.find("config")
            sched_period = ""
            sched_strategy = ""
            if config_el is not None:
                sp = config_el.find("schedulingPeriod")
                ss = config_el.find("schedulingStrategy")
                sched_period = sp.text.strip() if sp is not None and sp.text else ""
                sched_strategy = ss.text.strip() if ss is not None and ss.text else ""
            if not sched_period:
                sched_period = _get_child_text(proc, "schedulingPeriod")
            if not sched_strategy:
                sched_strategy = _get_child_text(proc, "schedulingStrategy")

            if proc_id:
                id_to_name[proc_id] = name or short_type

            scheduling = None
            if sched_period or sched_strategy:
                scheduling = {"period": sched_period, "strategy": sched_strategy}

            processors.append(
                Processor(
                    name=name or short_type,
                    type=short_type,
                    platform="nifi",
                    properties=props,
                    group=group_name,
                    state=state or "RUNNING",
                    scheduling=scheduling,
                )
            )

        # Connections
        conn_els = _find_children(contents, "connections", "connection")
        for conn in conn_els:
            src_el = conn.find("source")
            dst_el = conn.find("destination")
            src_id = ""
            dst_id = ""
            if src_el is not None:
                sid = src_el.find("id")
                src_id = sid.text.strip() if sid is not None and sid.text else ""
            if not src_id:
                src_id = _get_child_text(conn, "sourceId")
            if dst_el is not None:
                did = dst_el.find("id")
                dst_id = did.text.strip() if did is not None and did.text else ""
            if not dst_id:
                dst_id = _get_child_text(conn, "destinationId")

            rels: list[str] = []
            for r in conn.findall("selectedRelationships"):
                if r.text:
                    rels.append(r.text.strip())
            if not rels:
                for r in conn.findall("relationship"):
                    if r.text:
                        rels.append(r.text.strip())

            # Extract backpressure configuration
            bp_obj_text = _get_child_text(conn, "backPressureObjectThreshold")
            bp_data_text = _get_child_text(conn, "backPressureDataSizeThreshold")
            bp_obj = int(bp_obj_text) if bp_obj_text and bp_obj_text.isdigit() else 0
            bp_data = bp_data_text or ""

            connections.append(
                Connection(
                    source_name=src_id,
                    destination_name=dst_id,
                    relationship=",".join(rels) if rels else "success",
                    back_pressure_object_threshold=bp_obj,
                    back_pressure_data_size_threshold=bp_data,
                )
            )

        # Input ports
        for port_tag in ["inputPorts/inputPort", "inputPort"]:
            for p in contents.findall(port_tag):
                pid = _get_child_text(p, "id")
                pname = _get_child_text(p, "name") or "InputPort"
                if pid:
                    id_to_name[pid] = pname
                    processors.append(
                        Processor(
                            name=pname,
                            type="InputPort",
                            platform="nifi",
                            group=group_name,
                            properties={},
                        )
                    )

        # Output ports
        for port_tag in ["outputPorts/outputPort", "outputPort"]:
            for p in contents.findall(port_tag):
                pid = _get_child_text(p, "id")
                pname = _get_child_text(p, "name") or "OutputPort"
                if pid:
                    id_to_name[pid] = pname
                    processors.append(
                        Processor(
                            name=pname,
                            type="OutputPort",
                            platform="nifi",
                            group=group_name,
                            properties={},
                        )
                    )

        # Funnels — give each a unique name to prevent DAG node collisions
        funnel_counter = 0
        for funnel_tag in ["funnels/funnel", "funnel"]:
            for f in contents.findall(funnel_tag):
                fid = _get_child_text(f, "id")
                if fid:
                    funnel_counter += 1
                    funnel_name = f"Funnel_{funnel_counter}" if funnel_counter > 1 else "Funnel"
                    id_to_name[fid] = funnel_name
                    processors.append(
                        Processor(
                            name=funnel_name,
                            type="Funnel",
                            platform="nifi",
                            group=group_name,
                            properties={},
                        )
                    )

        # Nested processGroups
        pg_els = _find_children(contents, "processGroups", "processGroup")
        for pg in pg_els:
            pg_name = _get_child_text(pg, "name")
            pg_id = _get_child_text(pg, "id")
            if pg_id:
                id_to_name[pg_id] = pg_name
            process_groups.append(ProcessGroup(name=pg_name))
            _extract_from_group(pg, pg_name)

    # Find the root entry point
    _candidates = [
        doc.find(".//template/snippet"),
        doc.find(".//snippet"),
        doc.find(".//flowController/rootGroup"),
        doc.find(".//rootGroup"),
        doc.find(".//processGroupFlow/flow"),
    ]
    snippet = next((c for c in _candidates if c is not None), doc)

    # Controller services
    def _parse_cs_elements(cs_els: list[etree._Element]) -> None:
        for cs in cs_els:
            name = _get_child_text(cs, "name")
            cs_type = _get_child_text(cs, "type") or _get_child_text(cs, "class")
            short_type = cs_type.rsplit(".", 1)[-1] if cs_type else ""
            cs_props: dict[str, str] = {}
            # entry format
            props_el = cs.find("properties")
            if props_el is not None:
                for entry in props_el.findall("entry"):
                    key_el = entry.find("key")
                    val_el = entry.find("value")
                    if key_el is not None and key_el.text and val_el is not None:
                        cs_props[key_el.text] = val_el.text or ""
            # property format
            if not cs_props:
                for prop in cs.findall("property"):
                    n = prop.find("name")
                    v = prop.find("value")
                    if n is not None and n.text:
                        cs_props[n.text] = (v.text or "") if v is not None else ""
            controller_services.append(
                ControllerService(
                    name=name or short_type,
                    type=short_type,
                    properties=cs_props,
                )
            )

    # Try multiple CS locations
    cs_wrapper = snippet.find("controllerServices")
    if cs_wrapper is not None:
        _parse_cs_elements(list(cs_wrapper.findall("controllerService")))
    else:
        _parse_cs_elements(list(snippet.findall("controllerService")))
    # Global CS container outside snippet
    if not controller_services:
        global_cs = doc.find(".//controllerServices")
        if global_cs is not None:
            _parse_cs_elements(list(global_cs.findall("controllerService")))

    # Top-level processGroups
    pg_els = _find_children(snippet, "processGroups", "processGroup")
    for pg in pg_els:
        pg_name = _get_child_text(pg, "name")
        pg_id = _get_child_text(pg, "id")
        if pg_id:
            id_to_name[pg_id] = pg_name
        process_groups.append(ProcessGroup(name=pg_name))
        _extract_from_group(pg, pg_name)

    # Top-level processors directly in snippet
    proc_els = _find_children(snippet, "processors", "processor")
    for proc in proc_els:
        name = _get_child_text(proc, "name")
        full_type = _get_child_text(proc, "type") or _get_child_text(proc, "class")
        short_type = full_type.rsplit(".", 1)[-1] if full_type else ""
        proc_id = _get_child_text(proc, "id")
        if proc_id:
            id_to_name[proc_id] = name or short_type
        props = _extract_properties(proc)

        config_el = proc.find("config")
        sched_period = ""
        sched_strategy = ""
        if config_el is not None:
            sp = config_el.find("schedulingPeriod")
            ss = config_el.find("schedulingStrategy")
            sched_period = sp.text.strip() if sp is not None and sp.text else ""
            sched_strategy = ss.text.strip() if ss is not None and ss.text else ""
        if not sched_period:
            sched_period = _get_child_text(proc, "schedulingPeriod")
        if not sched_strategy:
            sched_strategy = _get_child_text(proc, "schedulingStrategy")

        scheduling = None
        if sched_period or sched_strategy:
            scheduling = {"period": sched_period, "strategy": sched_strategy}

        processors.append(
            Processor(
                name=name or short_type,
                type=short_type,
                platform="nifi",
                properties=props,
                group="(root)",
                state=_get_child_text(proc, "state") or "RUNNING",
                scheduling=scheduling,
            )
        )

    # Top-level connections in snippet
    conn_keys: set[str] = set()
    for c in connections:
        conn_keys.add(f"{c.source_name}|{c.destination_name}|{c.relationship}")

    conn_els = _find_children(snippet, "connections", "connection")
    for conn in conn_els:
        src_el = conn.find("source")
        dst_el = conn.find("destination")
        src_id = ""
        dst_id = ""
        if src_el is not None:
            sid = src_el.find("id")
            src_id = sid.text.strip() if sid is not None and sid.text else ""
        if not src_id:
            src_id = _get_child_text(conn, "sourceId")
        if dst_el is not None:
            did = dst_el.find("id")
            dst_id = did.text.strip() if did is not None and did.text else ""
        if not dst_id:
            dst_id = _get_child_text(conn, "destinationId")

        rels: list[str] = []
        for r in conn.findall("selectedRelationships"):
            if r.text:
                rels.append(r.text.strip())
        if not rels:
            for r in conn.findall("relationship"):
                if r.text:
                    rels.append(r.text.strip())

        rel_str = ",".join(sorted(rels)) if rels else "success"
        key = f"{src_id}|{dst_id}|{rel_str}"
        if key not in conn_keys:
            conn_keys.add(key)
            # Extract backpressure
            bp_obj_text = _get_child_text(conn, "backPressureObjectThreshold")
            bp_data_text = _get_child_text(conn, "backPressureDataSizeThreshold")
            bp_obj = int(bp_obj_text) if bp_obj_text and bp_obj_text.isdigit() else 0
            bp_data = bp_data_text or ""
            connections.append(
                Connection(
                    source_name=src_id,
                    destination_name=dst_id,
                    relationship=rel_str,
                    back_pressure_object_threshold=bp_obj,
                    back_pressure_data_size_threshold=bp_data,
                )
            )

    # Resolve connection IDs to processor names
    resolved_connections: list[Connection] = []
    for c in connections:
        src_fallback = c.source_name[:12] + "..." if len(c.source_name) > 12 else c.source_name
        dst_fallback = c.destination_name[:12] + "..." if len(c.destination_name) > 12 else c.destination_name
        src_name = id_to_name.get(c.source_name, src_fallback)
        dst_name = id_to_name.get(c.destination_name, dst_fallback)
        resolved_connections.append(
            Connection(
                source_name=src_name,
                destination_name=dst_name,
                relationship=c.relationship,
                back_pressure_object_threshold=c.back_pressure_object_threshold,
                back_pressure_data_size_threshold=c.back_pressure_data_size_threshold,
            )
        )

    # Populate process group processor lists
    group_map: dict[str, list[str]] = {}
    for p in processors:
        group_map.setdefault(p.group, []).append(p.name)
    for pg in process_groups:
        pg.processors = group_map.get(pg.name, [])

    # Detect version
    version = ""
    encoding_el = doc.find(".//encodingVersion")
    if encoding_el is not None and encoding_el.text:
        version = encoding_el.text.strip()

    # Phase 1: Extract parameter contexts
    parameter_contexts = _extract_parameter_contexts_xml(doc)

    # Phase 1: Resolve controller service references on processors
    cs_index = _build_cs_index(controller_services)
    for proc in processors:
        resolved_svc = _resolve_processor_services(proc, cs_index)
        if resolved_svc:
            proc.resolved_services = resolved_svc

    if not processors:
        warnings.append(Warning(severity="warning", message="No processors found in XML", source=filename))

    return ParseResult(
        platform="nifi",
        version=version,
        processors=processors,
        connections=resolved_connections,
        process_groups=process_groups,
        controller_services=controller_services,
        parameter_contexts=parameter_contexts,
        metadata={"source_file": filename, "id_count": len(id_to_name)},
        warnings=warnings,
    )
