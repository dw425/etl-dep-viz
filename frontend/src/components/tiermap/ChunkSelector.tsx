/**
 * Chunk Selector — left sidebar listing all chunks as filterable cards.
 * Click a card to switch the tier diagram to that chunk's sessions.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { ConstellationChunk, TableReferenceEntry } from '../../types/tiermap';

const C = {
  bg: '#080C14', surface: '#111827', border: '#1e293b',
  text: '#e2e8f0', muted: '#64748b', dim: '#475569',
};

const TIER_COLORS = ['#3B82F6','#EAB308','#A855F7','#10B981','#F97316','#06B6D4','#EC4899','#84CC16'];
function tierColor(t: number): string {
  return TIER_COLORS[Math.max(0, Math.floor(t) - 1) % TIER_COLORS.length];
}

type SortKey = 'default' | 'sessions' | 'tiers' | 'conflicts';

interface ChunkSelectorProps {
  chunks: ConstellationChunk[];
  activeChunkId: string | null;
  onSelect: (chunkId: string) => void;
  onBack: () => void;
  algorithm?: string;
  tableRanking?: TableReferenceEntry[];
}

const VIRTUAL_ITEM_HEIGHT = 120;
const VIRTUAL_OVERSCAN = 4;

export default function ChunkSelector({ chunks, activeChunkId, onSelect, onBack, algorithm, tableRanking }: ChunkSelectorProps) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('default');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) setContainerHeight(e.contentRect.height);
    });
    obs.observe(el);
    setContainerHeight(el.clientHeight);
    return () => obs.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop);
  }, []);

  const filtered = useMemo(() => {
    let list = chunks;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) =>
        c.label.toLowerCase().includes(q) ||
        c.pivot_tables.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (sortBy === 'sessions') list = [...list].sort((a, b) => b.session_count - a.session_count);
    else if (sortBy === 'tiers') list = [...list].sort((a, b) => a.tier_range[0] - b.tier_range[0]);
    else if (sortBy === 'conflicts') list = [...list].sort((a, b) => b.conflict_count - a.conflict_count);
    return list;
  }, [chunks, search, sortBy]);

  const useVirtual = filtered.length > 80;
  const totalHeight = useVirtual ? filtered.length * VIRTUAL_ITEM_HEIGHT : 0;
  const startIdx = useVirtual ? Math.max(0, Math.floor(scrollTop / VIRTUAL_ITEM_HEIGHT) - VIRTUAL_OVERSCAN) : 0;
  const endIdx = useVirtual ? Math.min(filtered.length, Math.ceil((scrollTop + containerHeight) / VIRTUAL_ITEM_HEIGHT) + VIRTUAL_OVERSCAN) : filtered.length;
  const visibleChunks = useVirtual ? filtered.slice(startIdx, endIdx) : filtered;

  return (
    <div style={{
      width: 260, borderRight: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.6)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0,
    }}>
      {/* Back button */}
      <button
        onClick={onBack}
        style={{
          padding: '8px 14px', background: 'transparent', border: 'none',
          borderBottom: `1px solid ${C.border}`, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
          color: '#60A5FA', fontSize: 11, fontWeight: 600,
        }}
      >
        ← Back to Constellation
      </button>

      {/* Search + Sort */}
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}` }}>
        <input
          type="text"
          placeholder="Filter clusters…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%', padding: '5px 10px', borderRadius: 5,
            border: `1px solid ${C.border}`, background: 'rgba(0,0,0,0.3)',
            color: C.text, fontSize: 11, outline: 'none',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        />
        <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
          {([['default', 'Default'], ['sessions', 'Sessions'], ['tiers', 'Tier'], ['conflicts', 'Conflicts']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              style={{
                padding: '2px 6px', borderRadius: 3, border: 'none', cursor: 'pointer',
                background: sortBy === key ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)',
                color: sortBy === key ? '#60A5FA' : C.dim, fontSize: 9, fontWeight: 600,
              }}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* Top Tables summary — table_gravity only */}
      {algorithm === 'table_gravity' && tableRanking && tableRanking.length > 0 && (
        <div style={{
          padding: '8px 10px', borderBottom: `1px solid ${C.border}`,
        }}>
          <div style={{
            fontSize: 9, fontWeight: 700, color: '#F59E0B',
            textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6,
          }}>
            Top Tables
          </div>
          {tableRanking.slice(0, 10).map((entry, i) => {
            const maxCount = tableRanking[0].ref_count;
            const barPct = maxCount > 0 ? (entry.ref_count / maxCount) * 100 : 0;
            return (
              <div key={entry.table} style={{ marginBottom: 3 }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', fontSize: 8,
                  fontFamily: 'monospace', color: i < 3 ? '#FBBF24' : C.muted,
                }}>
                  <span style={{
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  }}>
                    {entry.table}
                  </span>
                  <span style={{ flexShrink: 0, marginLeft: 6 }}>{entry.ref_count}</span>
                </div>
                <div style={{
                  height: 3, borderRadius: 2, marginTop: 1,
                  background: 'rgba(255,255,255,0.05)',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    width: `${barPct}%`,
                    background: i < 3
                      ? 'linear-gradient(90deg, #F59E0B, #FBBF24)'
                      : 'rgba(100, 116, 139, 0.4)',
                  }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Chunk cards */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}
      >
        {useVirtual && <div style={{ height: startIdx * VIRTUAL_ITEM_HEIGHT }} />}
        {visibleChunks.map((chunk) => {
          const isActive = chunk.id === activeChunkId;
          const isGravity = algorithm === 'table_gravity';
          // Tier distribution: count sessions per tier within this chunk's range
          const tierDist = getTierDistribution(chunk);
          return (
            <div
              key={chunk.id}
              onClick={() => onSelect(chunk.id)}
              style={{
                padding: '10px 12px', marginBottom: 4, borderRadius: 8, cursor: 'pointer',
                background: isActive ? 'rgba(59,130,246,0.1)' : 'rgba(0,0,0,0.2)',
                border: `1px solid ${isActive ? '#3B82F6' : C.border}`,
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: chunk.color, flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 10, fontWeight: 700, color: C.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }}>
                  {chunk.label}
                </span>
                <span style={{
                  fontSize: 9, fontWeight: 700, fontFamily: 'monospace',
                  padding: '1px 5px', borderRadius: 4,
                  background: 'rgba(59,130,246,0.15)', color: '#60A5FA', flexShrink: 0,
                }}>
                  {chunk.session_count}
                </span>
              </div>

              {isGravity && !!chunk.anchor_table && (
                <div style={{
                  fontSize: 8, color: '#FBBF24', fontFamily: 'monospace',
                  marginBottom: 3, display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  <span style={{ opacity: 0.7 }}>anchor:</span>
                  <span style={{
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  }}>
                    {chunk.anchor_table}
                  </span>
                  {!!chunk.anchor_ref_count && (
                    <span style={{
                      fontSize: 7, padding: '0 4px', borderRadius: 3,
                      background: 'rgba(245,158,11,0.15)', flexShrink: 0,
                    }}>
                      {chunk.anchor_ref_count} refs
                    </span>
                  )}
                </div>
              )}

              {/* Tier distribution bar */}
              {tierDist.length > 0 && (
                <div style={{
                  display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden',
                  marginBottom: 3, background: 'rgba(255,255,255,0.03)',
                }}>
                  {tierDist.map(({ tier, pct }) => (
                    <div key={tier} style={{
                      width: `${pct}%`, height: '100%',
                      background: tierColor(tier),
                      minWidth: pct > 0 ? 2 : 0,
                    }} />
                  ))}
                </div>
              )}

              <div style={{ fontSize: 9, color: C.muted, marginBottom: 3 }}>
                Tier {chunk.tier_range[0]}–{chunk.tier_range[1]}
              </div>

              {chunk.pivot_tables.length > 0 && (
                <div style={{
                  fontSize: 8, color: C.dim, fontFamily: 'monospace',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {chunk.pivot_tables.slice(0, 2).join(', ')}
                </div>
              )}

              {(chunk.conflict_count > 0 || chunk.chain_count > 0) && (
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  {chunk.conflict_count > 0 && (
                    <span style={{
                      fontSize: 8, padding: '1px 4px', borderRadius: 3,
                      background: 'rgba(239,68,68,0.12)', color: '#FCA5A5',
                    }}>
                      {chunk.conflict_count} conflicts
                    </span>
                  )}
                  {chunk.chain_count > 0 && (
                    <span style={{
                      fontSize: 8, padding: '1px 4px', borderRadius: 3,
                      background: 'rgba(249,115,22,0.12)', color: '#FDBA74',
                    }}>
                      {chunk.chain_count} chains
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {useVirtual && <div style={{ height: (filtered.length - endIdx) * VIRTUAL_ITEM_HEIGHT }} />}
        {filtered.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 11 }}>
            No clusters match
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '6px 12px', borderTop: `1px solid ${C.border}`,
        fontSize: 9, color: C.muted, textAlign: 'center',
      }}>
        {filtered.length}/{chunks.length} clusters · {filtered.reduce((a, c) => a + c.session_count, 0)} sessions
      </div>
    </div>
  );
}

function getTierDistribution(chunk: ConstellationChunk): Array<{ tier: number; pct: number }> {
  const [lo, hi] = chunk.tier_range;
  if (lo === hi) return [{ tier: lo, pct: 100 }];
  const tierCount = hi - lo + 1;
  // Approximate distribution: even split across tier range
  return Array.from({ length: tierCount }, (_, i) => ({
    tier: lo + i,
    pct: 100 / tierCount,
  }));
}
