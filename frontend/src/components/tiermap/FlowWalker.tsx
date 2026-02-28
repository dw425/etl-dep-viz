/**
 * FlowWalker — End-to-end flow walking view.
 * Left: upstream/downstream chain. Center: mapping pipeline. Right: context.
 */

import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import type { VectorResults } from '../../types/vectors';
import { getFlowData } from '../../api/client';

const SqlViewer = lazy(() => import('../shared/SqlViewer'));
const ExpressionViewer = lazy(() => import('../shared/ExpressionViewer'));

interface FlowSession {
  session_id: string;
  name: string;
  tier: number;
  via_table?: string;
}

interface FlowData {
  session: Record<string, unknown>;
  upstream: FlowSession[];
  downstream: FlowSession[];
  mapping_detail: Record<string, unknown> | null;
  tables_touched: Record<string, unknown>[];
  complexity: Record<string, unknown> | null;
  wave_info: Record<string, unknown> | null;
  scc: Record<string, unknown> | null;
  upstream_count: number;
  downstream_count: number;
}

interface Props {
  tierData: TierMapResult;
  vectorResults: VectorResults | null;
}

export default function FlowWalkerView({ tierData, vectorResults }: Props) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [flowData, setFlowData] = useState<FlowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedTransform, setExpandedTransform] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedField, setSelectedField] = useState<string | null>(null);

  const sessions = useMemo(() => tierData.sessions || [], [tierData]);
  const filteredSessions = useMemo(() => {
    if (!searchTerm) return sessions.slice(0, 50);
    const term = searchTerm.toLowerCase();
    return sessions.filter(s =>
      s.full?.toLowerCase().includes(term) || s.name?.toLowerCase().includes(term)
    ).slice(0, 50);
  }, [sessions, searchTerm]);

  const loadFlow = useCallback(async (sessionId: string) => {
    setLoading(true);
    setExpandedTransform(null);
    setSelectedField(null);
    try {
      const body = vectorResults
        ? { ...tierData, __vector_results: vectorResults }
        : tierData;
      const data = await getFlowData(tierData, sessionId);
      setFlowData(data as unknown as FlowData);
      setSelectedSessionId(sessionId);
    } catch (e) {
      console.error('Flow load error:', e);
    } finally {
      setLoading(false);
    }
  }, [tierData, vectorResults]);

  // Auto-select first session
  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      loadFlow(sessions[0].id);
    }
  }, [sessions, selectedSessionId, loadFlow]);

  const md = flowData?.mapping_detail as Record<string, unknown> | null;
  const instances = (md?.instances as Record<string, unknown>[]) || [];
  const connectors = (md?.connectors as Record<string, unknown>[]) || [];
  const fields = (md?.fields as Record<string, unknown>[]) || [];
  const sqlOverrides = (md?.sql_overrides as Record<string, unknown>[]) || [];
  const joinConditions = (md?.join_conditions as Record<string, unknown>[]) || [];
  const filterConditions = (md?.filter_conditions as Record<string, unknown>[]) || [];
  const routerGroups = (md?.router_groups as Record<string, unknown>[]) || [];
  const lookupConfigs = (md?.lookup_configs as Record<string, unknown>[]) || [];
  const preSql = (md?.pre_sql as string[]) || [];
  const postSql = (md?.post_sql as string[]) || [];
  const parameters = (md?.parameters as string[]) || [];

  // Group fields by transform
  const fieldsByTransform = useMemo(() => {
    const map: Record<string, Record<string, unknown>[]> = {};
    for (const f of fields) {
      const t = f.transform as string;
      if (!map[t]) map[t] = [];
      map[t].push(f);
    }
    return map;
  }, [fields]);

  // Categorize instances
  const sourceInsts = instances.filter(i => (i.type as string)?.toLowerCase() === 'source');
  const targetInsts = instances.filter(i => (i.type as string)?.toLowerCase() === 'target');
  const transformInsts = instances.filter(i => {
    const t = (i.type as string)?.toLowerCase();
    return t !== 'source' && t !== 'target';
  });

  const tierColor = (tier: number) => {
    if (tier <= 1) return '#10B981';
    if (tier <= 3) return '#3b82f6';
    if (tier <= 5) return '#F97316';
    return '#ef4444';
  };

  const session = flowData?.session as Record<string, unknown> | undefined;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left Panel: Flow Chain */}
      <div style={{ width: 260, borderRight: '1px solid #334155', overflow: 'auto', flexShrink: 0 }}>
        <div style={{ padding: '12px', borderBottom: '1px solid #334155' }}>
          <input
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search sessions..."
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6,
              border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0',
              fontSize: 11, outline: 'none',
            }}
          />
        </div>

        {/* Upstream */}
        {flowData && flowData.upstream.length > 0 && (
          <div style={{ padding: '8px 12px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>
              Upstream ({flowData.upstream_count})
            </div>
            {flowData.upstream.map((u, i) => (
              <div
                key={i}
                onClick={() => loadFlow(u.session_id)}
                style={{
                  padding: '6px 8px', borderRadius: 6, marginBottom: 4,
                  border: '1px solid #1e293b', cursor: 'pointer', fontSize: 11,
                  background: u.session_id === selectedSessionId ? 'rgba(59,130,246,0.15)' : 'transparent',
                }}
              >
                <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{u.name}</div>
                <div style={{ fontSize: 10, color: '#64748b', display: 'flex', gap: 6 }}>
                  <span style={{ color: tierColor(u.tier) }}>T{u.tier}</span>
                  {u.via_table && <span>via {u.via_table}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Current Session */}
        {flowData && (
          <div style={{ padding: '4px 12px' }}>
            <div style={{
              padding: '8px 10px', borderRadius: 8, background: 'rgba(59,130,246,0.2)',
              border: '1px solid #3b82f6',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa' }}>
                {(session?.full as string) || (session?.name as string)}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                Tier {session?.tier as number} | {(session?.transforms as number) || 0} transforms
              </div>
            </div>
          </div>
        )}

        {/* Downstream */}
        {flowData && flowData.downstream.length > 0 && (
          <div style={{ padding: '8px 12px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>
              Downstream ({flowData.downstream_count})
            </div>
            {flowData.downstream.map((d, i) => (
              <div
                key={i}
                onClick={() => loadFlow(d.session_id)}
                style={{
                  padding: '6px 8px', borderRadius: 6, marginBottom: 4,
                  border: '1px solid #1e293b', cursor: 'pointer', fontSize: 11,
                }}
              >
                <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{d.name}</div>
                <div style={{ fontSize: 10, color: '#64748b', display: 'flex', gap: 6 }}>
                  <span style={{ color: tierColor(d.tier) }}>T{d.tier}</span>
                  {d.via_table && <span>via {d.via_table}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Session browser */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid #334155' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>
            All Sessions
          </div>
          {filteredSessions.map(s => (
            <div
              key={s.id}
              onClick={() => loadFlow(s.id)}
              style={{
                padding: '4px 8px', borderRadius: 4, marginBottom: 2,
                cursor: 'pointer', fontSize: 11,
                background: s.id === selectedSessionId ? 'rgba(59,130,246,0.1)' : 'transparent',
                color: s.id === selectedSessionId ? '#60a5fa' : '#94a3b8',
              }}
            >
              {s.name}
            </div>
          ))}
        </div>
      </div>

      {/* Center Panel: Mapping Pipeline */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>
            Loading flow data...
          </div>
        )}

        {!loading && flowData && (
          <Suspense fallback={<div style={{ color: '#64748b' }}>Loading...</div>}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>
                Mapping Pipeline: {(session?.full as string) || ''}
              </div>

              {/* Source instances */}
              {sourceInsts.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#10B981', textTransform: 'uppercase', marginBottom: 6 }}>Sources</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {sourceInsts.map((inst, i) => (
                      <div key={i} style={{
                        padding: '6px 12px', borderRadius: 6, background: 'rgba(16,185,129,0.1)',
                        border: '1px solid rgba(16,185,129,0.3)', fontSize: 11,
                      }}>
                        <div style={{ fontWeight: 600, color: '#10B981' }}>{inst.transformation_name as string}</div>
                        <div style={{ fontSize: 10, color: '#64748b' }}>{inst.name as string}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Transform pipeline */}
              {transformInsts.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', marginBottom: 6 }}>Transforms</div>
                  {transformInsts.map((inst, i) => {
                    const tName = inst.name as string;
                    const tType = (inst.transformation_type as string) || (inst.type as string);
                    const isExpanded = expandedTransform === tName;
                    const instFields = fieldsByTransform[inst.transformation_name as string] || fieldsByTransform[tName] || [];
                    const sqlOvr = sqlOverrides.find(s => s.transform === (inst.transformation_name as string) || s.transform === tName);
                    const joinCond = joinConditions.find(j => j.joiner === tName || j.joiner === (inst.transformation_name as string));
                    const filterCond = filterConditions.find(f => f.filter === tName || f.filter === (inst.transformation_name as string));
                    const lkpCfg = lookupConfigs.find(l => l.lookup === tName || l.lookup === (inst.transformation_name as string));

                    return (
                      <div key={i} style={{ marginBottom: 8 }}>
                        <div
                          onClick={() => setExpandedTransform(isExpanded ? null : tName)}
                          style={{
                            padding: '8px 12px', borderRadius: 6,
                            background: isExpanded ? 'rgba(59,130,246,0.15)' : '#111827',
                            border: `1px solid ${isExpanded ? '#3b82f6' : '#1e293b'}`,
                            cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          }}
                        >
                          <div>
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0' }}>{tName}</span>
                            <span style={{ fontSize: 10, color: '#64748b', marginLeft: 8 }}>{tType}</span>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {instFields.length > 0 && <span style={{ fontSize: 10, color: '#64748b' }}>{instFields.length} fields</span>}
                            {sqlOvr && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(96,165,250,0.2)', color: '#60a5fa' }}>SQL</span>}
                            {joinCond && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(249,115,22,0.2)', color: '#F97316' }}>JOIN</span>}
                            {filterCond && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(245,158,11,0.2)', color: '#F59E0B' }}>FILTER</span>}
                            {lkpCfg && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(168,139,250,0.2)', color: '#A78BFA' }}>LKP</span>}
                            <span style={{ fontSize: 11, color: '#64748b' }}>{isExpanded ? '\u25BC' : '\u25B6'}</span>
                          </div>
                        </div>
                        {isExpanded && (
                          <div style={{ padding: '8px 12px', background: '#0f172a', borderRadius: '0 0 6px 6px', border: '1px solid #1e293b', borderTop: 'none' }}>
                            {/* SQL Override */}
                            {sqlOvr && <SqlViewer sql={sqlOvr.sql as string} title="SQL Override" />}
                            {/* Join condition */}
                            {joinCond && (
                              <div style={{ marginBottom: 8 }}>
                                <div style={{ fontSize: 10, fontWeight: 600, color: '#F97316', marginBottom: 4 }}>Join: {joinCond.type as string}</div>
                                <ExpressionViewer expression={joinCond.condition as string} onFieldClick={setSelectedField} />
                              </div>
                            )}
                            {/* Filter condition */}
                            {filterCond && (
                              <div style={{ marginBottom: 8 }}>
                                <div style={{ fontSize: 10, fontWeight: 600, color: '#F59E0B', marginBottom: 4 }}>Filter Condition</div>
                                <ExpressionViewer expression={filterCond.condition as string} onFieldClick={setSelectedField} />
                              </div>
                            )}
                            {/* Lookup config */}
                            {lkpCfg && (
                              <div style={{ marginBottom: 8 }}>
                                <div style={{ fontSize: 10, fontWeight: 600, color: '#A78BFA', marginBottom: 4 }}>
                                  Lookup: {lkpCfg.table as string} {lkpCfg.connection ? `(${lkpCfg.connection})` : ''}
                                </div>
                                <ExpressionViewer expression={lkpCfg.condition as string} onFieldClick={setSelectedField} />
                              </div>
                            )}
                            {/* Fields */}
                            {instFields.length > 0 && (
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, marginTop: 8 }}>
                                <thead>
                                  <tr style={{ borderBottom: '1px solid #334155' }}>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#64748b' }}>Field</th>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#64748b' }}>Type</th>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#64748b' }}>Port</th>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#64748b' }}>Expr Type</th>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#64748b' }}>Expression</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {instFields.map((f, fi) => (
                                    <tr key={fi} style={{
                                      borderBottom: '1px solid #1e293b',
                                      background: selectedField === (f.name as string) ? 'rgba(59,130,246,0.1)' : 'transparent',
                                    }}>
                                      <td style={{ padding: '3px 4px', color: '#e2e8f0', fontWeight: 500 }}>{f.name as string}</td>
                                      <td style={{ padding: '3px 4px', color: '#64748b' }}>{f.datatype as string}</td>
                                      <td style={{ padding: '3px 4px', color: '#64748b' }}>{f.porttype as string}</td>
                                      <td style={{ padding: '3px 4px' }}>
                                        <span style={{
                                          padding: '1px 5px', borderRadius: 3, fontSize: 9,
                                          background: (f.expression_type as string) === 'derived' ? 'rgba(96,165,250,0.15)' :
                                            (f.expression_type as string) === 'aggregated' ? 'rgba(168,139,250,0.15)' :
                                            (f.expression_type as string) === 'constant' ? 'rgba(245,158,11,0.15)' : 'transparent',
                                          color: (f.expression_type as string) === 'derived' ? '#60a5fa' :
                                            (f.expression_type as string) === 'aggregated' ? '#A78BFA' :
                                            (f.expression_type as string) === 'constant' ? '#F59E0B' : '#64748b',
                                        }}>
                                          {f.expression_type as string}
                                        </span>
                                      </td>
                                      <td style={{ padding: '3px 4px', color: '#94a3b8', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {f.expression as string}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Target instances */}
              {targetInsts.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', marginBottom: 6 }}>Targets</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {targetInsts.map((inst, i) => (
                      <div key={i} style={{
                        padding: '6px 12px', borderRadius: 6, background: 'rgba(239,68,68,0.1)',
                        border: '1px solid rgba(239,68,68,0.3)', fontSize: 11,
                      }}>
                        <div style={{ fontWeight: 600, color: '#ef4444' }}>{inst.transformation_name as string}</div>
                        <div style={{ fontSize: 10, color: '#64748b' }}>{inst.name as string}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Connectors summary */}
              {connectors.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>
                    Field Connections ({connectors.length})
                  </div>
                  <div style={{ maxHeight: 200, overflow: 'auto', fontSize: 10 }}>
                    {connectors.slice(0, 100).map((c, i) => (
                      <div key={i} style={{ padding: '2px 0', color: '#94a3b8', display: 'flex', gap: 4 }}>
                        <span style={{ color: '#10B981' }}>{c.from_instance as string}</span>
                        <span>.{c.from_field as string}</span>
                        <span style={{ color: '#64748b' }}>{'\u2192'}</span>
                        <span style={{ color: '#ef4444' }}>{c.to_instance as string}</span>
                        <span>.{c.to_field as string}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Suspense>
        )}
      </div>

      {/* Right Panel: Context */}
      <div style={{ width: 280, borderLeft: '1px solid #334155', overflow: 'auto', flexShrink: 0, padding: 12 }}>
        {flowData && session && (
          <>
            {/* Session metadata */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Session Info</div>
              {[
                ['Name', session.full || session.name],
                ['Tier', session.tier],
                ['Transforms', session.transforms],
                ['Sources', (session.sources as string[])?.length || 0],
                ['Targets', (session.targets as string[])?.length || 0],
                ['Lookups', (session.lookups as string[])?.length || 0],
              ].map(([k, v]) => (
                <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11 }}>
                  <span style={{ color: '#64748b' }}>{k as string}</span>
                  <span style={{ color: '#e2e8f0', fontWeight: 500 }}>{String(v)}</span>
                </div>
              ))}
            </div>

            {/* Complexity */}
            {flowData.complexity && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Complexity</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#3b82f6' }}>
                    {(flowData.complexity.overall_score as number)?.toFixed(0)}
                  </div>
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                    background: 'rgba(59,130,246,0.15)', color: '#60a5fa',
                  }}>
                    {flowData.complexity.bucket as string}
                  </span>
                </div>
              </div>
            )}

            {/* Connected sessions */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Connections</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>
                {flowData.upstream_count} upstream, {flowData.downstream_count} downstream
              </div>
            </div>

            {/* Tables touched */}
            {flowData.tables_touched.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Tables ({flowData.tables_touched.length})</div>
                {flowData.tables_touched.map((t, i) => (
                  <div key={i} style={{ padding: '3px 0', fontSize: 11, display: 'flex', gap: 6 }}>
                    <span style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 3,
                      background: (t.relation as string) === 'reads' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                      color: (t.relation as string) === 'reads' ? '#10B981' : '#ef4444',
                    }}>
                      {(t.relation as string) === 'reads' ? 'R' : 'W'}
                    </span>
                    <span style={{ color: '#e2e8f0' }}>{t.name as string}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Parameters */}
            {parameters.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Parameters</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {parameters.map(p => (
                    <span key={p} style={{
                      padding: '2px 8px', borderRadius: 4, fontSize: 10,
                      background: 'rgba(244,114,182,0.15)', color: '#F472B6',
                    }}>{p}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Pre/Post SQL */}
            <Suspense fallback={null}>
              {preSql.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {preSql.map((sql, i) => (
                    <SqlViewer key={i} sql={sql} title={`Pre-Session SQL ${i + 1}`} defaultCollapsed />
                  ))}
                </div>
              )}
              {postSql.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {postSql.map((sql, i) => (
                    <SqlViewer key={i} sql={sql} title={`Post-Session SQL ${i + 1}`} defaultCollapsed />
                  ))}
                </div>
              )}
            </Suspense>
          </>
        )}
      </div>
    </div>
  );
}
