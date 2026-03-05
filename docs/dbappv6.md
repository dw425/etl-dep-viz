# Pipeline Analyzer v6 Architecture Reference

Complete reference for all modules, tables, endpoints, and capabilities.

## 1. Architecture Overview

```
User Browser
    |
    v
[Vite React Frontend]  (:3000 dev / static in prod)
    |  REST + SSE
    v
[FastAPI Backend]  (:8000)
    |  SQLAlchemy ORM
    v
[SQLite (local) / PostgreSQL Lakebase (Databricks)]
```

**Tech Stack:**
- Backend: Python 3.13, FastAPI, SQLAlchemy, NetworkX, lxml, UMAP, scikit-learn
- Frontend: React 18, TypeScript, D3.js, Vite, TailwindCSS
- Deployment: Databricks Apps, Docker, 2-worker uvicorn
- AI/RAG: ChromaDB/PgVectorStore, Anthropic/OpenAI/Databricks LLM

**Data Flow:**
```
Upload XML/ZIP  ->  Parse (Infa/NiFi)  ->  Tier Assignment (DAG/BFS)
                ->  Constellation Clustering  ->  Vector Analysis (V1-V16)
                ->  Per-View Table Population  ->  Code Analysis Tables
                ->  AI Indexing (optional)
```

## 2. Backend Modules

### `backend/app/main.py`
- FastAPI app creation, middleware stack, router mounts
- Correlation-ID propagation (`contextvars`)
- Per-route timeout middleware with SSE exemptions
- Request metrics collector (p50/p95/p99 latency)
- Body size limit, GZip compression
- Health/diagnostics endpoints (DB, disk, memory, pool stats)
- Error aggregation ring buffer (200 entries)
- SQLite -> PostgreSQL migration endpoint
- Static file serving for production SPA

### `backend/app/config.py`
- Pydantic settings with `EDV_` env prefix
- Database URL, pool settings, CORS origins
- AI/LLM configuration (provider, model, API key)
- Databricks-specific settings (embedding model, LLM model)
- Upload limits, log buffer size

### `backend/app/models/database.py`
- 50 SQLAlchemy ORM models (see Schema section)
- Engine creation with pool settings and statement_timeout
- Slow query monitoring (>1s threshold)
- Token refresh for Databricks OAuth
- Schema migration system (additive ALTER TABLE)

### `backend/app/engines/infa_engine.py`
- Informatica PowerCenter XML parser
- `validate_xml_schema()` -- pre-validation
- `_parse_file()` -- per-file parsing with iterparse for >20MB files
- `_process_folder()` -- SOURCE/TARGET/MAPPING/SESSION/WORKFLOW extraction
- Code analysis: `_classify_code_language()`, `_extract_functions_from_text()`, `_classify_session_intent()`
- `_enrich_session_code_analysis()` -- post-parse enrichment
- `analyze()` -- main entry point, uses parse_coordinator for parallel parsing

### `backend/app/engines/parse_coordinator.py`
- ThreadPoolExecutor-based parallel file parsing
- SHA-256 deduplication for multi-file uploads
- Fault isolation per file (partial results on error)
- Progress callback support

### `backend/app/engines/data_populator.py`
- `populate_core_tables()` -- sessions, tables, connections, connection profiles
- `populate_normalized_tables()` -- transforms, fields, expressions, workflows, lookups, params, SQL overrides
- `populate_code_analysis_tables()` -- embedded code, function usage, session code profiles
- `populate_view_tables()` -- 10 per-view materialized tables
- `populate_constellation_tables()` -- chunks, points, edges
- `populate_vector_tables()` -- 8+ vector result tables
- `reconstruct_tier_data()` / `reconstruct_vector_results()` -- rebuild from DB
- Tier data cache (TTL: 3600s / 1 hour)

