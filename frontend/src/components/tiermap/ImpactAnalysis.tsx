/**
 * Impact Analysis — forward trace from a session showing all downstream effects.
 *
 * Visualizes cascading impact through the dependency graph with
 * depth-based layout and session/table affected counts.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { getImpactAnalysis } from '../../api/client';
import type { TierMapResult } from '../../types/tiermap';

interface ImpactNode {
  id: string;
  name: string;
  tier: number;
  depth: number;
}

interface ImpactEdge {
  from: string;
  to: string;
  type: string;
  depth: number;
}

interface ImpactData {
  source_session: string;
  source_name: string;
  impacted_sessions: ImpactNode[];
  impacted_tables: ImpactNode[];
  total_impacted: number;
  max_depth: number;
  edges: ImpactEdge[];
}

interface Props {
  tierData: TierMapResult;
  selectedSession?: string | null;
  onSessionSelect?: (sessionId: string) => void;
}

const DEPTH_COLORS = ['#3B82F6', '#A855F7', '#F59E0B', '#EF4444', '#10B981', '#EC4899', '#F97316', '#06B6D4'];
const ITEMS_PER_GROUP = 50;

/**
 * ImpactAnalysis -- forward-trace impact analysis view. Given a source session,
 * displays all downstream sessions and tables affected by a failure, grouped by
 * hop depth. Uses progressive "show more" expansion per depth group.
 */
export default function ImpactAnalysis({ tierData, selectedSession, onSessionSelect }: Props) {
  const [sessionId, setSessionId] = useState(selectedSession || '');
  const [impactData, setImpactData] = useState<ImpactData | null>(null);
  const [loading, setLoading] = useState(false);
  const [maxHops, setMaxHops] = useState(10);
  const [expandedDepths, setExpandedDepths] = useState<Set<number>>(new Set());

  const loadImpact = useCallback(async (sid: string) => {
    if (!sid) return;
    setLoading(true);
    try {
      const data = await getImpactAnalysis(tierData, sid, maxHops) as unknown as ImpactData;
      setImpactData(data);
    } catch {
      setImpactData(null);
    } finally {
      setLoading(false);
    }
  }, [tierData, maxHops]);

  useEffect(() => {
    if (selectedSession) {
      setSessionId(selectedSession);
      loadImpact(selectedSession);
    }
  }, [selectedSession, loadImpact]);

  // Group impacted items by depth
  const depthGroups = useMemo(() => {
    if (!impactData) return [];
    const groups: Record<number, { sessions: ImpactNode[]; tables: ImpactNode[] }> = {};
    for (const s of impactData.impacted_sessions) {
      if (s.depth === 0) continue; // Skip source
      if (!groups[s.depth]) groups[s.depth] = { sessions: [], tables: [] };
      groups[s.depth].sessions.push(s);
    }
    for (const t of impactData.impacted_tables) {
      if (t.depth === 0) continue;
      if (!groups[t.depth]) groups[t.depth] = { sessions: [], tables: [] };
      groups[t.depth].tables.push(t);
    }
    return Object.entries(groups)
      .map(([depth, g]) => ({ depth: Number(depth), ...g }))
      .sort((a, b) => a.depth - b.depth);
  }, [impactData]);

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      color: '#e2e8f0', fontFamily: '"JetBrains Mono", monospace',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Impact Analysis</h3>
        <select
          value={sessionId}
          onChange={e => { setSessionId(e.target.value); loadImpact(e.target.value); }}
          style={{
            flex: 1, maxWidth: 300, padding: '4px 8px', fontSize: 11,
            background: '#1e293b', border: '1px solid #334155', borderRadius: 4,
            color: '#e2e8f0',
          }}
        >
          <option value="">Select source session...</option>
          {tierData.sessions.map(s => (
            <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
          ))}
        </select>
        <label style={{ fontSize: 10, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4 }}>
          Hops:
          <input
            type="number"
            value={maxHops}
            onChange={e => setMaxHops(Math.max(1, Math.min(50, Number(e.target.value))))}
            style={{
              width: 40, padding: '2px 4px', fontSize: 10,
              background: '#1e293b', border: '1px solid #334155', borderRadius: 3,
              color: '#e2e8f0', textAlign: 'center',
            }}
          />
        </label>
      </div>

      {/* Summary bar */}
      {impactData && (
        <div style={{
          padding: '8px 16px', borderBottom: '1px solid #1e293b',
          display: 'flex', gap: 16, fontSize: 11,
        }}>
          <div>
            Source: <span style={{ color: '#3B82F6', fontWeight: 600 }}>{impactData.source_name}</span>
          </div>
          <div>
            Impacted Sessions: <span style={{ fontWeight: 600 }}>{impactData.impacted_sessions.length - 1}</span>
          </div>
          <div>
            Impacted Tables: <span style={{ fontWeight: 600 }}>{impactData.impacted_tables.length}</span>
          </div>
          <div>
            Max Depth: <span style={{ fontWeight: 600 }}>{impactData.max_depth}</span>
          </div>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>
            Analyzing impact...
          </div>
        )}

        {!loading && impactData && depthGroups.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>
            No downstream impact found for this session.
          </div>
        )}

        {!loading && impactData && depthGroups.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {depthGroups.map(group => {
              const color = DEPTH_COLORS[(group.depth - 1) % DEPTH_COLORS.length];
              return (
                <div key={group.depth}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color,
                    marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <span style={{
                      width: 20, height: 20, borderRadius: 10,
                      background: `${color}22`, color,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10,
                    }}>
                      {group.depth}
                    </span>
                    Depth {group.depth} — {group.sessions.length} sessions, {group.tables.length} tables
                  </div>

                  {(() => {
                    const allItems = [...group.sessions.map(s => ({ ...s, _kind: 'session' as const })), ...group.tables.map(t => ({ ...t, _kind: 'table' as const }))];
                    const expanded = expandedDepths.has(group.depth);
                    const shown = expanded ? allItems : allItems.slice(0, ITEMS_PER_GROUP);
                    return (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: 28 }}>
                        {shown.map(item => item._kind === 'session' ? (
                          <div
                            key={item.id}
                            onClick={() => onSessionSelect?.(item.id)}
                            style={{
                              padding: '4px 10px', fontSize: 10, borderRadius: 4,
                              background: '#1e293b', border: `1px solid ${color}44`,
                              cursor: 'pointer',
                            }}
                          >
                            <span style={{ color }}>{item.name}</span>
                            <span style={{ color: '#475569', marginLeft: 6 }}>T{item.tier}</span>
                          </div>
                        ) : (
                          <div
                            key={item.id}
                            style={{
                              padding: '4px 10px', fontSize: 10, borderRadius: 4,
                              background: '#0f172a', border: '1px solid #334155',
                            }}
                          >
                            <span style={{ color: '#10B981' }}>{item.name}</span>
                          </div>
                        ))}
                        {allItems.length > ITEMS_PER_GROUP && !expanded && (
                          <button
                            onClick={() => setExpandedDepths(prev => { const n = new Set(prev); n.add(group.depth); return n; })}
                            style={{
                              padding: '4px 10px', fontSize: 10, borderRadius: 4,
                              background: '#1e293b', border: '1px solid #334155', color: '#60a5fa',
                              cursor: 'pointer',
                            }}
                          >
                            +{allItems.length - ITEMS_PER_GROUP} more
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}

        {!loading && !impactData && !sessionId && (
          <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>
            Select a source session to analyze downstream impact
          </div>
        )}
      </div>
    </div>
  );
}
