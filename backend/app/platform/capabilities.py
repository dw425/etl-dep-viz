"""PlatformCapabilities -- feature flags that gate analyzers and generators.

Each parse engine sets a ``PlatformCapabilities`` instance on the
``ParseResult`` it returns.  Downstream components (vector engines,
constellation clustering, notebook generators, validators) inspect these
flags to decide which platform-specific logic to activate.

This decouples the analysis layer from platform knowledge: a new platform
only needs to declare its capabilities and the existing analyzers will
automatically include or skip themselves based on the flags.
"""

from pydantic import BaseModel


class PlatformCapabilities(BaseModel):
    """Declares what features a given ETL platform supports.

    Analyzers register with ``requires_capability=<attr_name>``; they only
    run when ``ParseResult.capabilities.<attr_name>`` is ``True``.

    Example -- Informatica::

        PlatformCapabilities(
            has_expression_language=True,
            expression_language_name="IEL",
            has_sessions=True,
            has_cdc=True,
            has_mdm=True,
            has_scd_patterns=True,
        )

    Example -- NiFi::

        PlatformCapabilities(
            has_expression_language=True,
            expression_language_name="NEL",
            has_process_groups=True,
            has_controller_services=True,
            has_streaming=True,
        )
    """

    # ── Expression Language ───────────────────────────────────────────────
    has_expression_language: bool = False
    expression_language_name: str = ""       # "NEL" (NiFi) | "IEL" (Informatica) | "JEXL" | ""

    # ── Platform-Specific Features ────────────────────────────────────────
    has_sessions: bool = False               # Informatica Sessions / workflow execution units
    has_cdc: bool = False                    # Change Data Capture support
    has_mdm: bool = False                    # Master Data Management patterns
    has_streaming: bool = False              # Real-time / micro-batch streaming
    has_process_groups: bool = False         # Hierarchical grouping (NiFi PGs, Informatica Folders)
    has_controller_services: bool = False    # Shared services / connection pools
    has_scd_patterns: bool = False           # Slowly Changing Dimension transforms

    # ── Generation Flags ──────────────────────────────────────────────────
    yaml_only: bool = False                  # True for manifest-only platforms (no custom Python generation)
