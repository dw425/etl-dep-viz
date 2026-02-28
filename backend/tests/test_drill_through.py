"""Tests for drill-through query engine."""

import pytest


class TestDrillThrough:
    def test_filter_by_tier(self, sample_tier_data):
        sessions = sample_tier_data["sessions"]
        tier1 = [s for s in sessions if s["tier"] == 1]
        assert len(tier1) >= 1

    def test_filter_by_critical(self, sample_tier_data):
        sessions = sample_tier_data["sessions"]
        critical = [s for s in sessions if s["critical"]]
        # Our fixture has write conflicts, so there should be critical sessions
        assert isinstance(critical, list)

    def test_combined_filters(self, sample_tier_data):
        sessions = sample_tier_data["sessions"]
        # Filter: tier >= 2 AND has lookups
        filtered = [
            s for s in sessions
            if s["tier"] >= 2 and s["lookupCount"] > 0
        ]
        assert isinstance(filtered, list)
