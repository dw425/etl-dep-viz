"""Performance profiling -- nested timing context manager for waterfall visualization.

Provides a tree-structured timer that records elapsed time for hierarchical
operations (parse -> tier assignment -> clustering -> vector analysis).  The
resulting tree can be serialized to JSON and sent to the frontend for
waterfall-style performance charts.

Usage::

    with PerfTimer("analyze") as root:
        with root.child("parse"):
            parse_files()
        with root.child("cluster"):
            cluster_data()

    print(root.to_dict())
    # {"name": "analyze", "elapsed_ms": 1500, "children": [
    #     {"name": "parse", "elapsed_ms": 1200, "children": []},
    #     {"name": "cluster", "elapsed_ms": 300, "children": []}
    # ]}

The timer uses ``time.monotonic()`` to avoid issues with system clock
adjustments during long-running operations.
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ── Data Structure ────────────────────────────────────────────────────────

@dataclass
class TimingNode:
    """A single node in the hierarchical timing tree.

    Each node records its own elapsed time and may carry arbitrary metadata
    (e.g. session counts, algorithm names) for diagnostic context.
    """

    name: str
    start_ms: float = 0.0                              # Absolute start time (monotonic ms)
    elapsed_ms: float = 0.0                             # Wall-clock duration in milliseconds
    children: list[TimingNode] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Recursively serialize the node and its children to a JSON-safe dict."""
        result: dict[str, Any] = {
            'name': self.name,
            'elapsed_ms': round(self.elapsed_ms, 1),
        }
        if self.children:
            result['children'] = [c.to_dict() for c in self.children]
        if self.metadata:
            result['metadata'] = self.metadata
        return result


# ── Timer ─────────────────────────────────────────────────────────────────

class PerfTimer:
    """Nested performance timer that builds a waterfall tree.

    Use as a context manager for the root span, then call ``child()`` to
    create nested sub-spans.  The tree is built via an internal stack so
    child spans are automatically parented to the current scope.
    """

    def __init__(self, name: str):
        self._root = TimingNode(name=name)
        self._stack: list[TimingNode] = [self._root]  # Stack tracks the current nesting scope
        self._t0 = 0.0

    def __enter__(self) -> PerfTimer:
        """Start the root timing span."""
        self._t0 = time.monotonic()
        self._root.start_ms = self._t0 * 1000
        return self

    def __exit__(self, *args) -> None:
        """Finalize the root span and log total elapsed time."""
        self._root.elapsed_ms = (time.monotonic() - self._t0) * 1000
        logger.info("perf: %s completed in %.0fms", self._root.name, self._root.elapsed_ms)

    @contextmanager
    def child(self, name: str, **metadata):
        """Create a child timing span nested under the current scope.

        Any key-value ``metadata`` kwargs are attached to the child node for
        diagnostic context (e.g. ``root.child("cluster", algorithm="louvain")``).
        """
        node = TimingNode(name=name, metadata=metadata)
        t0 = time.monotonic()
        node.start_ms = t0 * 1000
        # Attach to the current parent and push onto the stack
        parent = self._stack[-1]
        parent.children.append(node)
        self._stack.append(node)
        try:
            yield node
        finally:
            node.elapsed_ms = (time.monotonic() - t0) * 1000
            self._stack.pop()

    def add_metadata(self, key: str, value: Any) -> None:
        """Attach a metadata key-value pair to the *current* (innermost) span."""
        self._stack[-1].metadata[key] = value

    def to_dict(self) -> dict:
        """Serialize the full timing tree to a JSON-safe dict."""
        return self._root.to_dict()

    @property
    def elapsed_ms(self) -> float:
        """Total elapsed time of the root span in milliseconds."""
        return self._root.elapsed_ms
