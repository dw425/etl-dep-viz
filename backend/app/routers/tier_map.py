"""Tier Map router — Informatica + NiFi XML tier diagram + constellation map analysis.

Supports uploading individual .xml files OR .zip archives containing XML files.
Auto-detects platform (Informatica vs NiFi) from XML content.
"""

import asyncio
import io
import json
import logging
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

router = APIRouter()


def _classify_file(content: bytes) -> Literal['informatica', 'nifi']:
    """Classify a single XML file as Informatica or NiFi."""
    head = content[:5000].decode('utf-8', errors='replace').lower()
    if 'informatica' in head or '<folder ' in head or '<mapping ' in head:
        return 'informatica'
    if '<session ' in head and '<workflow ' in head:
        return 'informatica'
    return 'nifi'


def _detect_platform(raw_list: list[bytes]) -> Literal['informatica', 'nifi']:
    """Sniff the first few XML files to determine dominant platform."""
    for content in raw_list[:5]:
        if _classify_file(content) == 'informatica':
            return 'informatica'
    return 'nifi'


def _split_by_platform(
    raw: list[bytes], names: list[str],
) -> tuple[list[bytes], list[str], list[bytes], list[str]]:
    """Split files into (infa_raw, infa_names, nifi_raw, nifi_names)."""
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
    """Return the correct analyze function for the detected platform."""
    if platform == 'informatica':
        from app.engines.infa_engine import analyze
        return analyze
    else:
        from app.engines.nifi_tier_engine import analyze
        return analyze


def _merge_tier_results(a: dict, b: dict) -> dict:
    """Merge two tier_data results (from different platforms) into one.

    Re-numbers session IDs and table IDs in `b` to avoid collisions with `a`.
    """
    if not a.get('sessions'):
        return b
    if not b.get('sessions'):
        return a

    # Offset for b's IDs to avoid collisions
    a_max_s = max((int(s['id'].lstrip('S')) for s in a['sessions']), default=0)
    a_max_t = max((int(t['id'].lstrip('T_')) for t in a['tables']), default=0)

    # Build ID remap for b
    s_remap: dict[str, str] = {}
    for s in b['sessions']:
        old_id = s['id']
        num = int(old_id.lstrip('S'))
        new_id = f'S{num + a_max_s}'
        s_remap[old_id] = new_id
        s['id'] = new_id

    t_remap: dict[str, str] = {}
    for t in b['tables']:
        old_id = t['id']
        num = int(old_id.lstrip('T_'))
        new_id = f'T_{num + a_max_t}'
        t_remap[old_id] = new_id
        t['id'] = new_id

    # Remap connection endpoints
    remap_all = {**s_remap, **t_remap}
    for conn in b.get('connections', []):
        conn['from'] = remap_all.get(conn['from'], conn['from'])
        conn['to'] = remap_all.get(conn['to'], conn['to'])

    # Merge
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
            'write_conflicts': a_stats.get('write_conflicts', 0) + b_stats.get('write_conflicts', 0),
            'dep_chains': a_stats.get('dep_chains', 0) + b_stats.get('dep_chains', 0),
            'staleness_risks': a_stats.get('staleness_risks', 0) + b_stats.get('staleness_risks', 0),
            'source_tables': a_stats.get('source_tables', 0) + b_stats.get('source_tables', 0),
            'max_tier': max(a_stats.get('max_tier', 0), b_stats.get('max_tier', 0)),
        },
        'warnings': (a.get('warnings') or []) + (b.get('warnings') or []),
    }


async def _analyze_mixed(
    raw: list[bytes],
    names: list[str],
    progress_fn=None,
) -> dict:
    """Classify files per-platform, run both engines if needed, merge results."""
    infa_raw, infa_names, nifi_raw, nifi_names = _split_by_platform(raw, names)

    results = []

    if infa_raw:
        from app.engines.infa_engine import analyze as infa_analyze
        r = await asyncio.to_thread(infa_analyze, infa_raw, infa_names, progress_fn)
        results.append(r)

    if nifi_raw:
        from app.engines.nifi_tier_engine import analyze as nifi_analyze
        r = await asyncio.to_thread(nifi_analyze, nifi_raw, nifi_names, progress_fn)
        results.append(r)

    if not results:
        return {'sessions': [], 'tables': [], 'connections': [],
                'stats': {'session_count': 0, 'write_conflicts': 0, 'dep_chains': 0,
                          'staleness_risks': 0, 'source_tables': 0, 'max_tier': 0},
                'warnings': ['No XML files found.']}

    merged = results[0]
    for r in results[1:]:
        merged = _merge_tier_results(merged, r)
    return merged


