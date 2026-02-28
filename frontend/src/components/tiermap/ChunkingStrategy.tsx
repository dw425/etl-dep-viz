/**
 * ChunkingStrategy — Data Harmonization screen where users choose
 * chunking/grouping algorithms before visualization.
 *
 * Options:
 *  - Default: Tier-based grouping
 *  - Table Dependency: Group by shared table footprint
 *  - KNN Vectors: Use V1 community detection results
 *  - Custom: Select from multiple algorithm options
 */

import React, { useState, useCallback } from 'react';
import type { TierMapResult, ConstellationResult, AlgorithmKey } from '../../types/tiermap';
import type { VectorResults } from '../../types/vectors';

interface Props {
  tierData: TierMapResult;
  constellation: ConstellationResult | null;
  vectorResults: VectorResults | null;
  onRecluster: (algorithm: AlgorithmKey) => Promise<void>;
  onProceed: (view: string) => void;
}

interface StrategyOption {
  id: AlgorithmKey;
  name: string;
  description: string;
  recommended?: boolean;
  category: 'default' | 'dependency' | 'vector' | 'custom';
  requiresVectors?: boolean;
}

const STRATEGIES: StrategyOption[] = [
  { id: 'louvain', name: 'Louvain Community', description: 'Groups sessions by shared table dependencies using community detection. Best for most workloads.', recommended: true, category: 'default' },
  { id: 'tier', name: 'Tier-Based', description: 'Groups by execution tier (depth). Good for understanding execution ordering.', category: 'default' },
  { id: 'table_gravity', name: 'Table Gravity', description: 'Groups sessions that share the most tables together. Reveals data domain clusters.', category: 'dependency' },
  { id: 'components', name: 'Connected Components', description: 'Groups by graph connectivity. Shows isolated vs interconnected pipelines.', category: 'dependency' },
  { id: 'label_prop', name: 'Label Propagation', description: 'Fast community detection via label spreading. Good for large datasets.', category: 'vector' },
  { id: 'greedy_mod', name: 'Greedy Modularity', description: 'Optimizes modularity score for clean group boundaries.', category: 'custom' },
  { id: 'process_group', name: 'Process Group', description: 'Uses NiFi process groups or Informatica folders as natural boundaries.', category: 'custom' },
];

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  default: { label: 'Recommended', color: '#22C55E' },
  dependency: { label: 'Table Dependency', color: '#3B82F6' },
  vector: { label: 'KNN / Vector', color: '#A855F7' },
  custom: { label: 'Custom', color: '#F59E0B' },
};

export default function ChunkingStrategy({ tierData, constellation, vectorResults, onRecluster, onProceed }: Props) {
  const [selected, setSelected] = useState<AlgorithmKey>('louvain');
  const [loading, setLoading] = useState(false);

  const handleApply = useCallback(async () => {
    setLoading(true);
    try {
      await onRecluster(selected);
    } finally {
      setLoading(false);
    }
  }, [selected, onRecluster]);

  const sessionCount = tierData.sessions.length;
  const tableCount = tierData.tables.length;

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
          Data Harmonization &amp; Chunking
        </h2>
        <p style={{ fontSize: 12, color: '#64748b', maxWidth: 600 }}>
          Choose how to group {sessionCount.toLocaleString()} sessions and {tableCount.toLocaleString()} tables
          into manageable chunks for visualization and analysis.
        </p>
      </div>

      {/* Stats summary */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <StatCard label="Sessions" value={sessionCount} />
        <StatCard label="Tables" value={tableCount} />
        <StatCard label="Connections" value={tierData.connections.length} />
        <StatCard label="Max Tier" value={tierData.stats?.max_tier || 0} />
        {constellation && <StatCard label="Current Chunks" value={constellation.chunks.length} />}
      </div>

      {/* Strategy grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {Object.entries(CATEGORY_LABELS).map(([cat, { label, color }]) => {
          const strategies = STRATEGIES.filter(s => s.category === cat);
          if (strategies.length === 0) return null;
          return (
            <React.Fragment key={cat}>
              <div style={{ gridColumn: '1 / -1', fontSize: 10, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 8 }}>
                {label}
              </div>
              {strategies.map(s => {
                const isSel = selected === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => setSelected(s.id)}
                    style={{
                      padding: 16, borderRadius: 10, cursor: 'pointer',
                      background: isSel ? 'rgba(59,130,246,0.12)' : '#111827',
                      border: `1px solid ${isSel ? '#3b82f6' : '#1e293b'}`,
                      transition: 'all 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${isSel ? '#3b82f6' : '#334155'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isSel && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6' }} />}
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: isSel ? '#60a5fa' : '#e2e8f0' }}>
                        {s.name}
                      </span>
                      {s.recommended && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'rgba(34,197,94,0.2)', color: '#22C55E', fontWeight: 700 }}>RECOMMENDED</span>}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
                      {s.description}
                    </div>
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 12, marginTop: 24, justifyContent: 'flex-end' }}>
        <button
          onClick={handleApply}
          disabled={loading}
          style={{
            padding: '10px 24px', borderRadius: 8, border: 'none', cursor: loading ? 'wait' : 'pointer',
            background: '#3b82f6', color: '#fff', fontSize: 13, fontWeight: 600,
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Applying...' : `Apply ${STRATEGIES.find(s => s.id === selected)?.name || selected}`}
        </button>
        <button
          onClick={() => onProceed('tier')}
          style={{
            padding: '10px 24px', borderRadius: 8, border: '1px solid #1e293b', cursor: 'pointer',
            background: 'transparent', color: '#64748b', fontSize: 13, fontWeight: 600,
          }}
        >
          Tier Diagram
        </button>
        <button
          onClick={() => onProceed('constellation')}
          style={{
            padding: '10px 24px', borderRadius: 8, border: '1px solid #22C55E', cursor: 'pointer',
            background: 'rgba(34,197,94,0.1)', color: '#22C55E', fontSize: 13, fontWeight: 600,
          }}
        >
          Constellation View
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ padding: '10px 16px', borderRadius: 8, background: '#111827', border: '1px solid #1e293b', textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>{value.toLocaleString()}</div>
      <div style={{ fontSize: 9, color: '#64748b' }}>{label}</div>
    </div>
  );
}
