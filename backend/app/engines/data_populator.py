"""Data populator — fills per-view materialized tables from parse output.

Four entry points called at different stages of the pipeline:
  1. populate_core_tables()           — after parse (sessions, tables, connections)
  2. populate_view_tables()           — after core tables (derived per-view data)
  3. populate_constellation_tables()  — after clustering
  4. populate_vector_tables()         — after vector analysis

All functions are idempotent: they delete existing rows for the upload_id before
inserting new ones. This makes re-parse and re-analysis safe without manual cleanup.

Table Groups (26 total):
  Foundation (4): SessionRecord, TableRecord, ConnectionRecord, ConnectionProfileRecord
  Core Views (10): TierLayout, GalaxyNodes, ExplorerDetail, WriteConflicts,
                    ReadChains, ExecOrder, MatrixCells, TableProfiles,
                    DuplicateGroups, DuplicateMembers
  Constellation (3): ConstellationChunks, ConstellationPoints, ConstellationEdges
  Vector (8): ComplexityScores, WaveAssignments, UmapCoords, Communities,
              WaveFunction, ConcentrationGroups, ConcentrationMembers, Ensemble

Also provides reconstruction functions to rebuild in-memory dicts from
normalized DB tables (used when loading an existing upload without re-parsing):
  - reconstruct_tier_data()        — sessions, tables, connections
  - reconstruct_constellation()    — chunks, points, edges
  - reconstruct_vector_results()   — all vector engine outputs
"""

import hashlib
import json
import logging
import re
import threading
import time
from collections import defaultdict

from sqlalchemy.orm import Session

from app.models.database import (
    ConfigRecord,
    ConnectionProfileRecord,
    ConnectionRecord,
    EmbeddedCodeRecord,
    ExpressionRecord,
    FieldMappingRecord,
    FolderRecord,
    FunctionUsageRecord,
    LookupConfigRecord,
    MappingRecord,
    MetadataExtensionRecord,
    ParameterRecord,
    RepositoryMetadataRecord,
    SQLOverrideRecord,
    SessionCodeProfile,
    SessionRecord,
    ShortcutRecord,
    SourceDefinitionRecord,
    TableRecord,
    TargetDefinitionRecord,
    TransformRecord,
    WorkflowRecord,
    WorkflowTaskEdgeRecord,
    VwAffinityPropagation,
    VwDataFlow,
    VwExpressionComplexity,
    VwSchemaDrift,
    VwTableGravity,
    VwTransformCentrality,
    VwComplexityScores,
    VwCommunities,
    VwConcentrationGroups,
    VwConcentrationMembers,
    VwConstellationChunks,
    VwConstellationEdges,
    VwConstellationPoints,
    VwDuplicateGroups,
    VwDuplicateMembers,
    VwEnsemble,
    VwExecOrder,
    VwExplorerDetail,
    VwGalaxyNodes,
    VwHdbscanDensity,
    VwHierarchicalLineage,
    VwMatrixCells,
    VwReadChains,
    VwSpectralClustering,
    VwTableProfiles,
    VwTierLayout,
    VwUmapCoords,
    VwWaveAssignments,
    VwWaveFunction,
    VwWriteConflicts,
)

logger = logging.getLogger(__name__)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _delete_for_upload(db: Session, model, upload_id: int) -> None:
    """Delete all rows for a given upload_id from a model table."""
    db.query(model).filter(model.upload_id == upload_id).delete(synchronize_session=False)


def _bulk_save(db: Session, objects: list) -> None:
    """Bulk insert a list of ORM objects."""
    if objects:
        db.bulk_save_objects(objects)


def _json_dumps(obj) -> str | None:
    """Safe JSON dump, returns None for empty/None values."""
    if not obj:
        return None
    return json.dumps(obj, default=str)


# ── 1. Core Table Population ─────────────────────────────────────────────────

def populate_core_tables(
    db: Session,
    upload_id: int,
    tier_data: dict,
    connection_profiles: list | None = None,
) -> None:
    """Populate foundation tables from parse output. Idempotent (deletes first)."""
    logger.info("populate_core_tables: upload_id=%d sessions=%d tables=%d connections=%d",
                upload_id,
                len(tier_data.get('sessions', [])),
                len(tier_data.get('tables', [])),
                len(tier_data.get('connections', [])))

    # Delete existing rows for this upload
    for model in [ConnectionProfileRecord, ConnectionRecord, TableRecord, SessionRecord]:
        _delete_for_upload(db, model, upload_id)

    # Insert sessions
    session_records = []
    for s in tier_data.get('sessions', []):
        md = s.get('mapping_detail') or {}
        session_records.append(SessionRecord(
            upload_id=upload_id,
            session_id=s.get('id', ''),
            name=s.get('name', ''),
            full_name=s.get('full', s.get('name', '')),
            tier=float(s.get('tier', 1)),
            step=s.get('step'),
            workflow=s.get('workflow'),
            transforms=s.get('transforms', 0),
            ext_reads=s.get('extReads', 0),
            lookup_count=s.get('lookupCount', 0),
            critical=1 if s.get('critical') else 0,
            sources_json=_json_dumps(s.get('sources')),
            targets_json=_json_dumps(s.get('targets')),
            lookups_json=_json_dumps(s.get('lookups')),
            mapping_detail_json=_json_dumps(s.get('mapping_detail')),
            connections_used_json=_json_dumps(s.get('connections_used')),
            folder_path=s.get('folder', ''),
            mapping_name=s.get('mapping', md.get('mapping_name', '')),
            config_reference=s.get('config_reference', ''),
            scheduler_name=(s.get('scheduler') or {}).get('name', ''),
            expression_count=len(md.get('expressions', [])),
            field_mapping_count=len(md.get('connectors', [])),
            # Phase 6 code analysis fields
            total_loc=cp.get('total_loc', 0) if (cp := s.get('code_profile')) else 0,
            total_functions_used=cp.get('total_functions_used', 0) if (cp := s.get('code_profile')) else 0,
            distinct_functions_used=cp.get('distinct_functions_used', 0) if (cp := s.get('code_profile')) else 0,
            has_embedded_sql=cp.get('has_sql', 0) if (cp := s.get('code_profile')) else 0,
            has_embedded_java=cp.get('has_java', 0) if (cp := s.get('code_profile')) else 0,
            has_stored_procedure=cp.get('has_stored_procedure', 0) if (cp := s.get('code_profile')) else 0,
            core_intent=cp.get('core_intent') if (cp := s.get('code_profile')) else None,
            # Phase 7 (V7) expanded columns
            session_attributes_json=_json_dumps(s.get('session_attributes')),
            folder_owner=(s.get('_folder_meta') or {}).get('owner', ''),
            mapping_is_valid=(s.get('_mapping_meta') or {}).get('is_valid', ''),
            workflow_enabled=(s.get('_workflow_meta') or {}).get('is_enabled', ''),
            pipeline_partitions_json=_json_dumps(s.get('pipeline_partitions')),
            connection_references_json=_json_dumps(s.get('connection_references')),
        ))
    _bulk_save(db, session_records)

    # Insert tables
    table_records = []
    for t in tier_data.get('tables', []):
        table_records.append(TableRecord(
            upload_id=upload_id,
            table_id=t.get('id', ''),
            name=t.get('name', ''),
            type=t.get('type', 'unknown'),
            tier=float(t.get('tier', 0.5)),
            conflict_writers=t.get('conflictWriters', 0),
            readers=t.get('readers', 0),
            lookup_users=t.get('lookupUsers', 0),
        ))
    _bulk_save(db, table_records)

    # Insert connections
    conn_records = []
    for c in tier_data.get('connections', []):
        conn_records.append(ConnectionRecord(
            upload_id=upload_id,
            from_id=c.get('from', ''),
            to_id=c.get('to', ''),
            conn_type=c.get('type', 'unknown'),
        ))
    _bulk_save(db, conn_records)

    # Insert connection profiles
    profiles = connection_profiles or tier_data.get('connection_profiles', [])
    if profiles:
        profile_records = []
        for p in profiles:
            profile_records.append(ConnectionProfileRecord(
                upload_id=upload_id,
                name=p.get('name', ''),
                dbtype=p.get('type', p.get('dbtype', '')),
                dbsubtype=p.get('dbsubtype', ''),
                connection_string=p.get('connection_string', p.get('host', '')),
            ))
        _bulk_save(db, profile_records)

    db.flush()
    logger.info("populate_core_tables: done — %d sessions, %d tables, %d connections, %d profiles",
                len(session_records), len(table_records), len(conn_records), len(profiles))


# ── 1b. Normalized Storage Population (Phase 5) ──────────────────────────────

_PARAM_RE = re.compile(r'(\$\$\w+|\$PM\w+)')
_TABLE_RE = re.compile(r'\bFROM\s+([\w\$#\.@]+)', re.I)


def _classify_expression(expr: str) -> tuple[str, int, int]:
    """Classify expression and compute complexity + nesting depth."""
    if not expr or expr.strip() == '':
        return 'passthrough', 0, 0
    e = expr.strip()
    depth = e.count('(')
    funcs = len(re.findall(r'\w+\(', e))
    if e.startswith(':LKP.') or ':LKP.' in e:
        return 'lookup', funcs + 1, depth
    if 'IIF(' in e.upper() or 'DECODE(' in e.upper():
        return 'conditional', funcs + depth, depth
    if any(f in e.upper() for f in ('SUM(', 'AVG(', 'COUNT(', 'MAX(', 'MIN(')):
        return 'aggregated', funcs + depth, depth
    if funcs > 0:
        return 'derived', funcs + depth, depth
    return 'passthrough', 0, 0


