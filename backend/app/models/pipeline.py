"""Pipeline models -- the unified parse result and supporting types.

``ParseResult`` is the canonical output produced by every parse engine
(Informatica XML, NiFi JSON).  It aggregates processors, connections,
process groups, controller services, parameter contexts, and platform
capabilities into a single structure that downstream analysis (tier
assignment, constellation clustering, vector analysis) consumes.
"""

from app.models.processor import CamelModel, Connection, ControllerService, ProcessGroup, Processor
from app.platform.capabilities import PlatformCapabilities  # noqa: F401


# ── Diagnostic & Metadata Models ──────────────────────────────────────────

class Warning(CamelModel):
    """A diagnostic warning emitted during parsing or analysis.

    Severity levels: ``"critical"``, ``"warning"``, ``"info"``.
    ``source`` identifies which engine or phase produced the warning.
    """

    severity: str  # "critical", "warning", "info"
    message: str
    source: str = ""


class ParameterEntry(CamelModel):
    """A single parameter within a NiFi Parameter Context.

    ``sensitive`` marks secrets that should be masked in exports.
    ``databricks_variable`` holds the suggested Databricks widget name
    for migration code generation.
    """

    key: str
    value: str = ""
    sensitive: bool = False
    inferred_type: str = "string"       # "string", "integer", "boolean", "password"
    databricks_variable: str = ""       # Target variable name for notebook generation


class ParameterContext(CamelModel):
    """A NiFi Parameter Context -- a named collection of key-value parameters.

    Parameter Contexts are scoped to a Process Group and can be referenced
    via ``#{paramName}`` expressions in processor properties.
    """

    name: str
    parameters: list[ParameterEntry] = []


# ── Unified Parse Result ──────────────────────────────────────────────────

class ParseResult(CamelModel):
    """Normalized output from any ETL parser (Informatica or NiFi).

    This is the primary data transfer object between the parse layer and
    the analysis/visualization pipeline.  The ``sessions`` and ``workflows``
    lists contain pre-computed tier-map data when available, while
    ``processors``/``connections`` hold the raw graph for further analysis.
    """

    platform: str                                       # "informatica" or "nifi"
    version: str = ""                                   # Platform version string
    processors: list[Processor] = []                    # All extracted processors
    connections: list[Connection] = []                  # All directed edges
    process_groups: list[ProcessGroup] = []             # Logical groupings
    controller_services: list[ControllerService] = []   # Shared services
    parameter_contexts: list[ParameterContext] = []     # NiFi parameter contexts
    metadata: dict = {}                                 # Parser-specific metadata
    warnings: list[Warning] = []                        # Diagnostic messages
    capabilities: PlatformCapabilities | None = None    # Feature flags for this platform
    sessions: list[dict] = []                           # Pre-computed session dicts for tier map
    workflows: list[dict] = []                          # Workflow groupings (Informatica)
