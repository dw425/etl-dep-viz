/**
 * FlowWalker — End-to-end flow walking view.
 *
 * Layout (three-panel):
 *   Left  (260px) — Session browser + upstream/downstream chain for the selected session
 *   Center (flex) — Mapping pipeline: sources → transforms (expandable) → targets + connectors
 *   Right (280px) — Context: session metadata, complexity score, tables, parameters, pre/post SQL
 *
 * Data flow:
 *   1. Sessions from tierData are listed and filtered by searchTerm (capped at 50)
 *   2. Selecting a session calls loadFlow() → POST /api/layers/flow/{sessionId}
 *   3. The response (FlowData) populates all three panels
 *   4. SQL overrides, join/filter conditions, and expressions are rendered via lazy viewers
 */

import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import type { VectorResults } from '../../types/vectors';
import { getFlowData } from '../../api/client';
import { useCommitSearch } from '../../hooks/useCommitSearch';

const SqlViewer = lazy(() => import('../shared/SqlViewer'));
const ExpressionViewer = lazy(() => import('../shared/ExpressionViewer'));

/** Session entry in the upstream/downstream chain, linked via a shared table. */
interface FlowSession {
  session_id: string;
  name: string;
  tier: number;
  /** The shared table that forms the dependency between sessions */
  via_table?: string;
}

/** Full flow data response from POST /api/layers/flow/{sessionId}. */
interface FlowData {
  /** Session metadata (name, tier, transforms, sources/targets/lookups) */
  session: Record<string, unknown>;
  /** Sessions that feed data into this session */
  upstream: FlowSession[];
  /** Sessions that consume this session's output */
  downstream: FlowSession[];
  /** Deep Informatica parse results: instances, connectors, fields, SQL, conditions */
  mapping_detail: Record<string, unknown> | null;
  /** All tables referenced by this session with relation type */
  tables_touched: Record<string, unknown>[];
  /** V11 complexity score and bucket for this session */
  complexity: Record<string, unknown> | null;
  /** V4 wave assignment info */
  wave_info: Record<string, unknown> | null;
  /** Strongly connected component membership */
  scc: Record<string, unknown> | null;
  upstream_count: number;
  downstream_count: number;
}

interface Props {
  tierData: TierMapResult;
  vectorResults: VectorResults | null;
  uploadId?: number | null;
}

/**
 * FlowWalkerView -- three-panel end-to-end flow exploration view.
 *
 * Left panel: session browser + upstream/downstream dependency chain.
 * Center panel: mapping pipeline (source -> transforms -> target) with
 *   expandable transform cards showing SQL overrides, join/filter conditions,
 *   lookup configs, and field-level detail.
 * Right panel: session metadata, complexity score, tables, parameters, pre/post SQL.
 */
