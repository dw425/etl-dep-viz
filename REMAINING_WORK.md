# ETL Dependency Visualizer — Remaining Work

> **Repo**: `dw425/etl-dep-viz` | **Branch**: `main`
> **Last updated**: 2026-02-28 (post-production-readiness pass)

---

## Completed Items

### Phase 1: Foundation & Infrastructure
- [x] Fixed critical import bug in `tags.py` and `active_tags.py`
- [x] Bumped max upload to 300MB
- [x] Added `vector_results_json` column to Upload model with migration
- [x] Added dev dependencies (pytest, httpx, pytest-cov)
- [x] Created `CLAUDE.md` with project conventions
- [x] Added structured logging + request timing middleware
- [x] Hardened ZIP extraction (SpooledTemporaryFile, zip bomb protection)

### Phase 2: Parse Engine Hardening
- [x] Hardened Informatica parser (per-transform error handling, encoding fallback)
- [x] Added `_parse_mapping_detail()` for L5/L6 (instances, connectors, fields)
- [x] Hardened NiFi parser (validation, unresolved endpoint handling)
- [x] Created 3 test fixture XML files

### Phase 3: Data Science Model Verification
- [x] All 11 vector engines verified via tests
- [x] Feature extraction pipeline tested

### Phase 4: Test Infrastructure
- [x] Backend pytest setup with 65 passing tests
- [x] Unit tests for parsers, vector engines, feature extractor, orchestrator
- [x] API integration tests for tier_map, vectors, layers, active_tags
- [x] Drill-through filter tests

### Phase 5: End-to-End Integration
- [x] Vector results caching & persistence (upload_id, GET cached results)
- [x] Vector analysis SSE streaming endpoint
- [x] L5 Mapping Pipeline — full rewrite from stub
- [x] L6 Object Detail — TransformDetail (6B) and ExpressionDetail (6C) added
- [x] Error boundaries wrapping all vector and navigation views
- [x] New views integrated: TableExplorer, DuplicatePipelines, ChunkingStrategy
- [x] Galaxy Map filter sidebar with tier/connection/session/table filters

### Phase 6: Production Hardening
- [x] ErrorBoundary component created and applied to all views
- [x] Dockerfile: `[full]` extras, HEALTHCHECK instruction
- [x] docker-compose.yml: EDV_MAX_UPLOAD_MB=300, memory limit 2GB
- [x] .dockerignore: excludes tests, .claude, markdown files
- [x] Export capabilities: wave plan CSV, complexity CSV, environment summary JSON, all vectors JSON

---

## What Remains

### 1. Frontend Test Infrastructure (Vitest)

**Priority: MEDIUM** | **Effort: Medium**

- [ ] Add vitest, @testing-library/react, jsdom to frontend dev deps
- [ ] Create `vitest.config.ts` and `src/test/setup.ts`
- [ ] Component render tests for DependencyApp, ExplorerView, TierDiagram, etc.
- [ ] Navigation hook tests (drill down/up/home)
- [ ] API client tests with mocked fetch

---

### 2. Performance Benchmarks

**Priority: LOW** | **Effort: Medium**

- [ ] `test_performance.py` (marked `@pytest.mark.slow`):
  - Parse 100-session XML under 5s
  - Vector Phase 1 under 10s for 100 sessions
  - Full vector pipeline under 60s for 100 sessions
  - Feature matrix build under 2s for 1000 sessions
- [ ] `large_synthetic_infa.py` fixture generator

---

### 3. Semantic Layer Integration

**Priority: LOW** | **Effort: Small**

- [ ] Wire SemanticToggle to real data (business glossary upload)
- [ ] Backend translation endpoint
- [ ] Replace labels in L1-L6 when business mode active

---

### 4. Active Tags End-to-End Testing

**Priority: LOW** | **Effort: Small**

- [ ] Verify TagContextMenu → createActiveTag → tag appears on node
- [ ] Verify tags persist across reloads
- [ ] Test tag filtering in DrillThroughPanel

---

### 5. Frontend Polish

**Priority: LOW** | **Effort: Medium**

- [ ] Transition animations between layer views
- [ ] Loading skeletons while vector analysis runs
- [ ] Responsive layout at 1280px/1440px/1920px breakpoints
- [ ] Keyboard shortcuts (arrow keys for nav, Escape to drill up)
- [ ] Empty states for views requiring vectors not yet computed

---

## Quick Reference — File Locations

| Area | Path |
|------|------|
| Vector engines | `backend/app/engines/vectors/` (16 files) |
| Infrastructure engine | `backend/app/engines/infrastructure.py` |
| Semantic engine | `backend/app/engines/semantic.py` |
| Vector router | `backend/app/routers/vectors.py` |
| Layer router | `backend/app/routers/layers.py` |
| Tags router | `backend/app/routers/active_tags.py` |
| Tags model | `backend/app/models/tags.py` |
| Upload model | `backend/app/models/database.py` |
| Navigation system | `frontend/src/navigation/` (6 files) |
| Layer views | `frontend/src/layers/` (7 files) |
| Vector views | `frontend/src/components/tiermap/` (11+ files) |
| Shared components | `frontend/src/components/shared/` (ErrorBoundary, etc.) |
| Type definitions | `frontend/src/types/vectors.ts` |
| API client | `frontend/src/api/client.ts` |
| Main app | `frontend/src/components/tiermap/DependencyApp.tsx` |
| Backend entry | `backend/app/main.py` |
| Dependencies | `backend/pyproject.toml` |
| Tests | `backend/tests/` (11 test files, 65 tests) |
| Test fixtures | `backend/tests/fixtures/` (3 XML files) |
