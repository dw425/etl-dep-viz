# V3 Fix — Per-View Materialized Tables Architecture

## Overview

V3 replaces the JSON-blob-only storage model with **25 per-view materialized database tables**. Each visualization view queries its own dedicated table, populated during parse/analysis. Data persists across browser refreshes via SQLite + localStorage auto-restore.

## Data Model (26 Tables)

### Project Table (1)

| Table | Model | Purpose |
|-------|-------|---------|
| `projects` | Project | Top-level project container grouping uploads and all derived data |

Projects have: `id`, `name`, `description`, `user_id`, `created_at`, `updated_at`.
Uploads have a `project_id` FK (nullable, CASCADE delete).

### Foundation Tables (4)

| Table | Model | Purpose |
|-------|-------|---------|
| `session_records` | SessionRecord | Parsed ETL sessions with tier, step, transforms, etc. |
| `table_records` | TableRecord | Database tables referenced by sessions |
| `connection_records` | ConnectionRecord | Edges between sessions/tables (6 types) |
| `connection_profiles` | ConnectionProfileRecord | DB connection metadata from parsed XML |

**Connection types:** `write_conflict`, `write_clean`, `read_after_write`, `lookup_stale`, `chain`, `source_read`

### Core View Tables (10)

| Table | View(s) | Key Columns |
|-------|---------|-------------|
| `vw_tier_layout` | Tier Diagram | session_id, name, tier, step, is_critical, node_type |
| `vw_galaxy_nodes` | Galaxy Map | node_id, node_type, name, tier, x, y, size, group_id |
| `vw_explorer_detail` | Explorer | session_id, name, tier, step, workflow, transforms, conflict_count, chain_count |
| `vw_write_conflicts` | Conflicts | table_name, writer_count, writer_sessions_json |
| `vw_read_chains` | Conflicts | table_name, writer_sessions_json, reader_sessions_json, chain_length |
| `vw_exec_order` | Exec Order | position, session_id, name, tier, step, has_conflict, has_chain |
| `vw_matrix_cells` | Matrix | session_id, table_id, session_name, table_name, conn_type |
| `vw_table_profiles` | Table Explorer | table_name, type, tier, writer_count, reader_count, lookup_count |
| `vw_duplicate_groups` | Duplicates | group_id, match_type, fingerprint, similarity, member_count |
| `vw_duplicate_members` | Duplicates | group_id, session_id, name, sources_json, targets_json |

### Constellation Tables (3)

| Table | View(s) | Key Columns |
|-------|---------|-------------|
| `vw_constellation_chunks` | Constellation, Chunking | chunk_id, label, algorithm, session_count, pivot_tables_json |
| `vw_constellation_points` | Constellation | session_id, chunk_id, x, y, tier, is_critical |
| `vw_constellation_edges` | Constellation | from_chunk, to_chunk, count |

### Vector Analysis Tables (8)

| Table | View(s) | Vector | Phase |
|-------|---------|--------|-------|
| `vw_complexity_scores` | Complexity, Heat Map | V11 | 1 |
| `vw_wave_assignments` | Waves | V4 | 1 |
| `vw_umap_coords` | UMAP | V3 | 2 |
| `vw_communities` | (cross-ref) | V1 | 1 |
| `vw_wave_function` | Simulator | V9 | 2 |
| `vw_concentration_groups` | Concentration | V10 | 2 |
| `vw_concentration_members` | Concentration | V10 | 2 |
| `vw_ensemble` | Consensus | V8 | 3 |

All tables have `upload_id` FK with CASCADE delete + index on `(upload_id)`.

---

## Data Flow

```
XML Upload → Parse Engine (infa_engine.py)
                ↓
        tier_data JSON blob saved to Upload row (legacy compat)
                ↓
        populate_core_tables()
            → session_records
            → table_records
            → connection_records
            → connection_profiles
                ↓
        populate_view_tables()
            → vw_tier_layout, vw_galaxy_nodes, vw_explorer_detail
            → vw_write_conflicts, vw_read_chains, vw_exec_order
            → vw_matrix_cells, vw_table_profiles
            → vw_duplicate_groups, vw_duplicate_members
                ↓
        populate_constellation_tables()  (during clustering)
            → vw_constellation_chunks, vw_constellation_points, vw_constellation_edges
                ↓
        populate_vector_tables()  (when user runs vector analysis)
            → vw_complexity_scores, vw_wave_assignments, vw_umap_coords
            → vw_communities, vw_wave_function
            → vw_concentration_groups, vw_concentration_members, vw_ensemble
```

---

## Per-View API Endpoints

