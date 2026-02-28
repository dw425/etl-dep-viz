"""Core processor and connection models."""

from pydantic import BaseModel, ConfigDict


def _to_camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class CamelModel(BaseModel):
    """Base model that serializes snake_case fields as camelCase."""

    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
    )


class Processor(CamelModel):
    """A single processor/component extracted from an ETL flow definition."""

    name: str
    type: str
    platform: str = "unknown"
    properties: dict = {}
    group: str = "(root)"
    state: str = "RUNNING"
    scheduling: dict | None = None
    resolved_services: dict | None = None  # resolved controller service properties (e.g. JDBC URL from DBCPConnectionPool)


class Connection(CamelModel):
    """A directed edge between two processors in the flow."""

    source_name: str
    destination_name: str
    relationship: str = "success"
    back_pressure_object_threshold: int = 0  # NiFi backPressureObjectThreshold
    back_pressure_data_size_threshold: str = ""  # NiFi backPressureDataSizeThreshold (e.g. "1 GB")


class ProcessGroup(CamelModel):
    """A logical grouping of processors."""

    name: str
    processors: list[str] = []


class ControllerService(CamelModel):
    """A shared service used by one or more processors (e.g. DBCP connection pool)."""

    name: str
    type: str
    properties: dict = {}