### `backend/app/engines/vectors/`
- 16 analysis vectors organized in 3 phases + extended
- `orchestrator.py` -- 3-phase execution coordinator
- `feature_extractor.py` -- feature matrix builder
- Phase 1 Core: V1 (community detection), V4 (topological SCC/wave plan), V11 (16-dim complexity)
- Phase 2 Advanced: V2 (hierarchical), V3 (UMAP), V9 (wave function), V10 (concentration)
- Phase 3 Ensemble: V5 (affinity), V6 (spectral), V7 (HDBSCAN), V8 (ensemble consensus)
- Extended: V12 (expression complexity), V13 (data flow), V14 (schema drift), V15 (transform centrality), V16 (table gravity)

### `backend/app/engines/` (AI/RAG)
- `embedding_engine.py` -- text embedding (local/API/Databricks)
- `vector_store.py` -- ChromaDB vector storage
- `pg_vector_store.py` -- PostgreSQL vector storage (Databricks)
- `document_generator.py` -- session/table/chain document generation
- `indexing_pipeline.py` -- chunking + embedding + storage pipeline
- `query_engine.py` -- intent classification, hybrid search, RAG chat
- `databricks_llm.py` -- Databricks serving endpoint LLM client
- `databricks_embeddings.py` -- Databricks embedding endpoint client

## 3. Database Schema (50 tables)

### Core Entities (4)
| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `projects` | id, name, description | Top-level project container |
| `uploads` | id, project_id, filename, platform, tier_data_json | Parsed file + results |
| `user_profiles` | user_id, display_name, preferences_json | User profiles |
| `activity_log` | id, user_id, action, target_type | Activity tracking |

### Foundation Records (4)
| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `session_records` | upload_id, session_id, name, tier, transforms, core_intent, total_loc | Normalized sessions |
| `table_records` | upload_id, table_id, name, type, tier | Normalized tables |
| `connection_records` | upload_id, from_id, to_id, conn_type | Dependency edges |
| `connection_profiles` | upload_id, name, dbtype, connection_string | DB connection metadata |

### Code Analysis Tables (3) -- NEW in v6
| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `embedded_code_records` | upload_id, session_name, code_type, code_subtype, code_text, line_count | Detected embedded code (SQL, Java, Python, etc.) |
| `function_usage_records` | upload_id, session_name, function_name, function_category, call_count | Function calls from expressions and SQL |
| `session_code_profiles` | upload_id, session_name, has_sql, has_java, total_loc, core_intent | Per-session code metrics summary |

### Normalized Parse Tables (7)
| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `transform_records` | upload_id, session_name, transform_name, transform_type | Transform instances |
| `field_mapping_records` | upload_id, session_name, from_field, to_field | Field-level mappings |
| `expression_records` | upload_id, session_name, expression_text, expression_type | Informatica expressions |
| `workflow_records` | upload_id, workflow_name, session_count | Workflow metadata |
| `lookup_config_records` | upload_id, session_name, lookup_table, lookup_condition | Lookup configurations |
| `parameter_records` | upload_id, parameter_name, parameter_type | Session parameters |
| `sql_override_records` | upload_id, session_name, sql_text, referenced_tables_json | SQL overrides |

### Per-View Materialized Tables (28)
TierLayout, GalaxyNodes, ExplorerDetail, WriteConflicts, ReadChains, ExecOrder, MatrixCells, TableProfiles, DuplicateGroups, DuplicateMembers, ConstellationChunks, ConstellationPoints, ConstellationEdges, ComplexityScores, WaveAssignments, UmapCoords, Communities, WaveFunction, ConcentrationGroups, ConcentrationMembers, Ensemble, HierarchicalLineage, AffinityPropagation, SpectralClustering, HdbscanDensity, ExpressionComplexity, DataFlow, SchemaDrift, TransformCentrality, TableGravity

### AI/RAG Table (1)
| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `document_embeddings` | upload_id, doc_type, content, embedding | Vector embeddings for RAG |

## 4. API Endpoints (89 total)

