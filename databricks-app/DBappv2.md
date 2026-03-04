# Databricks App v2 — Major Overhaul Plan

## Current Issues
- Constellation view blank after migration (JSON blobs empty, no fallback to view tables)
- App performance slow on Lakebase (queries not optimized for PostgreSQL)
- Parts of app don't render correctly (missing data reconstruction)
- UI cluttered — too many buttons, poor top bar layout
- Color scheme too dark/black, doesn't match Databricks ecosystem aesthetic
- AI Chat non-functional (requires local ChromaDB + LLM API key)
- Branding doesn't reflect enterprise positioning

---

## 1. Branding & Naming

**Rename** from "ETL Dep Viz" to:

> **Pipeline Analyzer**
> *Powered by Blueprint*

Alternative names (user to pick):
- Data Pipeline Analyzer
- Enterprise Pipeline Visualizer
- Pipeline Intelligence
- ETL Dependency Analyzer

### Files to Change
| File | What | Line |
|------|------|------|
| `frontend/src/components/tiermap/DependencyApp.tsx` | Top-left logo text | ~1087-1092 |
| `frontend/src/components/tiermap/DependencyApp.tsx` | Welcome screen title | ~776-778 |
| `frontend/index.html` | `<title>` tag | 5 |
| `frontend/src/components/tiermap/DependencyApp.tsx` | Add "Powered by Blueprint" subtitle below name | ~1087-1092 |

### Design
Match Lakehouse Optimizer style:
```
┌──────────────────────────────────────────────────┐
│ Pipeline Analyzer    [tabs...]     [controls...] │
│ Powered by Blueprint                             │
└──────────────────────────────────────────────────┘
```
- Name: bold, white, ~16px, condensed font weight 700
- Subtitle: muted text, ~11px, `color: var(--text-muted)`

---

## 2. Color Scheme Overhaul

Replace pure black (`#080C14`) with Lakehouse Optimizer dark blue-grey palette.

### New CSS Variables (`frontend/src/index.css`)
```css
:root {
  --bg:          #1a2332;    /* main background — dark blue-grey */
  --surface:     #243044;    /* cards, panels */
  --surface-alt: #2d3a4e;    /* hover states, active tabs */
  --border:      #3a4a5e;    /* borders */
  --bar:         #151d2b;    /* top bar background */
  --text:        #e2e8f0;    /* primary text */
  --text-muted:  #8899aa;    /* secondary text */
  --text-dim:    #5a6a7a;    /* disabled/dim text */
  --accent-blue: #60a5fa;    /* primary accent */
  /* keep existing semantic colors (write, read, lookup, etc.) */
}
```

### Theme Object in DependencyApp.tsx (~line 729-741)
Update dark mode values:
```typescript
// Dark theme
bg: '#1a2332',
bgCard: '#243044',
bgBar: 'rgba(21,29,43,0.95)',
border: '#3a4a5e',
```

### Additional Style Targets
- Top bar: `background: var(--bar)` with subtle bottom border
- View tab area: slightly lighter than bar
- Stats bar: match bar background
- All `#080C14` / `#0F172A` references → new palette

---

## 3. Top Bar Redesign

### Remove
- **Galaxy Map** tab (from VIEWS array, line 113; rendering block lines 1318-1322; can keep component file)
- **Export** button (lines 1143-1152)
- **HTML** button (lines 1155-1163)
- **Diff** button (lines 1130-1142) — rarely used
- **Logs** button (lines 1164-1172) — move to Admin panel

### Keep (repositioned)
- All view tabs (minus Galaxy Map)
- **Vectors** button
- **Help** button
- **Light/Dark** toggle
- **Profile** button
- **Admin** button (include Logs here)
- **New Upload** button

### New Layout
```
┌─────────────────────────────────────────────────────────────────────┐
│ Pipeline Analyzer  │ Tier │ Constellation │ Explorer │ ...tabs...  │
│ Powered by Blueprint                                               │
├─────────────────────────────────────────────────────────────────────┤
│                                    Vectors │ ? │ ☀ │ 👤 │ ⚙ Admin │
└─────────────────────────────────────────────────────────────────────┘
```

