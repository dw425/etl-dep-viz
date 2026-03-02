// ── Constellation Vector types — analysis results from V1–V11 ──

// ── V11 Complexity ──

/** A single dimension's contribution to a session's overall complexity score. From V11 engine. */
export interface DimensionScore {
  /** Dimension identifier (e.g. "D1_transform_volume", "D3_risk"). */
  name: string;
  /** Unscaled metric value before normalization. */
  raw_value: number;
  /** 0-100 normalized score for cross-dimension comparison. */
  normalized: number;
  /** Relative importance weight applied during scoring. */
  weight: number;
  /** Final contribution: normalized * weight. */
  weighted_score: number;
}

/** Per-session complexity assessment from V11 engine. Used in L4 blueprint and complexity view. */
export interface SessionComplexityScore {
  /** Internal session identifier (e.g. "S1"). */
  session_id: string;
  /** Human-readable session name. */
  name: string;
  /** Weighted aggregate complexity score (0-100). */
  overall_score: number;
  /** Categorical bucket derived from overall_score thresholds. */
  bucket: 'Simple' | 'Medium' | 'Complex' | 'Very Complex';
  /** Per-dimension breakdown (8 dimensions: D1-D8). */
  dimensions: DimensionScore[];
  /** Low-end migration effort estimate in hours. */
  hours_estimate_low: number;
  /** High-end migration effort estimate in hours. */
  hours_estimate_high: number;
  /** Top complexity-contributing factors as human-readable strings. */
  top_drivers: string[];
}

/** Aggregate complexity results from V11 engine across all sessions. */
export interface ComplexityResult {
  /** Per-session complexity scores. */
  scores: SessionComplexityScore[];
  /** Count of sessions per bucket (e.g. {"Simple": 5, "Complex": 2}). */
  bucket_distribution: Record<string, number>;
  /** Summary statistics (mean, median, stddev, etc.). */
  aggregate_stats: Record<string, number>;
  /** Total low-end migration effort in hours across all sessions. */
  total_hours_low: number;
  /** Total high-end migration effort in hours across all sessions. */
  total_hours_high: number;
}

// ── V4 Wave Plan ──

/** Strongly Connected Component group from the dependency DAG. From V4 engine. */
export interface SCCGroup {
  /** Unique integer identifier for this SCC group. */
  group_id: number;
  /** Sessions belonging to this SCC (flat list of IDs like "S1", "S2"). */
  session_ids: string[];
  /** True if this SCC contains a circular dependency cycle. */
  is_cycle: boolean;
  /** Number of edges internal to this group. */
  internal_edge_count: number;
}

/** A migration wave — a group of sessions that can be migrated in parallel. From V4 engine. */
export interface MigrationWave {
  /** 1-based wave ordinal (Wave 1 runs first). */
  wave_number: number;
  /** Sessions assigned to this wave (flat list of IDs). */
  session_ids: string[];
  /** SCC group IDs included in this wave (integer references to SCCGroup.group_id). */
  scc_groups: number[];
  /** Wave numbers that must complete before this wave can start. */
  prerequisite_waves: number[];
  /** Low-end effort estimate for this wave in hours. */
  estimated_hours_low: number;
  /** High-end effort estimate for this wave in hours. */
  estimated_hours_high: number;
  /** Number of sessions in this wave. */
  session_count: number;
}

/** Complete migration wave plan with SCC analysis. Top-level V4 result. */
export interface WavePlan {
  /** Ordered list of migration waves (Wave 1 first). */
  waves: MigrationWave[];
  /** All SCC groups found in the dependency graph (dicts with session_ids). */
  scc_groups: SCCGroup[];
  /** Longest dependency chain through the wave plan. */
  critical_path_length: number;
  /** Total sessions covered by the plan. */
  total_sessions: number;
  /** Sessions involved in at least one dependency cycle. */
  cyclic_session_count: number;
  /** Sessions with no circular dependencies. */
  acyclic_session_count: number;
}

// ── V1 Community ──

/** Multi-resolution community assignment for a single session. From V1 engine. */
export interface CommunityAssignment {
  /** Session identifier (e.g. "S1"). */
  session_id: string;
  /** Macro-level community ID (coarsest grouping). */
  macro: number;
  /** Meso-level community ID (intermediate grouping). */
  meso: number;
  /** Micro-level community ID (finest grouping). */
  micro: number;
}

