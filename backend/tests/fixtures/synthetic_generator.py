"""Synthetic Informatica XML generator for scale testing.

Generates realistic PowerCenter XML with configurable session counts:
- 100 sessions: small project (~50KB)
- 500 sessions: medium project (~250KB)
- 5000 sessions: enterprise project (~2.5MB)

Each session gets realistic sources, targets, lookups, mappings,
workflows with topological ordering, and transform instances.
"""

from __future__ import annotations

import hashlib
import random
import string
from typing import List, Tuple
from xml.sax.saxutils import escape


# ── Table name pools ──────────────────────────────────────────────────────────

_SOURCE_TABLES = [
    "CUSTOMER", "ORDER_HEADER", "ORDER_LINE", "PRODUCT", "INVENTORY",
    "SUPPLIER", "SHIPMENT", "PAYMENT", "INVOICE", "ACCOUNT",
    "EMPLOYEE", "DEPARTMENT", "REGION", "COUNTRY", "CURRENCY",
    "EXCHANGE_RATE", "PRICE_LIST", "DISCOUNT", "TAX_RATE", "CATEGORY",
    "BRAND", "WAREHOUSE", "BIN_LOCATION", "PURCHASE_ORDER", "PO_LINE",
    "VENDOR", "MATERIAL", "BOM_HEADER", "BOM_LINE", "WORK_ORDER",
    "GL_JOURNAL", "GL_ACCOUNT", "COST_CENTER", "PROFIT_CENTER", "PROJECT",
    "BUDGET", "FORECAST", "ACTUAL", "VARIANCE", "KPI_METRIC",
]

_STAGING_TABLES = [
    "STG_CUSTOMER", "STG_ORDER", "STG_PRODUCT", "STG_INVENTORY",
    "STG_SUPPLIER", "STG_SHIPMENT", "STG_PAYMENT", "STG_INVOICE",
    "STG_EMPLOYEE", "STG_DEPARTMENT", "STG_ACCOUNT", "STG_GL_JOURNAL",
    "STG_PURCHASE_ORDER", "STG_VENDOR", "STG_MATERIAL", "STG_BOM",
    "STG_WORK_ORDER", "STG_BUDGET", "STG_FORECAST", "STG_KPI",
]

_FACT_TABLES = [
    "FACT_SALES", "FACT_INVENTORY", "FACT_SHIPMENT", "FACT_PAYMENT",
    "FACT_PRODUCTION", "FACT_PROCUREMENT", "FACT_GL_TRANSACTION",
    "FACT_BUDGET", "FACT_HEADCOUNT", "FACT_KPI",
]

_DIM_TABLES = [
    "DIM_CUSTOMER", "DIM_PRODUCT", "DIM_DATE", "DIM_EMPLOYEE",
    "DIM_GEOGRAPHY", "DIM_CURRENCY", "DIM_ACCOUNT", "DIM_VENDOR",
    "DIM_MATERIAL", "DIM_PROJECT",
]

_LOOKUP_TABLES = [
    "LKP_CUSTOMER_MASTER", "LKP_PRODUCT_MASTER", "LKP_DATE_BRIDGE",
    "LKP_CURRENCY_RATE", "LKP_ACCOUNT_MAP", "LKP_COST_CENTER",
    "LKP_VENDOR_MAP", "LKP_MATERIAL_MAP", "LKP_GEO_MAP", "LKP_PROJECT_MAP",
]

_TRANSFORM_TYPES = [
    "Expression", "Filter", "Joiner", "Aggregator", "Sorter",
    "Sequence Generator", "Update Strategy", "Router", "Normalizer",
    "Rank", "Union",
]


def _rand_suffix(n: int = 3) -> str:
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=n))


def _pick(pool: list, n: int) -> list:
    """Pick n items from pool (with replacement if needed)."""
    if n <= len(pool):
        return random.sample(pool, n)
    return [random.choice(pool) for _ in range(n)]


# ── XML generation ────────────────────────────────────────────────────────────

def _make_source_def(name: str) -> str:
    """Generate a SOURCE element with fields."""
    fields = []
    for i, col in enumerate(["ID", "NAME", "VALUE", "STATUS", "CREATED_DT"]):
        fields.append(
            f'        <SOURCEFIELD NAME="{col}" DATATYPE="string" '
            f'PRECISION="50" SCALE="0" KEYTYPE="{"PRIMARY KEY" if i == 0 else "NOT A KEY"}" '
            f'NULLABLE="{"NULL" if i > 0 else "NOTNULL"}"/>'
        )
    return (
        f'      <SOURCE NAME="{name}" DATABASENAME="{name}" DBDNAME="Oracle">\n'
        + "\n".join(fields) + "\n"
        f'      </SOURCE>'
    )


