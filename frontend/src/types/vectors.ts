// ── Constellation Vector types — analysis results from V1–V11 ──

// ── V11 Complexity ──
export interface DimensionScore {
  name: string;
  raw_value: number;
  normalized: number;
  weight: number;
  weighted_score: number;
}

export interface SessionComplexityScore {
  session_id: string;
  name: string;
  overall_score: number;
  bucket: 'Simple' | 'Medium' | 'Complex' | 'Very Complex';
  dimensions: DimensionScore[];
  hours_estimate_low: number;
  hours_estimate_high: number;
  top_drivers: string[];
}

export interface ComplexityResult {
  scores: SessionComplexityScore[];
  bucket_distribution: Record<string, number>;
  aggregate_stats: Record<string, number>;
  total_hours_low: number;
  total_hours_high: number;
}

// ── V4 Wave Plan ──
export interface SCCGroup {
  group_id: number;
  session_ids: string[];
  is_cycle: boolean;
  internal_edge_count: number;
}

export interface MigrationWave {
  wave_number: number;
  session_ids: string[];
  scc_groups: number[];
  prerequisite_waves: number[];
  estimated_hours_low: number;
  estimated_hours_high: number;
  session_count: number;
}

export interface WavePlan {
  waves: MigrationWave[];
  scc_groups: SCCGroup[];
  critical_path_length: number;
  total_sessions: number;
  cyclic_session_count: number;
  acyclic_session_count: number;
}

// ── V1 Community ──
export interface CommunityAssignment {
  session_id: string;
  macro: number;
  meso: number;
  micro: number;
}

export interface SupernodeGraph {
  supernodes: Supernode[];
  superedges: Superedge[];
}

export interface Supernode {
  id: string;
  session_count: number;
  session_ids: string[];
  avg_complexity?: number;
  bucket_distribution?: Record<string, number>;
}

export interface Superedge {
  from: string;
  to: string;
  weight: number;
  pair_count: number;
}

export interface CommunityResult {
  assignments: CommunityAssignment[];
  macro_communities: Record<string, string[]>;
  meso_communities: Record<string, string[]>;
  micro_communities: Record<string, string[]>;
  modularity: Record<string, number>;
  supernode_graph: SupernodeGraph;
}

// ── V9 Wave Function ──
export interface SessionCriticality {
  session_id: string;
  blast_radius: number;
  chain_depth: number;
  criticality_score: number;
  amplification_factor: number;
  criticality_tier: number;
  forward_reach: string[];
  backward_reach: string[];
}

export interface WaveFunctionResult {
  sessions: SessionCriticality[];
  fluctuation_data: { session_id: string; amplitudes: { hop: number; amplitude: number; cumulative_nodes: number }[] }[];
  max_blast_radius: number;
  avg_criticality: number;
}

// ── V10 Concentration ──
export interface GravityGroup {
  group_id: number;
  medoid_session_id: string;
  session_ids: string[];
  core_tables: string[];
  signature_transforms: string[];
  cohesion: number;
  coupling: number;
  session_count: number;
}

export interface IndependentSession {
  session_id: string;
  independence_type: 'full' | 'near';
  confidence: number;
  reason: string;
}

export interface ConcentrationResult {
  gravity_groups: GravityGroup[];
  independent_sessions: IndependentSession[];
  optimal_k: number;
  silhouette: number;
}

// ── V8 Ensemble ──
export interface ConsensusSession {
  session_id: string;
  consensus_cluster: number;
  consensus_score: number;
  per_vector_assignments: Record<string, number>;
  is_contested: boolean;
}

export interface EnsembleResult {
  sessions: ConsensusSession[];
  consensus_clusters: Record<string, string[]>;
  n_clusters: number;
  contested_count: number;
  high_confidence_count: number;
  vectors_used: string[];
}

// ── Unified Vector Results ──
export interface VectorResults {
  session_count: number;
  session_ids: string[];
  v1_communities?: CommunityResult;
  v4_wave_plan?: WavePlan;
  v11_complexity?: ComplexityResult;
  v2_hierarchical_lineage?: { domains: { domain_id: number; label: string; session_ids: string[]; core_tables: string[]; session_count: number }[]; optimal_k: number; silhouette: number };
  v3_dimensionality_reduction?: { projections: Record<string, { coords: { session_id: string; x: number; y: number; cluster: number }[]; n_clusters: number }>; method: string };
  v5_affinity_propagation?: { clusters: Record<string, string[]>; exemplars: string[]; n_clusters: number };
  v6_spectral_clustering?: { clusters: Record<string, string[]>; optimal_k: number; embedding_2d: { session_id: string; x: number; y: number }[] };
  v7_hdbscan_density?: { clusters: Record<string, string[]>; noise_sessions: string[]; n_clusters: number; noise_ratio: number };
  v8_ensemble_consensus?: EnsembleResult;
  v9_wave_function?: WaveFunctionResult;
  v10_concentration?: ConcentrationResult;
  timings?: Record<string, number>;
  total_time?: number;
}

// ── Layer Navigation ──
export interface LayerContext {
  layer: number;
  params: Record<string, string>;
  scrollPosition?: number;
}

export interface DrillFilter {
  complexity_bucket?: string;
  wave_number?: number[];
  criticality_tier_min?: number;
  community_macro?: number;
  domain_id?: number;
  is_independent?: boolean;
}

// ── L1 Enterprise ──
export interface L1Data {
  layer: 1;
  supernode_graph: SupernodeGraph;
  environment_summary: {
    total_sessions: number;
    total_groups: number;
    complexity_distribution: Record<string, number>;
    wave_count: number;
    total_hours_low: number;
    total_hours_high: number;
    cyclic_sessions: number;
  };
  vector_results: VectorResults;
}

// ── Active Tags ──
export interface ActiveTag {
  tag_id: string;
  object_id: string;
  object_type: 'session' | 'table' | 'transform' | 'domain';
  tag_type: string;
  label: string;
  color: string;
  note: string;
}

// ── What-If Simulation ──
export interface WhatIfResult {
  source_session: string;
  blast_radius: number;
  max_depth: number;
  affected_sessions: string[];
  hop_breakdown: Record<string, string[]>;
  amplitude_decay: { hop: number; amplitude: number; cumulative_nodes: number }[];
}

// ── Infrastructure ──
export interface SystemNode {
  system_id: string;
  name: string;
  system_type: string;
  environment: string;
  session_count: number;
  table_count: number;
  tables: string[];
}

export interface SystemEdge {
  from_system: string;
  to_system: string;
  session_count: number;
  session_ids: string[];
}

export interface InfrastructureGraph {
  systems: SystemNode[];
  edges: SystemEdge[];
  environment_groups: Record<string, string[]>;
}
