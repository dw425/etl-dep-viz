/**
 * Lineage Builder — interactive column-level lineage viewer.
 *
 * Shows field-to-field data flow through transformation instances
 * for a selected session. Click source → target to trace paths.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { getColumnLineage } from '../../api/client';
import type { TierMapResult, TierSession } from '../../types/tiermap';

interface ColumnNode {
  id: string;
  instance: string;
  field: string;
  instance_type: string;
  transformation_type: string;
  expression: string;
  expression_type: string;
  datatype: string;
}

interface ColumnFlow {
  from: string;
  to: string;
  from_instance: string;
  from_field: string;
  to_instance: string;
  to_field: string;
  from_type: string;
  to_type: string;
}

interface LineageData {
  session_id: string;
  session_name: string;
  columns: ColumnNode[];
  flows: ColumnFlow[];
  instance_count: number;
  connector_count: number;
  message?: string;
}

interface Props {
  tierData: TierMapResult;
  selectedSession?: string | null;
  onSessionSelect?: (sessionId: string) => void;
}

const TYPE_COLORS: Record<string, string> = {
  'Source': '#10B981',
  'Source Qualifier': '#10B981',
  'Target': '#EF4444',
  'Target Definition': '#EF4444',
  'Lookup Procedure': '#F59E0B',
  'Expression': '#A855F7',
  'Filter': '#3B82F6',
  'Router': '#EC4899',
  'Joiner': '#06B6D4',
  'Aggregator': '#84CC16',
  'Sorter': '#F97316',
  'Sequence Generator': '#6366F1',
};

/** Map transformation type to a color, matching by substring (case-insensitive). */
function getTypeColor(type: string): string {
  for (const [key, color] of Object.entries(TYPE_COLORS)) {
    if (type.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return '#64748b';
}

/**
 * LineageBuilder -- column-level lineage viewer showing field-to-field data
 * flow through transformation instances. Clicking any field triggers a
 * bidirectional BFS trace that highlights the complete forward and backward
 * lineage path, dimming unrelated fields.
 */
export default function LineageBuilder({ tierData, selectedSession, onSessionSelect }: Props) {
  const [sessionId, setSessionId] = useState(selectedSession || '');
  const [lineageData, setLineageData] = useState<LineageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // Group columns by instance
  const instanceGroups = useMemo(() => {
    if (!lineageData) return [];
    const groups: Record<string, { type: string; columns: ColumnNode[] }> = {};
    for (const col of lineageData.columns) {
      if (!groups[col.instance]) {
        groups[col.instance] = {
          type: col.transformation_type || col.instance_type,
          columns: [],
        };
      }
      groups[col.instance].columns.push(col);
    }
    return Object.entries(groups).map(([name, g]) => ({
      name,
      type: g.type,
      columns: g.columns,
    }));
  }, [lineageData]);

  // Build adjacency for tracing
  const adjacency = useMemo(() => {
    if (!lineageData) return { forward: new Map<string, string[]>(), backward: new Map<string, string[]>() };
    const forward = new Map<string, string[]>();
    const backward = new Map<string, string[]>();
    for (const flow of lineageData.flows) {
      const fwd = forward.get(flow.from) || [];
      fwd.push(flow.to);
      forward.set(flow.from, fwd);
      const bwd = backward.get(flow.to) || [];
      bwd.push(flow.from);
      backward.set(flow.to, bwd);
    }
    return { forward, backward };
  }, [lineageData]);

  const loadLineage = useCallback(async (sid: string) => {
    if (!sid) return;
    setLoading(true);
    try {
      const data = await getColumnLineage(tierData, sid) as unknown as LineageData;
      setLineageData(data);
      setHighlighted(new Set());
      setSelectedNode(null);
    } catch {
      setLineageData(null);
    } finally {
      setLoading(false);
    }
  }, [tierData]);

  useEffect(() => {
    if (selectedSession) {
      setSessionId(selectedSession);
      loadLineage(selectedSession);
    }
  }, [selectedSession, loadLineage]);

  // Trace forward + backward from selected node
  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNode(nodeId);
    const traced = new Set<string>();
    // Forward trace
    const queue = [nodeId];
    while (queue.length) {
      const cur = queue.shift()!;
      if (traced.has(cur)) continue;
      traced.add(cur);
      for (const next of adjacency.forward.get(cur) || []) {
        queue.push(next);
      }
    }
    // Backward trace
    const queue2 = [nodeId];
    const visited = new Set<string>();
    while (queue2.length) {
      const cur = queue2.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      traced.add(cur);
      for (const prev of adjacency.backward.get(cur) || []) {
        queue2.push(prev);
      }
    }
    setHighlighted(traced);
  }, [adjacency]);

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
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Column Lineage</h3>
        <select
          value={sessionId}
          onChange={e => { setSessionId(e.target.value); loadLineage(e.target.value); }}
          style={{
            flex: 1, maxWidth: 300, padding: '4px 8px', fontSize: 11,
            background: '#1e293b', border: '1px solid #334155', borderRadius: 4,
            color: '#e2e8f0',
          }}
        >
          <option value="">Select session...</option>
          {tierData.sessions?.map(s => (
            <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
          ))}
        </select>
        {lineageData && (
          <span style={{ fontSize: 10, color: '#64748b' }}>
            {lineageData.connector_count} connectors | {instanceGroups.length} transforms
          </span>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>Loading lineage...</div>
        )}

        {!loading && !lineageData && !sessionId && (
          <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>
            Select a session above to view column-level lineage.
          </div>
        )}

        {!loading && lineageData?.message && (
          <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>{lineageData.message}</div>
        )}

        {!loading && lineageData && !lineageData.message && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {instanceGroups.map(group => {
              const color = getTypeColor(group.type);
              return (
                <div key={group.name} style={{
                  border: `1px solid ${color}33`,
                  borderRadius: 8, overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '6px 12px', background: `${color}15`,
                    display: 'flex', alignItems: 'center', gap: 8,
                    borderBottom: `1px solid ${color}33`,
                  }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: 4,
                      background: color, flexShrink: 0,
                    }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color }}>{group.name}</span>
                    <span style={{ fontSize: 9, color: '#64748b' }}>{group.type}</span>
                    <span style={{ fontSize: 9, color: '#475569', marginLeft: 'auto' }}>
                      {group.columns.length} fields
                    </span>
                  </div>
                  <div style={{ padding: '4px 0' }}>
                    {group.columns.slice(0, 30).map(col => {
                      const isHighlighted = highlighted.has(col.id);
                      const isSelected = selectedNode === col.id;
                      return (
                        <div
                          key={col.id}
                          onClick={() => handleNodeClick(col.id)}
                          style={{
                            padding: '3px 12px', fontSize: 10, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 8,
                            background: isSelected ? `${color}22` : isHighlighted ? 'rgba(59,130,246,0.08)' : 'transparent',
                            opacity: highlighted.size > 0 && !isHighlighted ? 0.3 : 1,
                          }}
                        >
                          <span style={{ color: isHighlighted ? '#e2e8f0' : '#94a3b8', minWidth: 120 }}>{col.field}</span>
                          <span style={{ color: '#475569', fontSize: 9 }}>{col.datatype}</span>
                          {col.expression_type !== 'passthrough' && (
                            <span style={{
                              fontSize: 8, padding: '1px 4px', borderRadius: 2,
                              background: col.expression_type === 'derived' ? '#A855F722' :
                                col.expression_type === 'aggregated' ? '#F59E0B22' :
                                col.expression_type === 'lookup' ? '#3B82F622' : '#64748b22',
                              color: col.expression_type === 'derived' ? '#A855F7' :
                                col.expression_type === 'aggregated' ? '#F59E0B' :
                                col.expression_type === 'lookup' ? '#3B82F6' : '#64748b',
                            }}>
                              {col.expression_type}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {group.columns.length > 30 && (
                      <div style={{ padding: '3px 12px', fontSize: 9, color: '#475569' }}>
                        +{group.columns.length - 30} more fields
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!loading && !lineageData && !sessionId && (
          <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>
            Select a session to view column-level lineage
          </div>
        )}
      </div>
    </div>
  );
}