def _make_target_def(name: str) -> str:
    """Generate a TARGET element with fields."""
    fields = []
    for i, col in enumerate(["ID", "NAME", "VALUE", "STATUS", "LOAD_DT"]):
        fields.append(
            f'        <TARGETFIELD NAME="{col}" DATATYPE="string" '
            f'PRECISION="50" SCALE="0" KEYTYPE="{"PRIMARY KEY" if i == 0 else "NOT A KEY"}" '
            f'NULLABLE="{"NULL" if i > 0 else "NOTNULL"}"/>'
        )
    return (
        f'      <TARGET NAME="{name}" DATABASENAME="{name}" DBDNAME="Oracle">\n'
        + "\n".join(fields) + "\n"
        f'      </TARGET>'
    )


def _make_lookup_transform(name: str, table: str) -> str:
    """Generate a Lookup Procedure TRANSFORMATION element."""
    return (
        f'      <TRANSFORMATION NAME="{name}" TYPE="Lookup Procedure">\n'
        f'        <TABLEATTRIBUTE NAME="Lookup table name" VALUE="{table}"/>\n'
        f'        <TABLEATTRIBUTE NAME="Lookup condition" VALUE="{name}.ID = IN_ID"/>\n'
        f'        <TRANSFORMFIELD NAME="ID" DATATYPE="string" PORTTYPE="INPUT/OUTPUT" EXPRESSION="ID"/>\n'
        f'        <TRANSFORMFIELD NAME="NAME" DATATYPE="string" PORTTYPE="OUTPUT" EXPRESSION="NAME"/>\n'
        f'      </TRANSFORMATION>'
    )


def _make_mapping(
    mname: str,
    sources: List[str],
    targets: List[str],
    lookups: List[Tuple[str, str]],
    transforms: List[str],
) -> str:
    """Generate a MAPPING element with instances and connectors."""
    lines = [f'      <MAPPING NAME="{mname}">']

    # Source instances
    for src in sources:
        lines.append(
            f'        <INSTANCE NAME="SQ_{src}" TYPE="SOURCE" '
            f'TRANSFORMATION_NAME="{src}" TRANSFORMATION_TYPE="Source Qualifier"/>'
        )

    # Target instances
    for tgt in targets:
        lines.append(
            f'        <INSTANCE NAME="TGT_{tgt}" TYPE="TARGET" '
            f'TRANSFORMATION_NAME="{tgt}" TRANSFORMATION_TYPE="Target Definition"/>'
        )

    # Lookup instances
    for lkp_name, _lkp_table in lookups:
        lines.append(
            f'        <INSTANCE NAME="{lkp_name}" TYPE="TRANSFORMATION" '
            f'TRANSFORMATION_NAME="{lkp_name}" TRANSFORMATION_TYPE="Lookup Procedure"/>'
        )

    # Transform instances
    for tx in transforms:
        tx_type = random.choice(_TRANSFORM_TYPES)
        lines.append(
            f'        <INSTANCE NAME="{tx}" TYPE="TRANSFORMATION" '
            f'TRANSFORMATION_NAME="{tx}" TRANSFORMATION_TYPE="{tx_type}"/>'
        )

    # Connectors: source → transforms → target
    if sources and targets:
        lines.append(
            f'        <CONNECTOR FROMINSTANCE="SQ_{sources[0]}" FROMFIELD="ID" '
            f'TOINSTANCE="TGT_{targets[0]}" TOFIELD="ID" '
            f'FROMINSTANCETYPE="Source Qualifier" TOINSTANCETYPE="Target Definition"/>'
        )

    lines.append('      </MAPPING>')
    return "\n".join(lines)


def _make_session(sname: str, mname: str, overrides: List[Tuple[str, str, str]] | None = None) -> str:
    """Generate a SESSION element with optional SESSTRANSFORMATIONINST overrides."""
    lines = [f'      <SESSION NAME="{sname}" MAPPINGNAME="{mname}">']

    if overrides:
        for inst_name, attr_name, attr_val in overrides:
            lines.append(
                f'        <SESSTRANSFORMATIONINST TRANSFORMATIONNAME="{inst_name}" '
                f'TRANSFORMATIONTYPE="Source Qualifier">\n'
                f'          <ATTRIBUTE NAME="{attr_name}" VALUE="{attr_val}"/>\n'
                f'        </SESSTRANSFORMATIONINST>'
            )

    lines.append('      </SESSION>')
    return "\n".join(lines)


