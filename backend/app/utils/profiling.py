"""Performance profiling — nested timing context manager for waterfall visualization.

Usage:
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
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class TimingNode:
    """A node in the timing tree."""
    name: str
    start_ms: float = 0.0
    elapsed_ms: float = 0.0
    children: list[TimingNode] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        result: dict[str, Any] = {
            'name': self.name,
            'elapsed_ms': round(self.elapsed_ms, 1),
        }
        if self.children:
            result['children'] = [c.to_dict() for c in self.children]
        if self.metadata:
            result['metadata'] = self.metadata
        return result


class PerfTimer:
    """Nested performance timer that builds a waterfall tree."""

    def __init__(self, name: str):
        self._root = TimingNode(name=name)
        self._stack: list[TimingNode] = [self._root]
        self._t0 = 0.0

    def __enter__(self) -> PerfTimer:
        self._t0 = time.monotonic()
        self._root.start_ms = self._t0 * 1000
        return self

    def __exit__(self, *args) -> None:
        self._root.elapsed_ms = (time.monotonic() - self._t0) * 1000
        logger.info("perf: %s completed in %.0fms", self._root.name, self._root.elapsed_ms)

    @contextmanager
    def child(self, name: str, **metadata):
        """Create a child timing span."""
        node = TimingNode(name=name, metadata=metadata)
        t0 = time.monotonic()
        node.start_ms = t0 * 1000
        parent = self._stack[-1]
        parent.children.append(node)
        self._stack.append(node)
        try:
            yield node
        finally:
            node.elapsed_ms = (time.monotonic() - t0) * 1000
            self._stack.pop()

    def add_metadata(self, key: str, value: Any) -> None:
        """Add metadata to the current timing span."""
        self._stack[-1].metadata[key] = value

    def to_dict(self) -> dict:
        """Return the full timing tree as a dict."""
        return self._root.to_dict()

    @property
    def elapsed_ms(self) -> float:
        return self._root.elapsed_ms