### Health & Admin (8)
- `GET /api/health` -- DB, disk, memory, pool stats, library versions
- `GET /api/health/metrics` -- p50/p95/p99 latency, throughput, LLM usage
- `GET /api/health/slow-queries` -- SQL >1s threshold
- `GET /api/health/logs` -- Ring buffer log entries
- `GET /api/health/errors` -- Aggregated error events
- `POST /api/health/report-error` -- Frontend error reporting
- `POST /api/admin/migrate-sqlite` -- SQLite to PostgreSQL migration
- `GET /api/admin/migrate-status` -- Migration progress

### Tier Map (11)
- `POST /api/tier-map/analyze` -- Upload + parse + cluster (SSE stream)
- `POST /api/tier-map/constellation` -- Cluster only
- `POST /api/tier-map/constellation-stream` -- SSE clustering
- `POST /api/tier-map/recluster` -- Re-cluster existing data
- `GET /api/tier-map/algorithms` -- Available algorithms
- `GET /api/tier-map/lab/algorithms` -- Lab algorithm list
- `POST /api/tier-map/lab/run` -- Custom algorithm experiment
- `GET /api/tier-map/uploads` -- List uploads
- `GET /api/tier-map/uploads/{id}` -- Upload metadata
- `DELETE /api/tier-map/uploads/{id}` -- Delete upload (cascade)
- `GET /api/tier-map/uploads/{id}/sessions` -- Session list

### Vectors (10)
- `POST /api/vectors/analyze` -- Full vector analysis
- `POST /api/vectors/analyze-stream` -- SSE vector analysis
- `POST /api/vectors/analyze-selective` -- Selected vectors only
- `POST /api/vectors/analyze-incremental` -- Incremental analysis
- `GET /api/vectors/results/{id}` -- Cached results
- `POST /api/vectors/wave-plan` -- V4 wave plan
- `POST /api/vectors/complexity` -- V11 complexity scores
- `POST /api/vectors/what-if/{session_id}` -- What-if simulation
- `GET /api/vectors/config` -- Vector configuration
- `POST /api/vectors/sweep-resolution` -- Parameter sweep

### Views (26)
- `GET /api/views/{view}?upload_id=X` -- Per-view materialized data
- Views: explorer, conflicts, exec-order, matrix, tables, duplicates, constellation, complexity, waves, umap, simulator, concentration, consensus, hierarchical, affinity, spectral, hdbscan, expression_complexity, data_flow, schema_drift, transform_centrality, table_gravity
- Special: search/code, anomalies, effort_estimate, transpile

### Layers (7)
- `POST /api/layers/L1` through `L6` -- Progressive disclosure
- `POST /api/layers/flow/{session_id}` -- Flow walker

### Lineage (6)
- `POST /api/lineage/graph` -- Full lineage graph
- `POST /api/lineage/trace/forward/{id}` / `backward/{id}` -- Trace
- `POST /api/lineage/table/{name}` -- Table lineage
- `POST /api/lineage/columns/{id}` -- Column-level lineage
- `POST /api/lineage/impact/{id}` -- Impact analysis

### Exports (9), Projects (5), Users (5), Active Tags (5), Chat (7)

## 5. Parse Engines

### Informatica PowerCenter (`infa_engine.py`)
**Elements parsed:**
- `FOLDER` -- namespace container
- `SOURCE` / `TARGET` -- table definitions with DATABASENAME
- `TRANSFORMATION` -- all types including Lookup Procedure, Custom Transformation, Expression, Filter, Router, Aggregator, Joiner, Sorter, Update Strategy
- `MAPPING` -- INSTANCE/CONNECTOR linking transforms
- `SESSION` -- MAPPINGNAME + SESSTRANSFORMATIONINST overrides
- `WORKFLOW` / `WORKLET` -- TASKINSTANCE + WORKFLOWLINK execution order
- `MAPPINGVARIABLE` -- SCD state variables ($$)
- `SCHEDULER` -- execution timing
- `TRANSFORMFIELD` -- field expressions with EXPRESSION attribute
- `TABLEATTRIBUTE` -- SQL overrides, lookup conditions, join conditions