- Row 1: Brand + primary view tabs (scrollable if needed)
- Row 2 right-aligned: utility buttons as icons only (no text labels, use tooltips)
- **New Upload** moves to the landing/project page only (not persistent in top bar)

### Files
- `DependencyApp.tsx` lines 1079-1232 — restructure top bar JSX
- `DependencyApp.tsx` lines 111-137 — remove `galaxy` from VIEWS array

---

## 4. Fix Constellation View (Critical)

### Problem
`constellation_json` is `'{}'` after migration. `get_upload()` returns empty constellation.
The data exists in view tables: `vw_constellation_chunks`, `vw_constellation_points`, `vw_constellation_edges`.

### Solution
Add `reconstruct_constellation()` to `data_populator.py`, similar to existing `reconstruct_tier_data()`.

**New function in `backend/app/engines/data_populator.py`:**
```python
def reconstruct_constellation(db: Session, upload_id: int) -> dict | None:
    """Rebuild constellation from vw_constellation_* tables."""
    chunks = db.query(VwConstellationChunks).filter_by(upload_id=upload_id).all()
    points = db.query(VwConstellationPoints).filter_by(upload_id=upload_id).all()
    edges = db.query(VwConstellationEdges).filter_by(upload_id=upload_id).all()
    if not points:
        return None
    return {
        'chunks': [chunk_to_dict(c) for c in chunks],
        'points': [point_to_dict(p) for p in points],
        'cross_chunk_edges': [edge_to_dict(e) for e in edges],
    }
```

**Update `backend/app/routers/tier_map.py` get_upload() (~line 919):**
```python
constellation = row.get_constellation()
if not constellation or not constellation.get('points'):
    from app.engines.data_populator import reconstruct_constellation
    constellation = reconstruct_constellation(db, upload_id)
if constellation:
    result['constellation'] = constellation
```

### Files
| File | Change |
|------|--------|
| `backend/app/engines/data_populator.py` | Add `reconstruct_constellation()` |
| `backend/app/routers/tier_map.py` | Fallback logic in `get_upload()` |

---

## 5. Fix Vector Results Loading

### Problem
`vector_results_json` is `'{}'` after migration. Vector views (Complexity, Waves, Communities, UMAP, etc.) may be blank or broken.

### Solution
Add `reconstruct_vector_results()` to `data_populator.py` that rebuilds from vector view tables.

**Tables to reconstruct from:**
- `vw_complexity_scores` → `v11_complexity`
- `vw_wave_assignments` + `vw_wave_function` → `v4_wave_plan`
- `vw_communities` → `v1_communities`
- `vw_umap_coords` → `v3_umap`
- `vw_concentration_groups` + `vw_concentration_members` → `v9_concentration`
- `vw_ensemble` → `v8_ensemble`

**Update `get_upload()` with same fallback pattern.**

### Files
| File | Change |
|------|--------|
| `backend/app/engines/data_populator.py` | Add `reconstruct_vector_results()` |
| `backend/app/routers/tier_map.py` | Fallback for vector_results |

---

## 6. Performance Optimization

### Problem
App is slow across the board:
- **Database**: No indexes on foreign keys → full table scans on every view load
- **Compute**: Medium (6GB RAM) is too tight — parsing OOM'd, general sluggishness
- **Connection pool**: Only 5 connections, too small for concurrent users
- **Frontend**: Large datasets (13K sessions, 60K+ connections) cause slow renders
- **Parse workers**: Set to 1 to avoid OOM — should increase with larger compute

### Solution

**A. Resize compute to Large** (`app.yaml` or Databricks UI):
- Current: **Medium** (6GB RAM, 1 vCPU)
- Target: **Large** (12GB RAM, 2 vCPU)
- Allows: `EDV_PARSE_WORKERS=2`, comfortable headroom for concurrent views + parsing
- Change via Databricks UI: App → Settings → Compute Size → Large