/** Coarsened graph where each supernode represents a macro community. Used in L1 visualization. */
export interface SupernodeGraph {
  /** Community-level supernodes. */
  supernodes: Supernode[];
  /** Edges between supernodes weighted by cross-community connections. */
  superedges: Superedge[];
}

/** A macro-community node in the supernode graph. Rendered as an orb in L1. */
export interface Supernode {
  /** Community identifier (e.g. "community_0"). */
  id: string;
  /** Number of sessions in this community. */
  session_count: number;
  /** Session IDs belonging to this community. */
  session_ids: string[];
  /** Average V11 complexity score (0-100), if computed. */
  avg_complexity?: number;
  /** Complexity bucket distribution within this community. */
  bucket_distribution?: Record<string, number>;
}

/** Edge between two supernodes representing inter-community dependencies. */
export interface Superedge {
  /** Source supernode ID. */
  from: string;
  /** Target supernode ID. */
  to: string;
  /** Normalized edge weight (0-1). */
  weight: number;
  /** Raw count of cross-community session pairs. */
  pair_count: number;
}

/** Full V1 community detection result. Key: "v1_communities" in VectorResults. */
export interface CommunityResult {
  /** Per-session multi-resolution community assignments. */
  assignments: CommunityAssignment[];
  /** Macro communities: community ID -> list of session IDs. */
  macro_communities: Record<string, string[]>;
  /** Meso communities: community ID -> list of session IDs. */
  meso_communities: Record<string, string[]>;
  /** Micro communities: community ID -> list of session IDs. */
  micro_communities: Record<string, string[]>;
  /** Modularity scores per resolution level (higher = better separation). */
  modularity: Record<string, number>;
  /** Coarsened graph for L1 enterprise constellation view. */
  supernode_graph: SupernodeGraph;
}

// ── V9 Wave Function ──

/** Criticality assessment for a single session. From V9 wave function engine. */
export interface SessionCriticality {
  /** Session identifier. */
  session_id: string;
  /** Number of downstream sessions affected by a failure. */
  blast_radius: number;
  /** Longest dependency chain originating from this session. */
  chain_depth: number;
  /** Composite criticality score (0-100). */
  criticality_score: number;
  /** Ratio of blast_radius to chain_depth; >1 means fan-out amplification. */
  amplification_factor: number;
  /** Tier 1-5 classification (5 = most critical). */
  criticality_tier: number;
  /** Session IDs reachable downstream. */
  forward_reach: string[];
  /** Session IDs reachable upstream. */
  backward_reach: string[];
}

/** Full V9 wave function result. Key: "v9_wave_function" in VectorResults. */
export interface WaveFunctionResult {
  /** Per-session criticality scores. */
  sessions: SessionCriticality[];
  /** Per-session hop-by-hop amplitude decay data for visualization. */
  fluctuation_data: { session_id: string; amplitudes: { hop: number; amplitude: number; cumulative_nodes: number }[] }[];
  /** Largest blast radius across all sessions. */
  max_blast_radius: number;
  /** Mean criticality score across all sessions. */
  avg_criticality: number;
}

// ── V10 Concentration ──

/** A gravity group — sessions clustered by shared table access patterns. From V10 engine. */
export interface GravityGroup {
  /** Unique group identifier. */
  group_id: number;
  /** Most representative session (medoid) of this group. */
  medoid_session_id: string;
  /** All session IDs in this group. */
  session_ids: string[];
  /** Tables most frequently accessed by group members. */
  core_tables: string[];
  /** Transform types characteristic of this group. */
  signature_transforms: string[];
  /** Internal cluster tightness metric (higher = tighter). */
  cohesion: number;
  /** External coupling metric (lower = more independent). */
  coupling: number;
  /** Number of sessions in this group. */
  session_count: number;
}

/** A session identified as having minimal dependencies. From V10 engine. */
export interface IndependentSession {
  /** Session identifier. */
  session_id: string;
  /** "full" = no dependencies; "near" = very few dependencies. */
  independence_type: 'full' | 'near';
  /** Confidence score for the independence classification (0-1). */
  confidence: number;
  /** Human-readable explanation of why this session is independent. */
  reason: string;
}