def populate_normalized_tables(
    db: Session,
    upload_id: int,
    tier_data: dict,
) -> None:
    """Populate normalized transform/field/expression/workflow/lookup/param/sql tables.

    Extracts data from mapping_detail JSON within each session.
    """
    logger.info("populate_normalized_tables: upload_id=%d", upload_id)

    # Delete existing rows
    for model in [SQLOverrideRecord, ParameterRecord, LookupConfigRecord,
                  WorkflowRecord, ExpressionRecord, FieldMappingRecord, TransformRecord]:
        _delete_for_upload(db, model, upload_id)

    transform_rows = []
    field_rows = []
    expr_rows = []
    lookup_rows = []
    param_map: dict[str, set] = {}  # param_name → set of session_names
    sql_rows = []

    for s in tier_data.get('sessions', []):
        sname = s.get('full', s.get('name', ''))
        md = s.get('mapping_detail')
        if not md or not isinstance(md, dict):
            continue

        mapping_name = md.get('mapping_name', s.get('mapping', ''))

        # Transforms (instances)
        for inst in md.get('instances', []):
            iname = inst.get('name', '')
            itype = inst.get('type', '')
            sql_ov = inst.get('sql_override', '')

            transform_rows.append(TransformRecord(
                upload_id=upload_id,
                session_name=sname,
                mapping_name=mapping_name,
                transform_name=iname,
                transform_type=itype,
                instance_name=inst.get('instance_name', iname),
                port_count=inst.get('port_count', 0),
                properties_json=_json_dumps(inst.get('properties')),
                sql_override=sql_ov if sql_ov else None,
                lookup_table=inst.get('lookup_table', ''),
                lookup_condition=inst.get('lookup_condition', ''),
                filter_condition=inst.get('filter_condition', ''),
                expression_count=len(inst.get('fields', [])),
            ))

            # SQL Overrides
            if sql_ov:
                refs = _TABLE_RE.findall(sql_ov)
                sql_rows.append(SQLOverrideRecord(
                    upload_id=upload_id,
                    session_name=sname,
                    transform_name=iname,
                    override_type='source' if 'source' in itype.lower() else 'lookup' if 'lookup' in itype.lower() else 'other',
                    sql_text=sql_ov,
                    referenced_tables_json=_json_dumps(refs) if refs else None,
                    sql_complexity=sql_ov.count('(') + sql_ov.upper().count('JOIN'),
                ))

            # Lookup configs
            lkp_table = inst.get('lookup_table', '')
            if lkp_table and 'lookup' in itype.lower():
                lookup_rows.append(LookupConfigRecord(
                    upload_id=upload_id,
                    session_name=sname,
                    lookup_name=iname,
                    lookup_table=lkp_table,
                    lookup_condition=inst.get('lookup_condition', ''),
                    sql_override=sql_ov if sql_ov else None,
                    cache_enabled=1,
                    lookup_policy=inst.get('lookup_policy', ''),
                ))

            # Parameters from SQL overrides and expressions
            params_found = _PARAM_RE.findall(sql_ov) if sql_ov else []

        # Connectors → field mappings
        for conn in md.get('connectors', []):
            from_inst = conn.get('from_instance', '')
            to_inst = conn.get('to_instance', '')
            from_type = conn.get('from_instance_type', '')
            to_type = conn.get('to_instance_type', '')
            for fm in conn.get('fields', []):
                field_rows.append(FieldMappingRecord(
                    upload_id=upload_id,
                    session_name=sname,
                    from_instance=from_inst,
                    from_field=fm.get('from_field', ''),
                    from_instance_type=from_type,
                    to_instance=to_inst,
                    to_field=fm.get('to_field', fm.get('from_field', '')),
                    to_instance_type=to_type,
                    from_datatype=fm.get('from_datatype', ''),
                    to_datatype=fm.get('to_datatype', ''),
                ))

        # Expressions
        for exp in md.get('expressions', []):
            expr_text = exp.get('expression', '')
            etype, complexity, depth = _classify_expression(expr_text)
            expr_rows.append(ExpressionRecord(
                upload_id=upload_id,
                session_name=sname,
                transform_name=exp.get('transform', ''),
                field_name=exp.get('field', ''),
                datatype=exp.get('datatype', ''),
                port_type=exp.get('port_type', ''),
                expression_text=expr_text,
                expression_type=etype,
                expression_complexity=complexity,
                nesting_depth=depth,
            ))
            # Collect params from expressions
            if expr_text:
                for p in _PARAM_RE.findall(expr_text):
                    param_map.setdefault(p, set()).add(sname)

        # Collect params from mapping_variables
        for mv in s.get('mapping_variables', []):
            pname = mv.get('name', '')
            if pname:
                param_map.setdefault(pname, set()).add(sname)

    # Bulk save in batches
    _bulk_save(db, transform_rows)
    _bulk_save(db, field_rows)
    _bulk_save(db, expr_rows)
    _bulk_save(db, lookup_rows)
    _bulk_save(db, sql_rows)

    # Parameters
    param_rows = []
    for pname, session_set in param_map.items():
        ptype = 'system' if pname.startswith('$PM') else 'user'
        param_rows.append(ParameterRecord(
            upload_id=upload_id,
            parameter_name=pname,
            parameter_type=ptype,
            used_by_sessions_json=_json_dumps(sorted(session_set)),
        ))
    _bulk_save(db, param_rows)

    # Workflows — from tier_data sessions grouped by workflow name
    wf_map: dict[str, dict] = {}
    for s in tier_data.get('sessions', []):
        wf = s.get('workflow', '')
        if wf:
            if wf not in wf_map:
                wf_map[wf] = {'sessions': 0, 'tasks': 0, 'folder': s.get('folder', '')}
            wf_map[wf]['sessions'] += 1
            wf_map[wf]['tasks'] += 1

    wf_rows = []
    # Collect workflow metadata from sessions
    wf_meta_map: dict[str, dict] = {}
    for s in tier_data.get('sessions', []):
        wf = s.get('workflow', '')
        if wf and wf not in wf_meta_map:
            wm = s.get('_workflow_meta', {})
            if wm:
                wf_meta_map[wf] = wm

    for wf_name, info in wf_map.items():
        wm = wf_meta_map.get(wf_name, {})
        wf_rows.append(WorkflowRecord(
            upload_id=upload_id,
            workflow_name=wf_name,
            folder_name=info.get('folder', ''),
            session_count=info['sessions'],
            task_count=info['tasks'],
            # Phase 7 (V7) expanded columns
            is_enabled=wm.get('is_enabled', ''),
            is_service=wm.get('is_service', ''),
            suspend_on_error=wm.get('suspend_on_error', ''),
            server_name=wm.get('server_name', ''),
            description=wm.get('description', ''),
            schedule_info_json=_json_dumps(wm.get('schedule_info')),
            workflow_variables_json=_json_dumps(wm.get('workflow_variables')),
            task_edges_count=wm.get('task_edges_count', 0),
            conditional_links_count=wm.get('conditional_links_count', 0),
        ))
    _bulk_save(db, wf_rows)

    db.flush()
    logger.info("populate_normalized_tables: done — %d transforms, %d fields, %d expressions, "
                "%d lookups, %d params, %d sql_overrides, %d workflows",
                len(transform_rows), len(field_rows), len(expr_rows),
                len(lookup_rows), len(param_rows), len(sql_rows), len(wf_rows))


# ── 1c. Code Analysis Table Population ────────────────────────────────────────


def populate_code_analysis_tables(
    db: Session,
    upload_id: int,
    tier_data: dict,
) -> None:
    """Populate embedded_code_records, function_usage_records, and session_code_profiles.

    Extracts data from 'embedded_code', 'function_usage', and 'code_profile' keys
    that were added to session dicts by _enrich_session_code_analysis in infa_engine.
    """
    logger.info("populate_code_analysis_tables: upload_id=%d", upload_id)

    # Delete existing rows
    for model in [SessionCodeProfile, FunctionUsageRecord, EmbeddedCodeRecord]:
        _delete_for_upload(db, model, upload_id)

    ec_rows = []
    fu_rows = []
    cp_rows = []

    for s in tier_data.get('sessions', []):
        sname = s.get('full', s.get('name', ''))

        # Embedded code records
        for ec in s.get('embedded_code', []):
            ec_rows.append(EmbeddedCodeRecord(
                upload_id=upload_id,
                session_name=sname,
                transform_name=ec.get('transform_name', ''),
                code_type=ec.get('code_type', 'unknown'),
                code_subtype=ec.get('code_subtype'),
                code_text=ec.get('code_text'),
                line_count=ec.get('line_count', 0),
                char_count=ec.get('char_count', 0),
                language_confidence=ec.get('language_confidence', 1.0),
                contains_dml=ec.get('contains_dml', 0),
                contains_ddl=ec.get('contains_ddl', 0),
                referenced_tables_json=_json_dumps(ec.get('referenced_tables')),
                referenced_functions_json=_json_dumps(ec.get('referenced_functions')),
            ))

        # Function usage records
        for fu in s.get('function_usage', []):
            fu_rows.append(FunctionUsageRecord(
                upload_id=upload_id,
                session_name=sname,
                transform_name=fu.get('transform_name', ''),
                field_name=fu.get('field_name', ''),
                function_name=fu.get('function_name', ''),
                function_category=fu.get('function_category', 'custom_udf'),
                call_count=fu.get('call_count', 1),
                nested_depth=fu.get('nested_depth', 0),
                arguments_json=_json_dumps(fu.get('arguments')),
            ))

        # Session code profile
        cp = s.get('code_profile')
        if cp:
            cp_rows.append(SessionCodeProfile(
                upload_id=upload_id,
                session_name=sname,
                has_sql=cp.get('has_sql', 0),
                has_plsql=cp.get('has_plsql', 0),
                has_java=cp.get('has_java', 0),
                has_python=cp.get('has_python', 0),
                has_r_code=cp.get('has_r_code', 0),
                has_shell=cp.get('has_shell', 0),
                has_javascript=cp.get('has_javascript', 0),
                has_stored_procedure=cp.get('has_stored_procedure', 0),
                has_custom_transform=cp.get('has_custom_transform', 0),
                has_pre_post_sql=cp.get('has_pre_post_sql', 0),
                total_code_blocks=cp.get('total_code_blocks', 0),
                total_loc=cp.get('total_loc', 0),
                total_functions_used=cp.get('total_functions_used', 0),
                distinct_functions_used=cp.get('distinct_functions_used', 0),
                total_expressions=cp.get('total_expressions', 0),
                aggregate_function_count=cp.get('aggregate_function_count', 0),
                string_function_count=cp.get('string_function_count', 0),
                date_function_count=cp.get('date_function_count', 0),
                math_function_count=cp.get('math_function_count', 0),
                conversion_function_count=cp.get('conversion_function_count', 0),
                conditional_function_count=cp.get('conditional_function_count', 0),
                lookup_function_count=cp.get('lookup_function_count', 0),
                custom_udf_count=cp.get('custom_udf_count', 0),
                analytic_function_count=cp.get('analytic_function_count', 0),
                financial_function_count=cp.get('financial_function_count', 0),
                binary_function_count=cp.get('binary_function_count', 0),
                encoding_function_count=cp.get('encoding_function_count', 0),
                encryption_function_count=cp.get('encryption_function_count', 0),
                core_intent=cp.get('core_intent'),
                intent_confidence=cp.get('intent_confidence', 0.0),
                intent_details_json=_json_dumps(cp.get('intent_details')),
            ))

    _bulk_save(db, ec_rows)
    _bulk_save(db, fu_rows)
    _bulk_save(db, cp_rows)

    db.flush()
    logger.info("populate_code_analysis_tables: done — %d embedded_code, %d function_usage, %d code_profiles",
                len(ec_rows), len(fu_rows), len(cp_rows))


