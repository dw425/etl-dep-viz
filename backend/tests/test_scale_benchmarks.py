"""Scale benchmark tests — verify parsing works at 100, 500, and 5000 sessions.

These tests validate correctness and capture timing at scale.
"""

import time

import pytest

from tests.fixtures.synthetic_generator import generate_synthetic_xml, generate_synthetic_zip


# ── Synthetic generator sanity ────────────────────────────────────────────────

class TestSyntheticGenerator:
    def test_generates_valid_xml(self):
        xml = generate_synthetic_xml(10, seed=1)
        assert xml.startswith(b'<?xml')
        assert b'<POWERMART>' in xml
        assert b'<SESSION ' in xml

    def test_deterministic_with_seed(self):
        a = generate_synthetic_xml(20, seed=42)
        b = generate_synthetic_xml(20, seed=42)
        assert a == b

    def test_different_seeds_differ(self):
        a = generate_synthetic_xml(20, seed=1)
        b = generate_synthetic_xml(20, seed=2)
        assert a != b

    def test_generates_zip(self):
        zdata = generate_synthetic_zip(50, file_count=3, seed=42)
        import io, zipfile
        with zipfile.ZipFile(io.BytesIO(zdata)) as zf:
            names = zf.namelist()
            assert len(names) == 3
            assert all(n.endswith('.xml') for n in names)

    def test_generates_zip_with_duplicates(self):
        zdata = generate_synthetic_zip(50, file_count=3, seed=42, include_duplicates=True)
        import io, zipfile
        with zipfile.ZipFile(io.BytesIO(zdata)) as zf:
            names = zf.namelist()
            assert len(names) == 4  # 3 + 1 duplicate
            assert 'export_duplicate.xml' in names


# ── Parse correctness at scale ────────────────────────────────────────────────

class TestScaleParsing:
    def test_100_sessions(self):
        """100-session parse — basic scale test."""
        xml = generate_synthetic_xml(100, seed=42)
        from app.engines.infa_engine import analyze

        t0 = time.monotonic()
        result = analyze([xml], ["synthetic_100.xml"])
        elapsed_ms = (time.monotonic() - t0) * 1000

        stats = result['stats']
        assert stats['session_count'] >= 80  # some may merge/dedup
        assert stats['session_count'] <= 120
        assert len(result['tables']) > 0
        assert len(result['connections']) > 0
        assert stats['max_tier'] >= 1
        # Timing: should complete in under 5s
        assert elapsed_ms < 5000, f"100-session parse took {elapsed_ms:.0f}ms"

    def test_500_sessions(self):
        """500-session parse — medium scale test."""
        xml = generate_synthetic_xml(500, seed=42)
        from app.engines.infa_engine import analyze

        t0 = time.monotonic()
        result = analyze([xml], ["synthetic_500.xml"])
        elapsed_ms = (time.monotonic() - t0) * 1000

        stats = result['stats']
        assert stats['session_count'] >= 400
        assert stats['session_count'] <= 550
        assert len(result['tables']) > 10
        assert len(result['connections']) > 10
        assert stats['max_tier'] >= 2
        # Timing: should complete in under 30s
        assert elapsed_ms < 30000, f"500-session parse took {elapsed_ms:.0f}ms"

    def test_multi_file_merge(self):
        """Multi-file parse with merge — verifies session merge across files."""
        xml_a = generate_synthetic_xml(50, seed=10)
        xml_b = generate_synthetic_xml(50, seed=20)
        from app.engines.infa_engine import analyze

        result = analyze(
            [xml_a, xml_b],
            ["file_a.xml", "file_b.xml"],
        )
        stats = result['stats']
        # Sessions with same names get merged, so count may be less than 100
        assert stats['session_count'] >= 40
        assert len(result['tables']) > 0

    def test_progress_callback(self):
        """Verify progress_fn is called correctly during multi-file parse."""
        xml_a = generate_synthetic_xml(20, seed=1)
        xml_b = generate_synthetic_xml(20, seed=2)
        from app.engines.infa_engine import analyze

        progress_calls = []
        def on_progress(current, total, filename, sessions_so_far=0):
            progress_calls.append((current, total, filename, sessions_so_far))

        analyze([xml_a, xml_b], ["a.xml", "b.xml"], progress_fn=on_progress)

        assert len(progress_calls) == 2
        # With parallel parsing, callbacks may arrive in any order
        filenames = sorted(c[2] for c in progress_calls)
        assert filenames == ["a.xml", "b.xml"]
        assert all(c[1] == 2 for c in progress_calls)  # total is always 2

    def test_dependency_chains(self):
        """Verify multi-tier dependency chains are created."""
        xml = generate_synthetic_xml(200, seed=42, chain_depth=5)
        from app.engines.infa_engine import analyze

        result = analyze([xml], ["chain_test.xml"])
        stats = result['stats']
        # With 5 tiers of 40 sessions each, we expect multi-tier output
        assert stats['max_tier'] >= 2
        # Verify connections exist (chains may show as various connection types)
        assert len(result['connections']) >= 1

    def test_write_conflicts(self):
        """Verify write conflicts are detected at scale."""
        xml = generate_synthetic_xml(100, seed=42, write_conflict_pct=0.3)
        from app.engines.infa_engine import analyze

        result = analyze([xml], ["conflict_test.xml"])
        stats = result['stats']
        assert stats['write_conflicts'] >= 1

    def test_lookups_detected(self):
        """Verify lookup relationships are detected at scale."""
        xml = generate_synthetic_xml(100, seed=42, lookup_pct=0.5)
        from app.engines.infa_engine import analyze

        result = analyze([xml], ["lookup_test.xml"])
        stats = result['stats']
        assert stats['staleness_risks'] >= 1


# ── Memory / performance guards ──────────────────────────────────────────────

class TestPerformanceGuards:
    def test_large_xml_size_reasonable(self):
        """Verify generated XML is within expected size range."""
        xml_100 = generate_synthetic_xml(100, seed=42)
        xml_500 = generate_synthetic_xml(500, seed=42)
        xml_5k = generate_synthetic_xml(5000, seed=42)

        # Rough bounds
        assert 30_000 < len(xml_100) < 500_000        # ~50-300KB
        assert 100_000 < len(xml_500) < 2_000_000     # ~200KB-1.5MB
        assert 500_000 < len(xml_5k) < 20_000_000     # ~1-15MB

    def test_empty_input(self):
        """Parser handles empty input gracefully."""
        from app.engines.infa_engine import analyze
        result = analyze([], [])
        assert result['stats']['session_count'] == 0

    def test_single_session(self):
        """Single session parses correctly."""
        xml = generate_synthetic_xml(1, seed=42)
        from app.engines.infa_engine import analyze
        result = analyze([xml], ["single.xml"])
        assert result['stats']['session_count'] >= 1


@pytest.mark.slow
class TestLargeScale:
    """Tests for 5000+ sessions — marked slow, skip with -m 'not slow'."""

    def test_5000_sessions(self):
        """5000-session parse — enterprise scale test."""
        xml = generate_synthetic_xml(5000, seed=42)
        from app.engines.infa_engine import analyze

        t0 = time.monotonic()
        result = analyze([xml], ["synthetic_5000.xml"])
        elapsed_ms = (time.monotonic() - t0) * 1000

        stats = result['stats']
        assert stats['session_count'] >= 4000
        assert stats['session_count'] <= 5500
        assert len(result['tables']) > 50
        assert len(result['connections']) > 50
        assert stats['max_tier'] >= 3
        # Timing: should complete in under 120s
        assert elapsed_ms < 120000, f"5000-session parse took {elapsed_ms:.0f}ms"
