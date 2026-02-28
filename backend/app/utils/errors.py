"""Custom exception classes for the ETL Migration Platform."""


class ETLMigrationError(Exception):
    """Base exception for all platform errors."""


class ParseError(ETLMigrationError):
    """Raised when a file cannot be parsed."""


class UnsupportedFormatError(ParseError):
    """Raised when the file format is not recognized."""


class AnalysisError(ETLMigrationError):
    """Raised when analysis fails."""


class MappingError(ETLMigrationError):
    """Raised when processor mapping fails."""


class GenerationError(ETLMigrationError):
    """Raised when notebook generation fails."""


class ValidationError(ETLMigrationError):
    """Raised when validation fails."""
