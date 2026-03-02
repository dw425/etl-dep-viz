# ETL Dependency Visualizer — Complete Application Documentation

> **Generated**: 2026-03-02 | **Version**: 2.0.0 | **Stack**: FastAPI + React 18 + TypeScript + D3.js + SQLite

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Flow Pipeline](#2-data-flow-pipeline)
3. [Backend — Python / FastAPI](#3-backend--python--fastapi)
   - 3.1 [Configuration](#31-configuration)
   - 3.2 [Application Entry Point (main.py)](#32-application-entry-point)
   - 3.3 [Database Models (26 Tables)](#33-database-models)
   - 3.4 [API Routers (~85 Endpoints)](#34-api-routers)
   - 3.5 [Parse Engines](#35-parse-engines)
   - 3.6 [Constellation Engine](#36-constellation-engine)
   - 3.7 [Vector Engines (V1–V11)](#37-vector-engines-v1v11)
   - 3.8 [Data Populator](#38-data-populator)
   - 3.9 [AI/RAG Pipeline](#39-airag-pipeline)
   - 3.10 [Export Engines](#310-export-engines)
   - 3.11 [Utility Modules](#311-utility-modules)
4. [Frontend — React / TypeScript / D3](#4-frontend--react--typescript--d3)
   - 4.1 [Type System](#41-type-system)
   - 4.2 [API Client](#42-api-client)
   - 4.3 [Master Component (DependencyApp)](#43-master-component-dependencyapp)
   - 4.4 [View Components (36 Components)](#44-view-components)
   - 4.5 [Navigation System](#45-navigation-system)
   - 4.6 [Layer System (L1–L6)](#46-layer-system-l1l6)
   - 4.7 [Shared Components](#47-shared-components)
5. [Feature Matrix](#5-feature-matrix)
6. [Key Algorithms](#6-key-algorithms)
7. [Deployment](#7-deployment)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         BROWSER (React 18)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Upload   │ │ 24-View  │ │ 6-Layer  │ │ Vector   │ │ AI Chat  │ │
│  │ + Parse  │ │ Tab Bar  │ │ Drill    │ │ Overlays │ │ (RAG)    │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│       │ SSE        │ REST       │ REST        │ REST       │ REST  │
└───────┼────────────┼────────────┼─────────────┼────────────┼───────┘
        │            │            │             │            │
┌───────▼────────────▼────────────▼─────────────▼────────────▼───────┐
│                      FastAPI (Python 3.13)                         │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────┐  │
│  │ tier_map   │ │ vectors    │ │ layers     │ │ chat / exports │  │
│  │ router     │ │ router     │ │ router     │ │ routers        │  │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └───────┬────────┘  │
│        │              │              │                 │           │
│  ┌─────▼──────┐ ┌─────▼──────┐ ┌────▼─────┐ ┌────────▼────────┐  │
│  │ Infa/NiFi  │ │ V1-V11     │ │ Feature  │ │ Embedding +     │  │
│  │ Parsers    │ │ Engines    │ │ Extractor│ │ ChromaDB + LLM  │  │
│  └─────┬──────┘ └─────┬──────┘ └────┬─────┘ └────────┬────────┘  │
│        │              │              │                 │           │
│  ┌─────▼──────────────▼──────────────▼─────────────────▼────────┐  │
│  │                  SQLite (26 Tables)                           │  │
│  │  uploads │ sessions │ connections │ vw_* views │ vectors     │  │
│  └──────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

**Key Design Principles**:
- **DB-First**: All parsed data persisted to SQLite; reload without re-parsing
- **Materialized Views**: Per-view tables pre-computed for instant rendering
- **SSE Streaming**: Long operations (parse, vector analysis) stream progress events
- **3-Phase Vector**: Core → Advanced → Ensemble with dependency resolution
- **6-Layer Drill**: Enterprise → Domain → Workflow → Session → Mapping → Object

---

## 2. Data Flow Pipeline

```
Step 1: UPLOAD
  User uploads .xml / .zip files
  → _extract_xml_from_uploads() deduplicates via SHA-256
  → Platform auto-detection (Informatica vs NiFi)

Step 2: PARSE
  → infa_engine.analyze() or nifi_tier_engine.analyze()
  → Produces: {sessions[], tables[], connections[], stats, warnings}

Step 3: PERSIST
  → Upload row created in SQLite (tier_data_json blob)
  → populate_core_tables(): SessionRecord, TableRecord, ConnectionRecord
  → populate_view_tables(): 10 materialized Vw* tables

Step 4: CONSTELLATION (optional)
  → build_constellation(): fingerprints → similarity graph → clustering → 2D layout
  → populate_constellation_tables(): chunks, points, cross-chunk edges

Step 5: VECTOR ANALYSIS (optional, 3 phases)
  Phase 1 (Core):   V11 complexity → V1 communities → V4 wave plan
  Phase 2 (Advanced): V2 hierarchical, V3 UMAP, V9 criticality, V10 concentration
  Phase 3 (Ensemble): V5 affinity, V6 spectral, V7 HDBSCAN → V8 consensus
  → populate_vector_tables(): 8 materialized Vw* tables

Step 6: AI INDEXING (optional)
  → DocumentGenerator: 5 doc types (session, table, chain, group, environment)
  → EmbeddingEngine: sentence-transformers → L2-normalized vectors
  → VectorStore: ChromaDB collection with cosine similarity

Step 7: RENDERING
  → Frontend fetches per-view data from materialized tables
  → 24 interactive views + 6-layer progressive drill-down
  → Canvas/SVG/D3 rendering for large datasets (15K+ sessions)
```

---

## 3. Backend — Python / FastAPI

### 3.1 Configuration

**File**: `backend/app/config.py`

| Setting | Default | Description |
|---------|---------|-------------|
| `database_url` | `sqlite:///./etl_dep_viz.db` | SQLAlchemy connection string |
| `max_upload_mb` | 10240 (10 GB) | Maximum upload size |
| `cors_origins` | `["*"]` | CORS allowed origins |
| `vector_timeout_seconds` | 1800 | Vector analysis timeout |
| `parse_timeout_seconds` | 1800 | Parse operation timeout |
| `log_buffer_size` | 2000 | Ring buffer log retention |
| `max_sessions_for_phase3` | 15000 | Skip ensemble if exceeded |
| `embedding_mode` | `"local"` | `"local"` (sentence-transformers) or `"openai"` |
| `embedding_model` | `"all-MiniLM-L6-v2"` | Embedding model name |
| `chroma_persist_dir` | `"./chroma_data"` | ChromaDB persistence path |
| `llm_provider` | `"anthropic"` | LLM provider for AI chat |
| `llm_api_key` | `""` | API key for LLM |
| `llm_model` | `"claude-sonnet-4-20250514"` | LLM model identifier |
| `auto_index_on_parse` | `True` | Auto-index uploads on parse |

All settings use the `EDV_` environment variable prefix (e.g., `EDV_DATABASE_URL`).

---

### 3.2 Application Entry Point

**File**: `backend/app/main.py`

**Middleware Stack** (order matters):
1. **CORS** — Allows cross-origin requests
2. **Request Timing** — Generates correlation IDs, logs `method path → status (Xms)`
3. **Body Size Limit** — Rejects uploads exceeding `max_upload_mb`

**Error Handling**:
- `TimeoutError` → 408
- `ImportError` → 503 (missing optional dependency)
- `ETLMigrationError` → 500 with structured error code/severity
- Global catch → 500 with error type

**Health Endpoints**:
- `GET /api/health` — DB check, disk space, memory, library versions
- `GET /api/health/logs` — Ring buffer log retrieval (last N entries)
- `GET /api/health/errors` — Aggregated error buffer (by type, severity)
- `POST /api/health/report-error` — Frontend error reporting

**Router Mounts** (10 routers, all under `/api`):
tier_map, vectors, layers, active_tags, users, lineage, exports, chat, views, projects

**Static Files**: Serves built frontend from `backend/static/` at root `/`.

---

### 3.3 Database Models

**File**: `backend/app/models/database.py`

**26 tables** organized into 5 groups:

#### Core Tables (4)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `projects` | Top-level container for uploads | id, name, description, user_id |
| `uploads` | Parsed tier data + results (JSON blobs) | id, project_id(FK), filename, tier_data_json, constellation_json, vector_results_json |
| `user_profiles` | Client-generated user profiles | id(UUID), display_name, last_active |
| `activity_log` | Timestamped user actions | user_id, action, target_filename, details_json |

#### Normalized Relational Tables (4)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `session_records` | One row per ETL session | upload_id(FK), session_id, name, tier, step, transforms, ext_reads, critical |
| `table_records` | One row per database table | upload_id(FK), table_id, name, type, tier, conflict_writers |
| `connection_records` | One row per graph edge | upload_id(FK), from_id, to_id, conn_type |
| `connection_profiles` | Connection metadata | upload_id(FK), name, dbtype, dbsubtype, connection_string |

#### Per-View Materialized Tables (10)

| Table | View | Key Data |
|-------|------|----------|
| `vw_tier_layout` | Tier Diagram | session/table positions with x_band, node_type |
| `vw_galaxy_nodes` | Galaxy Map | 2D x,y coords, group_id, size |
| `vw_explorer_detail` | Explorer | Session metrics: transforms, conflict_count, chain_count |
| `vw_write_conflicts` | Conflicts | Tables with writer_count > 1, writer_sessions_json |
| `vw_read_chains` | Conflicts | Writer → reader chain relationships |
| `vw_exec_order` | Exec Order | Topological position, has_conflict/has_chain badges |
| `vw_matrix_cells` | Matrix | Sparse session×table connection type grid |
| `vw_table_profiles` | Tables | Per-table writer/reader/lookup counts |
| `vw_duplicate_groups` | Duplicates | Group by fingerprint match_type + similarity |
| `vw_duplicate_members` | Duplicates | Members within each duplicate group |

#### Constellation Tables (3)

| Table | Purpose |
|-------|---------|
| `vw_constellation_chunks` | Cluster metadata: label, session_count, pivot_tables, color |
| `vw_constellation_points` | Per-session 2D coords + chunk assignment |
| `vw_constellation_edges` | Cross-chunk edge counts |

#### Vector Tables (8)

| Table | Vector | Purpose |
|-------|--------|---------|
| `vw_complexity_scores` | V11 | 8-dimension scores, bucket, hours estimate |
| `vw_wave_assignments` | V4 | Wave number, SCC group assignment |
| `vw_umap_coords` | V3 | 2D UMAP coords at 3 scales |
| `vw_communities` | V1 | Macro/meso/micro community IDs |
| `vw_wave_function` | V9 | Blast radius, criticality score, chain depth |
| `vw_concentration_groups` | V10 | Medoid, core tables, cohesion/coupling |
| `vw_concentration_members` | V10 | Group membership, independence type |
| `vw_ensemble` | V8 | Consensus cluster, per-vector assignments, is_contested |

#### Other Models

**`active_tags`** — User annotations (tag_id, object_id, object_type, tag_type, label, color, note)

**Pydantic Models** (`models/processor.py`, `models/pipeline.py`):
- `Processor` — Single ETL component (name, type, platform, properties)
- `Connection` — Edge between processors (source, destination, relationship)
- `ProcessGroup` — Logical grouping (name, processor names)
- `ControllerService` — Shared service (name, type, properties)
- `ParseResult` — Normalized parser output (platform, processors, connections, warnings)
- `PlatformCapabilities` — Feature flags (has_expression_language, has_sessions, has_cdc, etc.)

---

### 3.4 API Routers

#### tier_map.py — Upload & Parse (~16 endpoints)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/tier-map/analyze` | Parse XML → tier data (synchronous) |
| POST | `/tier-map/constellation` | Parse + cluster (synchronous) |
| POST | `/tier-map/constellation-stream` | Parse + cluster with SSE progress |
| POST | `/tier-map/recluster` | Re-cluster existing data with new algorithm |
| GET | `/tier-map/algorithms` | List 7 clustering algorithms |
| GET | `/tier-map/uploads` | List recent uploads (paginated) |
| GET | `/tier-map/uploads/{id}` | Restore saved upload |
| DELETE | `/tier-map/uploads/{id}` | Delete upload |
| GET | `/tier-map/uploads/{id}/sessions` | Paginated session list with filters |

**Key Logic**:
- ZIP bomb protection: max 10GB uncompressed, 50MB spool threshold
- SHA-256 file deduplication
- Concurrency semaphore (max 2 simultaneous parses)
- Scaled timeout: base + 300s/file + 60s/100MB, capped at 4 hours
- Multi-platform merge with ID remapping

#### vectors.py — Vector Analysis (~11 endpoints)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/vectors/analyze` | Run vector phase (1/2/3) |
| POST | `/vectors/analyze-stream` | Run all phases with SSE streaming |
| GET | `/vectors/results/{id}` | Retrieve cached vectors |
| POST | `/vectors/wave-plan` | Standalone V4 wave plan |
| POST | `/vectors/complexity` | Standalone V11 complexity |
| POST | `/vectors/what-if/{session_id}` | V9 failure cascade simulation |
| GET | `/vectors/config` | Available vectors + phases metadata |
| POST | `/vectors/analyze-selective` | Run specific vectors with auto-deps |
| POST | `/vectors/sweep-resolution` | V1 resolution sensitivity sweep |
| POST | `/vectors/analyze-incremental` | Reuse cache, recompute specific vectors |

**Key Logic**:
- Content-addressed caching via SHA-256(session_ids + connections)
- 3-phase execution with dependency resolution
- SSE streaming: 5% → 33% → 66% → 95% → 100%

#### layers.py — 6-Layer Progressive Disclosure (~8 endpoints)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/layers/L1` | Enterprise constellation (supernodes, env summary) |
| POST | `/layers/L2/{group_id}` | Domain cluster (sessions, sub-clusters) |
| POST | `/layers/L3/{group_id}/{scope_type}/{scope_id}` | Workflow neighborhood |
| POST | `/layers/L4/{session_id}` | Session blueprint (complexity, criticality) |
| POST | `/layers/L5/{session_id}/{mapping_id}` | Mapping pipeline (transforms) |
| POST | `/layers/L6/{object_type}/{object_id}` | Object detail (table/transform) |
| POST | `/layers/flow/{session_id}` | End-to-end flow walker |

**Key Logic**: Auto-runs Phase 1 vectors if not supplied (lazy bootstrap)

#### views.py — Per-View Materialized Endpoints (~13 endpoints)

All `GET /views/{view}?upload_id=X`:
explorer, conflicts, exec-order, matrix, tables, duplicates, constellation, complexity, waves, umap, simulator, concentration, consensus

**Key Logic**: Falls back to JSON blob reconstruction for legacy uploads

#### lineage.py — Graph Traversal (~6 endpoints)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/lineage/graph` | Full lineage graph (nodes + edges) |
| POST | `/lineage/trace/forward/{node_id}` | BFS downstream impact |
| POST | `/lineage/trace/backward/{node_id}` | BFS upstream dependencies |
| POST | `/lineage/table/{table_name}` | Per-table readers/writers/lookups |
| POST | `/lineage/columns/{session_id}` | Column-level field lineage |
| POST | `/lineage/impact/{session_id}` | Forward impact analysis with depth |

#### chat.py — AI RAG Chat (~5 endpoints)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/chat/index/{id}` | Build ChromaDB index from tier_data |
| POST | `/chat/reindex/{id}` | Re-index with vector enrichment |
| POST | `/chat/{id}` | Natural language Q&A |
| POST | `/chat/{id}/search` | Semantic search (no LLM) |
| GET | `/chat/{id}/status` | Check index status |

#### exports.py — Export Formats (~9 endpoints)

Formats: Graphviz DOT, Mermaid, JSON, Excel (openpyxl), JIRA CSV/JSON, Databricks notebook, Snapshot, Merge

#### projects.py — Project CRUD (5 endpoints)

Standard CRUD: list, create, get, update, delete (with CASCADE)

#### users.py — User Profiles (5 endpoints)

Upsert profile, get profile + stats, list uploads, activity log, log activity

#### active_tags.py — Annotations CRUD (5 endpoints)

Create, get by object, update, delete, list with filters

---

### 3.5 Parse Engines

#### Informatica Parser (`infa_engine.py`)

**Input**: PowerCenter XML files (`.xml`)
**Output**: `{sessions, tables, connections, stats, warnings}`

**10-Phase Pipeline**:
1. Validate XML schema (lxml or ElementTree)
2. Parse sessions + resource mappings (SOURCE/TARGET/LOOKUP instances)
3. Build lookup table map from TRANSFORMATION NAME attributes
4. Detect write conflicts (multiple sessions writing same table)
5. Find dependency chains via BFS traversal
6. Assign tiers using topological sort (networkx) or BFS fallback
7. Build session output with metadata (transforms, extReads, lookupCount)
8. Build table output with conflict/chain/source/independent classification
9. Build connection graph (write_conflict, write_clean, read_after_write, lookup_stale, chain)
10. Compute statistics (session_count, write_conflicts, dep_chains, staleness_risks, max_tier)

#### NiFi Parser (`nifi_tier_engine.py`)

**Input**: NiFi flow XML files
**Output**: Same format as Informatica parser

**8-Phase Pipeline**:
1. Parse NiFi XML (processors, connections, process_groups)
2. Build connection DAG with cycle removal
3. Assign tiers via topological sort or BFS
4. Map resource usage (which processors read/write which tables)
5. Classify tables (source, conflict, chain, independent)
6. Generate session output
7. Generate table output
8. Generate connections + stats

**Processor Classification**: Deterministic type-checking against `_SOURCE_TYPES` / `_SINK_TYPES` sets with heuristic prefix fallback.

#### Parse Coordinator (`parse_coordinator.py`)

Coordinates parallel parsing with fault isolation:
- SHA-256 content hashing for duplicate detection
- ThreadPoolExecutor for parallel file parsing
- Idempotent session merging across files
- Returns `ParseAudit` with per-file status/timing

---

### 3.6 Constellation Engine

**File**: `backend/app/engines/constellation_engine.py`

**7 Clustering Algorithms**:

| Algorithm | Key | Method |
|-----------|-----|--------|
| Louvain | `louvain` | Multi-resolution modularity optimization |
| Tier Groups | `tier` | Group by execution tier |
| Connected Components | `components` | Graph connected components |
| Label Propagation | `label_prop` | Fast iterative label spreading |
| Greedy Modularity | `greedy_mod` | Agglomerative modularity maximization |
| Process Group | `process_group` | NiFi/Informatica structural grouping |
| Table Gravity | `table_gravity` | Cluster around shared pivot tables |

**6-Phase Pipeline**:
1. **Fingerprints**: Build per-session table set (sources ∪ targets ∪ lookups)
2. **Similarity Graph**: Inverted index → Jaccard similarity edges (> threshold)
3. **Clustering**: Algorithm-dependent community detection
4. **Layout**: Force-directed 2D coordinates with collision avoidance
5. **Chunk Metadata**: Label, color, pivot tables, conflict/chain counts
6. **Cross-Chunk Edges**: Aggregate session-level connections to chunk level

---

### 3.7 Vector Engines (V1–V11)

**Orchestrator** (`vectors/orchestrator.py`) manages 3-phase execution:

```
Phase 1 (Core):
  V11 → V1 → V4  (V11 first so V4 can use complexity for hour estimates)

Phase 2 (Advanced):
  V2, V3, V9, V10  (all independent, can run in parallel)

Phase 3 (Ensemble):
  V5, V6, V7 → V8  (V8 depends on V1 + V5 + V6 + V7)
```

#### V1 — Community Detection (Multi-Resolution Louvain)
- **Input**: Similarity matrix (Jaccard), adjacency
- **Output**: 3-level assignments (macro/meso/micro), modularity scores, supernode graph
- **Algorithm**: NetworkX Louvain at resolutions 0.3, 1.0, 3.0

#### V2 — Hierarchical Lineage (Ward Clustering)
- **Input**: Feature similarity matrix
- **Output**: Optimal K domains, silhouette score, domain labels from core tables
- **Algorithm**: Ward linkage → silhouette-guided K → fcluster

#### V3 — Dimensionality Reduction (UMAP/PCA)
- **Input**: 16-feature matrix
- **Output**: 2D coords at 3 scales (local/balanced/global), KMeans clusters
- **Algorithm**: UMAP with n_neighbors=10/30/100; PCA fallback

#### V4 — Topological SCC + Wave Plan
- **Input**: Adjacency matrix, complexity scores (optional)
- **Output**: Migration waves with prerequisites, SCC groups, hour estimates
- **Algorithm**: Tarjan SCC → condensation DAG → topological generations
- **Hour Estimates**: Simple 4-8h, Medium 16-40h, Complex 40-80h, Very Complex 80-200h

#### V5 — Affinity Propagation
- **Input**: Similarity matrix
- **Output**: Clusters with exemplar sessions
- **Algorithm**: sklearn AP with median preference; sampling for N≥5000

#### V6 — Spectral Clustering
- **Input**: Similarity matrix
- **Output**: Optimal K clusters, eigengap scores, 2D spectral embedding
- **Algorithm**: Eigengap heuristic → SpectralClustering; sparse for N≥5000

#### V7 — HDBSCAN Density
- **Input**: Feature matrix or UMAP 2D coords
- **Output**: Density clusters + noise sessions
- **Algorithm**: HDBSCAN (or DBSCAN fallback) with adaptive min_cluster_size

#### V8 — Ensemble Consensus
- **Input**: All per-vector cluster assignments (V1, V5, V6, V7)
- **Output**: Consensus partition, per-session confidence score, contested flags
- **Algorithm**: Co-association matrix → Ward linkage (N<8000) or majority voting (N≥8000)

#### V9 — Wave Function (Criticality)
- **Input**: Adjacency matrix, complexity scores
- **Output**: Per-session blast_radius, chain_depth, criticality_score, amplification_factor
- **Algorithm**: Bidirectional BFS with 0.7 decay factor per hop; composite scoring

#### V10 — Concentration (K-Medoids)
- **Input**: Feature matrix, similarity matrix
- **Output**: Gravity groups (medoid, core tables, cohesion/coupling) + independent sessions
- **Algorithm**: Independence detection → KMeans with silhouette-guided K

#### V11 — Complexity Analyzer (8 Dimensions)
- **Input**: Session features
- **Output**: Per-session overall_score (0-100), bucket, 8 dimension breakdowns, hour estimates
- **8 Dimensions**: D1 transform_volume (0.15), D2 diversity (0.10), D3 risk (0.20), D4 io_volume (0.10), D5 lookup_intensity (0.10), D6 coupling (0.15), D7 structural_depth (0.10), D8 external_reads (0.10)
- **Normalization**: Percentile-based (outlier-resistant)
- **Buckets**: Simple (0-30), Medium (31-55), Complex (56-75), Very Complex (76-100)

#### Feature Extractor (`vectors/feature_extractor.py`)

Bridges tier_data → numpy matrices:
- `extract_session_features()` → list of 16-dimension `SessionFeatures`
- `FeatureMatrixBuilder`:
  - `build_dense_matrix()` → (n, 16) normalized
  - `build_adjacency_matrix()` → (n, n) sparse CSR
  - `build_similarity_matrix()` → (n, n) Jaccard/Cosine

---

### 3.8 Data Populator

**File**: `backend/app/engines/data_populator.py`

All functions are **idempotent** (delete-first, then bulk insert):

| Function | Tables Populated |
|----------|-----------------|
| `populate_core_tables()` | SessionRecord, TableRecord, ConnectionRecord, ConnectionProfileRecord |
| `populate_view_tables()` | VwTierLayout, VwGalaxyNodes, VwExplorerDetail, VwWriteConflicts, VwReadChains, VwExecOrder, VwMatrixCells, VwTableProfiles, VwDuplicateGroups, VwDuplicateMembers |
| `populate_constellation_tables()` | VwConstellationChunks, VwConstellationPoints, VwConstellationEdges |
| `populate_vector_tables()` | VwComplexityScores, VwWaveAssignments, VwUmapCoords, VwCommunities, VwWaveFunction, VwConcentrationGroups, VwConcentrationMembers, VwEnsemble |

---

### 3.9 AI/RAG Pipeline

**Components**:

1. **DocumentGenerator** (`document_generator.py`) — Converts tier_data + vectors into 5 doc types:
   - Session profiles, Table profiles, Dependency chains, Group summaries, Environment summary

2. **EmbeddingEngine** (`embedding_engine.py`) — Generates vector embeddings:
   - Local: sentence-transformers (`all-MiniLM-L6-v2`, 384 dims)
   - OpenAI: text-embedding-ada-002 (1536 dims)
   - Fallback: zero-vectors if dependencies missing

3. **VectorStore** (`vector_store.py`) — ChromaDB persistence:
   - Collection per upload (`upload_{id}`)
   - Cosine similarity search
   - Metadata filtering

4. **QueryEngine** (`query_engine.py`) — RAG chat pipeline:
   - `classify_query()` → 10 intents (SESSION_LOOKUP, TABLE_LOOKUP, LINEAGE_TRACE, IMPACT_ANALYSIS, etc.)
   - `HybridSearchEngine.search()` → dense + keyword retrieval
   - `RAGChatEngine.chat()` → context assembly → LLM call → reference extraction

5. **IndexingPipeline** (`indexing_pipeline.py`) — Orchestrates: generate → embed → store

---

### 3.10 Export Engines

| Format | Endpoint | Description |
|--------|----------|-------------|
| Graphviz DOT | `/exports/lineage/dot` | Directed graph visualization |
| Mermaid | `/exports/lineage/mermaid` | Markdown flowchart |
| JSON | `/exports/lineage/json` | Machine-readable graph |
| Excel | `/exports/excel` | Multi-sheet workbook (openpyxl) |
| JIRA CSV | `/exports/jira/csv` | Import-ready migration tickets |
| JIRA JSON | `/exports/jira/json` | API-ready ticket payloads |
| Databricks | `/exports/databricks` | Python notebook scaffold |
| Snapshot | `/exports/snapshot` | Full state bundle (tier + vectors + constellation) |
| HTML | (frontend) | Self-contained interactive report (React+Babel from CDN) |

---

### 3.11 Utility Modules

| Module | Purpose |
|--------|---------|
| `utils/errors.py` | Error hierarchy: ETLMigrationError → ParseError, AnalysisError, etc. 20+ error codes |
| `utils/profiling.py` | Nested PerfTimer with child spans and timing tree export |
| `platform/capabilities.py` | PlatformCapabilities flags (has_cdc, has_mdm, has_streaming, etc.) |
| `vectors/centrality.py` | PageRank + Betweenness + Degree + K-core composite scoring |
| `vectors/drill_through.py` | Cross-dimension filtering (slice by community + complexity + wave) |
| `engines/infrastructure.py` | System topology inference from table names + connection profiles |
| `engines/semantic.py` | Technical → business name translation layer |

---

## 4. Frontend — React / TypeScript / D3

### 4.1 Type System

**File**: `frontend/src/types/tiermap.ts`

| Type | Description |
|------|-------------|
| `TierSession` | ETL session: id, step, name, full, tier, transforms, extReads, lookupCount, critical |
| `TierTable` | Database table: id, name, type, tier, conflictWriters, readers, lookupUsers |
| `TierConn` | Graph edge: from, to, type (6 connection types) |
| `TierMapResult` | Complete parse output: sessions[], tables[], connections[], stats, warnings |
| `ConstellationPoint` | 2D point: session_id, x, y, chunk_id, tier, critical |
| `ConstellationChunk` | Cluster: id, label, session_ids, table_names, pivot_tables, color |
| `ConstellationResult` | Clustering output: chunks, points, cross_chunk_edges, stats |
| `AlgorithmKey` | Union of 8 algorithm identifiers |

**File**: `frontend/src/types/vectors.ts`

| Type | Vector | Description |
|------|--------|-------------|
| `ComplexityResult` | V11 | scores[], bucket_distribution, aggregate_stats, total_hours |
| `WavePlan` | V4 | waves[], scc_groups[], critical_path_length |
| `CommunityResult` | V1 | assignments[], macro/meso/micro communities, supernode_graph |
| `WaveFunctionResult` | V9 | sessions[] with blast_radius + criticality, fluctuation_data |
| `ConcentrationResult` | V10 | gravity_groups[], independent_sessions[], optimal_k |
| `EnsembleResult` | V8 | sessions[] with consensus_cluster + per_vector_assignments |
| `VectorResults` | All | Union container for all 11 vector outputs |
| `DrillFilter` | — | Cross-dimension filter state (bucket, wave, criticality, community, etc.) |
| `WhatIfResult` | V9 | Cascade simulation: blast_radius, affected_sessions, hop_breakdown |
| `ActiveTag` | — | User annotation: tag_id, object_id, tag_type, label, color, note |

---

### 4.2 API Client

**File**: `frontend/src/api/client.ts`

~60+ functions organized by domain:

| Category | Functions |
|----------|-----------|
| **Upload/Parse** | analyzeTierMap, analyzeConstellationStream, recluster, getAlgorithms |
| **Persistence** | listUploads, getUpload, deleteUpload |
| **Vectors** | analyzeVectors, analyzeVectorsStream, getCachedVectors, getWavePlan, getComplexity, whatIfSimulation, sweepResolution, analyzeVectorsIncremental |
| **Layers** | getL1Data, getL2Data, getL3Data, getL4Data, getFlowData |
| **Per-View** | getViewExplorer, getViewConflicts, getViewExecOrder, getViewMatrix, getViewTables, getViewDuplicates, getViewConstellation, getViewComplexity, getViewWaves, getViewUmap, getViewSimulator, getViewConcentration, getViewConsensus |
| **Lineage** | getLineageGraph, traceLineageForward, traceLineageBackward, getTableLineage, getColumnLineage, getImpactAnalysis |
| **Exports** | exportExcel, exportLineageDot, exportLineageMermaid, exportJiraCsv, exportDatabricks, exportSnapshot, mergeUploads |
| **Chat** | chatIndexUpload, chatQuery, chatSearch, chatIndexStatus, chatReindex |
| **Projects** | listProjects, createProject, getProject, updateProject, deleteProject |
| **Users** | upsertUser, getUser, getUserUploads, getUserActivity, logActivity |
| **Health** | getHealthLogs, getHealth, getErrorAggregation, reportError, installGlobalErrorHandler |

**SSE Streaming**: `analyzeConstellationStream` and `analyzeVectorsStream` return `AbortController` and yield `StreamEvent` objects with phases, progress percentages, and ETAs.

---

### 4.3 Master Component (DependencyApp)

**File**: `frontend/src/components/tiermap/DependencyApp.tsx`

**24 Views** (ViewId union type):
- **Core**: tier, galaxy, constellation, explorer, conflicts, order, matrix
- **Harmonize**: tables, duplicates, chunking
- **Vector**: complexity, waves, heatmap, umap, simulator, concentration, consensus
- **Navigation**: layers, infra, flowwalker, lineage, impact, decisiontree, chat, admin

**Key State**:
- `tierData: TierMapResult | null` — parsed data
- `constellation: ConstellationResult | null` — clustering results
- `vectorResults: VectorResults | null` — vector analysis results
- `view: ViewId` — current active tab
- `rightPanel: 'vectors'|'drill'|'export'|null` — sidebar mode
- `theme: 'dark'|'light'` — persisted to localStorage
- `showExportModal: boolean` — HTML export view selector

**Keyboard Shortcuts**:
- `?` — Toggle help overlay
- `Esc` — Close overlay / drill up
- `Alt+←/→` — View history navigation
- `1-6` — Jump to core views
- `F11` — Toggle browser fullscreen

**Auto-Restore**: localStorage keys `edv-last-upload` + `edv-last-view` + URL state sync

---

### 4.4 View Components

**36 components** in `frontend/src/components/tiermap/`:

#### Core Visualizations

| Component | View | Rendering | Purpose |
|-----------|------|-----------|---------|
| `TierDiagram` | tier | SVG + HTML | Tier bands with session/table cards, Bezier connections |
| `GalaxyMapCanvas` | galaxy | SVG + D3 zoom | Orbital layout — sessions on circle, connections as arcs |
| `ConstellationCanvas` | constellation | Canvas 2D + D3 | 15K-session scatter plot with cluster hulls, mini-map |
| `ExplorerView` | explorer | HTML | Session list + detail panel with R/W/L metrics |
| `ConflictsView` | conflicts | HTML | Write-write conflicts + read-after-write chains |
| `ExecOrderView` | order | HTML | Timeline with conflict/chain badges, virtual scrolling |
| `MatrixView` | matrix | CSS Grid | Sparse session×table connection matrix with pagination |
| `WebGLCanvas` | (fallback) | Canvas 2D | High-performance tier diagram for >500 nodes |

#### Data Harmonization

| Component | View | Purpose |
|-----------|------|---------|
| `TableExplorer` | tables | Top 100 tables ranked by reference count |
| `DuplicatePipelines` | duplicates | Exact/near/partial duplicate detection (Jaccard) |
| `ChunkingStrategy` | chunking | Algorithm selection + pre-visualization |

#### Vector Overlays

| Component | View | Purpose |
|-----------|------|---------|
| `ComplexityOverlay` | complexity | V11 bucket distribution + 8-dimension breakdowns |
| `WavePlanView` | waves | V4 migration wave bands with prerequisites |
| `HeatMapView` | heatmap | Canvas grid with composite heat scores |
| `UMAPView` | umap | V3 2D scatter with color modes + rect-select |
| `WaveSimulator` | simulator | V9 "What-If" cascade animation |
| `ConcentrationView` | concentration | V10 gravity groups + independent sessions |
| `ConsensusRadar` | consensus | V8 per-session consensus scores |

#### Navigation & Analysis

| Component | View | Purpose |
|-----------|------|---------|
| `FlowWalker` | flowwalker | End-to-end mapping pipeline with transform detail |
| `DecisionTreeView` | decisiontree | SVG decision tree from mapping connectors |
| `LineageBuilder` | lineage | Column-level field-to-field flow tracing |
| `ImpactAnalysis` | impact | Forward trace with depth grouping |

#### Support

| Component | Purpose |
|-----------|---------|
| `AdminConsole` | Project/upload management, data cleanup |
| `UserProfileView` | Profile, upload history, activity log |
| `AIChat` | RAG chat with index building + references |
| `VectorControlPanel` | Phase selector, run button, timing display |
| `DrillThroughPanel` | Multi-dimension filter sidebar |
| `ExportManager` | JSON/CSV export for waves, complexity, etc. |
| `ExportHTMLModal` | View selector modal for HTML export |
| `AlgorithmPicker` | 7 clustering algorithms with compare mode |
| `ChunkSelector` | Constellation sidebar with virtual scrolling |
| `ChunkSummary` | Selected chunk stats bar |
| `ParseAuditDashboard` | Per-file parse results + timing |
| `SessionComparison` | Dual-overlay radar chart |
| `VectorProgressDashboard` | Per-vector timing waterfall |

---

### 4.5 Navigation System

**Files**: `frontend/src/navigation/`

| File | Purpose |
|------|---------|
| `useNavigation.ts` | Stack-based layer navigation hook (drillDown, drillUp, jumpTo) |
| `NavigationProvider.tsx` | Context provider for tier/vector state + navigation |
| `useUrlState.ts` | Deep linking (view, upload, layer, session in URL) |
| `Breadcrumb.tsx` | Clickable layer trail (L1 › L2 › L3 ...) |
| `ContextBanner.tsx` | Per-layer summary strip (sessions, groups, hours) |
| `GlobalSearch.tsx` | Type-grouped text search (sessions, tables, workflows) |
| `GlobalSearchOverlay.tsx` | Ctrl+K fuzzy search modal |
| `LayerContainer.tsx` | Suspense-wrapped layer router (lazy-loads L1–L6) |

---

### 4.6 Layer System (L1–L6)

**Progressive Disclosure Model**:

```
L1 Enterprise Constellation     → macro supernodes (V1 communities)
  └─ L2 Domain Cluster          → single community, meso sub-clusters
       └─ L3 Workflow Neighborhood → sessions in workflow/sub-cluster
            └─ L4 Session Blueprint → single session detail
                 └─ L5 Mapping Pipeline → transform pipeline
                      └─ L6 Object Detail → table/field metadata
```

| Layer | File | Data Source | Drill Action |
|-------|------|-------------|-------------|
| L1 | `L1_EnterpriseConstellation.tsx` | V1 supernodes + V11 + V4 | Click supernode → L2 |
| L1A | `L1A_InfrastructureTopology.tsx` | Connection profiles + inference | Click system → detail |
| L2 | `L2_DomainCluster.tsx` | getL2Data API | Click sub-cluster → L3 |
| L3 | `L3_WorkflowNeighborhood.tsx` | getL3Data API | Click session → L4 |
| L4 | `L4_SessionBlueprint.tsx` | getL4Data API | Click transform → L5 |
| L5 | `L5_MappingPipeline.tsx` | getFlowData API | Click field → L6 |
| L6 | `L6_ObjectDetail.tsx` | L6 API | Terminal level |

---

### 4.7 Shared Components

**Files**: `frontend/src/components/shared/`

| Component | Purpose |
|-----------|---------|
| `ErrorBoundary` | React error boundary with "Try Again" recovery |
| `TagBadge` | Colored pill badge for active tags |
| `TagContextMenu` | Right-click tag creation (7 types + custom) |
| `ExpressionViewer` | Informatica expression syntax highlighter (67 functions) |
| `SqlViewer` | Collapsible SQL viewer with copy + line numbers |
| `TierFilterSidebar` | Reusable tier/connection type/search filter |
| `SemanticToggle` | Technical ↔ Business terminology switch |
| `HelpOverlay` | Full help modal with shortcuts + view guide |

---

## 5. Feature Matrix

| Feature | Backend | Frontend | Status |
|---------|---------|----------|--------|
| Informatica XML parsing | infa_engine.py | Upload UI | Complete |
| NiFi XML parsing | nifi_tier_engine.py | Upload UI | Complete |
| Multi-file parallel parse | parse_coordinator.py | SSE progress | Complete |
| ZIP support + dedup | tier_map.py | Drag & drop | Complete |
| 7 clustering algorithms | constellation_engine.py | AlgorithmPicker | Complete |
| 11 vector engines (V1-V11) | vectors/ | VectorControlPanel | Complete |
| 3-phase orchestration | orchestrator.py | Phase buttons | Complete |
| 26 DB tables | database.py | Auto-restore | Complete |
| 24 views | routers/ | DependencyApp tabs | Complete |
| 6-layer drill-down | layers.py | L1-L6 components | Complete |
| AI RAG chat | chat.py + engines | AIChat component | Complete |
| Active tags (CRUD) | active_tags.py | TagContextMenu | Complete |
| 7 export formats | exports.py | ExportManager | Complete |
| HTML self-contained report | exportTierMapHTML.ts | ExportHTMLModal | Complete |
| Column-level lineage | lineage.py | LineageBuilder | Complete |
| Impact analysis | lineage.py | ImpactAnalysis | Complete |
| What-If simulation | v9_wave_function.py | WaveSimulator | Complete |
| Infrastructure topology | infrastructure.py | InfrastructureView | Complete |
| Ctrl+K global search | — | GlobalSearchOverlay | Complete |
| Dark/Light theme | — | DependencyApp | Complete |
| Project management | projects.py | AdminConsole | Complete |
| User profiles + activity | users.py | UserProfileView | Complete |
| Health monitoring | main.py | Log viewer | Complete |
| Error aggregation | main.py | Error panel | Complete |

---

## 6. Key Algorithms

| Algorithm | Engine | Time Complexity | Purpose |
|-----------|--------|-----------------|---------|
| Louvain multi-resolution | V1 | O(n log n) | Community detection at 3 scales |
| Tarjan SCC + topo sort | V4 | O(n + m) | Migration wave planning |
| 8-D percentile normalization | V11 | O(n log n) | Complexity scoring |
| Ward hierarchical + silhouette | V2 | O(n²) | Data domain discovery |
| UMAP / PCA | V3 | O(n log n) / O(n²) | 2D projection |
| Affinity Propagation | V5 | O(n² × iters) | Exemplar-based clustering |
| Spectral + eigengap | V6 | O(n³) dense | Eigenvalue-guided clustering |
| HDBSCAN | V7 | O(n log n) | Density-based noise detection |
| Co-association consensus | V8 | O(n²) / O(n) | Multi-vector agreement |
| BFS cascade + decay | V9 | O(n × m) | Failure impact propagation |
| K-Medoids + independence | V10 | O(n²) | Gravity group detection |
| Force-directed layout | Constellation | O(n² × iters) | 2D spatial arrangement |
| Jaccard similarity | Feature | O(n² × k) | Table-based session similarity |
| SHA-256 dedup | Parse | O(n × size) | File deduplication |

---

## 7. Deployment

### Local Development
```bash
# Backend
cd backend && pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend && npm install && npm run dev

# Tests
cd backend && python3 -m pytest -v
cd frontend && npx vitest run
```

### Docker
```bash
docker compose up --build
# Two-stage build: Node (frontend) → Python (backend)
# Serves on port 8000
```

### Environment Variables
```bash
EDV_DATABASE_URL=sqlite:///./etl_dep_viz.db
EDV_LLM_PROVIDER=anthropic
EDV_LLM_API_KEY=sk-...
EDV_LLM_MODEL=claude-sonnet-4-20250514
EDV_EMBEDDING_MODE=local
EDV_MAX_UPLOAD_MB=10240
```

### Remote Access
```bash
# Quick sharing via ngrok
ngrok http 8000

# Or Cloudflare tunnel
cloudflared tunnel --url http://localhost:8000
```
