/**
 * Chunk Summary — top bar showing stats for the currently selected chunk(s).
 */

import React from 'react';
import type { ConstellationChunk, CrossChunkEdge } from '../../types/tiermap';

const C = {
  border: '#1e293b', text: '#e2e8f0', muted: '#64748b',
};

interface ChunkSummaryProps {
  chunks: ConstellationChunk[];
  totalSessions: number;
  crossChunkEdges: CrossChunkEdge[];
}

/**
 * ChunkSummary -- horizontal stats bar showing aggregate metrics for the
 * currently selected chunk(s): session count, table count, tier range,
 * pivot tables, cross-cluster links, conflict/chain counts.
 */
export default function ChunkSummary({ chunks, totalSessions, crossChunkEdges }: ChunkSummaryProps) {
  if (chunks.length === 0) return null;

  const selectedIds = new Set(chunks.map(c => c.id));
  const crossCount = crossChunkEdges.filter(
    (e) => selectedIds.has(e.from_chunk) || selectedIds.has(e.to_chunk),
  ).reduce((sum, e) => sum + e.count, 0);

  const totalSelected = chunks.reduce((a, c) => a + c.session_count, 0);
  const totalTables = chunks.reduce((a, c) => a + c.table_count, 0);
  const tierMin = Math.min(...chunks.map(c => c.tier_range[0]));
  const tierMax = Math.max(...chunks.map(c => c.tier_range[1]));
  const totalConflicts = chunks.reduce((a, c) => a + c.conflict_count, 0);
  const totalChains = chunks.reduce((a, c) => a + c.chain_count, 0);

  const title = chunks.length === 1 ? chunks[0].label : `${chunks.length} clusters selected`;

  return (
    <div style={{
      padding: '6px 20px', borderBottom: `1px solid ${C.border}`,
      display: 'flex', gap: 20, fontSize: 10, color: C.muted,
      alignItems: 'center', flexWrap: 'wrap', flexShrink: 0,
      background: 'rgba(15,23,42,0.8)',
    }}>
      {/* Chunk color dot + name */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {chunks.length === 1 && (
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: chunks[0].color, display: 'inline-block',
          }} />
        )}
        <strong style={{ color: C.text }}>{title}</strong>
      </span>

      {/* Session count / total */}
      <span>
        <strong style={{ color: C.text }}>{totalSelected}</strong>
        <span> / {totalSessions} sessions</span>
      </span>

      {/* Table count */}
      <span>
        <strong style={{ color: '#10B981' }}>{totalTables}</strong> tables
      </span>

      {/* Tier range */}
      <span>
        Tier <strong style={{ color: C.text }}>{tierMin}</strong>–<strong style={{ color: C.text }}>{tierMax}</strong>
      </span>

      {/* Pivot tables — show from first chunk only */}
      {chunks.length === 1 && chunks[0].pivot_tables.length > 0 && (
        <span style={{ fontFamily: 'monospace', fontSize: 9, color: '#94A3B8' }}>
          {chunks[0].pivot_tables.slice(0, 3).join(' · ')}
        </span>
      )}

      {/* Cross-chunk connections */}
      {crossCount > 0 && (
        <span style={{ marginLeft: 'auto' }}>
          <strong style={{ color: '#F59E0B' }}>{crossCount}</strong> cross-cluster links
        </span>
      )}

      {/* Conflicts / chains */}
      {totalConflicts > 0 && (
        <span style={{ color: '#EF4444' }}>
          <strong>{totalConflicts}</strong> conflicts
        </span>
      )}
      {totalChains > 0 && (
        <span style={{ color: '#F97316' }}>
          <strong>{totalChains}</strong> chains
        </span>
      )}
    </div>
  );
}
