/**
 * Tier Map types -- core data structures from the parse engine output.
 * Produced by POST /api/tier-map/analyze and stored in the Upload model.
 */

/** An ETL session (Informatica workflow session or NiFi process group). */
export interface TierSession {
  /** Short internal ID, e.g. "S1", "S2". */
  id: string;
  /** Execution step ordinal from the XML. */
  step: number;
  /** Short display name (usually the mapping name). */
  name: string;
  /** Full qualified XML session name (Folder.Workflow.Session.Mapping). */
  full: string;
  /** Computed dependency tier (1 = no upstream deps, higher = deeper in the chain). */
  tier: number;
  /** Number of transformations within this session. */
  transforms: number;
  /** Number of external read (source) connections. */
  extReads: number;
  /** Number of lookup transformations. */
  lookupCount: number;
  /** True if this session is on the critical dependency path. */
  critical: boolean;
  /** Source table names read by this session. */
  sources?: string[];
  /** Target table names written by this session. */
  targets?: string[];
  /** Lookup table names used by this session. */
  lookups?: string[];
  /** Raw (unstripped) source table names from the XML. */
  raw_sources?: string[];
  /** Raw (unstripped) target table names from the XML. */
  raw_targets?: string[];
  /** Raw (unstripped) lookup table names from the XML. */
  raw_lookups?: string[];
  /** Workflow name. */
  workflow?: string;
  /** Folder name. */
  folder?: string;
  /** Mapping name. */
  mapping?: string;
  /** Named connections used by this session. */
  connections_used?: Array<{ connection_name: string; connection_type?: string; source_instance?: string; target_instance?: string }>;
  /** Deep-parsed mapping detail (instances, connectors, fields). */
  mapping_detail?: Record<string, unknown>;
  /** Code profile metrics for this session. */
  code_profile?: Record<string, unknown>;
  /** Embedded code blocks (SQL, Java, stored procedures). */
  embedded_code?: Array<Record<string, unknown>>;
  /** Function usage records. */
  function_usage?: Array<Record<string, unknown>>;
  /** Config reference identifier. */
  config_reference?: string;
  /** Scheduler metadata. */
  scheduler?: { name?: string };
  /** Total lines of code. */
  total_loc?: number;
  /** Total function invocations. */
  total_functions_used?: number;
  /** Distinct function count. */
  distinct_functions_used?: number;
  /** Whether session contains embedded SQL (0 or 1). */
  has_embedded_sql?: number;
  /** Whether session contains embedded Java (0 or 1). */
  has_embedded_java?: number;
  /** Whether session uses stored procedures (0 or 1). */
  has_stored_procedure?: number;
  /** Core intent classification. */
  core_intent?: string;
}

/** A database table referenced by one or more sessions. */
export interface TierTable {
  /** Short internal ID, e.g. "T_0", "T_1". */
  id: string;
  /** Uppercase table name as found in the XML. */
  name: string;
  /** Dependency classification: conflict (multi-writer), chain (dependency), independent, or source. */
  type: 'conflict' | 'chain' | 'independent' | 'source';
  /** Half-tier placement (0.5 for source tables, 1.5, 2.5, etc.). */
  tier: number;
  /** Number of sessions that write to this table (>1 = write conflict). */
  conflictWriters: number;
  /** Number of sessions that read from this table. */
  readers: number;
  /** Number of sessions using this table via lookup transforms. */
  lookupUsers: number;
}

/**
 * A directed connection between a session and a table (or vice versa).
 * Direction convention: write_conflict/write_clean: S->T; read_after_write: T->S; chain: bidirectional.
 */
export interface TierConn {
  /** Source node ID (session or table). */
  from: string;
  /** Target node ID (session or table). */
  to: string;
  /** Connection type indicating the dependency relationship. */
  type: 'write_conflict' | 'write_clean' | 'read_after_write' | 'lookup_stale' | 'chain' | 'source_read';
}

