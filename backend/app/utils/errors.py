"""Custom exception hierarchy for the ETL Migration Platform.

All domain exceptions inherit from ``ETLMigrationError``, which carries a
structured error code, severity level, and optional details dict.  The
global exception handler in ``main.py`` serializes these fields into the
JSON error response so the frontend can display contextual messages.

Error codes follow the format ``CATEGORY_NNN``:

==============================  ============================================
Range                           Category
==============================  ============================================
``PARSE_001`` - ``PARSE_099``   File parsing errors (XML, JSON, ZIP)
``ANALYSIS_001`` - ``ANALYSIS_099``  Vector/cluster analysis errors
``UPLOAD_001`` - ``UPLOAD_099``  Upload processing errors
``DB_001`` - ``DB_099``          Database errors
``EXPORT_001`` - ``EXPORT_099``  Export/report generation errors
==============================  ============================================
"""

from enum import Enum
from typing import Any


# ── Severity & Code Enums ─────────────────────────────────────────────────

class ErrorSeverity(str, Enum):
    """Tri-level severity for error classification and dashboard filtering."""

    WARNING = "warning"     # Non-fatal, operation continues with degraded output
    ERROR = "error"         # Operation failed but application remains stable
    CRITICAL = "critical"   # System-level failure; may require restart


class ErrorCode(str, Enum):
    """Enumerated error codes for every known failure mode.

    The string value is used in JSON responses and log messages for grep-ability.
    """

    # -- Parse errors --
    PARSE_001 = "PARSE_001"    # XML syntax error
    PARSE_002 = "PARSE_002"    # Empty file
    PARSE_003 = "PARSE_003"    # Unsupported format
    PARSE_004 = "PARSE_004"    # Encoding error (non-UTF-8)
    PARSE_005 = "PARSE_005"    # Zip extraction failed
    PARSE_006 = "PARSE_006"    # File too large (exceeds max_upload_mb)
    PARSE_007 = "PARSE_007"    # Timeout during parse
    PARSE_008 = "PARSE_008"    # No sessions found in file
    PARSE_009 = "PARSE_009"    # Duplicate file skipped (already uploaded)

    # -- Analysis errors --
    ANALYSIS_001 = "ANALYSIS_001"  # Vector computation failed
    ANALYSIS_002 = "ANALYSIS_002"  # Clustering algorithm failed
    ANALYSIS_003 = "ANALYSIS_003"  # Feature extraction failed
    ANALYSIS_004 = "ANALYSIS_004"  # Timeout during analysis
    ANALYSIS_005 = "ANALYSIS_005"  # Insufficient data for analysis (<2 sessions)

    # -- Upload errors --
    UPLOAD_001 = "UPLOAD_001"  # No files provided in request
    UPLOAD_002 = "UPLOAD_002"  # File size exceeds configured limit
    UPLOAD_003 = "UPLOAD_003"  # Invalid file type (not XML/JSON/ZIP)
    UPLOAD_004 = "UPLOAD_004"  # Zip bomb detected (ratio check)

    # -- Database errors --
    DB_001 = "DB_001"          # Upload not found for given ID
    DB_002 = "DB_002"          # Schema migration failed
    DB_003 = "DB_003"          # Data persistence failed (INSERT/UPDATE)

    # -- Export errors --
    EXPORT_001 = "EXPORT_001"  # Requested export format not supported
    EXPORT_002 = "EXPORT_002"  # Required data missing for export


# ── Exception Classes ─────────────────────────────────────────────────────

class ETLMigrationError(Exception):
    """Base exception for all platform errors.

    Carries structured metadata (code, severity, details) that the global
    exception handler in ``main.py`` serializes into the JSON response body.
    """

    def __init__(
        self,
        message: str,
        code: ErrorCode | str | None = None,
        severity: ErrorSeverity = ErrorSeverity.ERROR,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.severity = severity
        self.details = details or {}

    def to_dict(self) -> dict:
        """Serialize to a JSON-safe dict for API responses."""
        return {
            'error': str(self),
            'code': str(self.code) if self.code else None,
            'severity': self.severity.value if isinstance(self.severity, ErrorSeverity) else self.severity,
            'details': self.details,
        }


class ParseError(ETLMigrationError):
    """Raised when a file cannot be parsed (XML syntax, encoding, etc.)."""

    def __init__(self, message: str, code: ErrorCode | str = ErrorCode.PARSE_001, **kwargs):
        super().__init__(message, code=code, **kwargs)


class UnsupportedFormatError(ParseError):
    """Raised when the uploaded file format is not recognized by any parse engine."""

    def __init__(self, message: str, **kwargs):
        super().__init__(message, code=ErrorCode.PARSE_003, **kwargs)


class AnalysisError(ETLMigrationError):
    """Raised when a vector engine or clustering algorithm fails."""

    def __init__(self, message: str, code: ErrorCode | str = ErrorCode.ANALYSIS_001, **kwargs):
        super().__init__(message, code=code, **kwargs)


class MappingError(ETLMigrationError):
    """Raised when processor-to-Databricks mapping fails during notebook generation."""


class GenerationError(ETLMigrationError):
    """Raised when Databricks notebook code generation fails."""


class ValidationError(ETLMigrationError):
    """Raised when input validation fails (e.g. missing required fields)."""