/** Full V10 concentration analysis result. Key: "v10_concentration" in VectorResults. */
export interface ConcentrationResult {
  /** Groups of sessions clustered by table-access gravity. */
  gravity_groups: GravityGroup[];
  /** Sessions classified as independent (minimal coupling). */
  independent_sessions: IndependentSession[];
  /** Optimal number of clusters chosen automatically. */
  optimal_k: number;
  /** Silhouette coefficient measuring cluster quality (-1 to 1). */
  silhouette: number;
}

// ── V8 Ensemble ──

/** Per-session consensus clustering result combining multiple vector engines. From V8 engine. */
export interface ConsensusSession {
  /** Session identifier. */
  session_id: string;
  /** Final consensus cluster assignment. */
  consensus_cluster: number;
  /** Confidence in the consensus assignment (0-1). */
  consensus_score: number;
  /** Cluster assignments from each individual vector engine. */
  per_vector_assignments: Record<string, number>;
  /** True if vectors disagree significantly on this session's cluster. */
  is_contested: boolean;
}

/** Full V8 ensemble consensus result. Key: "v8_ensemble_consensus" in VectorResults. */
export interface EnsembleResult {
  /** Per-session consensus assignments. */
  sessions: ConsensusSession[];
  /** Cluster ID -> list of session IDs per consensus cluster. */
  consensus_clusters: Record<string, string[]>;
  /** Total number of consensus clusters found. */
  n_clusters: number;
  /** Number of sessions where vectors disagree. */
  contested_count: number;
  /** Number of sessions with high consensus confidence. */
  high_confidence_count: number;
  /** Vector engine IDs that contributed to the ensemble (e.g. ["V1", "V5", "V6"]). */
  vectors_used: string[];
}

// ── Unified Vector Results ──

/**
 * Combined output from all 11 vector engines (V1-V11).
 * Populated in 3 phases: Core (V1,V4,V11) -> Advanced (V2,V3,V9,V10) -> Ensemble (V5-V8).
 * Each vector key is optional since engines run incrementally.
 */
export interface VectorResults {
  /** Total sessions analyzed. */
  session_count: number;
  /** All session IDs included in the analysis. */
  session_ids: string[];
  /** V1: Multi-resolution community detection (Louvain). */
  v1_communities?: CommunityResult;
  /** V4: Migration wave planning via topological sort of the DAG. */
  v4_wave_plan?: WavePlan;
  /** V11: 8-dimension complexity scoring with hour estimates. */
  v11_complexity?: ComplexityResult;
  /** V2: Hierarchical lineage domains via agglomerative clustering. */
  v2_hierarchical_lineage?: { domains: { domain_id: number; label: string; session_ids: string[]; core_tables: string[]; session_count: number }[]; optimal_k: number; silhouette: number };
  /** V3: UMAP/t-SNE 2D projections with cluster labels. */
  v3_dimensionality_reduction?: { projections: Record<string, { coords: { session_id: string; x: number; y: number; cluster: number }[]; n_clusters: number }>; method: string };
  /** V5: Affinity propagation clustering with exemplar sessions. */
  v5_affinity_propagation?: { clusters: Record<string, string[]>; exemplars: string[]; n_clusters: number };
  /** V6: Spectral clustering with 2D spectral embedding. */
  v6_spectral_clustering?: { clusters: Record<string, string[]>; optimal_k: number; embedding_2d: { session_id: string; x: number; y: number }[] };
  /** V7: HDBSCAN density-based clustering with noise detection. */
  v7_hdbscan_density?: { clusters: Record<string, string[]>; noise_sessions: string[]; n_clusters: number; noise_ratio: number };
  /** V8: Ensemble consensus across V1/V5/V6/V7 clustering. */
  v8_ensemble_consensus?: EnsembleResult;
  /** V9: Wave function criticality and blast radius analysis. */
  v9_wave_function?: WaveFunctionResult;
  /** V10: Gravity-based concentration grouping with independence detection. */
  v10_concentration?: ConcentrationResult;
  /** Per-engine execution times in seconds (e.g. {"V1": 0.5, "V4": 1.2}). */
  timings?: Record<string, number>;
  /** Total wall-clock time for the full vector pipeline in seconds. */
  total_time?: number;
}

// ── Layer Navigation ──