**B. Add PostgreSQL indexes** (in `init_db` or startup):
```sql
CREATE INDEX IF NOT EXISTS idx_session_records_upload ON session_records(upload_id);
CREATE INDEX IF NOT EXISTS idx_table_records_upload ON table_records(upload_id);
CREATE INDEX IF NOT EXISTS idx_connection_records_upload ON connection_records(upload_id);
-- Same for all 20+ vw_* tables with upload_id FK
```

**C. Increase connection pool** (`backend/app/models/database.py`):
```python
eng = create_engine(url, pool_size=10, max_overflow=20, pool_pre_ping=True)
```

**D. Add query timeouts** for safety:
```python
eng = create_engine(url, ..., connect_args={"options": "-c statement_timeout=30000"})
```

**E. Increase parse workers** (`app.yaml`):
```yaml
- name: EDV_PARSE_WORKERS
  value: "2"
```

**F. Frontend render optimization**:
- Virtualize large lists (session tables with 13K+ rows) using `react-window` or pagination
- Debounce filter/search inputs that trigger re-renders
- Lazy-load heavy D3 visualizations (only mount when tab is active — already mostly done)

### Files
| File | Change |
|------|--------|
| `backend/app/models/database.py` | Pool size=10, max_overflow=20, indexes at startup, statement timeout |
| `app.yaml` | `EDV_PARSE_WORKERS: "2"` |
| Databricks UI | Resize compute: Medium → Large |
| Frontend components | Virtualize large lists, debounce filters |

---

## 7. AI Chat — Databricks Integration

### Current State
- Uses local ChromaDB for vector index
- Requires external LLM API key (OpenAI/Anthropic)
- Neither works in Databricks App (no ChromaDB, no API keys configured)

### Approach: Databricks Foundation Model API (**Confirmed**)

Use the Databricks Foundation Model serving endpoint for both embeddings and LLM.
Genie was considered but rejected — it's SQL-focused, not suited for graph/dependency analysis.

**Advantages:**
- No external API keys needed
- Runs within Databricks network (fast, secure)
- Service principal auth (already configured)
- Pay-per-token, no provisioned endpoints required
- Models: `databricks-meta-llama-3-1-70b-instruct` (LLM), `databricks-bge-large-en` (embeddings)

**Implementation:**

1. **Config** (`backend/app/config.py`):
   - Auto-detect `databricks_app=True` → set `llm_provider="databricks"`
   - `llm_model: str = "databricks-meta-llama-3-1-70b-instruct"`
   - `embedding_model: str = "databricks-bge-large-en"`

2. **New LLM client** (`backend/app/engines/chat/databricks_llm.py`):
   - `POST {DATABRICKS_HOST}/serving-endpoints/{model}/invocations`
   - Auth: OAuth token via same `_get_oauth_token()` helper used by Lakebase
   - Request format: `{"messages": [{"role": "system", ...}, {"role": "user", ...}]}`
   - Parse streaming or non-streaming response

3. **New embedding client** (`backend/app/engines/chat/databricks_embeddings.py`):
   - `POST {DATABRICKS_HOST}/serving-endpoints/{model}/invocations`
   - Request: `{"input": ["text1", "text2", ...]}`
   - Returns vector arrays for similarity search

4. **Replace ChromaDB** with in-memory FAISS:
   - ChromaDB doesn't install cleanly in App container (heavy deps)
   - FAISS is lightweight, already available via `faiss-cpu` pip package
   - Store index in memory (rebuild on app startup or first chat use)
   - Alternatively: PostgreSQL `pg_trgm` + `tsquery` for keyword search (no embeddings needed)

5. **Update RAG pipeline** (`backend/app/engines/chat/rag_engine.py`):
   - Swap LLM call to use `DatabricksLLM` when provider is `databricks`
   - Swap embedding call to use `DatabricksEmbeddings`
   - Keep existing chunking/indexing logic (tier_data → documents → vectors)

