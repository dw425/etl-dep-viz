/**
 * CompareView — Side-by-side comparison of two uploads.
 *
 * Lets users pick two uploads (baseline vs. comparison) and shows:
 *   - Summary stats (added/removed/changed sessions and tables)
 *   - Session list filtered by status (changed/added/removed/unchanged)
 *   - Per-session side-by-side detail: flow, tables, functions, tiering
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  listUploads,
  compareUploads,
  type UploadSummary,
  type CompareResult,
  type SessionDetail,
} from '../../api/client';

interface CompareViewProps {
  currentUploadId: number | null;
  onToast: (msg: string, severity: 'error' | 'warning' | 'info' | 'success') => void;
}

type FilterMode = 'all' | 'changed' | 'added' | 'removed' | 'unchanged';

// ── Inline theme tokens ─────────────────────────────────────────────────
const T = {
  bg: '#0f172a',
  bgCard: '#1e293b',
  bgHover: '#334155',
  border: '#334155',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textDim: '#64748b',
  accent: '#3B82F6',
  green: '#10B981',
  red: '#EF4444',
  yellow: '#F59E0B',
  purple: '#A855F7',
};

function Badge({ label, color, count }: { label: string; color: string; count: number }) {
  return (
    <div
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 10px', borderRadius: 6,
        background: `${color}18`, border: `1px solid ${color}40`,
        fontSize: 12, color, cursor: 'pointer',
      }}
    >
      <span style={{ fontWeight: 700 }}>{count}</span>
      <span>{label}</span>
    </div>
  );
}

function FieldDiff({ label, oldVal, newVal }: { label: string; oldVal: unknown; newVal: unknown }) {
  const old = String(oldVal ?? '-');
  const nw = String(newVal ?? '-');
  const changed = old !== nw;
  return (
    <tr style={{ borderBottom: `1px solid ${T.border}` }}>
      <td style={{ padding: '4px 8px', color: T.textMuted, fontSize: 11, width: 160 }}>{label}</td>
      <td style={{ padding: '4px 8px', textAlign: 'right', fontSize: 12, color: changed ? T.red : T.textDim, textDecoration: changed ? 'line-through' : 'none' }}>{old}</td>
      <td style={{ padding: '4px 8px', textAlign: 'center', fontSize: 10, color: T.textDim }}>{changed ? '\u2192' : '='}</td>
      <td style={{ padding: '4px 8px', textAlign: 'left', fontSize: 12, color: changed ? T.green : T.textDim }}>{nw}</td>
    </tr>
  );
}

function ListDiff({ label, oldList, newList }: { label: string; oldList: string[]; newList: string[] }) {
  const oldSet = new Set(oldList);
  const newSet = new Set(newList);
  const added = [...newSet].filter(x => !oldSet.has(x)).sort();
  const removed = [...oldSet].filter(x => !newSet.has(x)).sort();
  const common = [...oldSet].filter(x => newSet.has(x)).sort();
  if (added.length === 0 && removed.length === 0 && common.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {removed.map(t => (
          <span key={`r-${t}`} style={{ padding: '2px 6px', borderRadius: 4, fontSize: 10, background: `${T.red}20`, color: T.red, textDecoration: 'line-through' }}>{t}</span>
        ))}
        {added.map(t => (
          <span key={`a-${t}`} style={{ padding: '2px 6px', borderRadius: 4, fontSize: 10, background: `${T.green}20`, color: T.green }}>+ {t}</span>
        ))}
        {common.map(t => (
          <span key={`c-${t}`} style={{ padding: '2px 6px', borderRadius: 4, fontSize: 10, background: `${T.bgHover}`, color: T.textDim }}>{t}</span>
        ))}
      </div>
    </div>
  );
}

function SessionDetailPanel({ session, label, color }: { session: SessionDetail; label: string; color: string }) {
  return (
    <div style={{ flex: 1, minWidth: 280, padding: 12, background: T.bgCard, borderRadius: 8, border: `1px solid ${color}30` }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 4 }}>{session.name}</div>
      <div style={{ fontSize: 10, color: T.textDim, marginBottom: 12, wordBreak: 'break-all' }}>{session.full_name}</div>

      {/* Tiering */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 4 }}>Tiering</div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
          <span>Tier: <b style={{ color: T.accent }}>{session.tier}</b></span>
          <span>Step: <b>{session.step}</b></span>
          <span>Critical: <b style={{ color: session.critical ? T.red : T.textDim }}>{session.critical ? 'Yes' : 'No'}</b></span>
        </div>
      </div>

      {/* Flow */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 4 }}>Flow</div>
        <div style={{ fontSize: 12, display: 'flex', gap: 12 }}>
          <span>Transforms: <b>{session.transforms}</b></span>
          <span>Reads: <b>{session.ext_reads}</b></span>
          <span>Lookups: <b>{session.lookup_count}</b></span>
        </div>
        {session.sources.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: 10, color: T.textDim }}>Sources: </span>
            {session.sources.map(s => <span key={s} style={{ fontSize: 10, padding: '1px 4px', background: T.bgHover, borderRadius: 3, marginRight: 3 }}>{s}</span>)}
          </div>
        )}
        {session.targets.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: 10, color: T.textDim }}>Targets: </span>
            {session.targets.map(s => <span key={s} style={{ fontSize: 10, padding: '1px 4px', background: T.bgHover, borderRadius: 3, marginRight: 3 }}>{s}</span>)}
          </div>
        )}
        {session.lookups.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: 10, color: T.textDim }}>Lookups: </span>
            {session.lookups.map(s => <span key={s} style={{ fontSize: 10, padding: '1px 4px', background: T.bgHover, borderRadius: 3, marginRight: 3 }}>{s}</span>)}
          </div>
        )}
      </div>

      {/* Functions */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 4 }}>Functions & Code</div>
        <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span>LOC: <b>{session.total_loc}</b></span>
          <span>Funcs: <b>{session.total_functions_used}</b></span>
          <span>Distinct: <b>{session.distinct_functions_used}</b></span>
        </div>
        <div style={{ fontSize: 11, display: 'flex', gap: 8, marginTop: 4 }}>
          {session.has_embedded_sql && <span style={{ padding: '1px 5px', borderRadius: 3, background: `${T.yellow}20`, color: T.yellow, fontSize: 10 }}>SQL</span>}
          {session.has_embedded_java && <span style={{ padding: '1px 5px', borderRadius: 3, background: `${T.purple}20`, color: T.purple, fontSize: 10 }}>Java</span>}
          {session.has_stored_procedure && <span style={{ padding: '1px 5px', borderRadius: 3, background: `${T.red}20`, color: T.red, fontSize: 10 }}>StoredProc</span>}
          {session.core_intent && <span style={{ padding: '1px 5px', borderRadius: 3, background: `${T.accent}20`, color: T.accent, fontSize: 10 }}>{session.core_intent}</span>}
        </div>
      </div>
    </div>
  );
}