# ── 1d. Deep Parse Expansion Population (V7) ──────────────────────────────────


def populate_deep_parse_tables(
    db: Session,
    upload_id: int,
    tier_data: dict,
) -> None:
    """Populate all 8 new V7 deep-parse tables from tier_data.

    Extracts metadata from the _ prefixed keys on session dicts that were
    added by the expanded infa_engine parser. Idempotent (deletes first).
    """
    logger.info("populate_deep_parse_tables: upload_id=%d", upload_id)

    # Delete existing rows for all new tables
    for model in [ConfigRecord, WorkflowTaskEdgeRecord, TargetDefinitionRecord,
                  SourceDefinitionRecord, MetadataExtensionRecord, ShortcutRecord,
                  MappingRecord, FolderRecord, RepositoryMetadataRecord]:
        _delete_for_upload(db, model, upload_id)

    sessions = tier_data.get('sessions', [])
    if not sessions:
        return

    # ── Repository metadata (from first session's _repo_meta) ────────────
    repo_meta = None
    for s in sessions:
        rm = s.get('_repo_meta')
        if rm and rm.get('repository_name'):
            repo_meta = rm
            break
    if repo_meta:
        _bulk_save(db, [RepositoryMetadataRecord(
            upload_id=upload_id,
            creation_date=repo_meta.get('creation_date', ''),
            repository_version=repo_meta.get('repository_version', ''),
            repository_name=repo_meta.get('repository_name', ''),
            version=repo_meta.get('version', ''),
            codepage=repo_meta.get('codepage', ''),
            database_type=repo_meta.get('database_type', ''),
        )])

    # ── Folders (deduplicated from session _folder_meta) ─────────────────
    seen_folders: dict[str, dict] = {}
    folder_session_counts: dict[str, int] = defaultdict(int)
    folder_workflow_names: dict[str, set] = defaultdict(set)
    for s in sessions:
        fm = s.get('_folder_meta')
        if fm and fm.get('name'):
            fname = fm['name']
            if fname not in seen_folders:
                seen_folders[fname] = fm
            folder_session_counts[fname] += 1
            wf = s.get('workflow', '')
            if wf:
                folder_workflow_names[fname].add(wf)

    folder_rows = []
    for fname, fm in seen_folders.items():
        shortcuts = []
        for s in sessions:
            if (s.get('_folder_meta') or {}).get('name') == fname:
                shortcuts = s.get('_shortcuts', [])
                break
        folder_rows.append(FolderRecord(
            upload_id=upload_id,
            name=fname,
            description=fm.get('description', ''),
            owner=fm.get('owner', ''),
            shared=fm.get('shared', ''),
            permissions=fm.get('permissions', ''),
            session_count=folder_session_counts.get(fname, 0),
            workflow_count=len(folder_workflow_names.get(fname, set())),
            shortcut_count=len(shortcuts),
        ))
    _bulk_save(db, folder_rows)

    # ── Shortcuts (deduplicated across sessions) ─────────────────────────
    seen_shortcuts: set = set()
    shortcut_rows = []
    for s in sessions:
        for sc in s.get('_shortcuts', []):
            key = (sc.get('name', ''), sc.get('source_folder', ''))
            if key not in seen_shortcuts:
                seen_shortcuts.add(key)
                shortcut_rows.append(ShortcutRecord(
                    upload_id=upload_id,
                    name=sc.get('name', ''),
                    ref_object_name=sc.get('ref_object_name', ''),
                    object_type=sc.get('object_type', ''),
                    source_folder=sc.get('source_folder', ''),
                    repository_name=sc.get('repository_name', ''),
                    reference_type=sc.get('reference_type', ''),
                ))
    _bulk_save(db, shortcut_rows)

    # ── Metadata extensions (from folder metadata) ───────────────────────
    ext_rows = []
    seen_ext: set = set()
    for fname, fm in seen_folders.items():
        for ext in fm.get('metadata_extensions', []):
            key = ('FOLDER', fname, ext.get('name', ''))
            if key not in seen_ext:
                seen_ext.add(key)
                ext_rows.append(MetadataExtensionRecord(
                    upload_id=upload_id,
                    parent_type='FOLDER',
                    parent_name=fname,
                    extension_name=ext.get('name', ''),
                    extension_value=ext.get('value', ''),
                    datatype=ext.get('datatype', ''),
                    domain_name=ext.get('domain_name', ''),
                ))
    # Mapping-level metadata extensions
    for s in sessions:
        mm = s.get('_mapping_meta', {})
        mapping_name = s.get('mapping', '')
        for ext in mm.get('metadata_extensions', []):
            key = ('MAPPING', mapping_name, ext.get('name', ''))
            if key not in seen_ext:
                seen_ext.add(key)
                ext_rows.append(MetadataExtensionRecord(
                    upload_id=upload_id,
                    parent_type='MAPPING',
                    parent_name=mapping_name,
                    extension_name=ext.get('name', ''),
                    extension_value=ext.get('value', ''),
                    datatype=ext.get('datatype', ''),
                    domain_name=ext.get('domain_name', ''),
                ))
    _bulk_save(db, ext_rows)

    # ── Mappings (deduplicated, with usage counts) ───────────────────────
    mapping_sessions: dict[str, list] = defaultdict(list)
    mapping_meta: dict[str, dict] = {}
    for s in sessions:
        mname = s.get('mapping', '')
        if mname:
            mapping_sessions[mname].append(s.get('full', s.get('name', '')))
            if mname not in mapping_meta:
                mm = s.get('_mapping_meta', {})
                md = s.get('mapping_detail', {})
                mapping_meta[mname] = {
                    'folder': s.get('folder', ''),
                    'is_valid': mm.get('is_valid', ''),
                    'is_profile_mapping': mm.get('is_profile_mapping', ''),
                    'description': mm.get('description', ''),
                    'source_count': len(s.get('sources', [])),
                    'target_count': len(s.get('targets', [])),
                    'transform_count': len(md.get('instances', [])) if isinstance(md, dict) else 0,
                    'connector_count': len(md.get('connectors', [])) if isinstance(md, dict) else 0,
                    'target_load_order': mm.get('target_load_order', []),
                    'map_dependencies': mm.get('map_dependencies', []),
                    'metadata_extensions': mm.get('metadata_extensions', []),
                }

    mapping_rows = []
    for mname, meta in mapping_meta.items():
        mapping_rows.append(MappingRecord(
            upload_id=upload_id,
            mapping_name=mname,
            folder_name=meta.get('folder', ''),
            is_valid=meta.get('is_valid', ''),
            is_profile_mapping=meta.get('is_profile_mapping', ''),
            description=meta.get('description', ''),
            source_count=meta.get('source_count', 0),
            target_count=meta.get('target_count', 0),
            transform_count=meta.get('transform_count', 0),
            connector_count=meta.get('connector_count', 0),
            used_by_sessions_json=_json_dumps(mapping_sessions.get(mname, [])),
            target_load_order_json=_json_dumps(meta.get('target_load_order')),
            map_dependencies_json=_json_dumps(meta.get('map_dependencies')),
            metadata_extensions_json=_json_dumps(meta.get('metadata_extensions')),
        ))
    _bulk_save(db, mapping_rows)

    # ── Source definitions (deduplicated) ─────────────────────────────────
    seen_src: set = set()
    src_rows = []
    for s in sessions:
        for sd in s.get('_source_definitions', []):
            sname = sd.get('source_name', '')
            if sname and sname not in seen_src:
                seen_src.add(sname)
                src_rows.append(SourceDefinitionRecord(
                    upload_id=upload_id,
                    source_name=sname,
                    database_name=sd.get('database_name', ''),
                    database_type=sd.get('database_type', ''),
                    folder_name=sd.get('folder_name', ''),
                    flatfile_info_json=_json_dumps(sd.get('flatfile_info')),
                ))
    _bulk_save(db, src_rows)

    # ── Target definitions (deduplicated) ─────────────────────────────────
    seen_tgt: set = set()
    tgt_rows = []
    for s in sessions:
        for td in s.get('_target_definitions', []):
            tname = td.get('target_name', '')
            if tname and tname not in seen_tgt:
                seen_tgt.add(tname)
                tgt_rows.append(TargetDefinitionRecord(
                    upload_id=upload_id,
                    target_name=tname,
                    database_name=td.get('database_name', ''),
                    database_type=td.get('database_type', ''),
                    folder_name=td.get('folder_name', ''),
                    indexes_json=_json_dumps(td.get('indexes')),
                ))
    _bulk_save(db, tgt_rows)

    # ── Workflow task edges (from _workflow_meta) ─────────────────────────
    seen_wf_edges: set = set()
    edge_rows = []
    for s in sessions:
        wm = s.get('_workflow_meta')
        wf_name = s.get('workflow', '')
        if wm and wf_name:
            for edge in wm.get('task_edges', []):
                key = (wf_name, edge.get('from_task', ''), edge.get('to_task', ''))
                if key not in seen_wf_edges:
                    seen_wf_edges.add(key)
                    edge_rows.append(WorkflowTaskEdgeRecord(
                        upload_id=upload_id,
                        workflow_name=wf_name,
                        from_task=edge.get('from_task', ''),
                        to_task=edge.get('to_task', ''),
                        condition=edge.get('condition', ''),
                    ))
    _bulk_save(db, edge_rows)

    # ── Config records (from _config_map) ─────────────────────────────────
    seen_configs: set = set()
    config_rows = []
    config_usage: dict[str, list] = defaultdict(list)
    for s in sessions:
        cfg_ref = s.get('config_reference', '')
        if cfg_ref:
            config_usage[cfg_ref].append(s.get('full', s.get('name', '')))
        for cfg_name, cfg in (s.get('_config_map') or {}).items():
            if cfg_name not in seen_configs:
                seen_configs.add(cfg_name)
                config_rows.append(ConfigRecord(
                    upload_id=upload_id,
                    config_name=cfg_name,
                    is_default=cfg.get('is_default', ''),
                    description=cfg.get('description', ''),
                    attributes_json=_json_dumps(cfg.get('attributes')),
                ))
    # Update used_by_sessions after building usage map
    for cr in config_rows:
        cr.used_by_sessions_json = _json_dumps(config_usage.get(cr.config_name, []))
    _bulk_save(db, config_rows)

    db.flush()
    logger.info("populate_deep_parse_tables: done — %d folders, %d shortcuts, %d metadata_ext, "
                "%d mappings, %d source_defs, %d target_defs, %d task_edges, %d configs",
                len(folder_rows), len(shortcut_rows), len(ext_rows),
                len(mapping_rows), len(src_rows), len(tgt_rows),
                len(edge_rows), len(config_rows))


