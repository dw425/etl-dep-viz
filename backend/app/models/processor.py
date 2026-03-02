"""Core processor and connection Pydantic models.

These models represent the platform-agnostic intermediate representation (IR)
produced by both the Informatica and NiFi parse engines.  All models inherit
from ``CamelModel`` so they serialize to camelCase JSON for the React frontend
while keeping Pythonic snake_case attribute access on the backend.
"""

from pydantic import BaseModel, ConfigDict


def _to_camel(s: str) -> str:
    """Convert a snake_case string to camelCase for JSON serialization.

    Example: ``"source_name"`` -> ``"sourceName"``
    """
    parts = s.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class CamelModel(BaseModel):
    """Base Pydantic model that auto-converts snake_case fields to camelCase.

    ``populate_by_name=True`` allows construction with either the Python
    attribute name or the camelCase alias.
    """

    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
    )


# ── Parse IR Models ───────────────────────────────────────────────────────

class Processor(CamelModel):
    """A single processor/component extracted from an ETL flow definition.

    Represents an Informatica Session/Mapping or a NiFi Processor.
    ``resolved_services`` holds controller-service properties (e.g. JDBC URL)
    after service reference resolution.
    """

    name: str
    type: str
    platform: str = "unknown"          # "informatica", "nifi", or "unknown"
    properties: dict = {}              # Raw key-value properties from the definition
    group: str = "(root)"              # Parent process group name
    state: str = "RUNNING"             # NiFi scheduling state
    scheduling: dict | None = None     # NiFi scheduling config (strategy, period, etc.)
    resolved_services: dict | None = None  # Resolved controller service properties


class Connection(CamelModel):
    """A directed edge between two processors in the flow.

    For NiFi flows, ``relationship`` indicates the FlowFile routing
    relationship (e.g. "success", "failure").  Back-pressure thresholds
    are NiFi-specific and default to zero/empty for Informatica.
    """

    source_name: str
    destination_name: str
    relationship: str = "success"
    back_pressure_object_threshold: int = 0    # NiFi queue object count threshold
    back_pressure_data_size_threshold: str = ""  # NiFi queue size threshold (e.g. "1 GB")


class ProcessGroup(CamelModel):
    """A logical grouping of processors (NiFi Process Groups / Informatica Folders)."""

    name: str
    processors: list[str] = []  # Names of child processors in this group


class ControllerService(CamelModel):
    """A shared service used by one or more processors.

    Common examples: DBCP connection pools, Avro schema registries,
    SSL context services.  Properties contain the raw configuration
    key-value pairs from the flow definition.
    """

    name: str
    type: str
    properties: dict = {}
