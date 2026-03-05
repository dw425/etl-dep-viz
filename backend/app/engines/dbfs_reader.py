"""Dual-mode file reader for local and DBFS paths.

When running as a Databricks App, files can be staged on DBFS via CLI
(``databricks fs cp local.zip dbfs:/landing/...``) and then read
server-side without uploading through the browser.

For local development / non-Databricks deployments, the same functions
transparently fall back to standard file I/O.
"""

import logging
import os

logger = logging.getLogger(__name__)


def is_dbfs_path(path: str) -> bool:
    """Return True if *path* is a DBFS path (``dbfs:/...`` or ``/dbfs/...``)."""
    return path.startswith("dbfs:/") or path.startswith("/dbfs/")


def normalize_dbfs_path(path: str) -> str:
    """Normalize a DBFS path to the ``/prefix`` form expected by the DBFS API.

    ``dbfs:/landing/file.zip``  -> ``/landing/file.zip``
    ``/dbfs/landing/file.zip``  -> ``/landing/file.zip``
    """
    if path.startswith("dbfs:/"):
        return path[len("dbfs:"):]
    if path.startswith("/dbfs/"):
        return path[len("/dbfs"):]
    return path


def get_file_size(path: str) -> int:
    """Return file size in bytes.  Works for both DBFS and local paths."""
    if is_dbfs_path(path):
        from databricks.sdk import WorkspaceClient

        w = WorkspaceClient()
        status = w.dbfs.get_status(normalize_dbfs_path(path))
        return status.file_size or 0
    return os.path.getsize(path)


def read_file(path: str) -> bytes:
    """Read a file from DBFS or local filesystem, returning raw bytes.

    DBFS paths use ``WorkspaceClient().dbfs.download()`` which returns
    a context-managed file-like object.
    """
    if is_dbfs_path(path):
        logger.info("Reading DBFS path: %s", path)
        from databricks.sdk import WorkspaceClient

        w = WorkspaceClient()
        normalized = normalize_dbfs_path(path)
        with w.dbfs.download(normalized) as f:
            data = f.read()
        logger.info("Read %d bytes from DBFS: %s", len(data), path)
        return data

    logger.info("Reading local path: %s", path)
    with open(path, "rb") as fh:
        data = fh.read()
    logger.info("Read %d bytes from local: %s", len(data), path)
    return data
