"""Tier Map router — Informatica + NiFi XML tier diagram + constellation map analysis.

Supports uploading individual .xml files OR .zip archives containing XML files.
Auto-detects platform (Informatica vs NiFi) from XML content.

Upload pipeline (for all analyze endpoints):
  1. _extract_xml_from_uploads  — read files/ZIPs, dedup via SHA-256, re-encode if needed
  2. _detect_platform / _split_by_platform — classify each XML as Informatica or NiFi
  3. _analyze_mixed              — run the correct engine(s) in a thread, merge results
  4. Persist Upload row to SQLite for later retrieval without re-parsing
"""

import asyncio
import hashlib
import io
import json
import logging
import os
import tempfile
import time
import zipfile
from typing import List, Literal

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.models.database import Upload, get_db

logger = logging.getLogger(__name__)

# Limits for zip bomb protection
_MAX_UNCOMPRESSED_TOTAL = 10 * 1024 * 1024 * 1024  # 10GB total uncompressed
_SPOOL_THRESHOLD = 50 * 1024 * 1024                 # 50MB before spilling to disk
_ZIP_STREAM_CHUNK = 4 * 1024 * 1024                  # 4MB streaming chunk

# Concurrency control: limit simultaneous parses to prevent server overload
_PARSE_SEMAPHORE = asyncio.Semaphore(settings.parse_concurrency)
_PARSE_TIMEOUT_CAP = 28800  # hard limit 8 hours

router = APIRouter()


def _classify_file(content: bytes) -> Literal['informatica', 'nifi']:
    """Classify a single XML file as Informatica or NiFi by sniffing header content.

    Args:
        content: Raw XML bytes of the file.

    Returns:
        'informatica' if any Informatica-specific XML tags are found in the
        first 5 KB; 'nifi' otherwise (NiFi is the default assumption).
    """
    # Only inspect the first 5KB — enough to find XML root/header elements
    # without reading multi-MB files fully into a string
    head = content[:5000].decode('utf-8', errors='replace').lower()
    if 'informatica' in head or '<folder ' in head or '<mapping ' in head:
        return 'informatica'
    if '<session ' in head and '<workflow ' in head:
        return 'informatica'
    return 'nifi'


def _detect_platform(raw_list: list[bytes]) -> Literal['informatica', 'nifi']:
    """Sniff the first few XML files to determine dominant platform.

    Args:
        raw_list: All extracted XML file byte-strings from the upload.

    Returns:
        'informatica' if any of the first 5 files matches Informatica signatures;
        'nifi' otherwise. Checking only 5 files keeps this O(1) for large uploads.
    """
    for content in raw_list[:5]:
        if _classify_file(content) == 'informatica':
            return 'informatica'
    return 'nifi'


def _split_by_platform(
    raw: list[bytes], names: list[str],
) -> tuple[list[bytes], list[str], list[bytes], list[str]]:
    """Split files into (infa_raw, infa_names, nifi_raw, nifi_names).

    Enables mixed-platform uploads where a single ZIP contains both
    Informatica and NiFi XML files — each platform's files are routed
    to the correct engine for independent parsing.

    Args:
        raw: Raw XML byte-strings for each file.
        names: Corresponding filenames.

    Returns:
        Four-tuple of (infa_raw, infa_names, nifi_raw, nifi_names).
    """
    infa_raw, infa_names = [], []
    nifi_raw, nifi_names = [], []
    for content, name in zip(raw, names):
        if _classify_file(content) == 'informatica':
            infa_raw.append(content)
            infa_names.append(name)
        else:
            nifi_raw.append(content)
            nifi_names.append(name)
    return infa_raw, infa_names, nifi_raw, nifi_names


def _get_analyzer(platform: str):
    """Return the correct analyze function for the detected platform.

    Imports are deferred so the engine modules (and their dependencies)
    are only loaded when actually needed.
    """
    if platform == 'informatica':
        from app.engines.infa_engine import analyze
        return analyze
    else:
        from app.engines.nifi_tier_engine import analyze
        return analyze


def _extract_id_num(id_str: str, prefix: str) -> int:
    """Extract numeric suffix from an ID like 'S12' or 'T_5', safely handling bad formats.

    Args:
        id_str: The full ID string (e.g., 'S42', 'T_7').
        prefix: Expected prefix to strip (e.g., 'S', 'T_').

    Returns:
        Integer suffix, or 0 if the ID is malformed (prevents merge crashes).
    """
    if id_str.startswith(prefix):
        suffix = id_str[len(prefix):]
    else:
        suffix = id_str
    try:
        return int(suffix)
    except ValueError:
        return 0


def _merge_tier_results(a: dict, b: dict) -> dict:
    """Merge two tier_data results (from different platforms) into one.

    Re-numbers session IDs and table IDs in `b` to avoid collisions with `a`.
    Strategy: find the max numeric suffix used in `a`, then shift all IDs in `b`
    upward by that amount so neither set overlaps.
    """
    if not a.get('sessions'):
        return b
    if not b.get('sessions'):
        return a

    # ── Compute ID offsets so b's IDs don't collide with a's ──
    a_max_s = max((_extract_id_num(s['id'], 'S') for s in a['sessions']), default=0)
    a_max_t = max((_extract_id_num(t['id'], 'T_') for t in a['tables']), default=0)

    # ── Remap session IDs in b: S5 → S{5 + a_max_s} ──
    s_remap: dict[str, str] = {}
    for s in b['sessions']:
        old_id = s['id']
        num = _extract_id_num(old_id, 'S')
        new_id = f'S{num + a_max_s}'
        s_remap[old_id] = new_id
        s['id'] = new_id

    # ── Remap table IDs in b: T_3 → T_{3 + a_max_t} ──
    t_remap: dict[str, str] = {}
    for t in b['tables']:
        old_id = t['id']
        num = _extract_id_num(old_id, 'T_')
        new_id = f'T_{num + a_max_t}'
        t_remap[old_id] = new_id
        t['id'] = new_id

    # ── Apply remapped IDs to connection from/to endpoints in b ──
    remap_all = {**s_remap, **t_remap}
    for conn in b.get('connections', []):
        conn['from'] = remap_all.get(conn['from'], conn['from'])
        conn['to'] = remap_all.get(conn['to'], conn['to'])

    # ── Concatenate the two result sets ──
    sessions = a['sessions'] + b['sessions']
    tables = a['tables'] + b['tables']
    connections = a.get('connections', []) + b.get('connections', [])

    a_stats = a.get('stats', {})
    b_stats = b.get('stats', {})

    return {
        'sessions': sessions,
        'tables': tables,
        'connections': connections,
        'stats': {
            'session_count': len(sessions),
            # Additive stats: sum both platforms' counts
            'write_conflicts': a_stats.get('write_conflicts', 0) + b_stats.get('write_conflicts', 0),
            'dep_chains': a_stats.get('dep_chains', 0) + b_stats.get('dep_chains', 0),
            'staleness_risks': a_stats.get('staleness_risks', 0) + b_stats.get('staleness_risks', 0),
            'source_tables': a_stats.get('source_tables', 0) + b_stats.get('source_tables', 0),
            # max_tier: take the deeper of the two tier graphs
            'max_tier': max(a_stats.get('max_tier', 0), b_stats.get('max_tier', 0)),
        },
        'warnings': (a.get('warnings') or []) + (b.get('warnings') or []),
    }