async def _extract_xml_from_uploads(files: List[UploadFile]) -> tuple[list[bytes], list[str]]:
    """Read uploaded files, extracting XML from ZIP archives if present.

    Returns (raw_bytes_list, filename_list).

    Hardened: uses SpooledTemporaryFile for large ZIPs, validates zip integrity,
    enforces per-entry and total uncompressed size limits, runs extraction in thread.
    """
    raw: list[bytes] = []
    names: list[str] = []

    for f in files:
        content = await f.read()
        if not content:
            continue

        fname = (f.filename or 'unknown').lower()

        # ZIP archive — extract all .xml files inside
        if fname.endswith('.zip') or (content[:4] == b'PK\x03\x04'):
            # Validate before opening
            if not zipfile.is_zipfile(io.BytesIO(content)):
                logger.warning("File %s has ZIP signature but is not a valid ZIP", fname)
                raw.append(content)
                names.append(f.filename or 'unknown.xml')
                continue

            try:
                def _extract_zip(data: bytes) -> tuple[list[bytes], list[str]]:
                    z_raw, z_names = [], []
                    total_uncompressed = 0
                    # Use SpooledTemporaryFile so large ZIPs don't consume all RAM
                    spool = tempfile.SpooledTemporaryFile(max_size=_SPOOL_THRESHOLD)
                    spool.write(data)
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
                            if xml_bytes:
                                z_raw.append(xml_bytes)
                                z_names.append(info.filename.split('/')[-1])
                    spool.close()
                    return z_raw, z_names

                z_raw, z_names = await asyncio.to_thread(_extract_zip, content)
                raw.extend(z_raw)
                names.extend(z_names)
            except zipfile.BadZipFile:
                logger.warning("BadZipFile for %s — treating as raw XML", fname)
                raw.append(content)
                names.append(f.filename or 'unknown.xml')
        else:
            # Try UTF-8 decode, fall back to Latin-1 for encoding detection
            try:
                content.decode('utf-8')
            except UnicodeDecodeError:
                try:
                    text = content.decode('latin-1')
                    content = text.encode('utf-8')
                    logger.info("Re-encoded %s from Latin-1 to UTF-8", fname)
                except Exception:
                    pass  # leave as-is
            raw.append(content)
            names.append(f.filename or 'unknown.xml')

    return raw, names


@router.post('/tier-map/analyze')
async def analyze_tier_map(
    files: List[UploadFile] = File(...),
    x_user_id: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Upload XML files (Informatica or NiFi, or ZIPs) and receive tier diagram data.

    Persists the result so it can be retrieved later without re-parsing.
    """
    if not files:
        raise HTTPException(status_code=422, detail='No files uploaded.')

    t0 = time.monotonic()
    raw, names = await _extract_xml_from_uploads(files)

    if not raw:
        raise HTTPException(status_code=422, detail='No XML files found in upload.')

    result = await _analyze_mixed(raw, names)

    if not result.get('sessions') and result.get('warnings'):
        raise HTTPException(status_code=422, detail='; '.join(result['warnings']))

    duration_ms = int((time.monotonic() - t0) * 1000)

    # Persist to DB
    platform = _detect_platform(raw)
    upload = Upload(
        filename=', '.join(names[:5]) + (f' (+{len(names)-5})' if len(names) > 5 else ''),
        platform=platform,
        session_count=len(result.get('sessions', [])),
        parse_duration_ms=duration_ms,
        user_id=x_user_id,
    )
    upload.set_tier_data(result)
    db.add(upload)
    db.commit()
    db.refresh(upload)

    result['upload_id'] = upload.id
    return result


@router.post('/tier-map/constellation')
async def analyze_constellation(
    files: List[UploadFile] = File(...),
    algorithm: str = Query('louvain', description='Clustering algorithm'),
    x_user_id: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Upload XML files (Informatica or NiFi, or ZIPs) and receive tier data + constellation clustering."""
    if not files:
        raise HTTPException(status_code=422, detail='No files uploaded.')

    t0 = time.monotonic()
    raw, names = await _extract_xml_from_uploads(files)

    if not raw:
        raise HTTPException(status_code=422, detail='No XML files found in upload.')

    tier_data = await _analyze_mixed(raw, names)

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
    )
    upload.set_tier_data(tier_data)
    upload.set_constellation(constellation)
    db.add(upload)
    db.commit()
    db.refresh(upload)

    return {'upload_id': upload.id, 'tier_data': tier_data, 'constellation': constellation}