/** Complete tier map analysis result. Returned by POST /api/tier-map/analyze and stored in Upload model. */
export interface TierMapResult {
  /** All parsed ETL sessions. */
  sessions: TierSession[];
  /** All referenced database tables. */
  tables: TierTable[];
  /** All session-table dependency connections. */
  connections: TierConn[];
  /** Aggregate statistics computed during tier assignment. */
  stats: {
    session_count: number;
    write_conflicts: number;
    dep_chains: number;
    staleness_risks: number;
    source_tables: number;
    max_tier: number;
  };
  /** Parser warnings (e.g. unresolved references, skipped elements). */
  warnings: string[];
  /** Named connection profiles parsed from the XML (dbtype, connection string, etc.). */
  connection_profiles?: Array<{ name: string; type?: string; connection_string?: string; database?: string }>;
}

// ── Constellation Map types ──────────────────────────────────────────────

/** A single session point in the 2D constellation scatter plot. */
export interface ConstellationPoint {
  /** Session identifier. */
  session_id: string;
  /** X coordinate, normalized to [0,1]. */
  x: number;
  /** Y coordinate, normalized to [0,1]. */
  y: number;
  /** Chunk/cluster this session belongs to. */
  chunk_id: string;
  /** Session's dependency tier. */
  tier: number;
  /** Whether this session is on the critical path. */
  critical: boolean;
  /** Display name. */
  name: string;
}

/** A cluster/chunk in the constellation view grouping related sessions. */
export interface ConstellationChunk {
  /** Chunk identifier, e.g. "chunk_0". */
  id: string;
  /** Auto-generated or user label for this cluster. */
  label: string;
  /** Session IDs in this chunk. */
  session_ids: string[];
  /** Table names referenced by sessions in this chunk. */
  table_names: string[];
  /** Number of sessions. */
  session_count: number;
  /** Number of tables. */
  table_count: number;
  /** [min_tier, max_tier] range of sessions in this chunk. */
  tier_range: [number, number];
  /** Tables that act as pivots connecting sessions. */
  pivot_tables: string[];
  /** Number of write conflicts within this chunk. */
  conflict_count: number;
  /** Number of dependency chains within this chunk. */
  chain_count: number;
  /** Number of critical-path sessions in this chunk. */
  critical_count: number;
  /** Hex color for rendering. */
  color: string;
  /** Highest-reference-count table (table_gravity algorithm only). */
  anchor_table?: string | null;
  /** Reference count of the anchor table (table_gravity algorithm only). */
  anchor_ref_count?: number;
}

/** Edge between two constellation chunks representing cross-cluster dependencies. */
export interface CrossChunkEdge {
  /** Source chunk ID. */
  from_chunk: string;
  /** Target chunk ID. */
  to_chunk: string;
  /** Number of cross-chunk connections. */
  count: number;
}

/** Entry in the table reference ranking (table_gravity algorithm). */
export interface TableReferenceEntry {
  /** Table name. */
  table: string;
  /** Total reference count across all sessions. */
  ref_count: number;
  /** Percentage of total references. */
  pct: number;
}

/** Full constellation clustering result. Returned by POST /api/tier-map/constellation. */
export interface ConstellationResult {
  /** Clustering algorithm used (e.g. "louvain", "table_gravity"). */
  algorithm?: string;
  /** Clusters of sessions. */
  chunks: ConstellationChunk[];
  /** 2D scatter points for all sessions. */
  points: ConstellationPoint[];
  /** Inter-cluster edges. */
  cross_chunk_edges: CrossChunkEdge[];
  /** Aggregate clustering statistics. */
  stats: {
    total_sessions: number;
    total_chunks: number;
    largest_chunk: number;
    smallest_chunk: number;
    orphan_sessions: number;
    cross_chunk_edge_count: number;
  };
  /** Global table ranking by reference count (table_gravity algorithm only). */
  table_reference_ranking?: TableReferenceEntry[];
}

/** Metadata for a clustering algorithm. Returned by GET /api/tier-map/algorithms. */
export interface AlgorithmInfo {
  /** Human-readable algorithm name. */
  name: string;
  /** Short description of the algorithm's approach. */
  desc: string;
}

/** Valid clustering algorithm identifiers accepted by the constellation endpoint. */
export type AlgorithmKey = 'louvain' | 'tier' | 'components' | 'label_prop' | 'greedy_mod' | 'process_group' | 'table_gravity' | 'gradient_scale';

/** Combined response from the constellation analysis endpoint. */
export interface ConstellationResponse {
  /** Tier map data (sessions, tables, connections). */
  tier_data: TierMapResult;
  /** Constellation clustering result. */
  constellation: ConstellationResult;
}