def _make_workflow(
    wf_name: str,
    session_names: List[str],
    links: List[Tuple[str, str]],
) -> str:
    """Generate a WORKFLOW element with TASKINSTANCE and WORKFLOWLINK."""
    lines = [f'      <WORKFLOW NAME="{wf_name}">']
    lines.append('        <TASKINSTANCE TASKNAME="start" TASKTYPE="Start"/>')
    for sn in session_names:
        lines.append(
            f'        <TASKINSTANCE TASKNAME="{sn}" TASKTYPE="Session" REFERENCETASKNAME="{sn}"/>'
        )
    for frm, to in links:
        lines.append(f'        <WORKFLOWLINK FROMTASK="{frm}" TOTASK="{to}"/>')
    lines.append('      </WORKFLOW>')
    return "\n".join(lines)


def generate_synthetic_xml(
    session_count: int = 100,
    *,
    seed: int | None = 42,
    files_per_folder: int = 50,
    write_conflict_pct: float = 0.1,
    lookup_pct: float = 0.3,
    chain_depth: int | None = None,
) -> bytes:
    """Generate a synthetic Informatica PowerCenter XML file.

    Args:
        session_count: Number of sessions to generate (100, 500, 5000, etc.)
        seed: Random seed for reproducibility (None for random)
        files_per_folder: Max sessions per FOLDER element
        write_conflict_pct: Fraction of targets shared by multiple sessions
        lookup_pct: Fraction of sessions that use lookups
        chain_depth: Force a dependency chain of this depth (None = natural)

    Returns:
        XML content as bytes
    """
    if seed is not None:
        random.seed(seed)

    # Scale table pools based on session count
    num_sources = max(20, session_count // 5)
    num_staging = max(10, session_count // 10)
    num_facts = max(5, session_count // 50)
    num_dims = max(5, session_count // 50)
    num_lookups = max(5, session_count // 20)

    # Generate extended table pools
    source_pool = list(_SOURCE_TABLES)
    while len(source_pool) < num_sources:
        source_pool.append(f"SRC_{_rand_suffix(4)}_{random.choice(['ORDER', 'TRANS', 'EVENT', 'LOG', 'MASTER'])}")

    staging_pool = list(_STAGING_TABLES)
    while len(staging_pool) < num_staging:
        staging_pool.append(f"STG_{_rand_suffix(4)}")

    fact_pool = list(_FACT_TABLES)
    while len(fact_pool) < num_facts:
        fact_pool.append(f"FACT_{_rand_suffix(4)}")

    dim_pool = list(_DIM_TABLES)
    while len(dim_pool) < num_dims:
        dim_pool.append(f"DIM_{_rand_suffix(4)}")

    lookup_pool = list(_LOOKUP_TABLES)
    while len(lookup_pool) < num_lookups:
        lookup_pool.append(f"LKP_{_rand_suffix(4)}")

    # Build sessions with realistic dependency patterns
    sessions = []
    all_written: dict[str, list[str]] = {}  # table → list of writer session names
    target_pool = staging_pool + fact_pool + dim_pool

    # Create chain_depth tiers of dependencies if requested
    if chain_depth and chain_depth > 1:
        tier_size = max(1, session_count // chain_depth)
    else:
        chain_depth = max(3, min(10, session_count // 20))
        tier_size = max(1, session_count // chain_depth)

    for i in range(session_count):
        tier = i // tier_size  # natural tiering
        sname = f"s_m_LOAD_{tier}_{i:04d}"
        mname = f"m_LOAD_{tier}_{i:04d}"
        wf_idx = i // files_per_folder

        # Pick sources: earlier tiers read from source_pool, later tiers read from staging/fact
        if tier == 0:
            sources = _pick(source_pool, random.randint(1, 3))
        else:
            # Read from tables written by earlier tiers + some source tables
            earlier_targets = [t for t, writers in all_written.items()
                               if any(s.startswith(f"s_m_LOAD_{tier-1}_") for s in writers)]
            if earlier_targets:
                sources = _pick(earlier_targets, min(random.randint(1, 2), len(earlier_targets)))
                if random.random() < 0.3:
                    sources.append(random.choice(source_pool))
            else:
                sources = _pick(source_pool, random.randint(1, 3))

        # Pick targets
        if tier < chain_depth // 2:
            targets = _pick(staging_pool, random.randint(1, 2))
        else:
            targets = _pick(fact_pool + dim_pool, random.randint(1, 2))

        # Introduce write conflicts
        if random.random() < write_conflict_pct and all_written:
            conflict_table = random.choice(list(all_written.keys()))
            if conflict_table not in targets:
                targets.append(conflict_table)

        # Pick lookups
        lookups = []
        if random.random() < lookup_pct:
            num_lkp = random.randint(1, 2)
            for lkp_table in _pick(lookup_pool, num_lkp):
                lkp_name = f"LKP_{lkp_table}_{i:04d}"
                lookups.append((lkp_name, lkp_table))

        # Pick transforms
        num_tx = random.randint(2, 6)
        transforms = [f"EXP_{mname}_{j}" for j in range(num_tx)]

        # Track written tables
        for tgt in targets:
            if tgt not in all_written:
                all_written[tgt] = []
            all_written[tgt].append(sname)

        sessions.append({
            "name": sname,
            "mapping": mname,
            "sources": sources,
            "targets": targets,
            "lookups": lookups,
            "transforms": transforms,
            "wf_idx": wf_idx,
            "tier": tier,
        })

    # Generate XML
    xml_parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE POWERMART>',
        '<POWERMART>',
        '  <REPOSITORY NAME="REPO_SYNTHETIC">',
    ]

    # Split into folders
    folder_count = max(1, (session_count + files_per_folder - 1) // files_per_folder)
    for folder_idx in range(folder_count):
        folder_sessions = [s for s in sessions if s["wf_idx"] == folder_idx]
        if not folder_sessions:
            continue

        xml_parts.append(f'    <FOLDER NAME="FOLDER_{folder_idx:03d}">')

        # Collect all unique tables in this folder
        folder_sources = set()
        folder_targets = set()
        folder_lookups = {}  # lkp_name → table
        for s in folder_sessions:
            folder_sources.update(s["sources"])
            folder_targets.update(s["targets"])
            for lkp_name, lkp_table in s["lookups"]:
                folder_lookups[lkp_name] = lkp_table

        # SOURCE definitions
        for src in sorted(folder_sources):
            xml_parts.append(_make_source_def(src))

        # TARGET definitions
        for tgt in sorted(folder_targets):
            xml_parts.append(_make_target_def(tgt))

        # Lookup TRANSFORMATION definitions
        for lkp_name, lkp_table in sorted(folder_lookups.items()):
            xml_parts.append(_make_lookup_transform(lkp_name, lkp_table))

        # MAPPING definitions
        for s in folder_sessions:
            xml_parts.append(_make_mapping(
                s["mapping"], s["sources"], s["targets"], s["lookups"], s["transforms"],
            ))

        # SESSION definitions
        for s in folder_sessions:
            xml_parts.append(_make_session(s["name"], s["mapping"]))

        # WORKFLOW definitions (one per folder)
        wf_sessions = [s["name"] for s in folder_sessions]
        # Build chain links within workflow
        links = [("start", wf_sessions[0])] if wf_sessions else []
        for j in range(len(wf_sessions) - 1):
            links.append((wf_sessions[j], wf_sessions[j + 1]))
        xml_parts.append(_make_workflow(f"wf_LOAD_{folder_idx:03d}", wf_sessions, links))

        xml_parts.append('    </FOLDER>')

    xml_parts.append('  </REPOSITORY>')
    xml_parts.append('</POWERMART>')

    return "\n".join(xml_parts).encode("utf-8")


def generate_synthetic_zip(
    session_count: int = 100,
    file_count: int = 5,
    *,
    seed: int | None = 42,
    include_duplicates: bool = False,
) -> bytes:
    """Generate a ZIP archive containing multiple synthetic XML files.

    Args:
        session_count: Total sessions across all files
        file_count: Number of XML files in the ZIP
        seed: Random seed for reproducibility
        include_duplicates: If True, adds duplicate files for testing dedup

    Returns:
        ZIP archive as bytes
    """
    import io
    import zipfile

    if seed is not None:
        random.seed(seed)

    sessions_per_file = max(1, session_count // file_count)
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for i in range(file_count):
            file_sessions = min(sessions_per_file, session_count - i * sessions_per_file)
            if file_sessions <= 0:
                break
            xml_bytes = generate_synthetic_xml(
                file_sessions,
                seed=(seed + i) if seed is not None else None,
            )
            zf.writestr(f"export_{i:03d}.xml", xml_bytes)

        if include_duplicates and file_count > 1:
            # Add a duplicate of the first file
            first_xml = generate_synthetic_xml(
                sessions_per_file,
                seed=seed,
            )
            zf.writestr("export_duplicate.xml", first_xml)

    return buf.getvalue()


# ── CLI entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    xml = generate_synthetic_xml(count)
    print(f"Generated {count}-session XML: {len(xml):,} bytes")

    # Quick validation
    from app.engines.infa_engine import analyze
    result = analyze([xml], [f"synthetic_{count}.xml"])
    print(f"Parsed: {result['stats']['session_count']} sessions, "
          f"{len(result['tables'])} tables, "
          f"{len(result['connections'])} connections, "
          f"max_tier={result['stats']['max_tier']}")
