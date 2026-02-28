/**
 * Chunk Summary — top bar showing stats for the currently selected chunk.
 */

import React from 'react';
import type { ConstellationChunk, CrossChunkEdge } from '../../types/tiermap';

const C = {
  border: '#1e293b', text: '#e2e8f0', muted: '#64748b',
};

interface ChunkSummaryProps {
  chunk: ConstellationChunk;
  totalSessions: number;
  crossChunkEdges: CrossChunkEdge[];
}

export default function ChunkSummary({ chunk, totalSessions, crossChunkEdges }: ChunkSummaryProps) {
  const crossCount = crossChunkEdges.filter(
    (e) => e.from_chunk === chunk.id || e.to_chunk === chunk.id,
  ).reduce((sum, e) => sum + e.count, 0);

  return (
    <div style={{
      padding: '6px 20px', borderBottom: `1px solid ${C.border}`,
      display: 'flex', gap: 20, fontSize: 10, color: C.muted,
      alignItems: 'center', flexWrap: 'wrap', flexShrink: 0,
      background: 'rgba(15,23,42,0.8)',
    }}>
      {/* Chunk color dot + name */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', background: chunk.color, display: 'inline-block',
        }} />
        <strong style={{ color: C.text }}>{chunk.label}</strong>
      </span>

      {/* Session count / total */}
      <span>
        <strong style={{ color: C.text }}>{chunk.session_count}</strong>
        <span> / {totalSessions} sessions</span>
      </span>

      {/* Table count */}
      <span>
        <strong style={{ color: '#10B981' }}>{chunk.table_count}</strong> tables
      </span>

      {/* Tier range */}
      <span>
        Tier <strong style={{ color: C.text }}>{chunk.tier_range[0]}</strong>–<strong style={{ color: C.text }}>{chunk.tier_range[1]}</strong>
      </span>

      {/* Pivot tables */}
      {chunk.pivot_tables.length > 0 && (
        <span style={{ fontFamily: 'monospace', fontSize: 9, color: '#94A3B8' }}>
          {chunk.pivot_tables.slice(0, 3).join(' · ')}
        </span>
      )}

      {/* Cross-chunk connections */}
      {crossCount > 0 && (
        <span style={{ marginLeft: 'auto' }}>
          <strong style={{ color: '#F59E0B' }}>{crossCount}</strong> cross-cluster links
        </span>
      )}

      {/* Conflicts / chains */}
      {chunk.conflict_count > 0 && (
        <span style={{ color: '#EF4444' }}>
          <strong>{chunk.conflict_count}</strong> conflicts
        </span>
      )}
      {chunk.chain_count > 0 && (
        <span style={{ color: '#F97316' }}>
          <strong>{chunk.chain_count}</strong> chains
        </span>
      )}
    </div>
  );
}