**Code Detection (v6):**
- Languages: SQL, PL/SQL, Java, Python, R, Shell, JavaScript, Informatica Expression
- Classification: keyword pattern matching with confidence scores
- Subtypes: sql_override, pre_sql, post_sql, stored_proc, custom_transform, filter, join_condition, lookup_condition, router_expression

**Function Extraction (v6):**
- 80+ known Informatica functions across 8 categories
- Categories: aggregate, string, date, math, conversion, conditional, lookup, system
- Unknown functions classified as `custom_udf`
- Tracks call count, nesting depth per function

**Core Intent Classification (v6):**
- 9 intent types: load, transform, lookup_enrich, aggregate, filter, route, scd, audit, replicate
- Heuristic based on transform composition, mapping variables, target naming patterns
- Confidence scoring (0-1)

### NiFi (`nifi_tier_engine.py`)
- Flow definition XML, processor groups, connections, controller services
- Processor type mapping to tier assignment

## 6. Vector Engines (V1-V16)

| Vector | Name | Phase | Key Output |
|--------|------|-------|------------|
| V1 | Community Detection | Core | Louvain communities, modularity |
| V2 | Hierarchical Lineage | Advanced | Dendrogram, linkage matrix |
| V3 | Dimensionality Reduction | Advanced | UMAP 2D coordinates |
| V4 | Topological SCC | Core | SCC groups, wave plan, session_ids |
| V5 | Affinity Propagation | Ensemble | Exemplars, clusters |
| V6 | Spectral Clustering | Ensemble | Eigenvalues, assignments |
| V7 | HDBSCAN Density | Ensemble | Core/border/noise points |
| V8 | Ensemble Consensus | Ensemble | Consensus labels, agreement matrix |
| V9 | Wave Function | Advanced | Quantum-inspired simulation |
| V10 | Concentration | Advanced | Table-gravity groups, hub scores |
| V11 | Complexity Analyzer | Core | 16-dimension complexity scores (D1-D16) |
| V12 | Expression Complexity | Extended | Expression nesting, function counts |
| V13 | Data Flow | Extended | Volume estimates, throughput |
| V14 | Schema Drift | Extended | Baseline schema, drift detection |
| V15 | Transform Centrality | Extended | Betweenness, PageRank, degree |
| V16 | Table Gravity | Extended | Table hub detection, gravity scores |

**Orchestration:** 3-phase execution — Core first (V1,V4,V11), then Advanced (V2,V3,V9,V10), then Ensemble (V5-V8,V12-V16). Each phase depends on prior results.

## 7. AI Chat / RAG

**Pipeline:**
1. **Indexing**: `IndexingPipeline` chunks tier_data sessions/tables + vector results into text documents
2. **Embedding**: `EmbeddingEngine` (local/API/Databricks) produces dense vectors
3. **Storage**: ChromaDB (local) or PgVectorStore (Databricks)
4. **Query Classification**: `classify_query()` -- 16 intent types, keyword-based
5. **Hybrid Search**: Vector similarity + entity name augmentation
6. **LLM Generation**: Anthropic/OpenAI/Databricks serving endpoints
7. **Post-processing**: Reference extraction, follow-up suggestions

**LLM Cache:** SHA-256 keyed, 1-hour TTL, auto-eviction at 100 entries.

## 8. Frontend Components (37 views)

**Main app:** `DependencyApp.tsx` -- 24-tab view system with ViewId type

**Navigation:** Breadcrumb, context search, URL state management

**Key views:**
- TierDiagram, GalaxyMapCanvas (WebGL), ConstellationCanvas (D3)
- ExplorerView, ConflictsView, MatrixView, TableExplorer
- WavePlanView, WaveSimulator, UMAPView
- DecisionTreeView (V11), HeatMapView (canvas), ComplexityOverlay
- FlowWalker (session traversal), LineageBuilder (column-level)
- AIChat (RAG), AdminConsole, AlgorithmLab
- ExportManager (Excel, DOT, Mermaid, JIRA, Databricks notebook)

**Layers (L1-L6):** Progressive disclosure from Enterprise overview down to Object detail

## 9. Deployment

