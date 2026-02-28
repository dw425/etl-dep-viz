# ETL Dependency Visualizer — Remaining Work

> **Repo**: `dw425/etl-dep-viz` | **Branch**: `main`
> **Last commit**: `e21294f` — Wave 2: Constellation Vectors (V1-V11) + 6-Layer Progressive Disclosure
> **Date**: 2026-02-28

---

## What's Done (Wave 2 Commit)

### Backend (22 new files, ~3,800 lines)
- 11 vector engines (V1-V11) in `backend/app/engines/vectors/`
- Feature extractor, orchestrator (3-phase execution), drill-through engine, centrality metrics
- Infrastructure graph builder (`engines/infrastructure.py`)
- Semantic toggle engine (`engines/semantic.py`)
- ActiveTag SQLAlchemy model (`models/tags.py`)
- 3 new routers: `vectors.py` (4 endpoints), `layers.py` (6 endpoints), `active_tags.py` (4 endpoints)

### Frontend (26 new files, ~5,700 lines)
- 6 navigation components: `NavigationProvider`, `useNavigation`, `LayerContainer`, `Breadcrumb`, `ContextBanner`, `GlobalSearch`
- 7 layer views: L1 Enterprise, L1A Infrastructure, L2 Domain, L3 Workflow, L4 Session Blueprint, L5 Mapping (placeholder), L6 Object Detail (partial)
- 8 vector views: ComplexityOverlay, WavePlanView, UMAPView, WaveSimulator, ConcentrationView, VectorControlPanel, ConsensusRadar, DrillThroughPanel
- ExportManager, SemanticToggle, TagBadge, TagContextMenu
- Types: `types/vectors.ts` (252 lines of interfaces)
- API: 12 new functions in `client.ts`

### Integration
- `DependencyApp.tsx` expanded: 7 → 15 view modes, 3 right-panel toggles, NavigationProvider wired
- `main.py`: 3 new routers registered (vectors, layers, active_tags)
- `pyproject.toml`: numpy/scipy/scikit-learn/pandas added; umap-learn/hdbscan as optional

---

## What Remains

### 1. Database Schema — `vector_results_json` Column

**Priority: HIGH** | **Effort: Small**

The `Upload` model in `backend/app/models/database.py` only has `tier_data_json` and `constellation_json`. Vector analysis results are computed on-the-fly but never persisted.

**TODO:**
- [ ] Add `vector_results_json = Column(Text, nullable=True)` to the `Upload` model
- [ ] Update `vectors.py` router to store results after analysis: `upload.vector_results_json = json.dumps(results)`
- [ ] Update `GET /api/vectors/{upload_id}` to return cached results if available
- [ ] Handle schema migration (add column to existing SQLite DBs)

**Why it matters:** Without persistence, navigating away and coming back loses all vector analysis — forces re-computation every time.

---

### 2. L5 Mapping Pipeline — Full Implementation

**Priority: HIGH** | **Effort: Large**

`frontend/src/layers/L5_MappingPipeline.tsx` is currently a placeholder (~75 lines, mock diagram). The backend endpoint `/api/layers/L5/{session_id}/{mapping_id}` returns a stub message.

**TODO:**
- [ ] **Backend**: Extend XML parsers to extract per-mapping data:
  - Transform port definitions (input/output columns)
  - Expression code per transform
  - Column-level mappings (source field → target field)
  - Lookup table side branches with join keys
- [ ] **Backend**: Update `layers.py` L5 endpoint to return real mapping data
- [ ] **Frontend**: Build vertical transform pipeline diagram showing:
  - Source → Transform chain → Target flow
  - Port details on each transform node
  - Column Lineage Mode toggle (trace individual columns through transforms)
  - Expression Viewer in right panel when a transform is selected
  - Transform type filter checkboxes
- [ ] **Frontend**: Wire drill-down from L5 transform → L6 expression detail

**Depends on:** Extended XML parsing — this is the biggest gap. Current parsers extract session-level data but not individual transform/port/expression detail.