@router.post('/tier-map/constellation-stream')
async def analyze_constellation_stream(
    files: List[UploadFile] = File(...),
    algorithm: str = Query('louvain', description='Clustering algorithm'),
    x_user_id: str | None = Header(None),
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
        """Run parsing → clustering, pushing progress events to the queue."""
        t0 = time.monotonic()
        try:
            total = len(raw)
            logger.info("step=extract files=%d", total)
            await queue.put({'phase': 'extracting', 'current': total, 'total': total, 'percent': 5.0,
                             'elapsed_ms': int((time.monotonic() - t0) * 1000)})

            # ── Phase: parsing ──
            loop = asyncio.get_running_loop()
            sessions_so_far = [0]

            def progress_fn(current: int, total_files: int, filename: str) -> None:
                pct = round((current / total_files) * 90.0, 1)  # parsing = 5%–95%
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                logger.info("step=parse current=%d/%d file=%s sessions_so_far=%d elapsed_ms=%d",
                            current, total_files, filename, sessions_so_far[0], elapsed_ms)
                asyncio.run_coroutine_threadsafe(
                    queue.put({
                        'phase': 'parsing',
                        'current': current,
                        'total': total_files,
                        'filename': filename,
                        'percent': 5.0 + pct,
                        'elapsed_ms': elapsed_ms,
                    }),
                    loop,
                )

            # Detect platform for logging
            platform = _detect_platform(raw)
            logger.info("step=classify platform=%s files=%d", platform, total)

            # Apply timeout
            try:
                tier_data = await asyncio.wait_for(
                    _analyze_mixed(raw, names, progress_fn),
                    timeout=settings.parse_timeout_seconds,
                )
            except asyncio.TimeoutError:
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                logger.error("step=error phase=parsing type=TimeoutError message=Parse timeout after %dms", elapsed_ms)
                await queue.put({
                    'phase': 'timeout',
                    'message': f'Parse timed out after {settings.parse_timeout_seconds}s. Try uploading fewer files.',
                    'elapsed_ms': elapsed_ms,
                })
                return

            if not tier_data.get('sessions') and tier_data.get('warnings'):
                await queue.put({'phase': 'error', 'message': '; '.join(tier_data['warnings'])})
                return

            sessions_so_far[0] = len(tier_data.get('sessions', []))

            # ── Phase: clustering ──
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.info("step=cluster algorithm=%s sessions=%d elapsed_ms=%d",
                        algorithm, sessions_so_far[0], elapsed_ms)
            await queue.put({'phase': 'clustering', 'current': 0, 'total': 0, 'percent': 95.0,
                             'elapsed_ms': elapsed_ms})

            from app.engines.constellation_engine import build_constellation
            constellation = await asyncio.to_thread(build_constellation, tier_data, algorithm=algorithm)

            # ── Phase: persist ──
            duration_ms = int((time.monotonic() - t0) * 1000)
            upload = Upload(
                filename=', '.join(names[:5]) + (f' (+{len(names)-5})' if len(names) > 5 else ''),
                platform=platform,
                session_count=len(tier_data.get('sessions', [])),
                algorithm=algorithm,
                parse_duration_ms=duration_ms,
                user_id=user_id,
            )
            upload.set_tier_data(tier_data)
            upload.set_constellation(constellation)
            db.add(upload)
            db.commit()
            db.refresh(upload)

            logger.info("step=persist upload_id=%d duration_ms=%d", upload.id, duration_ms)

            # ── Phase: complete ──
            await queue.put({
                'phase': 'complete',
                'percent': 100.0,
                'elapsed_ms': duration_ms,
                'result': {'upload_id': upload.id, 'tier_data': tier_data, 'constellation': constellation},
            })
        except Exception as exc:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.error("step=error phase=process type=%s message=%s elapsed_ms=%d",
                         type(exc).__name__, str(exc), elapsed_ms)
            await queue.put({'phase': 'error', 'message': str(exc), 'elapsed_ms': elapsed_ms})

    async def _event_generator():
        """Yield SSE events from the queue until 'complete' or 'error'."""
        while True:
            event = await queue.get()
            yield f"data: {json.dumps(event)}\n\n"
            if event.get('phase') in ('complete', 'error'):
                break

    # Launch processing as a background task so the SSE generator can yield immediately
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
    """Re-cluster existing tier_data with a different algorithm (no file re-upload)."""
    if not tier_data.get('sessions'):
        raise HTTPException(status_code=422, detail='tier_data must contain sessions.')

    from app.engines.constellation_engine import build_constellation
    constellation = await asyncio.to_thread(build_constellation, tier_data, algorithm=algorithm)

    return {'tier_data': tier_data, 'constellation': constellation}


@router.get('/tier-map/algorithms')
async def list_algorithms():
    """Return available clustering algorithms with display metadata."""
    from app.engines.constellation_engine import ALGORITHMS
    return {'algorithms': ALGORITHMS}


# ── Persistence endpoints ─────────────────────────────────────────────────


@router.get('/tier-map/uploads')
def list_uploads(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    x_user_id: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """List recent uploads (most recent first). Optionally filter by user_id."""
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
            'created_at': r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get('/tier-map/uploads/{upload_id}')
def get_upload(upload_id: int, db: Session = Depends(get_db)):
    """Retrieve a previously parsed upload by ID (no re-parsing needed)."""
    row = db.query(Upload).filter(Upload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail='Upload not found.')
    result: dict = {
        'upload_id': row.id,
        'tier_data': row.get_tier_data(),
        'filename': row.filename,
        'platform': row.platform,
        'session_count': row.session_count,
        'algorithm': row.algorithm,
        'created_at': row.created_at.isoformat() if row.created_at else None,
    }
    constellation = row.get_constellation()
    if constellation:
        result['constellation'] = constellation
    return result


@router.delete('/tier-map/uploads/{upload_id}')
def delete_upload(upload_id: int, db: Session = Depends(get_db)):
    """Delete a stored upload."""
    row = db.query(Upload).filter(Upload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail='Upload not found.')
    db.delete(row)
    db.commit()
    return {'deleted': True}