# ── 2. Per-View Table Population ─────────────────────────────────────────────

def populate_view_tables(db: Session, upload_id: int) -> None:
    """Derive and populate all 10 core-view materialized tables from foundation tables.

    Call AFTER populate_core_tables(). Loads all foundation records into memory,
    builds lookup maps and connection indexes, then delegates to per-view
    populate functions. Each function is idempotent (deletes before inserting).
    """
    logger.info("populate_view_tables: upload_id=%d", upload_id)

    # Load foundation data into memory for derivation
    sessions = db.query(SessionRecord).filter(SessionRecord.upload_id == upload_id).all()
    tables = db.query(TableRecord).filter(TableRecord.upload_id == upload_id).all()
    connections = db.query(ConnectionRecord).filter(ConnectionRecord.upload_id == upload_id).all()

    # Build lookup maps
    session_map = {s.session_id: s for s in sessions}
    table_map = {t.table_id: t for t in tables}
    table_name_map = {t.name: t for t in tables}

    # Build connection indexes
    conn_by_from = defaultdict(list)
    conn_by_to = defaultdict(list)
    for c in connections:
        conn_by_from[c.from_id].append(c)
        conn_by_to[c.to_id].append(c)

    _populate_tier_layout(db, upload_id, sessions, tables)
    _populate_galaxy_nodes(db, upload_id, sessions, tables, connections)
    _populate_explorer_detail(db, upload_id, sessions, connections, session_map, table_map, conn_by_from, conn_by_to)
    _populate_write_conflicts(db, upload_id, tables, connections, session_map)
    _populate_read_chains(db, upload_id, tables, connections, session_map)
    _populate_exec_order(db, upload_id, sessions, connections, conn_by_from)
    _populate_matrix_cells(db, upload_id, sessions, tables, connections, session_map, table_map)
    _populate_table_profiles(db, upload_id, tables, connections, session_map)
    _populate_duplicate_groups(db, upload_id, sessions)

    db.flush()
    logger.info("populate_view_tables: done")


def _populate_tier_layout(db: Session, upload_id: int, sessions: list, tables: list) -> None:
    """Populate vw_tier_layout — node positions for the tier diagram."""
    _delete_for_upload(db, VwTierLayout, upload_id)
    rows = []
    for s in sessions:
        rows.append(VwTierLayout(
            upload_id=upload_id,
            session_id=s.session_id,
            name=s.name,
            full_name=s.full_name,
            tier=s.tier,
            step=s.step,
            is_critical=s.critical,
            x_band=s.tier,
            node_type='session',
        ))
    for t in tables:
        rows.append(VwTierLayout(
            upload_id=upload_id,
            table_id=t.table_id,
            name=t.name,
            tier=t.tier,
            is_critical=1 if t.conflict_writers > 1 else 0,
            x_band=t.tier,
            node_type='table',
        ))
    _bulk_save(db, rows)


def _populate_galaxy_nodes(db: Session, upload_id: int, sessions: list, tables: list, connections: list) -> None:
    """Populate vw_galaxy_nodes — 2D layout for galaxy map."""
    _delete_for_upload(db, VwGalaxyNodes, upload_id)

    # Build connection count per node for sizing
    conn_count = defaultdict(int)
    for c in connections:
        conn_count[c.from_id] += 1
        conn_count[c.to_id] += 1

    rows = []
    for i, s in enumerate(sessions):
        # Simple radial layout: spread sessions by tier
        import math
        angle = (2 * math.pi * i) / max(len(sessions), 1)
        radius = s.tier * 100
        rows.append(VwGalaxyNodes(
            upload_id=upload_id,
            node_id=s.session_id,
            node_type='session',
            name=s.name,
            tier=s.tier,
            x=radius * math.cos(angle),
            y=radius * math.sin(angle),
            size=max(1.0, min(10.0, conn_count.get(s.session_id, 1))),
            is_critical=s.critical,
        ))
    for i, t in enumerate(tables):
        angle = (2 * math.pi * i) / max(len(tables), 1)
        radius = t.tier * 100
        rows.append(VwGalaxyNodes(
            upload_id=upload_id,
            node_id=t.table_id,
            node_type='table',
            name=t.name,
            tier=t.tier,
            x=radius * math.cos(angle),
            y=radius * math.sin(angle),
            size=max(1.0, min(10.0, conn_count.get(t.table_id, 1))),
            is_critical=1 if t.conflict_writers > 1 else 0,
        ))
    _bulk_save(db, rows)


def _populate_explorer_detail(
    db: Session, upload_id: int, sessions: list, connections: list,
    session_map: dict, table_map: dict, conn_by_from: dict, conn_by_to: dict,
) -> None:
    """Populate vw_explorer_detail — session details with connection aggregates."""
    _delete_for_upload(db, VwExplorerDetail, upload_id)
    rows = []
    for s in sessions:
        # Count connections by type for this session
        outgoing = conn_by_from.get(s.session_id, [])
        incoming = conn_by_to.get(s.session_id, [])
        all_conns = outgoing + incoming

        conflict_count = sum(1 for c in all_conns if c.conn_type in ('write_conflict', 'read_after_write'))
        chain_count = sum(1 for c in all_conns if c.conn_type == 'chain')
        total_conns = len(all_conns)

        rows.append(VwExplorerDetail(
            upload_id=upload_id,
            session_id=s.session_id,
            name=s.name,
            full_name=s.full_name,
            tier=s.tier,
            step=s.step,
            workflow=s.workflow,
            transforms=s.transforms,
            ext_reads=s.ext_reads,
            lookup_count=s.lookup_count,
            is_critical=s.critical,
            write_targets_json=s.targets_json,
            read_sources_json=s.sources_json,
            lookup_tables_json=s.lookups_json,
            conflict_count=conflict_count,
            chain_count=chain_count,
            total_connections=total_conns,
        ))
    _bulk_save(db, rows)


def _populate_write_conflicts(
    db: Session, upload_id: int, tables: list, connections: list, session_map: dict,
) -> None:
    """Populate vw_write_conflicts — tables with multiple writers."""
    _delete_for_upload(db, VwWriteConflicts, upload_id)

    # Find tables that are targets of write_conflict or write_clean connections
    # Group writers by table
    table_writers = defaultdict(list)
    for c in connections:
        if c.conn_type in ('write_conflict', 'write_clean'):
            # from_id is the session, to_id is the table
            table_writers[c.to_id].append(c.from_id)

    rows = []
    for t in tables:
        writers = table_writers.get(t.table_id, [])
        if len(writers) >= 2:
            writer_info = []
            for sid in writers:
                s = session_map.get(sid)
                if s:
                    writer_info.append({'id': sid, 'name': s.name, 'tier': s.tier})
            rows.append(VwWriteConflicts(
                upload_id=upload_id,
                table_name=t.name,
                table_id=t.table_id,
                writer_count=len(writers),
                writer_sessions_json=_json_dumps(writer_info),
            ))
    _bulk_save(db, rows)


def _populate_read_chains(
    db: Session, upload_id: int, tables: list, connections: list, session_map: dict,
) -> None:
    """Populate vw_read_chains — tables that are both written and read."""
    _delete_for_upload(db, VwReadChains, upload_id)

    table_writers = defaultdict(list)
    table_readers = defaultdict(list)
    for c in connections:
        if c.conn_type in ('write_conflict', 'write_clean'):
            # Session writes to table: from=S*, to=T*
            table_writers[c.to_id].append(c.from_id)
        elif c.conn_type == 'read_after_write':
            # Table read by session: from=T*, to=S*
            table_readers[c.from_id].append(c.to_id)
        elif c.conn_type == 'chain':
            # Bidirectional: from=S*→to=T* or from=T*→to=S*
            if c.from_id.startswith('T'):
                table_readers[c.from_id].append(c.to_id)
            elif c.to_id.startswith('T'):
                table_readers[c.to_id].append(c.from_id)
        elif c.conn_type == 'source_read':
            # Table read by session: from=T*, to=S*
            table_readers[c.from_id].append(c.to_id)

    rows = []
    for t in tables:
        writers = table_writers.get(t.table_id, [])
        readers = table_readers.get(t.table_id, [])
        if writers and readers:
            w_info = [{'id': sid, 'name': session_map[sid].name, 'tier': session_map[sid].tier}
                      for sid in writers if sid in session_map]
            r_info = [{'id': sid, 'name': session_map[sid].name, 'tier': session_map[sid].tier}
                      for sid in readers if sid in session_map]
            rows.append(VwReadChains(
                upload_id=upload_id,
                table_name=t.name,
                table_id=t.table_id,
                writer_sessions_json=_json_dumps(w_info),
                reader_sessions_json=_json_dumps(r_info),
                chain_length=len(writers) + len(readers),
            ))
    _bulk_save(db, rows)


def _populate_exec_order(
    db: Session, upload_id: int, sessions: list, connections: list, conn_by_from: dict,
) -> None:
    """Populate vw_exec_order — ordered execution list with badges."""
    _delete_for_upload(db, VwExecOrder, upload_id)

    # Build sets of sessions involved in conflicts/chains
    conflict_sessions = set()
    chain_sessions = set()
    for c in connections:
        if c.conn_type in ('write_conflict', 'read_after_write'):
            conflict_sessions.add(c.from_id)
            conflict_sessions.add(c.to_id)
        if c.conn_type == 'chain':
            chain_sessions.add(c.from_id)
            chain_sessions.add(c.to_id)

    # Sort by step, then tier
    sorted_sessions = sorted(sessions, key=lambda s: (s.step or 0, s.tier))

    rows = []
    for pos, s in enumerate(sorted_sessions):
        rows.append(VwExecOrder(
            upload_id=upload_id,
            position=pos,
            session_id=s.session_id,
            name=s.name,
            full_name=s.full_name,
            tier=s.tier,
            step=s.step,
            has_conflict=1 if s.session_id in conflict_sessions else 0,
            has_chain=1 if s.session_id in chain_sessions else 0,
            write_targets_json=s.targets_json,
        ))
    _bulk_save(db, rows)