### Databricks Apps
- `databricks-app/app.py` -- uvicorn with 2 workers, 300s keep-alive
- `app.yaml` -- Databricks app manifest
- `build.sh` -- npm build + copy to backend/static/
- `Makefile` -- deploy, logs, restart targets
- Lakebase (PostgreSQL) backend with 600s statement_timeout

### Docker
- Two-stage build: Node (frontend) -> Python (backend)
- `docker-compose.yml` for local development

## 10. Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `EDV_DATABASE_URL` | `sqlite:///etl_dep_viz.db` | Database connection |
| `EDV_CORS_ORIGINS` | `["*"]` | CORS allowed origins |
| `EDV_MAX_UPLOAD_MB` | `2048` | Max upload size |
| `EDV_LOG_LEVEL` | `INFO` | Logging level |
| `EDV_LOG_BUFFER_SIZE` | `500` | Ring buffer capacity |
| `EDV_POOL_SIZE` | `10` | SQLAlchemy pool size |
| `EDV_POOL_MAX_OVERFLOW` | `20` | Pool overflow limit |
| `EDV_POOL_TIMEOUT` | `30` | Pool checkout timeout (s) |
| `EDV_POOL_RECYCLE` | `2700` | Connection recycle (s) |
| `EDV_LLM_PROVIDER` | `anthropic` | LLM provider |
| `EDV_LLM_MODEL` | `claude-sonnet-4-20250514` | LLM model |
| `EDV_LLM_API_KEY` | `` | LLM API key |
| `EDV_EMBEDDING_MODE` | `local` | Embedding mode |
| `EDV_EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | Embedding model |
| `EDV_CHROMA_PERSIST_DIR` | `./chroma_db` | ChromaDB storage |
| `EDV_DATABRICKS_APP` | `false` | Databricks mode flag |
| `EDV_DATABRICKS_EMBEDDING_MODEL` | `` | Databricks embedding endpoint |
| `EDV_DATABRICKS_LLM_MODEL` | `` | Databricks LLM endpoint |
| `EDV_WORKERS` | `2` | Uvicorn worker count |

## 11. Known Limitations

- **NiFi parser**: Less comprehensive than Informatica -- no deep code extraction
- **Code detection**: Pattern-based, not a full language parser -- may misclassify complex polyglot blocks
- **Parallel parse**: ThreadPoolExecutor, not ProcessPoolExecutor -- bounded by GIL for CPU-heavy XML parsing
- **Vector analysis**: Some vectors (V3 UMAP, V7 HDBSCAN) require minimum session counts
- **AI Chat**: Requires embedding model; falls back to zero-vectors (keyword-only) without one
- **SQLite**: No concurrent writes -- production should use PostgreSQL
- **Schema migrations**: Additive only (no column drops or type changes in SQLite)
- **Frontend**: Canvas/WebGL views (HeatMap, Galaxy) may lag on >5000 sessions

## 12. v6 Changes Summary

### Bug Fixes
- SSE timeout exemption for long-running streams (parse, constellation, vectors, chat indexing)
- PostgreSQL statement_timeout increased to 600s (was 120s)
- SSE heartbeat every 15s to prevent proxy timeouts
- Chat async blocking fixed with `asyncio.to_thread` wrapping
- Multi-worker support for Databricks (default 2)
- Tier data cache TTL increased to 1 hour

### New Tables
- `EmbeddedCodeRecord` -- detected embedded code per session
- `FunctionUsageRecord` -- function calls from expressions/SQL
- `SessionCodeProfile` -- per-session code metrics summary

### SessionRecord Expansion
- `total_loc`, `total_functions_used`, `distinct_functions_used`
- `has_embedded_sql`, `has_embedded_java`, `has_stored_procedure`
- `core_intent` -- load/transform/aggregate/etc.

### Parse Engine Enhancement
- Code language classification (SQL, PL/SQL, Java, Python, R, Shell, JS)
- Function extraction with 80+ known Informatica function catalog
- Core intent classification (9 intent types)
- LOC counting for all embedded code blocks
