"""Stripped pipeline models — only what's needed for tier map parsing."""

from app.models.processor import CamelModel, Connection, ControllerService, ProcessGroup, Processor
from app.platform.capabilities import PlatformCapabilities  # noqa: F401


class Warning(CamelModel):
    """A diagnostic warning emitted during parsing or analysis."""

    severity: str  # "critical", "warning", "info"
    message: str
    source: str = ""


class ParameterEntry(CamelModel):
    """A single parameter within a NiFi Parameter Context."""

    key: str
    value: str = ""
    sensitive: bool = False
    inferred_type: str = "string"
    databricks_variable: str = ""


class ParameterContext(CamelModel):
    """A NiFi Parameter Context."""

    name: str
    parameters: list[ParameterEntry] = []


class ParseResult(CamelModel):
    """Normalized output from any ETL parser."""

    platform: str
    version: str = ""
    processors: list[Processor] = []
    connections: list[Connection] = []
    process_groups: list[ProcessGroup] = []
    controller_services: list[ControllerService] = []
    parameter_contexts: list[ParameterContext] = []
    metadata: dict = {}
    warnings: list[Warning] = []
    capabilities: PlatformCapabilities | None = None
    sessions: list[dict] = []
    workflows: list[dict] = []