async def _analyze_mixed(
    raw: list[bytes],
    names: list[str],
    progress_fn=None,
) -> dict:
    """Classify files per-platform, run both engines if needed, merge results.

    Each engine runs in a thread pool via asyncio.to_thread so the event loop
    is not blocked by CPU-intensive XML parsing.  Results from both engines are
    then merged with _merge_tier_results to produce a single unified graph.
    """
    infa_raw, infa_names, nifi_raw, nifi_names = _split_by_platform(raw, names)

    results = []

    # Run Informatica engine if any Infa files were detected
    if infa_raw:
        from app.engines.infa_engine import analyze as infa_analyze
        r = await asyncio.to_thread(infa_analyze, infa_raw, infa_names, progress_fn)
        results.append(r)

    # Run NiFi engine if any NiFi files were detected
    if nifi_raw:
        from app.engines.nifi_tier_engine import analyze as nifi_analyze
        r = await asyncio.to_thread(nifi_analyze, nifi_raw, nifi_names, progress_fn)
        results.append(r)

    if not results:
        return {'sessions': [], 'tables': [], 'connections': [],
                'stats': {'session_count': 0, 'write_conflicts': 0, 'dep_chains': 0,
                          'staleness_risks': 0, 'source_tables': 0, 'max_tier': 0},
                'warnings': ['No XML files found.']}

    # Fold all platform results together with ID-collision-safe merge
    merged = results[0]
    for r in results[1:]:
        merged = _merge_tier_results(merged, r)
    return merged


def _process_file_bytes(
    content: bytes,
    filename: str,
    seen_hashes: set[str],
) -> tuple[list[bytes], list[str]]:
    """Process a single file's bytes: handle ZIP extraction, SHA-256 dedup, encoding normalization.

    Returns (raw_bytes_list, filename_list) — may return multiple entries if
    the file is a ZIP containing multiple XML files.

    This is a sync function (no await); ZIP extraction may be slow for large files.
    """
    raw: list[bytes] = []
    names: list[str] = []

    if not content:
        return raw, names

    fname = filename.lower()

    # Detect ZIP by extension OR by PK magic bytes (handles mis-named archives)
    if fname.endswith('.zip') or (content[:4] == b'PK\x03\x04'):
        # Validate before opening
        if not zipfile.is_zipfile(io.BytesIO(content)):
            logger.warning("File %s has ZIP signature but is not a valid ZIP", fname)
            raw.append(content)
            names.append(filename)
            return raw, names

        try:
            total_uncompressed = 0
            dupes = 0
            spool = tempfile.SpooledTemporaryFile(max_size=_SPOOL_THRESHOLD)
            spool.write(content)
            spool.seek(0)
            with zipfile.ZipFile(spool) as zf:
                for info in zf.infolist():
                    if info.is_dir() or not info.filename.lower().endswith('.xml'):
                        continue
                    # Zip bomb protection
                    total_uncompressed += info.file_size
                    if total_uncompressed > _MAX_UNCOMPRESSED_TOTAL:
                        logger.warning(
                            "ZIP extraction halted: total uncompressed size exceeds %dMB limit",
                            _MAX_UNCOMPRESSED_TOTAL // (1024 * 1024),
                        )
                        break
                    xml_bytes = zf.read(info)
                    if not xml_bytes:
                        continue
                    content_hash = hashlib.sha256(xml_bytes).hexdigest()
                    if content_hash in seen_hashes:
                        dupes += 1
                        logger.debug("Skipping duplicate ZIP entry %s", info.filename)
                        continue
                    seen_hashes.add(content_hash)
                    raw.append(xml_bytes)
                    names.append(info.filename.split('/')[-1])
            spool.close()
            if dupes:
                logger.info("ZIP %s: skipped %d duplicate entries", fname, dupes)
        except zipfile.BadZipFile:
            logger.warning("BadZipFile for %s — treating as raw XML", fname)
            raw.append(content)
            names.append(filename)
    else:
        # ── Encoding normalisation for raw XML files ──
        try:
            content.decode('utf-8')
        except UnicodeDecodeError:
            try:
                import chardet
                result = chardet.detect(content[:8192])
                detected_enc = result.get('encoding')
                confidence = result.get('confidence', 0)
                if detected_enc and confidence > 0.5:
                    text = content.decode(detected_enc)
                    content = text.encode('utf-8')
                    logger.info("Re-encoded %s from %s (%.0f%% confidence) to UTF-8",
                                fname, detected_enc, confidence * 100)
                else:
                    raise ValueError("Low confidence")
            except Exception:
                try:
                    text = content.decode('latin-1')
                    content = text.encode('utf-8')
                    logger.info("Re-encoded %s from Latin-1 to UTF-8 (chardet unavailable or low confidence)", fname)
                except Exception:
                    pass

        content_hash = hashlib.sha256(content).hexdigest()
        if content_hash in seen_hashes:
            logger.info("Skipping duplicate file %s", fname)
            return raw, names
        seen_hashes.add(content_hash)

        raw.append(content)
        names.append(filename)

    return raw, names