---

### 3. L6 Object Detail — Complete All Sub-views

**Priority: MEDIUM** | **Effort: Medium**

`L6_ObjectDetail.tsx` currently implements Table Detail (6A) but is missing Transform Detail (6B) and Expression Detail (6C).

**TODO:**
- [ ] **6B Transform Detail**: Input/output port listing, connected transforms upstream/downstream, expression code block, data type annotations
- [ ] **6C Expression Detail**: Original expression, PySpark equivalent, SQL equivalent, source lineage trace, migration notes/warnings
- [ ] Both depend on extended XML parsing data (same as L5)

---

### 4. Install & Verify Dependencies

**Priority: HIGH** | **Effort: Small**

The vector engines import numpy/scipy/scikit-learn with try/except guards, but the actual packages haven't been installed and tested in the etl-dep-viz environment.

**TODO:**
- [ ] `cd backend && pip install -e ".[full]"` (installs numpy, scipy, scikit-learn, pandas, umap-learn, hdbscan)
- [ ] Verify all 11 vector modules import cleanly: `python -c "from app.engines.vectors import orchestrator"`
- [ ] Test with a real Informatica XML upload:
  - Upload → parse → get tier_data
  - `POST /api/vectors/analyze?phase=1` → verify V1, V4, V11 complete
  - `POST /api/vectors/analyze?phase=2` → verify V2, V3, V9, V10 complete
  - `POST /api/vectors/analyze?phase=3` → verify V5, V6, V7, V8 complete

---

### 5. Test Infrastructure

**Priority: HIGH** | **Effort: Medium**

The repo has zero test files — no `tests/` directory, no test runner configuration.

**TODO:**
- [ ] Create `backend/tests/` directory
- [ ] Add `pytest` + `httpx` to dev dependencies in `pyproject.toml`
- [ ] **Unit tests** for vector engines:
  - `test_feature_extractor.py` — synthetic tier_data → verify SessionFeatures extraction
  - `test_v1_community.py` — small graph → verify community assignments + modularity
  - `test_v4_topological.py` — DAG with known SCCs → verify wave plan correctness
  - `test_v11_complexity.py` — sessions with known metrics → verify scoring + bucket assignment
  - `test_orchestrator.py` — end-to-end phase 1/2/3 pipeline
  - `test_drill_through.py` — filter by complexity + community → verify filtered results
- [ ] **API integration tests**:
  - `test_vectors_api.py` — upload fixture → hit all 4 vector endpoints
  - `test_layers_api.py` — upload fixture → hit L1-L6 endpoints
  - `test_active_tags_api.py` — CRUD cycle on tags
- [ ] **Frontend tests** (optional, if test runner added):
  - Component render tests for vector views
  - Navigation state machine tests (drill down/up/home)

---

### 6. End-to-End Data Flow Verification

**Priority: HIGH** | **Effort: Medium**

The full pipeline hasn't been tested end-to-end with real data.

**TODO:**
- [ ] Upload small Informatica XML (~10 sessions) → verify:
  - Parse → tier_data rendered in TierDiagram
  - "Run Vectors" → all 11 vectors complete in <10s
  - Switch to Complexity view → sessions colored by bucket
  - Switch to Waves view → migration waves rendered
  - Switch to Layers view → L1 supernodes appear
  - Drill L1 → L2 → L3 → L4 → breadcrumb back to L1
- [ ] Upload medium NiFi XML (~100 processors) → verify:
  - Vectors complete in <30s
  - UMAP scatter renders with auto-clusters
  - WaveSimulator "What-If" cascade animates
  - Consensus radar shows agreement/disagreement
- [ ] Upload large fixture (~1000 sessions) → verify:
  - No JavaScript memory issues
  - Canvas rendering performance acceptable
  - Drill-through filtering responsive

---

### 7. Vector Results Caching & Performance

**Priority: MEDIUM** | **Effort: Medium**