/** State for a single entry in the 6-layer navigation stack. */
export interface LayerContext {
  /** Layer number (1-6). */
  layer: number;
  /** Layer-specific parameters (e.g. groupId, sessionId, scopeType). */
  params: Record<string, string>;
  /** Saved scroll position for restoring on drill-up. */
  scrollPosition?: number;
}

/** Cross-cutting filters applied during layer drill-down to narrow visible sessions. */
export interface DrillFilter {
  /** Filter to a specific complexity bucket (e.g. "Complex"). */
  complexity_bucket?: string;
  /** Filter to specific migration wave numbers. */
  wave_number?: number[];
  /** Minimum criticality tier to include (1-5). */
  criticality_tier_min?: number;
  /** Filter to a specific V1 macro community. */
  community_macro?: number;
  /** Filter to a specific V2 hierarchical lineage domain. */
  domain_id?: number;
  /** Show only independent sessions (from V10). */
  is_independent?: boolean;
}

// ── L1 Enterprise ──

/** Server response for L1 Enterprise layer (GET /api/layers/L1). */
export interface L1Data {
  /** Always 1 for L1. */
  layer: 1;
  /** Coarsened community graph for the constellation visualization. */
  supernode_graph: SupernodeGraph;
  /** High-level statistics for the right-panel summary. */
  environment_summary: {
    total_sessions: number;
    total_groups: number;
    complexity_distribution: Record<string, number>;
    wave_count: number;
    total_hours_low: number;
    total_hours_high: number;
    cyclic_sessions: number;
  };
  /** Full vector results embedded for downstream use. */
  vector_results: VectorResults;
}

// ── Active Tags ──

/** User-defined annotation label attached to sessions, tables, or transforms. Stored in active_tags table. */
export interface ActiveTag {
  /** Server-generated unique tag ID. */
  tag_id: string;
  /** ID of the tagged object (session/table/transform). */
  object_id: string;
  /** Type of the tagged object. */
  object_type: 'session' | 'table' | 'transform' | 'domain';
  /** Tag category (e.g. "risk", "status", "review", "custom"). */
  tag_type: string;
  /** User-visible label text. */
  label: string;
  /** Hex color code for the tag badge. */
  color: string;
  /** Free-text annotation note. */
  note: string;
}

// ── What-If Simulation ──

/** Result of a what-if failure simulation for a single session. From POST /api/vectors/what-if/{sessionId}. */
export interface WhatIfResult {
  /** Session where the simulated failure originates. */
  source_session: string;
  /** Total number of downstream sessions affected. */
  blast_radius: number;
  /** Maximum hop depth the failure propagates. */
  max_depth: number;
  /** List of all affected downstream session IDs. */
  affected_sessions: string[];
  /** Sessions affected at each hop distance (e.g. {"1": ["S2","S3"], "2": ["S5"]}). */
  hop_breakdown: Record<string, string[]>;
  /** Amplitude decay curve showing how impact diminishes with distance. */
  amplitude_decay: { hop: number; amplitude: number; cumulative_nodes: number }[];
}

// ── Infrastructure ──

/** A system node in the infrastructure topology graph (L1A view). */
export interface SystemNode {
  /** Unique system identifier (e.g. "oracle", "s3"). */
  system_id: string;
  /** Human-readable system name. */
  name: string;
  /** Database/platform type (e.g. "oracle", "teradata", "kafka"). */
  system_type: string;
  /** Deployment environment (e.g. "on-prem", "aws", "azure"). */
  environment: string;
  /** Number of ETL sessions touching this system. */
  session_count: number;
  /** Number of tables belonging to this system. */
  table_count: number;
  /** Table names associated with this system. */
  tables: string[];
}

/** An edge representing data flow between two systems in the infrastructure graph. */
export interface SystemEdge {
  /** Source system ID. */
  from_system: string;
  /** Target system ID. */
  to_system: string;
  /** Number of sessions that cross this system boundary. */
  session_count: number;
  /** Session IDs that contribute to this edge. */
  session_ids: string[];
}

/** Complete infrastructure topology graph for the L1A view. */
export interface InfrastructureGraph {
  /** All detected systems (databases, file stores, messaging). */
  systems: SystemNode[];
  /** Data flow edges between systems. */
  edges: SystemEdge[];
  /** Systems grouped by deployment environment. */
  environment_groups: Record<string, string[]>;
}
