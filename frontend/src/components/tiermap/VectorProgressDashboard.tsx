/**
 * Vector Progress Dashboard — timing waterfall for vector analysis pipeline.
 *
 * Shows the 3-phase orchestration timing (Core → Advanced → Ensemble)
 * with per-vector timing bars and results summary.
 */

import React, { useMemo } from 'react';

interface VectorTiming {
  name: string;
  elapsed_ms: number;
  status: string;
  phase: string;
}

interface VectorProgressDashboardProps {
  vectorResults: any | null;
  analysisTimings?: VectorTiming[];
}

const PHASE_COLORS: Record<string, string> = {
  core: '#3B82F6',
  advanced: '#A855F7',
  ensemble: '#F59E0B',
};

const PHASE_LABELS: Record<string, string> = {
  core: 'Phase 1: Core',
  advanced: 'Phase 2: Advanced',
  ensemble: 'Phase 3: Ensemble',
};

const VECTOR_NAMES: Record<string, string> = {
  v1_community: 'V1 Community Detection',
  v2_partition: 'V2 Partition Quality',
  v3_centrality: 'V3 Centrality Analysis',
  v4_topological: 'V4 Topological Sort',
  v5_ensemble: 'V5 Ensemble Consensus',
  v6_wave: 'V6 Wave Planning',
  v7_gravity: 'V7 Gravity Analysis',
  v8_simulation: 'V8 What-If Simulation',
  v9_umap: 'V9 UMAP Projection',
  v10_concentration: 'V10 Concentration',
  v11_complexity: 'V11 Complexity Scoring',
};

/**
 * VectorProgressDashboard -- timing waterfall for the 3-phase vector analysis
 * pipeline. Groups vectors by phase (Core / Advanced / Ensemble) and renders
 * a proportional bar for each vector's elapsed time, color-coded by phase.
 * Shows summary counts (completed / 11) and total elapsed time.
 *
 * If no explicit `analysisTimings` are passed, timing data is derived from
 * the `_elapsed_ms` property on each vector result object.
 */
export default function VectorProgressDashboard({
  vectorResults,
  analysisTimings,
}: VectorProgressDashboardProps) {
  // Derive timing data from vector results if no explicit timings provided
  const timings = useMemo(() => {
    if (analysisTimings) return analysisTimings;
    if (!vectorResults) return [];

    const result: VectorTiming[] = [];
    const phaseMap: Record<string, string> = {
      v1_community: 'core', v4_topological: 'core', v11_complexity: 'core',
      v2_partition: 'advanced', v3_centrality: 'advanced',
      v9_umap: 'advanced', v10_concentration: 'advanced',
      v5_ensemble: 'ensemble', v6_wave: 'ensemble',
      v7_gravity: 'ensemble', v8_simulation: 'ensemble',
    };

    for (const [key, phase] of Object.entries(phaseMap)) {
      const data = vectorResults[key];
      result.push({
        name: key,
        elapsed_ms: data?._elapsed_ms ?? (data ? 100 : 0),
        status: data ? 'completed' : 'skipped',
        phase,
      });
    }
    return result;
  }, [vectorResults, analysisTimings]);

  if (!vectorResults && !analysisTimings) {
    return (
      <div style={{ padding: 24, color: '#94a3b8', textAlign: 'center' }}>
        No vector analysis data. Run analysis from the Vector Control Panel.
      </div>
    );
  }

  const maxTime = Math.max(...timings.map(t => t.elapsed_ms), 1);
  const totalTime = timings.reduce((sum, t) => sum + t.elapsed_ms, 0);
  const completed = timings.filter(t => t.status === 'completed').length;

  // Group by phase
  const phases = ['core', 'advanced', 'ensemble'];

  return (
    <div style={{ padding: 16, color: '#e2e8f0', fontFamily: '"JetBrains Mono", monospace' }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>
        Vector Analysis Pipeline
      </h3>

      {/* Summary */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 20, fontSize: 12 }}>
        <div>
          <span style={{ color: '#94a3b8' }}>Vectors: </span>
          <span style={{ color: '#10B981' }}>{completed}</span>
          <span style={{ color: '#94a3b8' }}>/11</span>
        </div>
        <div>
          <span style={{ color: '#94a3b8' }}>Total: </span>
          <span>{(totalTime / 1000).toFixed(1)}s</span>
        </div>
      </div>

      {/* Waterfall by phase */}
      {phases.map(phase => {
        const phaseTimings = timings.filter(t => t.phase === phase);
        if (phaseTimings.length === 0) return null;
        const phaseTotal = phaseTimings.reduce((s, t) => s + t.elapsed_ms, 0);

        return (
          <div key={phase} style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 12, fontWeight: 600, marginBottom: 8,
              color: PHASE_COLORS[phase],
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{PHASE_LABELS[phase]}</span>
              <span style={{ fontSize: 11, fontWeight: 400 }}>
                {(phaseTotal / 1000).toFixed(1)}s
              </span>
            </div>

            {phaseTimings.map(t => (
              <div key={t.name} style={{
                display: 'grid', gridTemplateColumns: '200px 1fr 60px',
                alignItems: 'center', marginBottom: 4, gap: 8,
              }}>
                <span style={{
                  fontSize: 11, color: t.status === 'completed' ? '#e2e8f0' : '#475569',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {VECTOR_NAMES[t.name] || t.name}
                </span>
                <div style={{
                  position: 'relative', height: 8,
                  background: '#1e293b', borderRadius: 4,
                }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, height: '100%',
                    borderRadius: 4,
                    width: `${(t.elapsed_ms / maxTime) * 100}%`,
                    background: t.status === 'completed'
                      ? PHASE_COLORS[phase]
                      : '#475569',
                    opacity: t.status === 'completed' ? 0.8 : 0.3,
                  }} />
                </div>
                <span style={{
                  fontSize: 10, color: '#64748b', textAlign: 'right',
                }}>
                  {t.status === 'completed' ? `${t.elapsed_ms}ms` : 'skip'}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