def _populate_matrix_cells(
    db: Session, upload_id: int, sessions: list, tables: list,
    connections: list, session_map: dict, table_map: dict,
) -> None:
    """Populate vw_matrix_cells — sparse session-table connection matrix."""
    _delete_for_upload(db, VwMatrixCells, upload_id)
    rows = []
    for c in connections:
        # Determine which is session and which is table
        s_id = c.from_id if c.from_id in session_map else c.to_id
        t_id = c.to_id if c.to_id in table_map else c.from_id

        s = session_map.get(s_id)
        t = table_map.get(t_id)
        if s and t:
            rows.append(VwMatrixCells(
                upload_id=upload_id,
                session_id=s_id,
                table_id=t_id,
                session_name=s.name,
                table_name=t.name,
                conn_type=c.conn_type,
            ))
    _bulk_save(db, rows)


def _populate_table_profiles(
    db: Session, upload_id: int, tables: list, connections: list, session_map: dict,
) -> None:
    """Populate vw_table_profiles — table-centric aggregation."""
    _delete_for_upload(db, VwTableProfiles, upload_id)

    # Aggregate connections by table
    table_writers = defaultdict(list)
    table_readers = defaultdict(list)
    table_lookups = defaultdict(list)
    for c in connections:
        if c.conn_type in ('write_conflict', 'write_clean'):
            table_writers[c.to_id].append(c.from_id)
        elif c.conn_type in ('chain', 'read_after_write', 'source_read'):
            table_readers[c.to_id].append(c.from_id)
        elif c.conn_type == 'lookup_stale':
            table_lookups[c.to_id].append(c.from_id)

    rows = []
    for t in tables:
        w = table_writers.get(t.table_id, [])
        r = table_readers.get(t.table_id, [])
        lu = table_lookups.get(t.table_id, [])

        w_info = [{'id': sid, 'name': session_map[sid].name}
                  for sid in w if sid in session_map]
        r_info = [{'id': sid, 'name': session_map[sid].name}
                  for sid in r if sid in session_map]
        lu_info = [{'id': sid, 'name': session_map[sid].name}
                   for sid in lu if sid in session_map]

        rows.append(VwTableProfiles(
            upload_id=upload_id,
            table_id=t.table_id,
            table_name=t.name,
            type=t.type,
            tier=t.tier,
            writer_count=len(w),
            reader_count=len(r),
            lookup_count=len(lu),
            total_refs=len(w) + len(r) + len(lu),
            writers_json=_json_dumps(w_info),
            readers_json=_json_dumps(r_info),
            lookup_users_json=_json_dumps(lu_info),
        ))
    _bulk_save(db, rows)


def _populate_duplicate_groups(db: Session, upload_id: int, sessions: list) -> None:
    """Populate vw_duplicate_groups + vw_duplicate_members — fingerprint-based dedup."""
    _delete_for_upload(db, VwDuplicateMembers, upload_id)
    _delete_for_upload(db, VwDuplicateGroups, upload_id)

    # Fingerprint: sorted(sources)|sorted(targets)|sorted(lookups)
    fp_groups = defaultdict(list)
    for s in sessions:
        sources = sorted(json.loads(s.sources_json)) if s.sources_json else []
        targets = sorted(json.loads(s.targets_json)) if s.targets_json else []
        lookups = sorted(json.loads(s.lookups_json)) if s.lookups_json else []
        fp = '|'.join([','.join(sources), ','.join(targets), ','.join(lookups)])
        fp_hash = hashlib.md5(fp.encode()).hexdigest()[:16]
        fp_groups[fp_hash].append((s, fp))

    group_rows = []
    member_rows = []
    gid = 0
    for fp_hash, members in fp_groups.items():
        if len(members) < 2:
            continue
        gid += 1
        group_id = f"DG_{gid}"
        group_rows.append(VwDuplicateGroups(
            upload_id=upload_id,
            group_id=group_id,
            match_type='exact',
            fingerprint=fp_hash,
            similarity=1.0,
            member_count=len(members),
        ))
        for s, fp in members:
            member_rows.append(VwDuplicateMembers(
                upload_id=upload_id,
                group_id=group_id,
                session_id=s.session_id,
                name=s.name,
                full_name=s.full_name,
                sources_json=s.sources_json,
                targets_json=s.targets_json,
                lookups_json=s.lookups_json,
            ))

    _bulk_save(db, group_rows)
    _bulk_save(db, member_rows)


# ── 3. Constellation Table Population ────────────────────────────────────────

def populate_constellation_tables(
    db: Session,
    upload_id: int,
    constellation_data: dict,
) -> None:
    """Populate constellation view tables from clustering output."""
    if not constellation_data:
        return

    logger.info("populate_constellation_tables: upload_id=%d chunks=%d points=%d",
                upload_id,
                len(constellation_data.get('chunks', [])),
                len(constellation_data.get('points', [])))

    for model in [VwConstellationEdges, VwConstellationPoints, VwConstellationChunks]:
        _delete_for_upload(db, model, upload_id)

    algorithm = constellation_data.get('algorithm', '')

    # Insert chunks
    chunk_rows = []
    for ch in constellation_data.get('chunks', []):
        chunk_rows.append(VwConstellationChunks(
            upload_id=upload_id,
            chunk_id=str(ch.get('id', ch.get('chunk_id', ''))),
            label=ch.get('label', ch.get('name', '')),
            algorithm=algorithm,
            session_count=ch.get('session_count', ch.get('size', 0)),
            table_count=ch.get('table_count', 0),
            tier_min=ch.get('tier_min'),
            tier_max=ch.get('tier_max'),
            pivot_tables_json=_json_dumps(ch.get('pivot_tables')),
            session_ids_json=_json_dumps(ch.get('session_ids', ch.get('sessions', []))),
            table_names_json=_json_dumps(ch.get('tables')),
            conflict_count=ch.get('conflict_count', 0),
            chain_count=ch.get('chain_count', 0),
            critical_count=ch.get('critical_count', 0),
            color=ch.get('color'),
        ))
    _bulk_save(db, chunk_rows)

    # Insert points
    point_rows = []
    for pt in constellation_data.get('points', []):
        point_rows.append(VwConstellationPoints(
            upload_id=upload_id,
            session_id=str(pt.get('id', pt.get('session_id', ''))),
            chunk_id=str(pt.get('chunk', pt.get('chunk_id', ''))),
            x=pt.get('x'),
            y=pt.get('y'),
            tier=pt.get('tier'),
            is_critical=1 if pt.get('critical') else 0,
            name=pt.get('name'),
        ))
    _bulk_save(db, point_rows)

    # Insert cross-chunk edges
    edge_rows = []
    for e in constellation_data.get('cross_chunk_edges', []):
        edge_rows.append(VwConstellationEdges(
            upload_id=upload_id,
            from_chunk=str(e.get('from', e.get('source', ''))),
            to_chunk=str(e.get('to', e.get('target', ''))),
            count=e.get('count', e.get('weight', 1)),
        ))
    _bulk_save(db, edge_rows)

    db.flush()
    logger.info("populate_constellation_tables: done — %d chunks, %d points, %d edges",
                len(chunk_rows), len(point_rows), len(edge_rows))


# ── 4. Vector Table Population ───────────────────────────────────────────────

def populate_vector_tables(
    db: Session,
    upload_id: int,
    vector_results: dict,
) -> None:
    """Populate all vector view tables from analysis output.

    Dispatches to per-vector populate functions based on which keys are
    present in vector_results. Each function handles multiple output formats
    (dict keys vary between vector engine versions) via .get() fallbacks.
    """
    if not vector_results:
        return

    logger.info("populate_vector_tables: upload_id=%d keys=%s",
                upload_id, list(vector_results.keys()))

    # V11 — Complexity scores
    if 'v11_complexity' in vector_results:
        _populate_complexity(db, upload_id, vector_results['v11_complexity'])

    # V4 — Wave plan
    if 'v4_wave_plan' in vector_results:
        _populate_waves(db, upload_id, vector_results['v4_wave_plan'])

    # V3 — UMAP coordinates
    if 'v3_dimensionality_reduction' in vector_results:
        _populate_umap(db, upload_id, vector_results['v3_dimensionality_reduction'])

    # V1 — Community detection
    if 'v1_communities' in vector_results:
        _populate_communities(db, upload_id, vector_results['v1_communities'])

    # V9 — Wave function (cascade simulation)
    if 'v9_wave_function' in vector_results:
        _populate_wave_function(db, upload_id, vector_results['v9_wave_function'])

    # V10 — Concentration analysis
    if 'v10_concentration' in vector_results:
        _populate_concentration(db, upload_id, vector_results['v10_concentration'])

    # V8 — Ensemble consensus
    if 'v8_ensemble_consensus' in vector_results:
        _populate_ensemble(db, upload_id, vector_results['v8_ensemble_consensus'])

    # V2 — Hierarchical lineage
    if 'v2_hierarchical_lineage' in vector_results:
        _populate_hierarchical(db, upload_id, vector_results['v2_hierarchical_lineage'])

    # V5 — Affinity propagation
    if 'v5_affinity_propagation' in vector_results:
        _populate_affinity(db, upload_id, vector_results['v5_affinity_propagation'])

    # V6 — Spectral clustering
    if 'v6_spectral_clustering' in vector_results:
        _populate_spectral(db, upload_id, vector_results['v6_spectral_clustering'])

    # V7 — HDBSCAN density
    if 'v7_hdbscan_density' in vector_results:
        _populate_hdbscan(db, upload_id, vector_results['v7_hdbscan_density'])

    # V12 — Expression complexity
    if 'v12_expression_complexity' in vector_results:
        _populate_expression_complexity(db, upload_id, vector_results['v12_expression_complexity'])

    # V13 — Data flow volume
    if 'v13_data_flow' in vector_results:
        _populate_data_flow(db, upload_id, vector_results['v13_data_flow'])

    # V14 — Schema drift
    if 'v14_schema_drift' in vector_results:
        _populate_schema_drift(db, upload_id, vector_results['v14_schema_drift'])

    # V15 — Transform centrality
    if 'v15_transform_centrality' in vector_results:
        _populate_transform_centrality(db, upload_id, vector_results['v15_transform_centrality'])

    # V16 — Table gravity
    if 'v16_table_gravity' in vector_results:
        _populate_table_gravity(db, upload_id, vector_results['v16_table_gravity'])

    db.flush()
    logger.info("populate_vector_tables: done")