async def _extract_xml_from_uploads(files: List[UploadFile]) -> tuple[list[bytes], list[str]]:
    """Read uploaded files, extracting XML from ZIP archives if present.

    Returns (raw_bytes_list, filename_list).

    Hardened against:
      - Zip bombs: total uncompressed size capped at 10 GB, entries streamed one at a time
      - Duplicate files: SHA-256 fingerprint checked before adding each file
      - Encoding issues: chardet-based re-encoding to UTF-8, falls back to Latin-1
      - Corrupt ZIPs: BadZipFile caught and treated as raw XML
    """
    raw: list[bytes] = []
    names: list[str] = []
    seen_hashes: set[str] = set()

    for f in files:
        content = await f.read()
        fname = f.filename or 'unknown.xml'
        f_raw, f_names = await asyncio.to_thread(_process_file_bytes, content, fname, seen_hashes)
        raw.extend(f_raw)
        names.extend(f_names)

    return raw, names


async def _extract_xml_from_path(file_path: str) -> tuple[list[bytes], list[str]]:
    """Read a file from a server-side path (DBFS or local) and extract XML.

    Uses the same _process_file_bytes logic as browser uploads.
    """
    from app.engines.dbfs_reader import read_file

    content = await asyncio.to_thread(read_file, file_path)
    filename = os.path.basename(file_path) or 'server_file'
    seen_hashes: set[str] = set()
    raw, names = await asyncio.to_thread(_process_file_bytes, content, filename, seen_hashes)
    return raw, names


# ── Upload pipeline endpoints ─────────────────────────────────────────────


@router.post('/tier-map/analyze')
async def analyze_tier_map(
    files: List[UploadFile] = File(...),
    x_user_id: str | None = Header(None),
    project_id: int | None = Query(None, description='Project to associate upload with'),
    db: Session = Depends(get_db),
):
    """Upload XML files (Informatica or NiFi, or ZIPs) and receive tier diagram data.

    Pipeline: extract XML -> classify platform -> run engine(s) -> persist to DB.
    Persists the result to SQLite so it can be retrieved later without re-parsing.

    Args:
        files: One or more .xml or .zip files containing ETL definitions.
        x_user_id: Optional user ID header for filtering uploads.
        project_id: Optional project to associate the upload with.
        db: SQLAlchemy session (injected).

    Returns:
        Tier data dict with sessions, tables, connections, stats, and upload_id.

    Raises:
        HTTPException(422): No files or no valid XML found.
        HTTPException(408): Parse exceeded the scaled timeout.
        HTTPException(429): Server already running max concurrent parses.
    """
    if not files:
        raise HTTPException(status_code=422, detail='No files uploaded.')

    # Acquire parse semaphore (max 2 concurrent parses)
    try:
        await asyncio.wait_for(_PARSE_SEMAPHORE.acquire(), timeout=10)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=429, detail='Server busy — too many concurrent parses. Try again shortly.')

    try:
        t0 = time.monotonic()
        raw, names = await _extract_xml_from_uploads(files)

        if not raw:
            raise HTTPException(status_code=422, detail='No XML files found in upload.')

        # Compute scaled timeout: base + 300s/file + 60s/100MB, capped at 4 hours
        total_size_mb = sum(len(r) for r in raw) / (1024 * 1024)
        scaled_timeout = min(
            _PARSE_TIMEOUT_CAP,
            max(settings.parse_timeout_seconds, int(600 * len(raw) + 120 * (total_size_mb / 100))),
        )

        try:
            result = await asyncio.wait_for(_analyze_mixed(raw, names), timeout=scaled_timeout)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=408, detail=f'Parse timed out after {scaled_timeout}s. Try uploading fewer files.')

        if not result.get('sessions') and result.get('warnings'):
            raise HTTPException(status_code=422, detail='; '.join(result['warnings']))

        duration_ms = int((time.monotonic() - t0) * 1000)

        # ── Persist to DB so the result can be reloaded without re-parsing ──
        platform = _detect_platform(raw)
        upload = Upload(
            filename=', '.join(names[:5]) + (f' (+{len(names)-5})' if len(names) > 5 else ''),
            platform=platform,
            session_count=len(result.get('sessions', [])),
            parse_duration_ms=duration_ms,
            user_id=x_user_id,
            project_id=project_id,
        )
        upload.set_tier_data(result)
        db.add(upload)
        db.commit()
        db.refresh(upload)

        # Populate per-view materialized tables
        from app.engines.data_populator import populate_core_tables, populate_view_tables, populate_code_analysis_tables, populate_deep_parse_tables, populate_normalized_tables
        try:
            populate_core_tables(db, upload.id, result, result.get('connection_profiles'))
            populate_code_analysis_tables(db, upload.id, result)
            populate_normalized_tables(db, upload.id, result)
            populate_deep_parse_tables(db, upload.id, result)
            populate_view_tables(db, upload.id)
            db.commit()
        except Exception as exc:
            logger.warning("Failed to populate view tables: %s", exc)
            db.rollback()

        result['upload_id'] = upload.id
        return result
    finally:
        _PARSE_SEMAPHORE.release()


# ── Constellation endpoints (synchronous + streaming) ─────────────────────