6. **Update chat router** (`backend/app/routers/chat.py`):
   - Index endpoint: build FAISS index instead of ChromaDB collection
   - Query endpoint: search FAISS → retrieve context → call Foundation Model
   - Status endpoint: check if FAISS index exists for upload_id

### Files
| File | Change |
|------|--------|
| `backend/app/config.py` | Add `llm_provider`, `llm_model`, `embedding_model` with Databricks defaults |
| New: `backend/app/engines/chat/databricks_llm.py` | Foundation Model LLM client (OAuth + REST) |
| New: `backend/app/engines/chat/databricks_embeddings.py` | Foundation Model embedding client |
| `backend/app/engines/chat/rag_engine.py` | Use Databricks LLM when `provider=databricks` |
| `backend/app/engines/chat/embedding_engine.py` | Use Databricks embeddings when `provider=databricks` |
| `backend/app/routers/chat.py` | Replace ChromaDB with FAISS index |
| `databricks-app/build.sh` | Add `faiss-cpu` to pip install list |

---

## 8. Rendering Fixes

### Missing data guards
Add null-safe checks throughout frontend for migrated data:

- `DependencyApp.tsx` line 382: `tierData.tables?.map(...)` instead of `tierData.tables.map(...)`
- All view components: guard against undefined arrays
- Constellation view: show "Run Clustering" prompt when no data

### Files
- Multiple `.tsx` components — add `?.` optional chaining where `.map()` is called on potentially-undefined data

---

## Implementation Order

| Phase | Items | Effort |
|-------|-------|--------|
| **Phase 1: Critical Fixes** | #4 Constellation, #5 Vector results, #8 Rendering guards | 1-2 hrs |
| **Phase 2: UI Overhaul** | #1 Branding, #2 Color scheme, #3 Top bar redesign | 2-3 hrs |
| **Phase 3: Performance** | #6 Compute resize (Large), indexes, pool, parse workers, frontend virtualization | 1-2 hrs |
| **Phase 4: AI Chat** | #7 Databricks Foundation Model integration | 2-3 hrs |

### Phase 1 — Do First (unblocks user)
1. Add `reconstruct_constellation()` to data_populator.py
2. Add `reconstruct_vector_results()` to data_populator.py
3. Update `get_upload()` with fallback logic
4. Add null-safety guards in frontend
5. Deploy and verify all views render

### Phase 2 — Visual Overhaul
1. Update CSS variables for dark blue-grey palette
2. Update theme object in DependencyApp.tsx
3. Rename app + add "Powered by Blueprint" subtitle
4. Remove Galaxy Map from VIEWS
5. Remove Export/HTML/Diff/Logs buttons from top bar
6. Restructure top bar layout (compact, icon-only utilities)
7. Build and deploy

### Phase 3 — Performance
1. Resize compute: Medium → Large via Databricks UI
2. Add indexes for all upload_id foreign keys (auto-create at startup)
3. Increase connection pool (10+20) and add statement timeout
4. Bump `EDV_PARSE_WORKERS` to 2
5. Add `react-window` for large session/table lists in frontend
6. Deploy and verify speed improvement

### Phase 4 — AI Chat
1. Add Databricks Foundation Model LLM client
2. Add Databricks embedding engine
3. Replace ChromaDB with FAISS or PG-based search
4. Update chat router to use new providers
5. Test end-to-end chat flow
6. Deploy

---

## Verification

```bash
# After each phase, verify:
# 1. Frontend builds
cd frontend && npx tsc --noEmit && npx vite build

# 2. Backend tests pass
cd backend && python3 -m pytest -v

# 3. Sync + deploy
databricks sync . /Workspace/Users/dan@bpcs.com/etl-dep-viz --profile blueprint_demos
databricks apps deploy etl-dep-viz --source-code-path /Workspace/Users/dan@bpcs.com/etl-dep-viz --profile blueprint_demos

# 4. Manual: Load upload, check all views render, verify performance
```