All endpoints under `/api/views/`, each queries its materialized table:

| Endpoint | Table | Params |
|----------|-------|--------|
| `GET /api/views/explorer` | vw_explorer_detail | upload_id, offset, limit, tier, search |
| `GET /api/views/conflicts` | vw_write_conflicts + vw_read_chains | upload_id |
| `GET /api/views/exec-order` | vw_exec_order | upload_id, offset, limit |
| `GET /api/views/matrix` | vw_matrix_cells | upload_id, page, page_size |
| `GET /api/views/tables` | vw_table_profiles | upload_id, sort, limit |
| `GET /api/views/duplicates` | vw_duplicate_groups + _members | upload_id |
| `GET /api/views/constellation` | vw_constellation_* | upload_id |
| `GET /api/views/complexity` | vw_complexity_scores | upload_id |
| `GET /api/views/waves` | vw_wave_assignments | upload_id |
| `GET /api/views/umap` | vw_umap_coords | upload_id, scale |
| `GET /api/views/simulator` | vw_wave_function | upload_id |
| `GET /api/views/concentration` | vw_concentration_* | upload_id |
| `GET /api/views/consensus` | vw_ensemble | upload_id |

---

## Frontend Auto-Restore Lifecycle

```
Page Load
  ↓
Check URL params (?upload=X&view=Y)
  ↓ (if no URL params)
Check localStorage (edv-last-upload, edv-last-view)
  ↓ (if found)
Call handleLoadUpload(uploadId)
  → GET /api/uploads/{id}
  → Restore tierData, constellation, vectorResults
  → Navigate to saved view
  ↓ (if nothing saved)
Show Dashboard
```

**State persistence points:**
- `setUploadId(id)` → `localStorage.setItem('edv-last-upload', id)`
- `navigateView(v)` → `localStorage.setItem('edv-last-view', v)`
- URL params synced via `useUrlState` hook

---

## Server Stability

- **Parse semaphore:** `asyncio.Semaphore(2)` — max 2 concurrent parses
- **429 response** if semaphore can't be acquired within 10s
- **Parse timeout:** `min(7200, max(base, 60*files + 30*(MB/100)))` seconds
- **Hard cap:** 2 hours maximum parse time

---

## Key Files

| File | Role |
|------|------|
| `backend/app/models/database.py` | All 28 SQLAlchemy models |
| `backend/app/engines/data_populator.py` | Population + reconstruction functions |
| `backend/app/routers/views.py` | 13 per-view API endpoints |
| `backend/app/routers/tier_map.py` | Parse endpoints with population wiring |
| `backend/app/routers/vectors.py` | Vector endpoints with population wiring |
| `frontend/src/components/tiermap/DependencyApp.tsx` | Auto-restore, localStorage, URL state |
| `frontend/src/api/client.ts` | Per-view API functions |
| `frontend/src/components/tiermap/HeatMapView.tsx` | New heat map view |
| `backend/tests/test_data_model.py` | 25 tests for data model |

---

## Population Functions

All in `backend/app/engines/data_populator.py`:

| Function | Called From | What It Does |
|----------|------------|--------------|
| `populate_core_tables(db, upload_id, tier_data, conn_profiles)` | /analyze, /constellation | Inserts sessions, tables, connections, profiles |
| `populate_view_tables(db, upload_id)` | /analyze, /constellation | Derives 10 core-view tables from foundation |
| `populate_constellation_tables(db, upload_id, constellation)` | /constellation, /constellation-stream | Inserts chunks, points, edges |
| `populate_vector_tables(db, upload_id, vector_results)` | /analyze (vectors), /analyze-stream | Inserts all vector view tables |
| `reconstruct_tier_data(db, upload_id)` | Legacy fallback | Rebuilds tier_data dict from normalized tables |

All population functions are **idempotent** — they delete existing rows for the upload_id before inserting.

---

## Test Coverage

`backend/tests/test_data_model.py` — 25 tests:

- **TestPopulateCoreTablesUnit** (4): sessions, tables, connections, profiles
- **TestPopulateViewTables** (7): explorer_detail, write_conflicts, exec_order, matrix_cells, table_profiles, tier_layout, duplicate_groups
- **TestPopulateConstellationTables** (3): chunks, points, edges
- **TestPopulateVectorTables** (2): complexity, waves
- **TestRoundtrip** (1): populate → reconstruct matches original
- **TestIdempotency** (1): populate twice → same row counts
- **TestCascadeDelete** (1): delete Upload → all tables cascade clean
- **TestViewEndpoints** (6): explorer, conflicts, exec_order, tables, 404, getUpload+vector_results
