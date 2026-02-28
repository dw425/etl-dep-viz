"""Parse coordinator — parallel file parsing with fault isolation.

Wraps per-file parsing in ThreadPoolExecutor for parallel execution,
with per-file error handling so one bad file doesn't abort the batch.
"""

from __future__ import annotations

import hashlib
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# Maximum parallel parse workers
_MAX_WORKERS = 4


@dataclass
class FileParseResult:
    """Result of parsing a single file."""
    filename: str
    status: str  # 'ok', 'error', 'skipped_duplicate'
    sessions: Dict[str, Any] = field(default_factory=dict)
    session_count: int = 0
    error: str = ''
    elapsed_ms: int = 0
    content_hash: str = ''
    file_size: int = 0


@dataclass
class ParseAudit:
    """Audit trail for a batch parse operation."""
    total_files: int = 0
    parsed_ok: int = 0
    parse_errors: int = 0
    duplicates_skipped: int = 0
    total_sessions: int = 0
    elapsed_ms: int = 0
    file_results: List[FileParseResult] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            'total_files': self.total_files,
            'parsed_ok': self.parsed_ok,
            'parse_errors': self.parse_errors,
            'duplicates_skipped': self.duplicates_skipped,
            'total_sessions': self.total_sessions,
            'elapsed_ms': self.elapsed_ms,
            'file_results': [
                {
                    'filename': r.filename,
                    'status': r.status,
                    'session_count': r.session_count,
                    'error': r.error,
                    'elapsed_ms': r.elapsed_ms,
                    'file_size': r.file_size,
                }
                for r in self.file_results
            ],
        }


def _hash_content(content: bytes) -> str:
    """SHA-256 hash of file content for duplicate detection."""
    return hashlib.sha256(content).hexdigest()


def parse_files_parallel(
    contents: List[bytes],
    filenames: List[str],
    parse_fn: Callable[[bytes, str], Dict[str, Any]],
    progress_fn: Optional[Callable[[int, int, str, str], None]] = None,
    max_workers: int = _MAX_WORKERS,
    deduplicate: bool = True,
) -> tuple[Dict[str, Any], ParseAudit]:
    """Parse multiple files in parallel with fault isolation and dedup.

    Args:
        contents: List of file contents (bytes)
        filenames: List of filenames
        parse_fn: Function to parse a single file: (content, filename) -> dict
        progress_fn: Optional callback(current, total, filename, status)
        max_workers: Maximum parallel workers
        deduplicate: If True, skip files with duplicate SHA-256 hashes

    Returns:
        (merged_sessions, audit) — merged session dict and parse audit trail
    """
    audit = ParseAudit(total_files=len(contents))
    t0 = time.monotonic()

    # Phase 1: Compute content hashes for dedup
    seen_hashes: dict[str, str] = {}  # hash → first filename
    work_items: list[tuple[int, bytes, str]] = []  # (index, content, filename)

    for i, (content, fname) in enumerate(zip(contents, filenames)):
        if not content:
            fr = FileParseResult(
                filename=fname, status='error', error='Empty file content',
                file_size=0,
            )
            audit.file_results.append(fr)
            audit.parse_errors += 1
            if progress_fn:
                progress_fn(i + 1, len(contents), fname, 'error')
            continue

        content_hash = _hash_content(content) if deduplicate else ''

        if deduplicate and content_hash in seen_hashes:
            fr = FileParseResult(
                filename=fname, status='skipped_duplicate',
                content_hash=content_hash, file_size=len(content),
            )
            audit.file_results.append(fr)
            audit.duplicates_skipped += 1
            logger.info("Skipping duplicate file %s (same as %s)", fname, seen_hashes[content_hash])
            if progress_fn:
                progress_fn(i + 1, len(contents), fname, 'skipped_duplicate')
            continue

        if deduplicate:
            seen_hashes[content_hash] = fname
        work_items.append((i, content, fname))

    # Phase 2: Parse files (parallel if >1 file, sequential if 1)
    all_sessions: Dict[str, Any] = {}

    if len(work_items) <= 1 or max_workers <= 1:
        # Sequential parsing
        for idx, content, fname in work_items:
            fr = _parse_single_file(content, fname, parse_fn)
            audit.file_results.append(fr)
            if fr.status == 'ok':
                audit.parsed_ok += 1
                audit.total_sessions += fr.session_count
                _merge_sessions(all_sessions, fr.sessions)
            else:
                audit.parse_errors += 1
            if progress_fn:
                progress_fn(idx + 1, len(contents), fname, fr.status)
    else:
        # Parallel parsing with ThreadPoolExecutor
        futures = {}
        effective_workers = min(max_workers, len(work_items))
        with ThreadPoolExecutor(max_workers=effective_workers) as executor:
            for idx, content, fname in work_items:
                future = executor.submit(_parse_single_file, content, fname, parse_fn)
                futures[future] = (idx, fname)

            for future in as_completed(futures):
                idx, fname = futures[future]
                try:
                    fr = future.result()
                except Exception as exc:
                    fr = FileParseResult(
                        filename=fname, status='error',
                        error=f'Executor error: {exc}',
                    )
                audit.file_results.append(fr)
                if fr.status == 'ok':
                    audit.parsed_ok += 1
                    audit.total_sessions += fr.session_count
                    _merge_sessions(all_sessions, fr.sessions)
                else:
                    audit.parse_errors += 1
                if progress_fn:
                    progress_fn(idx + 1, len(contents), fname, fr.status)

    # Sort file_results by original order
    audit.file_results.sort(key=lambda r: filenames.index(r.filename) if r.filename in filenames else 999)
    audit.elapsed_ms = int((time.monotonic() - t0) * 1000)

    return all_sessions, audit


def _parse_single_file(
    content: bytes,
    fname: str,
    parse_fn: Callable[[bytes, str], Dict[str, Any]],
) -> FileParseResult:
    """Parse a single file with fault isolation (try/except wrapper)."""
    t0 = time.monotonic()
    try:
        result = parse_fn(content, fname)
        elapsed_ms = int((time.monotonic() - t0) * 1000)

        if '_error' in result:
            return FileParseResult(
                filename=fname, status='error',
                error=result['_error'], elapsed_ms=elapsed_ms,
                file_size=len(content),
            )

        session_count = len(result)
        return FileParseResult(
            filename=fname, status='ok',
            sessions=result, session_count=session_count,
            elapsed_ms=elapsed_ms, file_size=len(content),
        )
    except Exception as exc:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.error("Parse failed for %s: %s", fname, exc, exc_info=True)
        return FileParseResult(
            filename=fname, status='error',
            error=str(exc), elapsed_ms=elapsed_ms,
            file_size=len(content),
        )


def _merge_sessions(target: Dict[str, Any], source: Dict[str, Any]) -> None:
    """Merge sessions from source into target, handling duplicates."""
    for sname, sdata in source.items():
        if sname not in target:
            target[sname] = sdata
        else:
            # Merge sources/targets/lookups from duplicate definitions
            for k in ('sources', 'targets', 'lookups'):
                existing = target[sname].get(k, [])
                for v in sdata.get(k, []):
                    if v not in existing:
                        existing.append(v)
                target[sname][k] = existing
            # Keep the workflow/step if not yet assigned
            if not target[sname].get('workflow') and sdata.get('workflow'):
                target[sname]['workflow'] = sdata['workflow']
                target[sname]['step'] = sdata.get('step', 0)