export default function FlowWalkerView({ tierData, vectorResults, uploadId }: Props) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [flowData, setFlowData] = useState<FlowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedTransform, setExpandedTransform] = useState<string | null>(null);
  const { committedValue: searchTerm, inputProps: searchInputProps, clear: clearSearch } = useCommitSearch();
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [showAllUpstream, setShowAllUpstream] = useState(false);
  const [showAllDownstream, setShowAllDownstream] = useState(false);

  const sessions = useMemo(() => tierData.sessions || [], [tierData]);

  // Apply filters to session list
  const filteredSessions = useMemo(() => {
    let list = sessions;
    const term = searchTerm.toLowerCase();
    if (term) {
      list = list.filter(s =>
        s.full?.toLowerCase().includes(term) || s.name?.toLowerCase().includes(term)
      );
    }
    if (tierFilter !== 'all') {
      const [lo, hi] = tierFilter.split('-').map(Number);
      list = list.filter(s => s.tier >= lo && s.tier <= hi);
    }
    if (criticalOnly) {
      list = list.filter(s => s.critical);
    }
    return list.slice(0, 50);
  }, [sessions, searchTerm, tierFilter, criticalOnly]);

  // Filter upstream/downstream by search term
  const filteredUpstream = useMemo(() => {
    if (!flowData) return [];
    const term = searchTerm.toLowerCase();
    const list = term
      ? flowData.upstream.filter(u => u.name.toLowerCase().includes(term))
      : flowData.upstream;
    return showAllUpstream ? list : list.slice(0, 20);
  }, [flowData, searchTerm, showAllUpstream]);

  const filteredDownstream = useMemo(() => {
    if (!flowData) return [];
    const term = searchTerm.toLowerCase();
    const list = term
      ? flowData.downstream.filter(d => d.name.toLowerCase().includes(term))
      : flowData.downstream;
    return showAllDownstream ? list : list.slice(0, 20);
  }, [flowData, searchTerm, showAllDownstream]);

  const loadFlow = useCallback(async (sessionId: string) => {
    setLoading(true);
    setLoadError(null);
    setExpandedTransform(null);
    setSelectedField(null);
    setShowAllUpstream(false);
    setShowAllDownstream(false);
    try {
      const data = await getFlowData(tierData, sessionId, uploadId);
      setFlowData(data as unknown as FlowData);
      setSelectedSessionId(sessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Flow load error:', msg);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [tierData, uploadId]);

  // Auto-load the first session on mount so the view is never blank after opening
  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      loadFlow(sessions[0].id);
    }
  }, [sessions, selectedSessionId, loadFlow]);

  // ── Destructure mapping_detail from the flow response ─────────────────────
  // mapping_detail contains the deep Informatica parse results (instances, connectors,
  // fields, SQL overrides, join/filter conditions, router groups, lookup configs).
  const md = flowData?.mapping_detail as Record<string, unknown> | null;
  const instances = (md?.instances as Record<string, unknown>[]) || [];
  const connectors = (md?.connectors as Record<string, unknown>[]) || [];
  const fields = (md?.fields as Record<string, unknown>[]) || [];
  const sqlOverrides = (md?.sql_overrides as Record<string, unknown>[]) || [];
  const joinConditions = (md?.join_conditions as Record<string, unknown>[]) || [];
  const filterConditions = (md?.filter_conditions as Record<string, unknown>[]) || [];
  const routerGroups = (md?.router_groups as Record<string, unknown>[]) || [];
  const lookupConfigs = (md?.lookup_configs as Record<string, unknown>[]) || [];
  // Pre/post SQL run at the session level (not per-transform)
  const preSql = (md?.pre_sql as string[]) || [];
  const postSql = (md?.post_sql as string[]) || [];
  const parameters = (md?.parameters as string[]) || [];

  // Group field metadata by transform name so each transform card can show its own fields
  const fieldsByTransform = useMemo(() => {
    const map: Record<string, Record<string, unknown>[]> = {};
    for (const f of fields) {
      const t = f.transform as string;
      if (!map[t]) map[t] = [];
      map[t].push(f);
    }
    return map;
  }, [fields]);

  // Split instances into source, target, and transform buckets for rendering order
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
      <div style={{ width: 260, borderRight: '1px solid #4a5a6e', overflow: 'auto', flexShrink: 0 }}>
        <div style={{ padding: '12px', borderBottom: '1px solid #4a5a6e' }}>
          <input
            {...searchInputProps}
            placeholder="Search sessions... (Enter to search)"
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6,
              border: '1px solid #4a5a6e', background: '#1a2332', color: '#e2e8f0',
              fontSize: 11, outline: 'none', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
            <select value={tierFilter} onChange={e => setTierFilter(e.target.value)}
              style={{ flex: 1, padding: '3px 4px', borderRadius: 4, border: '1px solid #4a5a6e', background: '#1a2332', color: '#94a3b8', fontSize: 10 }}>
              <option value="all">All Tiers</option>
              <option value="1-1">Tier 1</option>
              <option value="1-3">Tier 1-3</option>
              <option value="4-10">Tier 4-10</option>
              <option value="11-99">Tier 11+</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#94a3b8', cursor: 'pointer' }}>
              <input type="checkbox" checked={criticalOnly} onChange={e => setCriticalOnly(e.target.checked)}
                style={{ width: 12, height: 12 }} />
              Critical
            </label>
          </div>
        </div>

        {/* Upstream */}
        {flowData && flowData.upstream.length > 0 && (
          <div style={{ padding: '8px 12px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#8899aa', textTransform: 'uppercase', marginBottom: 6 }}>
              Upstream ({flowData.upstream_count}){searchTerm && filteredUpstream.length < flowData.upstream.length && ` — ${filteredUpstream.length} matching`}
            </div>
            {filteredUpstream.map((u, i) => (
              <div
                key={i}
                onClick={() => loadFlow(u.session_id)}
                style={{
                  padding: '6px 8px', borderRadius: 6, marginBottom: 4,
                  border: '1px solid #3a4a5e', cursor: 'pointer', fontSize: 11,
                  background: u.session_id === selectedSessionId ? 'rgba(59,130,246,0.15)' : 'transparent',
                }}
              >
                <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{u.name}</div>
                <div style={{ fontSize: 10, color: '#8899aa', display: 'flex', gap: 6 }}>
                  <span style={{ color: tierColor(u.tier) }}>T{u.tier}</span>
                  {u.via_table && <span>via {u.via_table}</span>}
                </div>
              </div>
            ))}
            {!showAllUpstream && !searchTerm && flowData.upstream.length > 20 && (
              <div onClick={() => setShowAllUpstream(true)}
                style={{ fontSize: 10, color: '#3b82f6', cursor: 'pointer', padding: '4px 8px' }}>
                Show all {flowData.upstream.length} upstream...
              </div>
            )}
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
            <div style={{ fontSize: 10, fontWeight: 700, color: '#8899aa', textTransform: 'uppercase', marginBottom: 6 }}>
              Downstream ({flowData.downstream_count}){searchTerm && filteredDownstream.length < flowData.downstream.length && ` — ${filteredDownstream.length} matching`}
            </div>
            {filteredDownstream.map((d, i) => (
              <div
                key={i}
                onClick={() => loadFlow(d.session_id)}
                style={{
                  padding: '6px 8px', borderRadius: 6, marginBottom: 4,
                  border: '1px solid #3a4a5e', cursor: 'pointer', fontSize: 11,
                }}
              >
                <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{d.name}</div>
                <div style={{ fontSize: 10, color: '#8899aa', display: 'flex', gap: 6 }}>
                  <span style={{ color: tierColor(d.tier) }}>T{d.tier}</span>
                  {d.via_table && <span>via {d.via_table}</span>}
                </div>
              </div>
            ))}
            {!showAllDownstream && !searchTerm && flowData.downstream.length > 20 && (
              <div onClick={() => setShowAllDownstream(true)}
                style={{ fontSize: 10, color: '#3b82f6', cursor: 'pointer', padding: '4px 8px' }}>
                Show all {flowData.downstream.length} downstream...
              </div>
            )}
          </div>
        )}

        {/* Session browser */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid #4a5a6e' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#8899aa', textTransform: 'uppercase', marginBottom: 6 }}>
            All Sessions {filteredSessions.length < sessions.length && `(${filteredSessions.length} shown)`}
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
              {s.critical && <span style={{ marginLeft: 4, fontSize: 9, color: '#ef4444' }}>!</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Center Panel: Mapping Pipeline */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8899aa' }}>
            Loading flow data...
          </div>
        )}

        {!loading && loadError && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
            <div style={{ color: '#ef4444', fontSize: 13 }}>Failed to load flow data</div>
            <div style={{ color: '#8899aa', fontSize: 11, maxWidth: 400, textAlign: 'center' }}>{loadError}</div>
          </div>
        )}

        {!loading && !loadError && !flowData && !selectedSessionId && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8899aa' }}>
            Select a session to view its flow
          </div>
        )}

        {!loading && flowData && (
          <Suspense fallback={<div style={{ color: '#8899aa' }}>Loading...</div>}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>
                Mapping Pipeline: {(session?.full as string) || ''}
              </div>

              {/* No mapping detail available */}
              {!md && instances.length === 0 && (
                <div style={{
                  padding: 24, textAlign: 'center', borderRadius: 10,
                  background: 'rgba(100,116,139,0.08)', border: '1px dashed #4a5a6e',
                }}>
                  <div style={{ fontSize: 13, color: '#8899aa', marginBottom: 8 }}>No mapping detail available</div>
                  <div style={{ fontSize: 11, color: '#5a6a7a' }}>
                    Upstream/downstream chain and tables are shown in the side panels.
                    {flowData.tables_touched?.length > 0 && ` This session touches ${flowData.tables_touched.length} tables.`}
                  </div>
                </div>
              )}

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
                        <div style={{ fontSize: 10, color: '#8899aa' }}>{inst.name as string}</div>
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
                    // Look up fields/conditions by both instance name and transformation_name
                    // because Informatica XML uses slightly different keys in different places
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
                            background: isExpanded ? 'rgba(59,130,246,0.15)' : '#243044',
                            border: `1px solid ${isExpanded ? '#3b82f6' : '#3a4a5e'}`,
                            cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          }}
                        >
                          <div>
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0' }}>{tName}</span>
                            <span style={{ fontSize: 10, color: '#8899aa', marginLeft: 8 }}>{tType}</span>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {instFields.length > 0 && <span style={{ fontSize: 10, color: '#8899aa' }}>{instFields.length} fields</span>}
                            {sqlOvr && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(96,165,250,0.2)', color: '#60a5fa' }}>SQL</span>}
                            {joinCond && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(249,115,22,0.2)', color: '#F97316' }}>JOIN</span>}
                            {filterCond && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(245,158,11,0.2)', color: '#F59E0B' }}>FILTER</span>}
                            {lkpCfg && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(168,139,250,0.2)', color: '#A78BFA' }}>LKP</span>}
                            <span style={{ fontSize: 11, color: '#8899aa' }}>{isExpanded ? '\u25BC' : '\u25B6'}</span>
                          </div>
                        </div>
                        {isExpanded && (
                          <div style={{ padding: '8px 12px', background: '#1a2332', borderRadius: '0 0 6px 6px', border: '1px solid #3a4a5e', borderTop: 'none' }}>
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
                            {/* Field table — shows all output fields with datatype, port, expr type, and expression */}
                            {instFields.length > 0 && (
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, marginTop: 8 }}>
                                <thead>
                                  <tr style={{ borderBottom: '1px solid #4a5a6e' }}>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#8899aa' }}>Field</th>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#8899aa' }}>Type</th>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#8899aa' }}>Port</th>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#8899aa' }}>Expr Type</th>
                                    <th style={{ textAlign: 'left', padding: '4px', color: '#8899aa' }}>Expression</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {instFields.map((f, fi) => (
                                    <tr key={fi} style={{
                                      borderBottom: '1px solid #3a4a5e',
                                      background: selectedField === (f.name as string) ? 'rgba(59,130,246,0.1)' : 'transparent',
                                    }}>
                                      <td style={{ padding: '3px 4px', color: '#e2e8f0', fontWeight: 500 }}>{f.name as string}</td>
                                      <td style={{ padding: '3px 4px', color: '#8899aa' }}>{f.datatype as string}</td>
                                      <td style={{ padding: '3px 4px', color: '#8899aa' }}>{f.porttype as string}</td>
                                      {/* expression_type badge: derived=blue, aggregated=purple, constant=amber */}
                                      <td style={{ padding: '3px 4px' }}>
                                        <span style={{
                                          padding: '1px 5px', borderRadius: 3, fontSize: 9,
                                          background: (f.expression_type as string) === 'derived' ? 'rgba(96,165,250,0.15)' :
                                            (f.expression_type as string) === 'aggregated' ? 'rgba(168,139,250,0.15)' :
                                            (f.expression_type as string) === 'constant' ? 'rgba(245,158,11,0.15)' : 'transparent',
                                          color: (f.expression_type as string) === 'derived' ? '#60a5fa' :
                                            (f.expression_type as string) === 'aggregated' ? '#A78BFA' :
                                            (f.expression_type as string) === 'constant' ? '#F59E0B' : '#8899aa',
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
                        <div style={{ fontSize: 10, color: '#8899aa' }}>{inst.name as string}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Connectors summary */}
              {connectors.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#8899aa', textTransform: 'uppercase', marginBottom: 6 }}>
                    Field Connections ({connectors.length})
                  </div>
                  <div style={{ maxHeight: 200, overflow: 'auto', fontSize: 10 }}>
                    {connectors.slice(0, 100).map((c, i) => (
                      <div key={i} style={{ padding: '2px 0', color: '#94a3b8', display: 'flex', gap: 4 }}>
                        <span style={{ color: '#10B981' }}>{c.from_instance as string}</span>
                        <span>.{c.from_field as string}</span>
                        <span style={{ color: '#8899aa' }}>{'\u2192'}</span>
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
      <div style={{ width: 280, borderLeft: '1px solid #4a5a6e', overflow: 'auto', flexShrink: 0, padding: 12 }}>
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
                  <span style={{ color: '#8899aa' }}>{k as string}</span>
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
              <div style={{ fontSize: 11, color: '#8899aa' }}>
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