@router.post('/tier-map/constellation')
async def analyze_constellation(
    files: List[UploadFile] = File(...),
    algorithm: str = Query('louvain', description='Clustering algorithm'),
    x_user_id: str | None = Header(None),
    project_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Upload XML files and receive tier data + constellation clustering in one call.

    Combines the tier-map parse pipeline with constellation graph clustering,
    producing both the dependency graph and grouped visual clusters.

    Args:
        files: One or more .xml or .zip files.
        algorithm: Clustering algorithm (default 'louvain').
        x_user_id: Optional user ID for tracking.
        project_id: Optional project association.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with upload_id, tier_data, and constellation.
    """
    if not files:
        raise HTTPException(status_code=422, detail='No files uploaded.')

    # Acquire parse semaphore
    try:
        await asyncio.wait_for(_PARSE_SEMAPHORE.acquire(), timeout=10)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=429, detail='Server busy — too many concurrent parses. Try again shortly.')

    try:
        t0 = time.monotonic()
        raw, names = await _extract_xml_from_uploads(files)

        if not raw:
            raise HTTPException(status_code=422, detail='No XML files found in upload.')

        # Compute scaled timeout: 300s/file + 60s/100MB, capped at 4 hours
        total_size_mb = sum(len(r) for r in raw) / (1024 * 1024)
        scaled_timeout = min(
            _PARSE_TIMEOUT_CAP,
            max(settings.parse_timeout_seconds, int(600 * len(raw) + 120 * (total_size_mb / 100))),
        )

        try:
            tier_data = await asyncio.wait_for(_analyze_mixed(raw, names), timeout=scaled_timeout)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=408, detail=f'Parse timed out after {scaled_timeout}s.')

        if not tier_data.get('sessions') and tier_data.get('warnings'):
            raise HTTPException(status_code=422, detail='; '.join(tier_data['warnings']))

        from app.engines.constellation_engine import build_constellation
        constellation = await asyncio.to_thread(build_constellation, tier_data, algorithm=algorithm)

        duration_ms = int((time.monotonic() - t0) * 1000)

        # Persist to DB
        platform = _detect_platform(raw)
        upload = Upload(
            filename=', '.join(names[:5]) + (f' (+{len(names)-5})' if len(names) > 5 else ''),
            platform=platform,
            session_count=len(tier_data.get('sessions', [])),
            algorithm=algorithm,
            parse_duration_ms=duration_ms,
            user_id=x_user_id,
            project_id=project_id,
        )
        upload.set_tier_data(tier_data)
        upload.set_constellation(constellation)
        db.add(upload)
        db.commit()
        db.refresh(upload)

        # Populate per-view materialized tables
        from app.engines.data_populator import populate_core_tables, populate_view_tables, populate_constellation_tables, populate_code_analysis_tables, populate_deep_parse_tables, populate_normalized_tables
        try:
            populate_core_tables(db, upload.id, tier_data, tier_data.get('connection_profiles'))
            populate_code_analysis_tables(db, upload.id, tier_data)
            populate_normalized_tables(db, upload.id, tier_data)
            populate_deep_parse_tables(db, upload.id, tier_data)
            populate_view_tables(db, upload.id)
            populate_constellation_tables(db, upload.id, constellation)
            db.commit()
        except Exception as exc:
            logger.warning("Failed to populate view tables: %s", exc)
            db.rollback()

        return {'upload_id': upload.id, 'tier_data': tier_data, 'constellation': constellation}
    finally:
        _PARSE_SEMAPHORE.release()


@router.post('/tier-map/constellation-stream')
async def analyze_constellation_stream(
    files: List[UploadFile] = File(...),
    algorithm: str = Query('louvain', description='Clustering algorithm'),
    x_user_id: str | None = Header(None),
    project_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Upload XML files (Informatica or NiFi, or ZIPs) and stream progress events via SSE.

    Returns text/event-stream with newline-delimited JSON events:
      data: {"phase":"extracting","current":0,"total":0,"percent":0}
      data: {"phase":"parsing","current":342,"total":15000,"filename":"sess_342.xml","percent":2.3}
      data: {"phase":"clustering","current":0,"total":0,"percent":95}
      data: {"phase":"complete","result":{...}}
    """
    if not files:
        raise HTTPException(status_code=422, detail='No files uploaded.')

    # Extract XML bytes BEFORE returning the streaming response —
    # UploadFile handles are closed once the endpoint handler returns,
    # so we must read them eagerly here (not inside the background task).
    raw, names = await _extract_xml_from_uploads(files)

    if not raw:
        raise HTTPException(status_code=422, detail='No XML files found in upload.')

    queue: asyncio.Queue = asyncio.Queue()
    user_id = x_user_id

    async def _process() -> None:
        """Run parsing → clustering, pushing SSE progress events to the shared queue."""
        t0 = time.monotonic()
        try:
            total = len(raw)
            total_size_mb = sum(len(r) for r in raw) / (1024 * 1024)
            file_sizes = {n: len(r) / (1024 * 1024) for n, r in zip(names, raw)}
            logger.info("step=extract files=%d total_size=%.0fMB", total, total_size_mb)
            # Signal client that extraction is done (5% progress marker)
            await queue.put({'phase': 'extracting', 'current': total, 'total': total, 'percent': 5.0,
                             'elapsed_ms': int((time.monotonic() - t0) * 1000),
                             'total_size_mb': round(total_size_mb, 1)})

            # ── Phase: parsing ──
            loop = asyncio.get_running_loop()
            # Mutable single-element lists allow mutation from inside the sync progress_fn closure
            sessions_so_far = [0]
            files_parsed = [0]

            def progress_fn(current: int, total_files: int, filename: str, cumulative_sessions: int = 0) -> None:
                """Called by the engine after each file is parsed; maps to SSE percent 5–95."""
                files_parsed[0] = current
                sessions_so_far[0] = cumulative_sessions
                # Use sessions-based progress if available (more meaningful), else file count
                if cumulative_sessions > 0 and files_parsed[0] > 2:
                    # Estimate total sessions: extrapolate from average sessions/file so far
                    avg_per_file = cumulative_sessions / files_parsed[0]
                    est_total = avg_per_file * total_files
                    pct = min(90.0, round((cumulative_sessions / est_total) * 90.0, 1))
                else:
                    pct = round((current / total_files) * 90.0, 1)
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                # ETA: linear extrapolation based on average ms-per-file so far
                if current > 0 and current < total_files:
                    avg_ms = elapsed_ms / current
                    eta_ms = int(avg_ms * (total_files - current))
                else:
                    eta_ms = 0
                fsize_mb = file_sizes.get(filename, 0)
                logger.info("step=parse current=%d/%d file=%s (%.1fMB) sessions_so_far=%d elapsed_ms=%d eta=%ds",
                            current, total_files, filename, fsize_mb, sessions_so_far[0], elapsed_ms, eta_ms // 1000)
                asyncio.run_coroutine_threadsafe(
                    queue.put({
                        'phase': 'parsing',
                        'current': current,
                        'total': total_files,
                        'filename': filename,
                        'file_size_mb': round(fsize_mb, 1),
                        'percent': 5.0 + pct,
                        'elapsed_ms': elapsed_ms,
                        'eta_ms': eta_ms,
                        'sessions_found': sessions_so_far[0],
                    }),
                    loop,
                )

            # Detect platform for logging
            platform = _detect_platform(raw)
            logger.info("step=classify platform=%s files=%d", platform, total)

            # Scale timeout: base timeout + 300s per file + 60s per 100MB, capped at 4 hours
            total_size_mb = sum(len(r) for r in raw) / (1024 * 1024)
            scaled_timeout = min(
                _PARSE_TIMEOUT_CAP,
                max(settings.parse_timeout_seconds, int(600 * total + 120 * (total_size_mb / 100))),
            )
            logger.info("step=timeout_calc base=%ds files=%d size_mb=%.0f scaled=%ds",
                        settings.parse_timeout_seconds, total, total_size_mb, scaled_timeout)
            try:
                tier_data = await asyncio.wait_for(
                    _analyze_mixed(raw, names, progress_fn),
                    timeout=scaled_timeout,
                )
            except asyncio.TimeoutError:
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                logger.error("step=error phase=parsing type=TimeoutError message=Parse timeout after %dms", elapsed_ms)
                await queue.put({
                    'phase': 'timeout',
                    'message': f'Parse timed out after {scaled_timeout}s. Try uploading fewer files.',
                    'elapsed_ms': elapsed_ms,
                })
                return

            if not tier_data.get('sessions') and tier_data.get('warnings'):
                await queue.put({'phase': 'error', 'message': '; '.join(tier_data['warnings'])})
                return

            sessions_so_far[0] = len(tier_data.get('sessions', []))
            tables_count = len(tier_data.get('tables', []))
            conns_count = len(tier_data.get('connections', []))

            # ── Phase: tier assignment complete, report ──
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.info("step=tier_complete sessions=%d tables=%d connections=%d elapsed_ms=%d",
                        sessions_so_far[0], tables_count, conns_count, elapsed_ms)
            await queue.put({
                'phase': 'parsing', 'current': total, 'total': total,
                'percent': 95.0, 'elapsed_ms': elapsed_ms,
                'sessions_found': sessions_so_far[0],
                'filename': f'Tier assignment done: {sessions_so_far[0]} sessions, {tables_count} tables',
            })

            # ── Phase: clustering ──
            logger.info("step=cluster algorithm=%s sessions=%d elapsed_ms=%d",
                        algorithm, sessions_so_far[0], elapsed_ms)
            await queue.put({'phase': 'clustering', 'current': 0, 'total': 0, 'percent': 96.0,
                             'elapsed_ms': elapsed_ms,
                             'sessions_found': sessions_so_far[0]})

            from app.engines.constellation_engine import build_constellation
            constellation = await asyncio.to_thread(build_constellation, tier_data, algorithm=algorithm)

            # ── Phase: persist ──
            duration_ms = int((time.monotonic() - t0) * 1000)
            logger.info("step=persist sessions=%d elapsed_ms=%d", sessions_so_far[0], duration_ms)
            upload = Upload(
                filename=', '.join(names[:5]) + (f' (+{len(names)-5})' if len(names) > 5 else ''),
                platform=platform,
                session_count=len(tier_data.get('sessions', [])),
                algorithm=algorithm,
                parse_duration_ms=duration_ms,
                user_id=user_id,
                project_id=project_id,
            )
            upload.set_tier_data(tier_data)
            upload.set_constellation(constellation)
            db.add(upload)
            db.commit()
            db.refresh(upload)

            # Populate per-view materialized tables
            from app.engines.data_populator import populate_core_tables, populate_view_tables, populate_constellation_tables, populate_code_analysis_tables, populate_deep_parse_tables, populate_normalized_tables
            try:
                populate_core_tables(db, upload.id, tier_data, tier_data.get('connection_profiles'))
                populate_code_analysis_tables(db, upload.id, tier_data)
                populate_normalized_tables(db, upload.id, tier_data)
                populate_deep_parse_tables(db, upload.id, tier_data)
                populate_view_tables(db, upload.id)
                populate_constellation_tables(db, upload.id, constellation)
                db.commit()
            except Exception as exc:
                logger.warning("step=populate_views error=%s", exc)

            logger.info("step=persist upload_id=%d duration_ms=%d", upload.id, duration_ms)

            # ── Phase: complete — attach optional parse audit metadata ──
            # _parse_audit is a per-file stats dict injected by the engine; pop it
            # so it doesn't pollute the main tier_data structure stored in the DB.
            parse_audit = tier_data.pop('_parse_audit', None)
            complete_event = {
                'phase': 'complete',
                'percent': 100.0,
                'elapsed_ms': duration_ms,
                'sessions_found': sessions_so_far[0],
                'result': {'upload_id': upload.id, 'tier_data': tier_data, 'constellation': constellation},
            }
            if parse_audit:
                complete_event['parse_audit'] = parse_audit
            await queue.put(complete_event)
        except Exception as exc:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.error("step=error phase=process type=%s message=%s elapsed_ms=%d",
                         type(exc).__name__, str(exc), elapsed_ms)
            await queue.put({'phase': 'error', 'message': str(exc), 'elapsed_ms': elapsed_ms})

    async def _event_generator():
        """Pull events from the queue and yield as SSE-formatted lines until terminal phase.

        Sends a heartbeat comment every 15s if no real event arrives, keeping
        proxies and load balancers from closing the connection.
        """
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
                continue
            yield f"data: {json.dumps(event)}\n\n"
            # 'complete' and 'error' are terminal events — stop the stream
            if event.get('phase') in ('complete', 'error', 'timeout'):
                break

    # Start the heavy processing in the background so the SSE response can be
    # returned immediately (the event loop stays free to service other requests).
    asyncio.ensure_future(_process())

    return StreamingResponse(
        _event_generator(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


# ── Server-side path parse endpoint ────────────────────────────────────────


def _validate_server_path(file_path: str) -> None:
    """Validate a server-side file path for safety.

    DBFS paths (``dbfs:/...``) are always allowed.
    Local paths must start with one of the configured allowed prefixes
    and must not contain ``..`` traversal sequences.

    Raises:
        HTTPException(400): If the path fails validation.
    """
    # Block path traversal
    if '..' in file_path:
        raise HTTPException(status_code=400, detail='Path traversal (..) is not allowed.')

    # DBFS paths are always allowed
    from app.engines.dbfs_reader import is_dbfs_path
    if is_dbfs_path(file_path):
        return

    # Local paths must be under an allowed prefix
    resolved = os.path.realpath(file_path)
    allowed = settings.server_parse_allowed_paths
    if not any(resolved.startswith(os.path.realpath(prefix)) for prefix in allowed):
        raise HTTPException(
            status_code=400,
            detail=f'Path not in allowed prefixes. Allowed: {allowed}',
        )


@router.post('/tier-map/analyze-path')
async def analyze_from_path(
    file_path: str = Query(..., description='Server-side file path (DBFS or local)'),
    algorithm: str = Query('louvain', description='Clustering algorithm'),
    x_user_id: str | None = Header(None),
    project_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    """Parse ETL files from a server-side path (DBFS or local) via SSE streaming.

    Use this when files are too large to upload via the browser. Upload to DBFS
    via CLI first, then trigger parse from the path::

        databricks fs cp export.zip dbfs:/landing/etl-dep-viz/export.zip
        # Then call: POST /api/tier-map/analyze-path?file_path=dbfs:/landing/etl-dep-viz/export.zip

    Returns text/event-stream with the same SSE format as constellation-stream.
    """
    _validate_server_path(file_path)

    # Validate file exists before starting the stream
    from app.engines.dbfs_reader import is_dbfs_path
    if not is_dbfs_path(file_path) and not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f'File not found: {file_path}')

    queue: asyncio.Queue = asyncio.Queue()
    user_id = x_user_id

    async def _process() -> None:
        """Read from server path → extract → parse → cluster → persist, pushing SSE events."""
        t0 = time.monotonic()
        acquired = False
        try:
            # Acquire parse semaphore
            try:
                await asyncio.wait_for(_PARSE_SEMAPHORE.acquire(), timeout=10)
                acquired = True
            except asyncio.TimeoutError:
                await queue.put({'phase': 'error', 'message': 'Server busy — too many concurrent parses. Try again shortly.'})
                return

            await queue.put({'phase': 'extracting', 'current': 0, 'total': 0, 'percent': 2.0,
                             'message': f'Reading {file_path}',
                             'elapsed_ms': int((time.monotonic() - t0) * 1000)})

            try:
                raw, names = await _extract_xml_from_path(file_path)
            except FileNotFoundError:
                await queue.put({'phase': 'error', 'message': f'File not found: {file_path}'})
                return
            except Exception as exc:
                await queue.put({'phase': 'error', 'message': f'Failed to read file: {exc}'})
                return

            if not raw:
                await queue.put({'phase': 'error', 'message': 'No XML files found in the specified path.'})
                return

            total = len(raw)
            total_size_mb = sum(len(r) for r in raw) / (1024 * 1024)
            file_sizes = {n: len(r) / (1024 * 1024) for n, r in zip(names, raw)}
            logger.info("step=extract_path files=%d total_size=%.0fMB path=%s", total, total_size_mb, file_path)
            await queue.put({'phase': 'extracting', 'current': total, 'total': total, 'percent': 5.0,
                             'elapsed_ms': int((time.monotonic() - t0) * 1000),
                             'total_size_mb': round(total_size_mb, 1)})

            # ── Phase: parsing ──
            loop = asyncio.get_running_loop()
            sessions_so_far = [0]
            files_parsed = [0]

            def progress_fn(current: int, total_files: int, filename: str, cumulative_sessions: int = 0) -> None:
                files_parsed[0] = current
                sessions_so_far[0] = cumulative_sessions
                if cumulative_sessions > 0 and files_parsed[0] > 2:
                    avg_per_file = cumulative_sessions / files_parsed[0]
                    est_total = avg_per_file * total_files
                    pct = min(90.0, round((cumulative_sessions / est_total) * 90.0, 1))
                else:
                    pct = round((current / total_files) * 90.0, 1)
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                if current > 0 and current < total_files:
                    avg_ms = elapsed_ms / current
                    eta_ms = int(avg_ms * (total_files - current))
                else:
                    eta_ms = 0
                fsize_mb = file_sizes.get(filename, 0)
                asyncio.run_coroutine_threadsafe(
                    queue.put({
                        'phase': 'parsing',
                        'current': current,
                        'total': total_files,
                        'filename': filename,
                        'file_size_mb': round(fsize_mb, 1),
                        'percent': 5.0 + pct,
                        'elapsed_ms': elapsed_ms,
                        'eta_ms': eta_ms,
                        'sessions_found': sessions_so_far[0],
                    }),
                    loop,
                )

            platform = _detect_platform(raw)
            scaled_timeout = min(
                _PARSE_TIMEOUT_CAP,
                max(settings.parse_timeout_seconds, int(600 * total + 120 * (total_size_mb / 100))),
            )
            try:
                tier_data = await asyncio.wait_for(
                    _analyze_mixed(raw, names, progress_fn),
                    timeout=scaled_timeout,
                )
            except asyncio.TimeoutError:
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                await queue.put({
                    'phase': 'timeout',
                    'message': f'Parse timed out after {scaled_timeout}s.',
                    'elapsed_ms': elapsed_ms,
                })
                return

            if not tier_data.get('sessions') and tier_data.get('warnings'):
                await queue.put({'phase': 'error', 'message': '; '.join(tier_data['warnings'])})
                return

            sessions_so_far[0] = len(tier_data.get('sessions', []))
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            await queue.put({
                'phase': 'parsing', 'current': total, 'total': total,
                'percent': 95.0, 'elapsed_ms': elapsed_ms,
                'sessions_found': sessions_so_far[0],
                'filename': f'Tier assignment done: {sessions_so_far[0]} sessions',
            })

            # ── Phase: clustering ──
            await queue.put({'phase': 'clustering', 'current': 0, 'total': 0, 'percent': 96.0,
                             'elapsed_ms': elapsed_ms, 'sessions_found': sessions_so_far[0]})

            from app.engines.constellation_engine import build_constellation
            constellation = await asyncio.to_thread(build_constellation, tier_data, algorithm=algorithm)

            # ── Phase: persist ──
            duration_ms = int((time.monotonic() - t0) * 1000)
            upload = Upload(
                filename=os.path.basename(file_path),
                platform=platform,
                session_count=len(tier_data.get('sessions', [])),
                algorithm=algorithm,
                parse_duration_ms=duration_ms,
                user_id=user_id,
                project_id=project_id,
            )
            upload.set_tier_data(tier_data)
            upload.set_constellation(constellation)
            db.add(upload)
            db.commit()
            db.refresh(upload)

            # Populate per-view materialized tables
            from app.engines.data_populator import populate_core_tables, populate_view_tables, populate_constellation_tables, populate_code_analysis_tables, populate_deep_parse_tables, populate_normalized_tables
            try:
                populate_core_tables(db, upload.id, tier_data, tier_data.get('connection_profiles'))
                populate_code_analysis_tables(db, upload.id, tier_data)
                populate_normalized_tables(db, upload.id, tier_data)
                populate_deep_parse_tables(db, upload.id, tier_data)
                populate_view_tables(db, upload.id)
                populate_constellation_tables(db, upload.id, constellation)
                db.commit()
            except Exception as exc:
                logger.warning("step=populate_views error=%s", exc)

            parse_audit = tier_data.pop('_parse_audit', None)
            complete_event = {
                'phase': 'complete',
                'percent': 100.0,
                'elapsed_ms': duration_ms,
                'sessions_found': sessions_so_far[0],
                'result': {'upload_id': upload.id, 'tier_data': tier_data, 'constellation': constellation},
            }
            if parse_audit:
                complete_event['parse_audit'] = parse_audit
            await queue.put(complete_event)
        except Exception as exc:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.error("step=error phase=analyze_path type=%s message=%s", type(exc).__name__, str(exc))
            await queue.put({'phase': 'error', 'message': str(exc), 'elapsed_ms': elapsed_ms})
        finally:
            if acquired:
                _PARSE_SEMAPHORE.release()

    async def _event_generator():
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
                continue
            yield f"data: {json.dumps(event)}\n\n"
            if event.get('phase') in ('complete', 'error', 'timeout'):
                break

    asyncio.ensure_future(_process())

    return StreamingResponse(
        _event_generator(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


@router.post('/tier-map/recluster')
async def recluster_constellation(
    tier_data: dict = Body(...),
    algorithm: str = Query('louvain', description='Clustering algorithm'),
):
    """Re-cluster existing tier_data with a different algorithm (no file re-upload).

    Allows users to experiment with clustering parameters without re-parsing
    the XML files. Only the constellation layout changes; tier data is unchanged.

    Args:
        tier_data: Previously parsed tier data containing sessions and connections.
        algorithm: Clustering algorithm to apply (e.g. 'louvain', 'leiden').

    Returns:
        Dict with the same tier_data and a new constellation result.
    """
    if not tier_data.get('sessions'):
        raise HTTPException(status_code=422, detail='tier_data must contain sessions.')

    from app.engines.constellation_engine import build_constellation
    constellation = await asyncio.to_thread(build_constellation, tier_data, algorithm=algorithm)

    return {'tier_data': tier_data, 'constellation': constellation}


@router.get('/tier-map/algorithms')
async def list_algorithms():
    """Return available clustering algorithms with display metadata.

    Used by the frontend algorithm picker dropdown to show options and descriptions.
    """
    from app.engines.constellation_engine import ALGORITHMS
    return {'algorithms': ALGORITHMS}


# ── Algorithm Lab endpoints ──────────────────────────────────────────────────


@router.get('/tier-map/lab/algorithms')
async def list_lab_algorithms():
    """Return available lab clustering algorithms with metadata, params schema, and speed ratings."""
    from app.engines.algorithm_lab_engine import LAB_ALGORITHMS
    return {'algorithms': LAB_ALGORITHMS}


@router.post('/tier-map/lab/run')
async def run_lab_algorithm_endpoint(
    tier_data: dict = Body(...),
    algorithm: str = Query('louvain', description='Lab clustering algorithm'),
    params: str = Query('{}', description='JSON-encoded algorithm parameters'),
    seed: int | None = Query(None, description='Random seed (null = random)'),
):
    """Run a lab clustering algorithm on tier_data and return constellation + quality metrics.

    Args:
        tier_data: Previously parsed tier data containing sessions, tables, connections.
        algorithm: Algorithm key from LAB_ALGORITHMS registry.
        params: JSON string of algorithm-specific parameters.
        seed: Random seed for reproducibility. Null for non-deterministic runs.

    Returns:
        Dict with constellation result, quality_metrics, and run_meta.
    """
    import json as _json

    if not tier_data.get('sessions'):
        raise HTTPException(status_code=422, detail='tier_data must contain sessions.')

    try:
        parsed_params = _json.loads(params) if isinstance(params, str) else params
    except (ValueError, TypeError):
        parsed_params = {}

    from app.engines.algorithm_lab_engine import run_lab_algorithm
    result = await asyncio.to_thread(
        run_lab_algorithm, tier_data, algorithm=algorithm, params=parsed_params, seed=seed
    )
    return result


# ── Persistence endpoints ─────────────────────────────────────────────────


@router.get('/tier-map/uploads')
def list_uploads(
    limit: int = Query(20, ge=1, le=500),
    offset: int = Query(0, ge=0),
    x_user_id: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """List recent uploads (most recent first). Optionally filter by X-User-Id header.

    Returns lightweight metadata only (no tier_data blobs) for fast dashboard rendering.

    Args:
        limit: Max results (1-500, default 20).
        offset: Pagination offset.
        x_user_id: Optional header filter — only show this user's uploads.
        db: SQLAlchemy session (injected).

    Returns:
        List of upload summary dicts with id, filename, platform, session_count, etc.
    """
    q = db.query(Upload)
    if x_user_id:
        q = q.filter(Upload.user_id == x_user_id)
    rows = q.order_by(Upload.created_at.desc()).offset(offset).limit(limit).all()
    return [
        {
            'id': r.id,
            'filename': r.filename,
            'platform': r.platform,
            'session_count': r.session_count,
            'algorithm': r.algorithm,
            'parse_duration_ms': r.parse_duration_ms,
            'project_id': r.project_id,
            'created_at': r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get('/tier-map/uploads/{upload_id}')
def get_upload(upload_id: int, db: Session = Depends(get_db)):
    """Retrieve a previously parsed upload by ID (no re-parsing needed).

    Returns the full tier_data JSON blob plus constellation and vector_results
    if available. This is the primary "load saved analysis" endpoint.

    Args:
        upload_id: DB primary key of the upload.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with tier_data, constellation (if available), vector_results (if available),
        and metadata (filename, platform, session_count, algorithm, created_at).
    """
    row = db.query(Upload).filter(Upload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail='Upload not found.')

    # Try JSON blob first; fall back to reconstructing from view tables
    tier_data = row.get_tier_data()
    if not tier_data or not tier_data.get('sessions'):
        from app.engines.data_populator import reconstruct_tier_data
        tier_data = reconstruct_tier_data(db, upload_id) or tier_data

    result: dict = {
        'upload_id': row.id,
        'tier_data': tier_data,
        'filename': row.filename,
        'platform': row.platform,
        'session_count': row.session_count,
        'algorithm': row.algorithm,
        'created_at': row.created_at.isoformat() if row.created_at else None,
    }
    constellation = row.get_constellation()
    if not constellation or not constellation.get('points'):
        from app.engines.data_populator import reconstruct_constellation
        constellation = reconstruct_constellation(db, upload_id) or constellation
    if constellation:
        result['constellation'] = constellation

    vector_results = row.get_vector_results()
    if not vector_results or len(vector_results) == 0:
        from app.engines.data_populator import reconstruct_vector_results
        vector_results = reconstruct_vector_results(db, upload_id) or vector_results
    if vector_results:
        result['vector_results'] = vector_results
    return result


@router.delete('/tier-map/uploads/{upload_id}')
def delete_upload(upload_id: int, db: Session = Depends(get_db)):
    """Delete a stored upload and all CASCADE-dependent view/vector rows."""
    row = db.query(Upload).filter(Upload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail='Upload not found.')
    db.delete(row)
    db.commit()
    return {'deleted': True}


# ── Paginated session API (Item 17) ──────────────────────────────────────────

@router.get('/tier-map/uploads/{upload_id}/sessions')
def list_sessions(
    upload_id: int,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    tier: int | None = Query(None, description='Filter by tier'),
    search: str | None = Query(None, description='Search by session name'),
    db: Session = Depends(get_db),
):
    """Paginated session list for an upload — supports tier filter and name search.

    Two code paths:
      - Fast path: uses normalized SessionRecord rows (DB-level filtering).
      - Legacy path: falls back to the JSON blob for uploads without SessionRecord rows.

    Args:
        upload_id: DB primary key of the upload.
        offset: Pagination offset.
        limit: Page size (1-500, default 100).
        tier: Optional filter for a specific tier number.
        search: Optional substring search against session name/full path.
        db: SQLAlchemy session (injected).

    Returns:
        Dict with sessions list, total count, offset, and limit.
    """
    from app.models.database import SessionRecord

    row = db.query(Upload).filter(Upload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail='Upload not found.')

    # Check if we have normalized session records
    q = db.query(SessionRecord).filter(SessionRecord.upload_id == upload_id)
    count = q.count()

    if count == 0:
        # ── Legacy path: no normalized SessionRecord rows, fall back to the JSON blob ──
        # Older uploads were stored only as a JSON blob; filter/paginate in Python.
        tier_data = row.get_tier_data()
        sessions = tier_data.get('sessions', [])
        if tier is not None:
            sessions = [s for s in sessions if int(s.get('tier', 0)) == tier]
        if search:
            search_lower = search.lower()
            # Match against both short name and fully-qualified workflow path
            sessions = [s for s in sessions if search_lower in s.get('name', '').lower()
                        or search_lower in s.get('full', '').lower()]
        total = len(sessions)
        page = sessions[offset:offset + limit]
        return {'sessions': page, 'total': total, 'offset': offset, 'limit': limit}

    # ── Fast path: use normalized SessionRecord rows for DB-level filtering ──
    if tier is not None:
        q = q.filter(SessionRecord.tier == float(tier))
    if search:
        q = q.filter(SessionRecord.full_name.ilike(f'%{search}%'))

    total = q.count()
    rows = q.order_by(SessionRecord.tier, SessionRecord.step).offset(offset).limit(limit).all()

    sessions = []
    for r in rows:
        sessions.append({
            'id': r.session_id,
            'name': r.name,
            'full': r.full_name,
            'tier': r.tier,
            'step': r.step,
            'workflow': r.workflow,
            'transforms': r.transforms,
            'critical': bool(r.critical),
            # sources/targets/lookups are stored as JSON strings in the DB column
            'sources': json.loads(r.sources_json) if r.sources_json else [],
            'targets': json.loads(r.targets_json) if r.targets_json else [],
            'lookups': json.loads(r.lookups_json) if r.lookups_json else [],
        })

    return {'sessions': sessions, 'total': total, 'offset': offset, 'limit': limit}
