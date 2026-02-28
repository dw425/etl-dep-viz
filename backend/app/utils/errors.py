"""Custom exception classes for the ETL Migration Platform.

Error codes follow the format: CATEGORY_NNN
  PARSE_001 - PARSE_099:     File parsing errors
  ANALYSIS_001 - ANALYSIS_099: Vector/cluster analysis errors
  UPLOAD_001 - UPLOAD_099:    Upload processing errors
  DB_001 - DB_099:            Database errors
  EXPORT_001 - EXPORT_099:    Export/report errors
"""

from enum import Enum
from typing import Any


class ErrorSeverity(str, Enum):
    WARNING = "warning"     # Non-fatal, operation continues
    ERROR = "error"         # Operation failed but app is stable
    CRITICAL = "critical"   # System-level failure


class ErrorCode(str, Enum):
    # Parse errors
    PARSE_001 = "PARSE_001"    # XML syntax error
    PARSE_002 = "PARSE_002"    # Empty file
    PARSE_003 = "PARSE_003"    # Unsupported format
    PARSE_004 = "PARSE_004"    # Encoding error
    PARSE_005 = "PARSE_005"    # Zip extraction failed
    PARSE_006 = "PARSE_006"    # File too large
    PARSE_007 = "PARSE_007"    # Timeout during parse
    PARSE_008 = "PARSE_008"    # No sessions found
    PARSE_009 = "PARSE_009"    # Duplicate file skipped

    # Analysis errors
    ANALYSIS_001 = "ANALYSIS_001"  # Vector computation failed
    ANALYSIS_002 = "ANALYSIS_002"  # Clustering failed
    ANALYSIS_003 = "ANALYSIS_003"  # Feature extraction failed
    ANALYSIS_004 = "ANALYSIS_004"  # Timeout during analysis
    ANALYSIS_005 = "ANALYSIS_005"  # Insufficient data for analysis

    # Upload errors
    UPLOAD_001 = "UPLOAD_001"  # No files provided
    UPLOAD_002 = "UPLOAD_002"  # File size exceeds limit
    UPLOAD_003 = "UPLOAD_003"  # Invalid file type
    UPLOAD_004 = "UPLOAD_004"  # Zip bomb detected

    # Database errors
    DB_001 = "DB_001"          # Upload not found
    DB_002 = "DB_002"          # Migration failed
    DB_003 = "DB_003"          # Persistence failed

    # Export errors
    EXPORT_001 = "EXPORT_001"  # Export format unsupported
    EXPORT_002 = "EXPORT_002"  # Export data missing


class ETLMigrationError(Exception):
    """Base exception for all platform errors."""

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
        return {
            'error': str(self),
            'code': str(self.code) if self.code else None,
            'severity': self.severity.value if isinstance(self.severity, ErrorSeverity) else self.severity,
            'details': self.details,
        }


class ParseError(ETLMigrationError):
    """Raised when a file cannot be parsed."""

    def __init__(self, message: str, code: ErrorCode | str = ErrorCode.PARSE_001, **kwargs):
        super().__init__(message, code=code, **kwargs)


class UnsupportedFormatError(ParseError):
    """Raised when the file format is not recognized."""

    def __init__(self, message: str, **kwargs):
        super().__init__(message, code=ErrorCode.PARSE_003, **kwargs)


class AnalysisError(ETLMigrationError):
    """Raised when analysis fails."""

    def __init__(self, message: str, code: ErrorCode | str = ErrorCode.ANALYSIS_001, **kwargs):
        super().__init__(message, code=code, **kwargs)


class MappingError(ETLMigrationError):
    """Raised when processor mapping fails."""


class GenerationError(ETLMigrationError):
    """Raised when notebook generation fails."""


class ValidationError(ETLMigrationError):
    """Raised when validation fails."""