**TODO:**
- [ ] Phase-level caching: if Phase 1 is cached, skip re-computation when user requests Phase 2
- [ ] Progress reporting: vector analysis can take 10-30s for large datasets — add SSE streaming progress events (like the existing constellation stream endpoint)
- [ ] Consider Web Worker for frontend-heavy views (UMAP scatter with 15K points)

---

### 8. Frontend Polish (Phase 8 Items)

**Priority: LOW** | **Effort: Medium**

**TODO:**
- [ ] **Transition animations**: CSS transform scale + fade between layer transitions (currently instant cut)
- [ ] **Loading states**: Spinner/skeleton while vector analysis runs, especially for Phase 2/3 which are slower
- [ ] **Responsive layout**: Test and fix layouts at 1280px, 1440px, 1920px breakpoints
- [ ] **Dark theme refinement**: Some vector views may have contrast issues — audit all new components
- [ ] **Keyboard shortcuts**: Arrow keys for layer navigation, Escape to drill up
- [ ] **Error boundaries**: Wrap each vector view in error boundary so one failure doesn't crash the app
- [ ] **Empty states**: Better messaging when vectors haven't been run yet (currently some views show blank)

---

### 9. Export Capabilities

**Priority: LOW** | **Effort: Medium**

`ExportManager.tsx` exists but the actual export functions are stubs.

**TODO:**
- [ ] Wave plan → Excel export (wave assignments, session lists, hours estimates per wave)
- [ ] Complexity distribution → PDF/JSON report
- [ ] Per-layer exports:
  - L1: Environment summary JSON
  - L2: Domain migration plan CSV
  - L3: Wave worksheet
  - L4: Session conversion spec
- [ ] Backend export endpoints (or generate entirely client-side with libraries like `xlsx`/`jspdf`)

---

### 10. Semantic Layer Integration

**Priority: LOW** | **Effort: Small**

`SemanticToggle.tsx` exists but isn't wired to actual data.

**TODO:**
- [ ] Backend: `POST /api/semantic/config` — upload business glossary (JSON mapping technical → business names)
- [ ] Backend: `GET /api/semantic/translate` — translate session/table/domain names
- [ ] Frontend: Wire toggle state through NavigationProvider so all layers respect the mode
- [ ] Frontend: Replace labels in L1-L6 when business mode is active

---

### 11. Active Tags Persistence

**Priority: LOW** | **Effort: Small**

Tags model and API exist but haven't been tested with the frontend.

**TODO:**
- [ ] Verify `TagContextMenu` right-click → `createActiveTag()` → tag appears on node
- [ ] Verify `TagBadge` renders on sessions/tables that have tags
- [ ] Verify tags persist across page reloads (stored in SQLite via ActiveTag model)
- [ ] Test tag filtering in DrillThroughPanel (filter by tag_type)

---

## Dependency Order

```
[1] Install deps & verify imports     ← DO FIRST
[4] Database schema (vector_results)  ← DO SECOND (enables persistence)
[6] E2E data flow verification        ← DO THIRD (validates everything works)
[5] Test infrastructure               ← THEN add guardrails
[7] Caching & performance             ← Polish
[2] L5 Mapping Pipeline               ← Requires extended XML parsing (biggest effort)
[3] L6 Object Detail completion       ← Same XML parsing dependency as L5
[8] Frontend polish                   ← Whenever
[9] Export capabilities               ← Whenever
[10] Semantic layer                   ← Whenever
[11] Active tags testing              ← Whenever
```

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
| Vector views | `frontend/src/components/tiermap/` (8 new files) |
| Shared components | `frontend/src/components/shared/` (3 new files) |
| Type definitions | `frontend/src/types/vectors.ts` |
| API client | `frontend/src/api/client.ts` |
| Main app | `frontend/src/components/tiermap/DependencyApp.tsx` |
| Backend entry | `backend/app/main.py` |
| Dependencies | `backend/pyproject.toml` |
