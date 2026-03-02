// Tier Map types — exact Lumen_Retro data structure (extended for full depth)

export interface TierSession {
  id: string;          // "S1", "S2", ...
  step: number;
  name: string;        // short display name
  full: string;        // full XML session name
  tier: number;        // 1 | 2 | 3 | ... (no cap)
  transforms: number;
  extReads: number;
  lookupCount: number;
  critical: boolean;
}

export interface TierTable {
  id: string;          // "T_0", "T_1", ...
  name: string;        // uppercase table name
  type: 'conflict' | 'chain' | 'independent' | 'source';
  tier: number;        // 0.5 (source) | 1.5 | 2.5 | ... (no cap)
  conflictWriters: number;
  readers: number;
  lookupUsers: number;
}

export interface TierConn {
  from: string;        // session or table id
  to: string;
  type: 'write_conflict' | 'write_clean' | 'read_after_write' | 'lookup_stale' | 'chain' | 'source_read';
}

export interface TierMapResult {
  sessions: TierSession[];
  tables: TierTable[];
  connections: TierConn[];
  stats: {
    session_count: number;
    write_conflicts: number;
    dep_chains: number;
    staleness_risks: number;
    source_tables: number;
    max_tier: number;
  };
  warnings: string[];
}

// ── Constellation Map types ──────────────────────────────────────────────

export interface ConstellationPoint {
  session_id: string;
  x: number;           // normalized [0,1]
  y: number;           // normalized [0,1]
  chunk_id: string;
  tier: number;
  critical: boolean;
  name: string;
}

export interface ConstellationChunk {
  id: string;          // "chunk_0", "chunk_1", ...
  label: string;
  session_ids: string[];
  table_names: string[];
  session_count: number;
  table_count: number;
  tier_range: [number, number];
  pivot_tables: string[];
  conflict_count: number;
  chain_count: number;
  critical_count: number;
  color: string;
  anchor_table?: string | null;      // table_gravity only
  anchor_ref_count?: number;         // table_gravity only
}

export interface CrossChunkEdge {
  from_chunk: string;
  to_chunk: string;
  count: number;
}

export interface TableReferenceEntry {
  table: string;
  ref_count: number;
  pct: number;
}

export interface ConstellationResult {
  algorithm?: string;
  chunks: ConstellationChunk[];
  points: ConstellationPoint[];
  cross_chunk_edges: CrossChunkEdge[];
  stats: {
    total_sessions: number;
    total_chunks: number;
    largest_chunk: number;
    smallest_chunk: number;
    orphan_sessions: number;
    cross_chunk_edge_count: number;
  };
  table_reference_ranking?: TableReferenceEntry[];  // table_gravity only
}

export interface AlgorithmInfo {
  name: string;
  desc: string;
}

export type AlgorithmKey = 'louvain' | 'tier' | 'components' | 'label_prop' | 'greedy_mod' | 'process_group' | 'table_gravity' | 'gradient_scale';

export interface ConstellationResponse {
  tier_data: TierMapResult;
  constellation: ConstellationResult;
}