export default function CompareView({ currentUploadId, onToast }: CompareViewProps) {
  const [uploads, setUploads] = useState<UploadSummary[]>([]);
  const [uploadA, setUploadA] = useState<number | null>(null);
  const [uploadB, setUploadB] = useState<number | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Load upload list
  useEffect(() => {
    listUploads(100).then(setUploads).catch(() => onToast('Failed to load uploads', 'error'));
  }, []);

  // Auto-set current upload as B
  useEffect(() => {
    if (currentUploadId && !uploadB) setUploadB(currentUploadId);
  }, [currentUploadId]);

  const runCompare = useCallback(async () => {
    if (!uploadA || !uploadB) return;
    if (uploadA === uploadB) { onToast('Select two different uploads', 'warning'); return; }
    setLoading(true);
    setResult(null);
    setSelectedSession(null);
    try {
      const r = await compareUploads(uploadA, uploadB);
      setResult(r);
      onToast(`Compared: ${r.stats.matched_count} matched, ${r.stats.added_count} added, ${r.stats.removed_count} removed`, 'success');
    } catch (e: unknown) {
      onToast(e instanceof Error ? e.message : 'Compare failed', 'error');
    } finally {
      setLoading(false);
    }
  }, [uploadA, uploadB, onToast]);

  // Build the session list based on filter
  const sessionList = useMemo(() => {
    if (!result) return [];
    const items: Array<{ key: string; name: string; status: 'changed' | 'unchanged' | 'added' | 'removed'; session_a?: SessionDetail; session_b?: SessionDetail; changes?: Record<string, unknown> }> = [];

    for (const m of result.matched) {
      const status = m.has_changes ? 'changed' : 'unchanged';
      items.push({ key: m.full_name, name: m.upload_a.name, status, session_a: m.upload_a, session_b: m.upload_b, changes: m.changes });
    }
    for (const s of result.added) {
      items.push({ key: s.full_name, name: s.name, status: 'added', session_b: s });
    }
    for (const s of result.removed) {
      items.push({ key: s.full_name, name: s.name, status: 'removed', session_a: s });
    }
    return items;
  }, [result]);

  const filteredList = useMemo(() => {
    let list = sessionList;
    if (filter !== 'all') list = list.filter(s => s.status === filter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(s => s.name.toLowerCase().includes(q) || s.key.toLowerCase().includes(q));
    }
    return list;
  }, [sessionList, filter, searchQuery]);

  const selectedItem = useMemo(() => {
    if (!selectedSession) return null;
    return sessionList.find(s => s.key === selectedSession) || null;
  }, [selectedSession, sessionList]);

  const statusColor = (s: string) => s === 'changed' ? T.yellow : s === 'added' ? T.green : s === 'removed' ? T.red : T.textDim;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: '"JetBrains Mono", monospace', color: T.text }}>
      {/* ── Upload Selector ── */}
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, background: T.bgCard }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Compare Uploads</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 11, color: T.textMuted }}>Baseline (A):</label>
            <select
              value={uploadA ?? ''}
              onChange={e => { setUploadA(e.target.value ? Number(e.target.value) : null); setResult(null); }}
              style={{ padding: '4px 8px', borderRadius: 4, border: `1px solid ${T.border}`, background: T.bg, color: T.text, fontSize: 12 }}
            >
              <option value="">Select upload...</option>
              {uploads.map(u => (
                <option key={u.id} value={u.id}>{u.filename} (#{u.id}, {u.session_count} sessions)</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 12, color: T.textDim }}>vs</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 11, color: T.textMuted }}>Current (B):</label>
            <select
              value={uploadB ?? ''}
              onChange={e => { setUploadB(e.target.value ? Number(e.target.value) : null); setResult(null); }}
              style={{ padding: '4px 8px', borderRadius: 4, border: `1px solid ${T.border}`, background: T.bg, color: T.text, fontSize: 12 }}
            >
              <option value="">Select upload...</option>
              {uploads.map(u => (
                <option key={u.id} value={u.id}>{u.filename} (#{u.id}, {u.session_count} sessions)</option>
              ))}
            </select>
          </div>
          <button
            onClick={runCompare}
            disabled={!uploadA || !uploadB || loading}
            style={{
              padding: '6px 16px', borderRadius: 6, border: 'none',
              background: uploadA && uploadB && !loading ? T.accent : T.bgHover,
              color: '#fff', fontSize: 12, fontWeight: 600, cursor: uploadA && uploadB && !loading ? 'pointer' : 'default',
            }}
          >
            {loading ? 'Comparing...' : 'Compare'}
          </button>
        </div>
      </div>

      {/* ── Results ── */}
      {result && (
        <>
          {/* Stats bar */}
          <div style={{ padding: '8px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Badge label="Matched" color={T.textMuted} count={result.stats.matched_count} />
            <Badge label="Changed" color={T.yellow} count={result.stats.changed_count} />
            <Badge label="Unchanged" color={T.textDim} count={result.stats.unchanged_count} />
            <Badge label="Added" color={T.green} count={result.stats.added_count} />
            <Badge label="Removed" color={T.red} count={result.stats.removed_count} />
            <div style={{ marginLeft: 'auto', fontSize: 11, color: T.textDim }}>
              Tables: +{result.stats.tables_added} / -{result.stats.tables_removed} / ~{result.stats.tables_modified}
              {' | '}
              Connections: +{result.stats.connections_added} / -{result.stats.connections_removed}
            </div>
          </div>

          {/* Filter + search */}
          <div style={{ padding: '6px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 6, alignItems: 'center' }}>
            {(['all', 'changed', 'added', 'removed', 'unchanged'] as FilterMode[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '3px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                  border: `1px solid ${filter === f ? T.accent : T.border}`,
                  background: filter === f ? `${T.accent}20` : 'transparent',
                  color: filter === f ? T.accent : T.textMuted,
                }}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              style={{
                marginLeft: 'auto', padding: '4px 8px', borderRadius: 4,
                border: `1px solid ${T.border}`, background: T.bg, color: T.text, fontSize: 11, width: 200,
              }}
            />
          </div>

          {/* Main content: session list + detail */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {/* Session list (left panel) */}
            <div style={{ width: 340, borderRight: `1px solid ${T.border}`, overflow: 'auto' }}>
              {filteredList.map(item => (
                <div
                  key={item.key}
                  onClick={() => setSelectedSession(item.key)}
                  style={{
                    padding: '8px 12px', cursor: 'pointer',
                    borderBottom: `1px solid ${T.border}`,
                    background: selectedSession === item.key ? T.bgHover : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>
                      {item.name}
                    </div>
                    <span style={{
                      fontSize: 9, padding: '2px 6px', borderRadius: 3,
                      background: `${statusColor(item.status)}20`,
                      color: statusColor(item.status),
                      fontWeight: 700,
                    }}>
                      {item.status.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: T.textDim, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.key}
                  </div>
                  {item.status === 'changed' && item.changes && (
                    <div style={{ fontSize: 10, color: T.yellow, marginTop: 2 }}>
                      {Object.keys(item.changes).length} field(s) changed
                    </div>
                  )}
                </div>
              ))}
              {filteredList.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', color: T.textDim, fontSize: 12 }}>No sessions match filter</div>
              )}
            </div>

            {/* Detail panel (right) */}
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {!selectedItem && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
                  <div style={{ fontSize: 36, opacity: 0.2 }}>{'\u21C4'}</div>
                  <div style={{ fontSize: 13, color: T.textDim }}>Select a session to view side-by-side comparison</div>
                </div>
              )}

              {selectedItem && (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>{selectedItem.name}</div>
                  <div style={{ fontSize: 10, color: T.textDim, marginBottom: 16, wordBreak: 'break-all' }}>{selectedItem.key}</div>

                  {/* Side-by-side panels */}
                  {selectedItem.status === 'changed' && selectedItem.session_a && selectedItem.session_b && (
                    <>
                      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                        <SessionDetailPanel session={selectedItem.session_a} label={`Baseline (A) — ${result.upload_a_info.filename}`} color={T.accent} />
                        <SessionDetailPanel session={selectedItem.session_b} label={`Current (B) — ${result.upload_b_info.filename}`} color={T.purple} />
                      </div>

                      {/* Changes diff table */}
                      <div style={{ background: T.bgCard, borderRadius: 8, padding: 12, border: `1px solid ${T.yellow}30` }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.yellow, marginBottom: 8 }}>Changes</div>

                        {/* Scalar field changes */}
                        {Object.keys(selectedItem.changes!).filter(k => !['sources', 'targets', 'lookups'].includes(k)).length > 0 && (
                          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
                            <thead>
                              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                                <th style={{ textAlign: 'left', padding: '4px 8px', fontSize: 10, color: T.textDim }}>Field</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontSize: 10, color: T.accent }}>Baseline (A)</th>
                                <th style={{ padding: '4px 8px', fontSize: 10 }}></th>
                                <th style={{ textAlign: 'left', padding: '4px 8px', fontSize: 10, color: T.purple }}>Current (B)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(selectedItem.changes!).filter(([k]) => !['sources', 'targets', 'lookups'].includes(k)).map(([field, diff]) => {
                                const d = diff as { old: unknown; new: unknown };
                                return <FieldDiff key={field} label={field} oldVal={d.old} newVal={d.new} />;
                              })}
                            </tbody>
                          </table>
                        )}

                        {/* List changes (sources, targets, lookups) */}
                        {['sources', 'targets', 'lookups'].map(field => {
                          const diff = selectedItem.changes![field] as { added: string[]; removed: string[] } | undefined;
                          if (!diff) return null;
                          return <ListDiff key={field} label={field} oldList={selectedItem.session_a![field as keyof SessionDetail] as string[] || []} newList={selectedItem.session_b![field as keyof SessionDetail] as string[] || []} />;
                        })}
                      </div>
                    </>
                  )}

                  {/* Added session — only B */}
                  {selectedItem.status === 'added' && selectedItem.session_b && (
                    <div style={{ display: 'flex', gap: 12 }}>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.textDim, fontSize: 12, background: T.bgCard, borderRadius: 8, padding: 24 }}>
                        Not present in baseline
                      </div>
                      <SessionDetailPanel session={selectedItem.session_b} label={`New in ${result.upload_b_info.filename}`} color={T.green} />
                    </div>
                  )}

                  {/* Removed session — only A */}
                  {selectedItem.status === 'removed' && selectedItem.session_a && (
                    <div style={{ display: 'flex', gap: 12 }}>
                      <SessionDetailPanel session={selectedItem.session_a} label={`Removed from ${result.upload_a_info.filename}`} color={T.red} />
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.textDim, fontSize: 12, background: T.bgCard, borderRadius: 8, padding: 24 }}>
                        Not present in current
                      </div>
                    </div>
                  )}

                  {/* Unchanged session — both sides identical */}
                  {selectedItem.status === 'unchanged' && selectedItem.session_a && selectedItem.session_b && (
                    <div style={{ display: 'flex', gap: 12 }}>
                      <SessionDetailPanel session={selectedItem.session_a} label={`Baseline (A) — ${result.upload_a_info.filename}`} color={T.accent} />
                      <SessionDetailPanel session={selectedItem.session_b} label={`Current (B) — ${result.upload_b_info.filename}`} color={T.purple} />
                    </div>
                  )}

                  {/* Table diff section */}
                  {selectedItem.status === 'changed' && selectedItem.session_a && selectedItem.session_b && (
                    <div style={{ marginTop: 16, background: T.bgCard, borderRadius: 8, padding: 12, border: `1px solid ${T.border}` }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 8 }}>Table Structure Comparison</div>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <div style={{ fontSize: 11, color: T.accent, fontWeight: 600, marginBottom: 4 }}>Baseline Tables</div>
                          <TableList sources={selectedItem.session_a.sources} targets={selectedItem.session_a.targets} lookups={selectedItem.session_a.lookups} />
                        </div>
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <div style={{ fontSize: 11, color: T.purple, fontWeight: 600, marginBottom: 4 }}>Current Tables</div>
                          <TableList sources={selectedItem.session_b.sources} targets={selectedItem.session_b.targets} lookups={selectedItem.session_b.lookups} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* No result yet */}
      {!result && !loading && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <div style={{ fontSize: 48, opacity: 0.15 }}>{'\u21C4'}</div>
          <div style={{ fontSize: 14, color: T.textDim }}>Select two uploads and click Compare to see differences</div>
          <div style={{ fontSize: 11, color: T.textDim, maxWidth: 400, textAlign: 'center' }}>
            Sessions are matched by their fully qualified name across uploads.
            The diff shows changes in tiering, flow (sources/targets/lookups),
            functions, and code metrics for each session.
          </div>
        </div>
      )}
    </div>
  );
}

function TableList({ sources, targets, lookups }: { sources: string[]; targets: string[]; lookups: string[] }) {
  return (
    <div style={{ fontSize: 11 }}>
      {sources.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: T.textDim }}>Sources: </span>
          {sources.map(t => <span key={t} style={{ padding: '1px 4px', borderRadius: 3, background: `${T.green}15`, color: T.green, marginRight: 3, fontSize: 10 }}>{t}</span>)}
        </div>
      )}
      {targets.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: T.textDim }}>Targets: </span>
          {targets.map(t => <span key={t} style={{ padding: '1px 4px', borderRadius: 3, background: `${T.accent}15`, color: T.accent, marginRight: 3, fontSize: 10 }}>{t}</span>)}
        </div>
      )}
      {lookups.length > 0 && (
        <div>
          <span style={{ color: T.textDim }}>Lookups: </span>
          {lookups.map(t => <span key={t} style={{ padding: '1px 4px', borderRadius: 3, background: `${T.yellow}15`, color: T.yellow, marginRight: 3, fontSize: 10 }}>{t}</span>)}
        </div>
      )}
      {sources.length === 0 && targets.length === 0 && lookups.length === 0 && (
        <span style={{ color: T.textDim }}>No tables</span>
      )}
    </div>
  );
}