def _populate_complexity(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_complexity_scores from V11 output (16 dimensions)."""
    _delete_for_upload(db, VwComplexityScores, upload_id)
    rows = []
    for item in data.get('scores', data.get('sessions', [])):
        dims_raw = item.get('dimensions_raw', item.get('raw', {}))
        dims_norm = item.get('dimensions_normalized', item.get('normalized', {}))
        est = item.get('effort_estimate', item.get('estimate', {}))
        # Build dimension values — support both new (dimensions list) and legacy (dict) formats
        dim_raw_vals = {}
        dim_norm_vals = {}
        dimensions_list = item.get('dimensions', [])
        if dimensions_list:
            # New format: list of {name, raw_value, normalized, ...}
            for idx, dim in enumerate(dimensions_list, 1):
                dim_raw_vals[f'd{idx}'] = dim.get('raw_value', 0)
                dim_norm_vals[f'd{idx}'] = dim.get('normalized', 0)
        else:
            # Legacy dict format
            for i in range(1, 17):
                dim_raw_vals[f'd{i}'] = dims_raw.get(f'd{i}', 0)
                dim_norm_vals[f'd{i}'] = dims_norm.get(f'd{i}', 0)
        kwargs = {
            'upload_id': upload_id,
            'session_id': str(item.get('session_id', item.get('id', ''))),
            'name': item.get('name', ''),
            'tier': item.get('tier'),
            'overall_score': item.get('overall_score', item.get('score', 0)),
            'bucket': item.get('bucket', item.get('complexity_bucket', '')),
            'hours_low': item.get('hours_estimate_low', est.get('hours_low', est.get('low', 0))),
            'hours_high': item.get('hours_estimate_high', est.get('hours_high', est.get('high', 0))),
            'top_drivers_json': _json_dumps(item.get('top_drivers')),
        }
        for i in range(1, 17):
            kwargs[f'd{i}_raw'] = dim_raw_vals.get(f'd{i}', 0)
            kwargs[f'd{i}_norm'] = dim_norm_vals.get(f'd{i}', 0)
        rows.append(VwComplexityScores(**kwargs))
    _bulk_save(db, rows)


def _populate_waves(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_wave_assignments from V4 output."""
    _delete_for_upload(db, VwWaveAssignments, upload_id)
    rows = []
    for wave in data.get('waves', []):
        wave_num = wave.get('wave', wave.get('wave_number', 0))
        # V4 output may have either 'sessions' (list of dicts) or 'session_ids' (list of strings)
        sessions_list = wave.get('sessions', [])
        if sessions_list:
            for s in sessions_list:
                rows.append(VwWaveAssignments(
                    upload_id=upload_id,
                    session_id=str(s.get('id', s.get('session_id', ''))),
                    name=s.get('name', ''),
                    wave_number=wave_num,
                    scc_group_id=s.get('scc_group_id'),
                    is_cycle=1 if s.get('is_cycle') else 0,
                ))
        else:
            # Flat list of session IDs — check top-level scc_groups for cycle detection
            top_scc = data.get('scc_groups', [])
            wave_scc_ids = set(wave.get('scc_groups', []))  # may be ints (group IDs)
            cyclic_ids = set()
            for g in top_scc:
                if isinstance(g, dict) and g.get('group_id') in wave_scc_ids:
                    if g.get('is_cycle') or len(g.get('session_ids', [])) > 1:
                        cyclic_ids.update(g.get('session_ids', []))
            for sid in wave.get('session_ids', []):
                rows.append(VwWaveAssignments(
                    upload_id=upload_id,
                    session_id=str(sid),
                    name='',
                    wave_number=wave_num,
                    scc_group_id=None,
                    is_cycle=1 if sid in cyclic_ids else 0,
                ))
    _bulk_save(db, rows)


def _populate_umap(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_umap_coords from V3 output.

    V3 output format: {projections: {scale_name: {coords: [{session_id, x, y, cluster}]}}, method: str}
    """
    _delete_for_upload(db, VwUmapCoords, upload_id)
    rows = []

    # Handle V3 projections format: projections -> {scale: {coords: [...]}}
    projections = data.get('projections', {})
    if projections:
        for scale_name, proj in projections.items():
            for item in proj.get('coords', []):
                rows.append(VwUmapCoords(
                    upload_id=upload_id,
                    session_id=str(item.get('session_id', item.get('id', ''))),
                    scale=scale_name,
                    x=item.get('x', 0),
                    y=item.get('y', 0),
                    cluster_id=item.get('cluster_id', item.get('cluster')),
                ))
    else:
        # Fallback: flat list of points
        for item in data.get('points', data.get('embeddings', [])):
            rows.append(VwUmapCoords(
                upload_id=upload_id,
                session_id=str(item.get('session_id', item.get('id', ''))),
                scale=item.get('scale', 'balanced'),
                x=item.get('x', 0),
                y=item.get('y', 0),
                cluster_id=item.get('cluster_id', item.get('cluster')),
            ))
    _bulk_save(db, rows)


def _populate_communities(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_communities from V1 output."""
    _delete_for_upload(db, VwCommunities, upload_id)
    rows = []
    for item in data.get('assignments', data.get('communities', [])):
        rows.append(VwCommunities(
            upload_id=upload_id,
            session_id=str(item.get('session_id', item.get('id', ''))),
            macro_id=item.get('macro_id', item.get('macro')),
            meso_id=item.get('meso_id', item.get('meso')),
            micro_id=item.get('micro_id', item.get('micro')),
        ))
    _bulk_save(db, rows)


def _populate_wave_function(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_wave_function from V9 output."""
    _delete_for_upload(db, VwWaveFunction, upload_id)
    rows = []
    for item in data.get('sessions', data.get('scores', [])):
        rows.append(VwWaveFunction(
            upload_id=upload_id,
            session_id=str(item.get('session_id', item.get('id', ''))),
            name=item.get('name', ''),
            blast_radius=item.get('blast_radius', 0),
            chain_depth=item.get('chain_depth', 0),
            criticality_score=item.get('criticality_score', item.get('criticality', 0)),
            amplification_factor=item.get('amplification_factor', item.get('amplification', 0)),
            criticality_tier=item.get('criticality_tier', ''),
        ))
    _bulk_save(db, rows)


def _populate_concentration(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_concentration_groups + vw_concentration_members from V10 output.

    V10 output format: {gravity_groups: [{group_id, medoid_session_id, session_ids, core_tables, cohesion, coupling}],
                        independent_sessions: [{session_id, independence_type, confidence}]}
    """
    _delete_for_upload(db, VwConcentrationMembers, upload_id)
    _delete_for_upload(db, VwConcentrationGroups, upload_id)

    group_rows = []
    member_rows = []

    # V10 uses 'gravity_groups' as the key
    groups = data.get('gravity_groups', data.get('groups', data.get('clusters', [])))
    for grp in groups:
        gid = str(grp.get('group_id', grp.get('id', '')))
        medoid_sid = str(grp.get('medoid_session_id', grp.get('medoid', '')))
        group_rows.append(VwConcentrationGroups(
            upload_id=upload_id,
            group_id=gid,
            medoid_session_id=medoid_sid,
            core_tables_json=_json_dumps(grp.get('core_tables')),
            cohesion=grp.get('cohesion', 0),
            coupling=grp.get('coupling', 0),
            session_count=grp.get('session_count', len(grp.get('session_ids', grp.get('members', [])))),
        ))
        # V10 uses 'session_ids' (flat list) not 'members' (list of dicts)
        session_ids = grp.get('session_ids', [])
        members = grp.get('members', [])
        if session_ids and not members:
            # Build member rows from flat session_ids list
            for sid in session_ids:
                member_rows.append(VwConcentrationMembers(
                    upload_id=upload_id,
                    session_id=str(sid),
                    group_id=gid,
                    is_medoid=1 if str(sid) == medoid_sid else 0,
                    independence_type='',
                    confidence=0,
                ))
        else:
            for m in members:
                member_rows.append(VwConcentrationMembers(
                    upload_id=upload_id,
                    session_id=str(m.get('session_id', m.get('id', ''))),
                    group_id=gid,
                    is_medoid=1 if m.get('is_medoid') else 0,
                    independence_type=m.get('independence_type', ''),
                    confidence=m.get('confidence', 0),
                ))

    # Also populate independent sessions as a special group
    for indep in data.get('independent_sessions', []):
        member_rows.append(VwConcentrationMembers(
            upload_id=upload_id,
            session_id=str(indep.get('session_id', '')),
            group_id='independent',
            is_medoid=0,
            independence_type=indep.get('independence_type', ''),
            confidence=indep.get('confidence', 0),
        ))

    _bulk_save(db, group_rows)
    _bulk_save(db, member_rows)


def _populate_ensemble(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_ensemble from V8 output."""
    _delete_for_upload(db, VwEnsemble, upload_id)
    rows = []
    for item in data.get('assignments', data.get('sessions', [])):
        rows.append(VwEnsemble(
            upload_id=upload_id,
            session_id=str(item.get('session_id', item.get('id', ''))),
            consensus_cluster=item.get('consensus_cluster', item.get('cluster')),
            consensus_score=item.get('consensus_score', item.get('score', 0)),
            per_vector_json=_json_dumps(item.get('per_vector', item.get('vectors'))),
            is_contested=1 if item.get('is_contested') else 0,
        ))
    _bulk_save(db, rows)


def _populate_hierarchical(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_hierarchical_lineage from V2 output."""
    _delete_for_upload(db, VwHierarchicalLineage, upload_id)
    rows = []
    for item in data.get('assignments', data.get('clusters', data.get('sessions', []))):
        rows.append(VwHierarchicalLineage(
            upload_id=upload_id,
            session_id=str(item.get('session_id', item.get('id', ''))),
            cluster_id=item.get('cluster_id', item.get('cluster')),
            level=item.get('level', 0),
            parent_cluster=item.get('parent_cluster'),
            merge_distance=item.get('merge_distance', 0),
            session_count=item.get('session_count', 1),
        ))
    _bulk_save(db, rows)


def _populate_affinity(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_affinity_propagation from V5 output."""
    _delete_for_upload(db, VwAffinityPropagation, upload_id)
    rows = []
    for item in data.get('assignments', data.get('clusters', data.get('sessions', []))):
        rows.append(VwAffinityPropagation(
            upload_id=upload_id,
            session_id=str(item.get('session_id', item.get('id', ''))),
            exemplar_id=str(item.get('exemplar_id', item.get('exemplar', ''))),
            cluster_id=item.get('cluster_id', item.get('cluster')),
            responsibility=item.get('responsibility', 0),
            availability=item.get('availability', 0),
            preference=item.get('preference', 0),
        ))
    _bulk_save(db, rows)


def _populate_spectral(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_spectral_clustering from V6 output."""
    _delete_for_upload(db, VwSpectralClustering, upload_id)
    rows = []
    for item in data.get('assignments', data.get('clusters', data.get('sessions', []))):
        rows.append(VwSpectralClustering(
            upload_id=upload_id,
            session_id=str(item.get('session_id', item.get('id', ''))),
            cluster_id=item.get('cluster_id', item.get('cluster')),
            eigenvalue=item.get('eigenvalue', 0),
            eigen_gap=item.get('eigen_gap', 0),
        ))
    _bulk_save(db, rows)


def _populate_hdbscan(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_hdbscan_density from V7 output."""
    _delete_for_upload(db, VwHdbscanDensity, upload_id)
    rows = []
    for item in data.get('assignments', data.get('clusters', data.get('sessions', []))):
        rows.append(VwHdbscanDensity(
            upload_id=upload_id,
            session_id=str(item.get('session_id', item.get('id', ''))),
            cluster_id=item.get('cluster_id', item.get('cluster')),
            probability=item.get('probability', 0),
            outlier_score=item.get('outlier_score', 0),
            persistence=item.get('persistence', 0),
        ))
    _bulk_save(db, rows)


def _populate_expression_complexity(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_expression_complexity from V12 output."""
    _delete_for_upload(db, VwExpressionComplexity, upload_id)
    rows = []
    for item in data.get('assignments', data.get('sessions', [])):
        rows.append(VwExpressionComplexity(
            upload_id=upload_id,
            session_id=str(item.get('session_id', '')),
            cluster_id=item.get('cluster_id', 0),
            expression_count=item.get('expression_count', 0),
            avg_depth=item.get('avg_depth', 0),
            total_functions=item.get('total_functions', 0),
            expression_density=item.get('expression_density', 0),
            score=item.get('score', 0),
            bucket=item.get('bucket', ''),
        ))
    _bulk_save(db, rows)


def _populate_data_flow(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_data_flow from V13 output."""
    _delete_for_upload(db, VwDataFlow, upload_id)
    rows = []
    for item in data.get('assignments', data.get('sessions', [])):
        rows.append(VwDataFlow(
            upload_id=upload_id,
            session_id=str(item.get('session_id', '')),
            cluster_id=item.get('cluster_id', 0),
            source_volume=item.get('source_volume', 0),
            output_volume=item.get('output_volume', 0),
            funnel_ratio=item.get('funnel_ratio', 0),
            bottleneck_transform=item.get('bottleneck_transform', ''),
        ))
    _bulk_save(db, rows)


def _populate_schema_drift(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_schema_drift from V14 output."""
    _delete_for_upload(db, VwSchemaDrift, upload_id)
    rows = []
    for item in data.get('assignments', data.get('sessions', [])):
        rows.append(VwSchemaDrift(
            upload_id=upload_id,
            session_id=str(item.get('session_id', '')),
            cluster_id=item.get('cluster_id', 0),
            field_count=item.get('field_count', 0),
            drift_score=item.get('drift_score', 0),
            added_fields=item.get('added_fields', 0),
            removed_fields=item.get('removed_fields', 0),
            type_changes=item.get('type_changes', 0),
        ))
    _bulk_save(db, rows)


def _populate_transform_centrality(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_transform_centrality from V15 output."""
    _delete_for_upload(db, VwTransformCentrality, upload_id)
    rows = []
    for item in data.get('assignments', data.get('sessions', [])):
        rows.append(VwTransformCentrality(
            upload_id=upload_id,
            session_id=str(item.get('session_id', '')),
            cluster_id=item.get('cluster_id', 0),
            transform_count=item.get('transform_count', 0),
            max_centrality=item.get('max_centrality', 0),
            chokepoint_transform=item.get('chokepoint_transform', ''),
            avg_degree=item.get('avg_degree', 0),
        ))
    _bulk_save(db, rows)


def _populate_table_gravity(db: Session, upload_id: int, data: dict) -> None:
    """Populate vw_table_gravity from V16 output."""
    _delete_for_upload(db, VwTableGravity, upload_id)
    rows = []
    for item in data.get('assignments', data.get('tables', [])):
        rows.append(VwTableGravity(
            upload_id=upload_id,
            session_id=str(item.get('session_id', item.get('table_name', ''))),
            cluster_id=item.get('cluster_id', 0),
            table_name=item.get('table_name', ''),
            reader_count=item.get('reader_count', 0),
            writer_count=item.get('writer_count', 0),
            lookup_count=item.get('lookup_count', 0),
            gravity_score=item.get('gravity_score', 0),
            is_hub=1 if item.get('is_hub') else 0,
        ))
    _bulk_save(db, rows)


# ── 5. Reconstruct tier_data from normalized tables ──────────────────────────

# TTL cache for reconstruct_tier_data: {upload_id: (data, expire_time)}
_tier_cache: dict[int, tuple[dict, float]] = {}
_tier_cache_lock = threading.Lock()
_TIER_CACHE_TTL = 3600  # 1 hour


def invalidate_tier_cache(upload_id: int) -> None:
    """Invalidate cached tier_data for an upload (call after re-parse or delete)."""
    with _tier_cache_lock:
        _tier_cache.pop(upload_id, None)


def reconstruct_tier_data(db: Session, upload_id: int) -> dict | None:
    """Reconstruct full tier_data dict from normalized DB tables.

    Results are cached for 1 hour per upload_id. Call invalidate_tier_cache()
    after re-parse or delete. Returns None if no sessions exist.
    """
    # Check TTL cache first
    with _tier_cache_lock:
        cached = _tier_cache.get(upload_id)
        if cached and cached[1] > time.monotonic():
            return cached[0]

    sessions = db.query(SessionRecord).filter(SessionRecord.upload_id == upload_id).all()
    if not sessions:
        return None

    tables = db.query(TableRecord).filter(TableRecord.upload_id == upload_id).all()
    connections = db.query(ConnectionRecord).filter(ConnectionRecord.upload_id == upload_id).all()

    session_list = []
    for s in sessions:
        session_list.append({
            'id': s.session_id,
            'name': s.name,
            'full': s.full_name,
            'tier': s.tier,
            'step': s.step,
            'workflow': s.workflow,
            'transforms': s.transforms,
            'extReads': s.ext_reads,
            'lookupCount': s.lookup_count,
            'critical': bool(s.critical),
            'sources': json.loads(s.sources_json) if s.sources_json else [],
            'targets': json.loads(s.targets_json) if s.targets_json else [],
            'lookups': json.loads(s.lookups_json) if s.lookups_json else [],
            'mapping_detail': json.loads(s.mapping_detail_json) if s.mapping_detail_json else None,
        })

    table_list = []
    for t in tables:
        table_list.append({
            'id': t.table_id,
            'name': t.name,
            'type': t.type,
            'tier': t.tier,
            'conflictWriters': t.conflict_writers,
            'readers': t.readers,
            'lookupUsers': t.lookup_users,
        })

    conn_list = []
    for c in connections:
        conn_list.append({
            'from': c.from_id,
            'to': c.to_id,
            'type': c.conn_type,
        })

    result = {
        'sessions': session_list,
        'tables': table_list,
        'connections': conn_list,
        'stats': {
            'session_count': len(session_list),
            'write_conflicts': sum(1 for t in table_list if t.get('conflictWriters', 0) > 1),
            'dep_chains': sum(1 for c in conn_list if c['type'] == 'chain'),
            'staleness_risks': sum(1 for c in conn_list if c['type'] == 'lookup_stale'),
            'source_tables': sum(1 for t in table_list if t.get('type') == 'source'),
            'max_tier': max((s.get('tier', 0) for s in session_list), default=0),
        },
    }

    # Store in TTL cache
    with _tier_cache_lock:
        _tier_cache[upload_id] = (result, time.monotonic() + _TIER_CACHE_TTL)

    return result


# ── 6. Reconstruct constellation from materialized tables ─────────────────

def reconstruct_constellation(db: Session, upload_id: int) -> dict | None:
    """Rebuild constellation dict from vw_constellation_* tables.

    Returns the same shape as the /api/views/constellation endpoint:
    {chunks: [...], points: [...], edges: [...]}.
    Returns None if no points exist for the upload_id.
    """
    points = db.query(VwConstellationPoints).filter(
        VwConstellationPoints.upload_id == upload_id
    ).all()
    if not points:
        logger.info("No constellation points found for upload %d", upload_id)
        return None

    chunks = db.query(VwConstellationChunks).filter(
        VwConstellationChunks.upload_id == upload_id
    ).all()
    edges = db.query(VwConstellationEdges).filter(
        VwConstellationEdges.upload_id == upload_id
    ).all()
    logger.info("Reconstructing constellation for upload %d: %d chunks, %d points, %d edges",
                upload_id, len(chunks), len(points), len(edges))

    def _jl(val):
        if not val or val == 'null':
            return []
        try:
            parsed = json.loads(val) if isinstance(val, str) else val
            return parsed if parsed is not None else []
        except (json.JSONDecodeError, TypeError):
            return []

    chunk_list = [
        {
            'id': c.chunk_id,
            'label': c.label,
            'algorithm': c.algorithm,
            'session_count': c.session_count,
            'table_count': c.table_count,
            'tier_range': [c.tier_min or 0, c.tier_max or 0],
            'pivot_tables': _jl(c.pivot_tables_json),
            'session_ids': _jl(c.session_ids_json),
            'table_names': _jl(c.table_names_json),
            'conflict_count': c.conflict_count,
            'chain_count': c.chain_count,
            'critical_count': c.critical_count,
            'color': c.color or '#6366f1',
        }
        for c in chunks
    ]
    point_list = [
        {
            'session_id': p.session_id,
            'chunk_id': p.chunk_id,
            'x': p.x,
            'y': p.y,
            'tier': p.tier,
            'critical': bool(p.is_critical),
            'name': p.name,
        }
        for p in points
    ]
    edge_list = [
        {'from_chunk': e.from_chunk, 'to_chunk': e.to_chunk, 'count': e.count}
        for e in edges
    ]

    return {
        'chunks': chunk_list,
        'points': point_list,
        'cross_chunk_edges': edge_list,
        'stats': {
            'total_sessions': len(point_list),
            'total_chunks': len(chunk_list),
            'largest_chunk': max((c['session_count'] for c in chunk_list), default=0),
            'smallest_chunk': min((c['session_count'] for c in chunk_list), default=0),
            'orphan_sessions': 0,
            'cross_chunk_edge_count': len(edge_list),
        },
    }


# ── 7. Reconstruct vector_results from materialized tables ────────────────

def reconstruct_vector_results(db: Session, upload_id: int) -> dict | None:
    """Rebuild vector_results dict from vw_* vector tables.

    Returns a dict keyed by vector engine name (v11_complexity, v4_wave_plan,
    v1_communities, v3_dimensionality_reduction, v9_wave_function,
    v10_concentration, v8_ensemble_consensus).
    Returns None if no vector data exists for the upload_id.
    """
    results = {}
    logger.info("Reconstructing vector results for upload %d", upload_id)

    def _jl(val):
        if not val or val == 'null':
            return []
        try:
            parsed = json.loads(val) if isinstance(val, str) else val
            return parsed if parsed is not None else []
        except (json.JSONDecodeError, TypeError):
            return []

    # V11 — Complexity (16 dimensions)
    complexity_rows = db.query(VwComplexityScores).filter(
        VwComplexityScores.upload_id == upload_id
    ).all()
    if complexity_rows:
        results['v11_complexity'] = {
            'scores': [
                {
                    'session_id': r.session_id,
                    'name': r.name,
                    'tier': r.tier,
                    'overall_score': r.overall_score,
                    'bucket': r.bucket,
                    'dimensions_raw': {f'd{i}': getattr(r, f'd{i}_raw', 0) or 0 for i in range(1, 17)},
                    'dimensions_normalized': {f'd{i}': getattr(r, f'd{i}_norm', 0) or 0 for i in range(1, 17)},
                    'hours_low': r.hours_low,
                    'hours_high': r.hours_high,
                    'top_drivers': _jl(r.top_drivers_json),
                }
                for r in complexity_rows
            ],
        }

    # V4 — Waves
    wave_rows = db.query(VwWaveAssignments).filter(
        VwWaveAssignments.upload_id == upload_id
    ).all()
    if wave_rows:
        waves: dict[int, dict] = {}
        for r in wave_rows:
            w = r.wave_number
            if w not in waves:
                waves[w] = {'session_ids': [], 'scc_groups': set()}
            waves[w]['session_ids'].append(r.session_id)
            if r.scc_group_id is not None:
                waves[w]['scc_groups'].add(r.scc_group_id)
        results['v4_wave_plan'] = {
            'waves': [
                {
                    'wave_number': w,
                    'session_ids': data['session_ids'],
                    'scc_groups': sorted(data['scc_groups']),
                    'prerequisite_waves': [w - 1] if w > 1 else [],
                    'session_count': len(data['session_ids']),
                    'estimated_hours_low': 0,
                    'estimated_hours_high': 0,
                }
                for w, data in sorted(waves.items())
            ],
        }

    # V3 — UMAP / Dimensionality Reduction
    umap_rows = db.query(VwUmapCoords).filter(
        VwUmapCoords.upload_id == upload_id
    ).all()
    if umap_rows:
        projections = {}
        for r in umap_rows:
            scale = r.scale or 'balanced'
            if scale not in projections:
                projections[scale] = {'coords': []}
            projections[scale]['coords'].append({
                'session_id': r.session_id,
                'x': r.x,
                'y': r.y,
                'cluster_id': r.cluster_id,
            })
        results['v3_dimensionality_reduction'] = {'projections': projections}

    # V1 — Communities
    comm_rows = db.query(VwCommunities).filter(
        VwCommunities.upload_id == upload_id
    ).all()
    if comm_rows:
        results['v1_communities'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'macro_id': r.macro_id,
                    'meso_id': r.meso_id,
                    'micro_id': r.micro_id,
                }
                for r in comm_rows
            ],
        }

    # V9 — Wave Function (failure propagation)
    wf_rows = db.query(VwWaveFunction).filter(
        VwWaveFunction.upload_id == upload_id
    ).all()
    if wf_rows:
        results['v9_wave_function'] = {
            'sessions': [
                {
                    'session_id': r.session_id,
                    'name': r.name,
                    'blast_radius': r.blast_radius,
                    'chain_depth': r.chain_depth,
                    'criticality_score': r.criticality_score,
                    'amplification_factor': r.amplification_factor,
                    'criticality_tier': r.criticality_tier,
                }
                for r in wf_rows
            ],
        }

    # V10 — Concentration
    conc_groups = db.query(VwConcentrationGroups).filter(
        VwConcentrationGroups.upload_id == upload_id
    ).all()
    conc_members = db.query(VwConcentrationMembers).filter(
        VwConcentrationMembers.upload_id == upload_id
    ).all()
    if conc_groups:
        members_by_group = {}
        indep_sessions = []
        for m in conc_members:
            if m.group_id == 'independent':
                indep_sessions.append({
                    'session_id': m.session_id,
                    'independence_type': m.independence_type,
                    'confidence': m.confidence,
                })
            else:
                members_by_group.setdefault(m.group_id, []).append(m.session_id)

        results['v10_concentration'] = {
            'gravity_groups': [
                {
                    'group_id': g.group_id,
                    'medoid_session_id': g.medoid_session_id,
                    'core_tables': _jl(g.core_tables_json),
                    'cohesion': g.cohesion,
                    'coupling': g.coupling,
                    'session_count': g.session_count,
                    'session_ids': members_by_group.get(g.group_id, []),
                }
                for g in conc_groups
            ],
            'independent_sessions': indep_sessions,
        }

    # V8 — Ensemble Consensus
    ens_rows = db.query(VwEnsemble).filter(
        VwEnsemble.upload_id == upload_id
    ).all()
    if ens_rows:
        results['v8_ensemble_consensus'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'consensus_cluster': r.consensus_cluster,
                    'consensus_score': r.consensus_score,
                    'per_vector': _jl(r.per_vector_json),
                    'is_contested': bool(r.is_contested),
                }
                for r in ens_rows
            ],
        }

    # V2 — Hierarchical Lineage
    hier_rows = db.query(VwHierarchicalLineage).filter(
        VwHierarchicalLineage.upload_id == upload_id
    ).all()
    if hier_rows:
        results['v2_hierarchical_lineage'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'cluster_id': r.cluster_id,
                    'level': r.level,
                    'parent_cluster': r.parent_cluster,
                    'merge_distance': r.merge_distance,
                    'session_count': r.session_count,
                }
                for r in hier_rows
            ],
        }

    # V5 — Affinity Propagation
    ap_rows = db.query(VwAffinityPropagation).filter(
        VwAffinityPropagation.upload_id == upload_id
    ).all()
    if ap_rows:
        results['v5_affinity_propagation'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'exemplar_id': r.exemplar_id,
                    'cluster_id': r.cluster_id,
                    'responsibility': r.responsibility,
                    'availability': r.availability,
                    'preference': r.preference,
                }
                for r in ap_rows
            ],
        }

    # V6 — Spectral Clustering
    spec_rows = db.query(VwSpectralClustering).filter(
        VwSpectralClustering.upload_id == upload_id
    ).all()
    if spec_rows:
        results['v6_spectral_clustering'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'cluster_id': r.cluster_id,
                    'eigenvalue': r.eigenvalue,
                    'eigen_gap': r.eigen_gap,
                }
                for r in spec_rows
            ],
        }

    # V7 — HDBSCAN Density
    hdb_rows = db.query(VwHdbscanDensity).filter(
        VwHdbscanDensity.upload_id == upload_id
    ).all()
    if hdb_rows:
        results['v7_hdbscan_density'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'cluster_id': r.cluster_id,
                    'probability': r.probability,
                    'outlier_score': r.outlier_score,
                    'persistence': r.persistence,
                }
                for r in hdb_rows
            ],
        }

    # V12 — Expression Complexity
    ec_rows = db.query(VwExpressionComplexity).filter(
        VwExpressionComplexity.upload_id == upload_id
    ).all()
    if ec_rows:
        results['v12_expression_complexity'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'cluster_id': r.cluster_id,
                    'expression_count': r.expression_count,
                    'avg_depth': r.avg_depth,
                    'total_functions': r.total_functions,
                    'expression_density': r.expression_density,
                    'score': r.score,
                    'bucket': r.bucket,
                }
                for r in ec_rows
            ],
        }

    # V13 — Data Flow
    df_rows = db.query(VwDataFlow).filter(
        VwDataFlow.upload_id == upload_id
    ).all()
    if df_rows:
        results['v13_data_flow'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'cluster_id': r.cluster_id,
                    'source_volume': r.source_volume,
                    'output_volume': r.output_volume,
                    'funnel_ratio': r.funnel_ratio,
                    'bottleneck_transform': r.bottleneck_transform,
                }
                for r in df_rows
            ],
        }

    # V14 — Schema Drift
    sd_rows = db.query(VwSchemaDrift).filter(
        VwSchemaDrift.upload_id == upload_id
    ).all()
    if sd_rows:
        results['v14_schema_drift'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'cluster_id': r.cluster_id,
                    'field_count': r.field_count,
                    'drift_score': r.drift_score,
                    'added_fields': r.added_fields,
                    'removed_fields': r.removed_fields,
                    'type_changes': r.type_changes,
                }
                for r in sd_rows
            ],
        }

    # V15 — Transform Centrality
    tc_rows = db.query(VwTransformCentrality).filter(
        VwTransformCentrality.upload_id == upload_id
    ).all()
    if tc_rows:
        results['v15_transform_centrality'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'cluster_id': r.cluster_id,
                    'transform_count': r.transform_count,
                    'max_centrality': r.max_centrality,
                    'chokepoint_transform': r.chokepoint_transform,
                    'avg_degree': r.avg_degree,
                }
                for r in tc_rows
            ],
        }

    # V16 — Table Gravity
    tg_rows = db.query(VwTableGravity).filter(
        VwTableGravity.upload_id == upload_id
    ).all()
    if tg_rows:
        results['v16_table_gravity'] = {
            'assignments': [
                {
                    'session_id': r.session_id,
                    'cluster_id': r.cluster_id,
                    'table_name': r.table_name,
                    'reader_count': r.reader_count,
                    'writer_count': r.writer_count,
                    'lookup_count': r.lookup_count,
                    'gravity_score': r.gravity_score,
                    'is_hub': bool(r.is_hub),
                }
                for r in tg_rows
            ],
            'hub_tables': [r.table_name for r in tg_rows if r.is_hub],
        }

    if results:
        logger.info("Reconstructed vectors for upload %d: %s", upload_id, list(results.keys()))
    else:
        logger.warning("No vector data found for upload %d", upload_id)
    return results if results else None
