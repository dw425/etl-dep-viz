/**
 * TierDiagram.tsx -- Tier bands with session/table cards, SVG Bezier curves,
 * and a right sidebar with tier visibility, node detail, connection density,
 * session search, session filters, and cluster filters.
 *
 * Scalable to 13K+ sessions via:
 *  - Auto-collapse tiers with many sessions
 *  - Per-tier pagination (show first PAGE_SIZE, expandable)
 *  - Connection limiting (only draw for hov/sel when total > CONN_LIMIT)
 *  - Debounced SVG recalc on scroll/resize
 *  - Isolation mode: selecting a node shows only its direct connections
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { TierMapResult, TierConn, ConstellationChunk } from '../../types/tiermap';
import {
  connTypes,
  getTierCfg,
  TABLE_STYLES,
  buildTierGroups,
  type ConnTypeConfig,
} from './constants';

/* ── Tuning constants ────────────────────────────────────────────────── */

const PAGE_SIZE = 50;
const TABLE_PAGE_SIZE = 30;
const LARGE_DATASET = 500;
const AUTO_COLLAPSE_THRESHOLD = 50;
const CONN_LIMIT = 1000;

interface Props {
  data: TierMapResult;
  chunks?: ConstellationChunk[];
}

interface LineData {
  fX: number; fY: number; tX: number; tY: number;
  color: string; dash: string; th: number;
  isAct: boolean; isDim: boolean; type: TierConn['type'];
}

const TierDiagram: React.FC<Props> = ({ data, chunks }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement>>({});
  const [lines, setLines] = useState<LineData[]>([]);
  const [svgDims, setSvgDims] = useState({ w: 0, h: 0 });
  const [hov, setHov] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hiddenTiers, setHiddenTiers] = useState<Set<number>>(() => new Set());
  const [collapsedTiers, setCollapsedTiers] = useState<Set<number>>(() => new Set());
  const [hideMinorConns, setHideMinorConns] = useState(false);
  const [tierSessionLimits, setTierSessionLimits] = useState<Record<number, number>>({});
  const [tierTableLimits, setTierTableLimits] = useState<Record<number, number>>({});

  // ── Filter state ──
  const [searchQuery, setSearchQuery] = useState('');
  const [showCriticalOnly, setShowCriticalOnly] = useState(false);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [isolateSelected, setIsolateSelected] = useState(true);

  const regRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) nodeRefs.current[id] = el;
    else delete nodeRefs.current[id];
  }, []);

  /* ── Derived data ────────────────────────────────────────────────────── */

  const isLargeDataset = data.sessions.length >= LARGE_DATASET;
  const tGroupsData = useMemo(() => buildTierGroups(data), [data]);

  useEffect(() => {
    const threshold = isLargeDataset ? AUTO_COLLAPSE_THRESHOLD : 200;
    const large = tGroupsData.filter(g => g.sessions.length > threshold).map(g => g.tier);
    if (large.length > 0) setCollapsedTiers(new Set(large));
    setTierSessionLimits({});
    setTierTableLimits({});
  }, [tGroupsData, isLargeDataset]);

  // Build cluster session lookup
  const clusterSessionIds = useMemo(() => {
    if (!selectedClusterId || !chunks) return null;
    const chunk = chunks.find(c => c.id === selectedClusterId);
    return chunk ? new Set(chunk.session_ids) : null;
  }, [selectedClusterId, chunks]);

  // Which session is each session associated with (for cluster badge display)
  const sessionClusterMap = useMemo(() => {
    const m = new Map<string, string>();
    if (!chunks) return m;
    for (const c of chunks) {
      for (const sid of c.session_ids) m.set(sid, c.label);
    }
    return m;
  }, [chunks]);

  // Set of connected node IDs when isolation is active
  const isolatedIds = useMemo(() => {
    if (!sel || !isolateSelected) return null;
    const ids = new Set<string>([sel]);
    data.connections.forEach(c => {
      if (c.from === sel) ids.add(c.to);
      if (c.to === sel) ids.add(c.from);
    });
    return ids;
  }, [sel, isolateSelected, data.connections]);

  const nodeTierMap = useMemo(() => {
    const m = new Map<string, number>();
    data.sessions.forEach(s => m.set(s.id, s.tier));
    data.tables.forEach(t => m.set(t.id, t.tier));
    return m;
  }, [data]);

  // Are any filters active? (used to auto-expand collapsed tiers)
  const hasActiveFilters = !!(searchQuery || showCriticalOnly || selectedClusterId);

  // Filter sessions based on search, critical, cluster, and isolation
  const filteredSessionIds = useMemo(() => {
    const lq = searchQuery.toLowerCase().trim();
    const ids = new Set<string>();
    for (const s of data.sessions) {
      // Search filter
      if (lq && !s.name.toLowerCase().includes(lq) && !(s.full || '').toLowerCase().includes(lq)) continue;
      // Critical filter
      if (showCriticalOnly && !s.critical) continue;
      // Cluster filter
      if (clusterSessionIds && !clusterSessionIds.has(s.id)) continue;
      // Isolation filter
      if (isolatedIds && !isolatedIds.has(s.id)) continue;
      ids.add(s.id);
    }
    return ids;
  }, [data.sessions, searchQuery, showCriticalOnly, clusterSessionIds, isolatedIds]);

  // Filter tables based on session filters, isolation, and cluster
  const filteredTableIds = useMemo(() => {
    const hasSessionFilter = !!(searchQuery || showCriticalOnly);
    const ids = new Set<string>();
    for (const t of data.tables) {
      // When any session-level filter is active, only show tables connected to filtered sessions
      if (hasSessionFilter) {
        const hasConn = data.connections.some(c =>
          (c.to === t.id && filteredSessionIds.has(c.from)) ||
          (c.from === t.id && filteredSessionIds.has(c.to))
        );
        if (!hasConn) continue;
      }
      // Cluster filter: if cluster active, only show tables connected to filtered sessions
      if (clusterSessionIds) {
        const hasConn = data.connections.some(c =>
          (c.to === t.id && clusterSessionIds.has(c.from)) ||
          (c.from === t.id && clusterSessionIds.has(c.to))
        );
        if (!hasConn) continue;
      }
      // Isolation filter
      if (isolatedIds && !isolatedIds.has(t.id)) continue;
      ids.add(t.id);
    }
    return ids;
  }, [data.tables, data.connections, searchQuery, showCriticalOnly, filteredSessionIds, clusterSessionIds, isolatedIds]);

  // Build filtered tier groups
  const filteredGroups = useMemo(() => {
    return tGroupsData
      .filter(g => !hiddenTiers.has(g.tier))
      .map(g => ({
        ...g,
        sessions: g.sessions.filter(s => filteredSessionIds.has(s.id)),
        tables: g.tables.filter(t => filteredTableIds.has(t.id)),
      }))
      .filter(g => g.sessions.length > 0 || g.tables.length > 0);
  }, [tGroupsData, hiddenTiers, filteredSessionIds, filteredTableIds]);

  // Set of node IDs actually rendered in DOM (respecting pagination + collapse)
  const renderedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of filteredGroups) {
      // When filters active, override collapse so search results are visible
      if (!hasActiveFilters && collapsedTiers.has(g.tier)) continue;
      const sLimit = tierSessionLimits[g.tier] ?? PAGE_SIZE;
      g.sessions.slice(0, sLimit).forEach(s => ids.add(s.id));
      const tLimit = tierTableLimits[g.tier] ?? TABLE_PAGE_SIZE;
      g.tables.slice(0, tLimit).forEach(t => ids.add(t.id));
    }
    return ids;
  }, [filteredGroups, collapsedTiers, hasActiveFilters, tierSessionLimits, tierTableLimits]);

  // Active connections (between rendered nodes)
  const activeConns = useMemo(() => {
    const isLargeConns = data.connections.length > CONN_LIMIT;
    const focusId = hov || sel;

    return data.connections.filter(cn => {
      if (!renderedNodeIds.has(cn.from) || !renderedNodeIds.has(cn.to)) return false;
      if (hideMinorConns && cn.type === 'source_read') return false;
      if (isLargeConns && focusId) return cn.from === focusId || cn.to === focusId;
      if (isLargeConns && !focusId) return false;
      return true;
    });
  }, [data.connections, renderedNodeIds, hideMinorConns, hov, sel]);

  // Connection counts for all data (for density sidebar)
  const allConnCounts = useMemo(() => {
    const c: Record<string, number> = {};
    data.connections.forEach(cn => { c[cn.from] = (c[cn.from] || 0) + 1; c[cn.to] = (c[cn.to] || 0) + 1; });
    return c;
  }, [data.connections]);

  const connCounts = useMemo(() => {
    const c: Record<string, number> = {};
    activeConns.forEach(cn => { c[cn.from] = (c[cn.from] || 0) + 1; c[cn.to] = (c[cn.to] || 0) + 1; });
    return c;
  }, [activeConns]);

  const isConn = useCallback(
    (id: string) =>
      activeConns.some(c =>
        (c.from === id && (c.to === hov || c.to === sel)) ||
        (c.to === id && (c.from === hov || c.from === sel)),
      ),
    [activeConns, hov, sel],
  );

  /* ── SVG recalc ──────────────────────────────────────────────────────── */

  const recalc = useCallback(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const cr = el.getBoundingClientRect();
    const st = el.scrollTop;
    const sleft = el.scrollLeft;
    setSvgDims({ w: el.scrollWidth, h: el.scrollHeight });

    if (activeConns.length === 0) { setLines([]); return; }

    const groups: Record<string, { conns: number[]; count: number }> = {};
    activeConns.forEach((cn, ci) => {
      const fE = nodeRefs.current[cn.from];
      const tE = nodeRefs.current[cn.to];
      if (!fE || !tE) return;
      const fR = fE.getBoundingClientRect();
      const tR = tE.getBoundingClientRect();
      const down = fR.top < tR.top;
      const key = down ? cn.from + '-' + cn.to : cn.to + '-' + cn.from;
      if (!groups[key]) groups[key] = { conns: [], count: 0 };
      groups[key].conns.push(ci);
      groups[key].count++;
    });

    const newLines: LineData[] = activeConns
      .map((cn, ci) => {
        const fE = nodeRefs.current[cn.from];
        const tE = nodeRefs.current[cn.to];
        if (!fE || !tE) return null;
        const fR = fE.getBoundingClientRect();
        const tR = tE.getBoundingClientRect();
        const down = fR.top < tR.top;
        let fX = fR.left + fR.width / 2 - cr.left + sleft;
        let fY = down ? fR.bottom - cr.top + st : fR.top - cr.top + st;
        let tX = tR.left + tR.width / 2 - cr.left + sleft;
        let tY = down ? tR.top - cr.top + st : tR.bottom - cr.top + st;

        const key = down ? cn.from + '-' + cn.to : cn.to + '-' + cn.from;
        const g = groups[key];
        if (g && g.count > 1) {
          const off = (g.conns.indexOf(ci) - (g.count - 1) / 2) * 14;
          fX += off;
          tX += off;
        }

        const ct: ConnTypeConfig = connTypes[cn.type] || connTypes.write_clean;
        const th = ct.baseWidth * (1 + Math.min(connCounts[cn.from] || 1, 7) * 0.12);
        const isAct = hov === cn.from || hov === cn.to || sel === cn.from || sel === cn.to;
        const isDim = !!(hov || sel) && !isAct;

        return { fX, fY, tX, tY, color: ct.color, dash: ct.dash, th, isAct, isDim, type: cn.type };
      })
      .filter(Boolean) as LineData[];

    setLines(newLines);
  }, [activeConns, connCounts, hov, sel]);

  useEffect(() => {
    const t = setTimeout(recalc, 80);
    return () => clearTimeout(t);
  }, [recalc]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const debouncedRecalc = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(recalc); };
    el.addEventListener('scroll', debouncedRecalc);
    window.addEventListener('resize', debouncedRecalc);
    return () => { el.removeEventListener('scroll', debouncedRecalc); window.removeEventListener('resize', debouncedRecalc); cancelAnimationFrame(raf); };
  }, [recalc]);

  /* ── Selected node detail ────────────────────────────────────────────── */

  const selSession = useMemo(() => (sel ? data.sessions.find(x => x.id === sel) ?? null : null), [data.sessions, sel]);
  const selTable = useMemo(() => (sel ? data.tables.find(x => x.id === sel) ?? null : null), [data.tables, sel]);
  const selNode = selSession || selTable;
  const selOuts = useMemo(() => data.connections.filter(c => c.from === sel), [data.connections, sel]);
  const selIns = useMemo(() => data.connections.filter(c => c.to === sel), [data.connections, sel]);

  const allNodes = useMemo(() => [...data.sessions, ...data.tables], [data.sessions, data.tables]);

  const densityNodes = useMemo(
    () => allNodes.filter(n => (allConnCounts[n.id] || 0) > 0)
      .sort((a, b) => (allConnCounts[b.id] || 0) - (allConnCounts[a.id] || 0))
      .slice(0, 12),
    [allNodes, allConnCounts],
  );

  const connTypeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    data.connections.forEach(cn => { c[cn.type] = (c[cn.type] || 0) + 1; });
    return c;
  }, [data.connections]);

  // Active filter count for the clear button
  const activeFilterCount = [searchQuery, showCriticalOnly, selectedClusterId].filter(Boolean).length;

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* ── Main canvas area ───────────────────────────────────────────── */}
      <div
        ref={containerRef}
        style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', position: 'relative' as const }}
      >
        {/* SVG overlay */}
        <svg
          style={{ position: 'absolute' as const, top: 0, left: 0, pointerEvents: 'none', zIndex: 1, overflow: 'visible' }}
          width={svgDims.w || undefined}
          height={svgDims.h || undefined}
        >
          <defs>
            {(Object.entries(connTypes) as [TierConn['type'], ConnTypeConfig][]).map(([k, v]) => (
              <marker key={k} id={'arr-' + k} viewBox="0 0 10 7" refX="9" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
                <path d="M0,0.5 L9,3.5 L0,6.5" fill={v.color} />
              </marker>
            ))}
          </defs>
          {lines.map((l, i) => {
            const dy = l.tY - l.fY;
            const cp = Math.max(Math.abs(dy) * 0.35, 30);
            const cpx = (l.tX - l.fX) * 0.15;
            const path = 'M' + l.fX + ',' + l.fY + ' C' + (l.fX + cpx) + ',' + (l.fY + (dy > 0 ? cp : -cp)) + ' ' + (l.tX - cpx) + ',' + (l.tY - (dy > 0 ? cp : -cp)) + ' ' + l.tX + ',' + l.tY;
            return (
              <path key={i} d={path} fill="none" stroke={l.color}
                strokeWidth={l.isAct ? l.th * 1.6 : l.th}
                strokeDasharray={l.dash || undefined}
                opacity={l.isDim ? 0.08 : l.isAct ? 1 : 0.45}
                markerEnd={'url(#arr-' + l.type + ')'}
                style={{ transition: 'opacity 0.15s' }}
              />
            );
          })}
        </svg>

        {/* Info banner */}
        {isLargeDataset && (
          <div style={{
            padding: '8px 16px', background: 'rgba(59,130,246,0.08)',
            borderBottom: '1px solid rgba(59,130,246,0.2)', fontSize: 11, color: '#94A3B8',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontWeight: 700, color: '#60A5FA' }}>{data.sessions.length.toLocaleString()} sessions</span>
            <span>across {tGroupsData.length} tiers</span>
            <span style={{ color: '#64748B' }}>|</span>
            <span>{data.connections.length.toLocaleString()} connections</span>
            {activeFilterCount > 0 && (
              <span style={{ color: '#F59E0B' }}>
                Showing {filteredSessionIds.size} of {data.sessions.length} sessions
              </span>
            )}
            {data.connections.length > CONN_LIMIT && (
              <span style={{ color: '#F59E0B', fontSize: 10 }}>Hover/click a node to see connections</span>
            )}
            <button
              onClick={() => {
                if (collapsedTiers.size > 0) setCollapsedTiers(new Set());
                else setCollapsedTiers(new Set(tGroupsData.filter(g => g.sessions.length > 10).map(g => g.tier)));
              }}
              style={{
                marginLeft: 'auto', padding: '3px 10px', borderRadius: 4, fontSize: 10,
                background: 'rgba(59,130,246,0.1)', color: '#60A5FA',
                border: '1px solid rgba(59,130,246,0.3)', cursor: 'pointer',
              }}
            >
              {collapsedTiers.size > 0 ? 'Expand All' : 'Collapse All'}
            </button>
          </div>
        )}

        {/* Filter active indicator */}
        {activeFilterCount > 0 && !isLargeDataset && (
          <div style={{
            padding: '6px 16px', background: 'rgba(245,158,11,0.08)',
            borderBottom: '1px solid rgba(245,158,11,0.2)', fontSize: 11, color: '#F59E0B',
          }}>
            Showing {filteredSessionIds.size} of {data.sessions.length} sessions
            {selectedClusterId && chunks && (
              <span> in cluster "{chunks.find(c => c.id === selectedClusterId)?.label}"</span>
            )}
          </div>
        )}

        {/* Tier band cards */}
        <div style={{ position: 'relative' as const, padding: '28px 40px', minWidth: 920, zIndex: 2 }}>
          {filteredGroups.length === 0 && (
            <div style={{ textAlign: 'center', padding: 48, color: '#475569', fontSize: 13 }}>
              No sessions match the current filters.
              <button onClick={() => { setSearchQuery(''); setShowCriticalOnly(false); setSelectedClusterId(null); setSel(null); }}
                style={{ marginLeft: 8, color: '#60A5FA', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                Clear filters
              </button>
            </div>
          )}
          {filteredGroups.map((g, gi) => {
            const cfg = getTierCfg(g.tier);
            // Auto-expand collapsed tiers when filters are active so results are visible
            const isCollapsed = hasActiveFilters ? false : collapsedTiers.has(g.tier);
            const sLimit = tierSessionLimits[g.tier] ?? PAGE_SIZE;
            const tLimit = tierTableLimits[g.tier] ?? TABLE_PAGE_SIZE;
            const visibleSessions = isCollapsed ? [] : g.sessions.slice(0, sLimit);
            const visibleTables = isCollapsed ? [] : g.tables.slice(0, tLimit);
            const hiddenSessionCount = Math.max(0, g.sessions.length - sLimit);
            const hiddenTableCount = Math.max(0, g.tables.length - tLimit);

            return (
              <div key={gi} style={{
                background: cfg.bgAlpha, border: '1px solid ' + cfg.border + '33',
                borderRadius: 12, padding: '22px 28px', marginBottom: 18,
              }}>
                {/* Tier header */}
                <div
                  style={{
                    fontSize: 10, fontWeight: 800, color: cfg.color,
                    textTransform: 'uppercase' as const, letterSpacing: '0.1em',
                    marginBottom: isCollapsed ? 0 : 12, display: 'flex', alignItems: 'center',
                    gap: 8, cursor: 'pointer',
                  }}
                  onClick={() => setCollapsedTiers(prev => {
                    const next = new Set(prev);
                    if (next.has(g.tier)) next.delete(g.tier); else next.add(g.tier);
                    return next;
                  })}
                >
                  <div style={{ width: 4, height: 16, borderRadius: 2, background: cfg.color }} />
                  <span style={{ fontSize: 12, marginRight: 4, color: cfg.color }}>
                    {isCollapsed ? '\u25B6' : '\u25BC'}
                  </span>
                  {cfg.label}
                  {isCollapsed && <span style={{ fontSize: 9, color: cfg.color, opacity: 0.8 }}>(click to expand)</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: cfg.color, opacity: 0.6, fontFamily: 'monospace' }}>
                    {g.sessions.length > 0 && g.sessions.length + ' session' + (g.sessions.length > 1 ? 's' : '')}
                    {g.sessions.length > 0 && g.tables.length > 0 && ' \u00B7 '}
                    {g.tables.length > 0 && g.tables.length + ' table' + (g.tables.length > 1 ? 's' : '')}
                  </span>
                </div>

                {!isCollapsed && (
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' as const, justifyContent: 'center' }}>
                  {visibleSessions.map(s => (
                    <SessionCard key={s.id} s={s} cfg={cfg} hov={hov} sel={sel} isConn={isConn}
                      regRef={regRef} setHov={setHov} setSel={setSel}
                      clusterLabel={sessionClusterMap.get(s.id)} />
                  ))}

                  {hiddenSessionCount > 0 && (
                    <button onClick={(e) => { e.stopPropagation(); setTierSessionLimits(prev => ({ ...prev, [g.tier]: (prev[g.tier] ?? PAGE_SIZE) + PAGE_SIZE })); }}
                      style={{
                        padding: '10px 20px', borderRadius: 8, border: '1px dashed ' + cfg.border + '66',
                        background: 'transparent', color: cfg.color, fontSize: 11, fontWeight: 600,
                        cursor: 'pointer', minWidth: 150, textAlign: 'center' as const,
                      }}>
                      + {hiddenSessionCount} more session{hiddenSessionCount > 1 ? 's' : ''}
                    </button>
                  )}

                  {visibleTables.map(t => {
                    const ts = TABLE_STYLES[t.type] || TABLE_STYLES.independent;
                    return (
                      <div key={t.id} ref={el => regRef(t.id, el)}
                        onMouseEnter={() => setHov(t.id)} onMouseLeave={() => setHov(null)}
                        onClick={() => setSel(p => (p === t.id ? null : t.id))}
                        style={{
                          background: hov === t.id || sel === t.id ? 'rgba(255,255,255,0.08)' : ts.bg,
                          border: (t.type === 'conflict' ? 2 : 1) + 'px solid ' + (sel === t.id ? '#fff' : hov === t.id ? '#fff' : ts.border),
                          borderRadius: 6, padding: '10px 14px', cursor: 'pointer', minWidth: 148,
                          textAlign: 'center' as const,
                          boxShadow: t.type === 'conflict' ? '0 0 16px rgba(239,68,68,0.25)' : 'none',
                          transition: 'all 0.15s',
                          opacity: (hov || sel) && hov !== t.id && sel !== t.id && !isConn(t.id) ? 0.3 : 1,
                        }}>
                        <div style={{ fontSize: 13, marginBottom: 2 }}>{ts.icon}</div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: ts.color, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.2, wordBreak: 'break-all' as const }}>
                          {t.name}
                        </div>
                        {(t.type === 'conflict' || t.readers > 0 || t.lookupUsers > 0) && (
                          <div style={{ fontSize: 8, color: ts.color, marginTop: 3, fontWeight: 600, opacity: 0.8 }}>
                            {t.type === 'conflict' ? t.conflictWriters + 'W' : ''}
                            {t.readers > 0 ? ' ' + t.readers + 'R' : ''}
                            {t.lookupUsers > 0 ? ' ' + t.lookupUsers + 'L' : ''}
                          </div>
                        )}
                        <div style={{ fontSize: 8, color: '#64748B', marginTop: 2, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{t.type}</div>
                      </div>
                    );
                  })}

                  {hiddenTableCount > 0 && (
                    <button onClick={(e) => { e.stopPropagation(); setTierTableLimits(prev => ({ ...prev, [g.tier]: (prev[g.tier] ?? TABLE_PAGE_SIZE) + TABLE_PAGE_SIZE })); }}
                      style={{
                        padding: '8px 16px', borderRadius: 6, border: '1px dashed rgba(100,116,139,0.3)',
                        background: 'transparent', color: '#64748B', fontSize: 10, fontWeight: 600,
                        cursor: 'pointer', minWidth: 120, textAlign: 'center' as const,
                      }}>
                      + {hiddenTableCount} more table{hiddenTableCount > 1 ? 's' : ''}
                    </button>
                  )}
                </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          RIGHT SIDEBAR
         ══════════════════════════════════════════════════════════════════ */}
      <div style={{
        width: 280, borderLeft: '1px solid #1E293B', background: 'rgba(15,23,42,0.6)',
        overflowY: 'auto', flexShrink: 0, display: 'flex', flexDirection: 'column' as const,
      }}>

        {/* ── Session Search ──────────────────────────────────────────── */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #1E293B', flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 6 }}>
            Search Sessions
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Filter by name..."
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6, fontSize: 11,
              background: '#0f172a', border: '1px solid #1E293B', color: '#E2E8F0',
              outline: 'none', boxSizing: 'border-box' as const,
            }}
          />
          {searchQuery && (
            <div style={{ fontSize: 9, color: '#64748B', marginTop: 4 }}>
              {filteredSessionIds.size} match{filteredSessionIds.size !== 1 ? 'es' : ''}
            </div>
          )}
        </div>

        {/* ── Session Filters ─────────────────────────────────────────── */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #1E293B', flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 6 }}>
            Session Filters
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 6, fontSize: 10, color: '#CBD5E1' }}>
            <input type="checkbox" checked={showCriticalOnly} onChange={() => setShowCriticalOnly(v => !v)}
              style={{ accentColor: '#EF4444' }} />
            Critical sessions only
            <span style={{ marginLeft: 'auto', fontSize: 9, color: '#EF4444', fontFamily: 'monospace' }}>
              {data.sessions.filter(s => s.critical).length}
            </span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 6, fontSize: 10, color: '#CBD5E1' }}>
            <input type="checkbox" checked={isolateSelected} onChange={() => setIsolateSelected(v => !v)}
              style={{ accentColor: '#3B82F6' }} />
            Isolate on select
            <span style={{ marginLeft: 'auto', fontSize: 9, color: '#64748B' }}>
              {sel ? 'active' : 'off'}
            </span>
          </label>

          {activeFilterCount > 0 && (
            <button
              onClick={() => { setSearchQuery(''); setShowCriticalOnly(false); setSelectedClusterId(null); setSel(null); }}
              style={{
                width: '100%', padding: '4px 0', borderRadius: 4, fontSize: 10,
                background: 'rgba(239,68,68,0.1)', color: '#EF4444',
                border: '1px solid rgba(239,68,68,0.2)', cursor: 'pointer', marginTop: 4,
              }}
            >
              Clear all filters ({activeFilterCount})
            </button>
          )}
        </div>

        {/* ── Cluster Filter ──────────────────────────────────────────── */}
        {chunks && chunks.length > 0 && (
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #1E293B', flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 6 }}>
              Cluster Filter
            </div>
            <select
              value={selectedClusterId || ''}
              onChange={e => setSelectedClusterId(e.target.value || null)}
              style={{
                width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 10,
                background: '#0f172a', border: '1px solid #1E293B', color: '#E2E8F0',
                outline: 'none', cursor: 'pointer',
              }}
            >
              <option value="">All clusters</option>
              {chunks.map(c => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.session_count} sessions)
                </option>
              ))}
            </select>
            {selectedClusterId && chunks && (() => {
              const ch = chunks.find(c => c.id === selectedClusterId);
              if (!ch) return null;
              return (
                <div style={{ marginTop: 6, fontSize: 9, color: '#94A3B8', lineHeight: 1.5 }}>
                  <div><span style={{ color: '#E2E8F0', fontWeight: 600 }}>{ch.session_count}</span> sessions, <span style={{ color: '#E2E8F0', fontWeight: 600 }}>{ch.table_count}</span> tables</div>
                  <div>Tiers {ch.tier_range[0]}–{ch.tier_range[1]}</div>
                  {ch.conflict_count > 0 && <div style={{ color: '#EF4444' }}>{ch.conflict_count} conflicts</div>}
                  {ch.chain_count > 0 && <div style={{ color: '#F97316' }}>{ch.chain_count} chains</div>}
                  {ch.critical_count > 0 && <div style={{ color: '#EF4444' }}>{ch.critical_count} critical</div>}
                  {ch.pivot_tables.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ color: '#64748B' }}>Pivots: </span>
                      {ch.pivot_tables.slice(0, 3).join(', ')}
                      {ch.pivot_tables.length > 3 && ` +${ch.pivot_tables.length - 3}`}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* ── Tier Visibility ─────────────────────────────────────────── */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #1E293B', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase' as const, letterSpacing: '0.1em' }}>
              Tier Visibility
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setHiddenTiers(new Set())}
                style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, border: '1px solid #1E293B', background: 'transparent', color: '#64748B', cursor: 'pointer' }}>
                All
              </button>
              <button onClick={() => setHiddenTiers(new Set(tGroupsData.map(g => g.tier)))}
                style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, border: '1px solid #1E293B', background: 'transparent', color: '#64748B', cursor: 'pointer' }}>
                None
              </button>
            </div>
          </div>

          {tGroupsData.map(g => {
            const cfg = getTierCfg(g.tier);
            const hidden = hiddenTiers.has(g.tier);
            return (
              <div key={g.tier}
                onClick={() => setHiddenTiers(prev => { const next = new Set(prev); if (next.has(g.tier)) next.delete(g.tier); else next.add(g.tier); return next; })}
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, cursor: 'pointer', userSelect: 'none' as const, overflow: 'hidden' as const }}>
                <div style={{
                  width: 16, height: 16, minWidth: 16, borderRadius: 3, flexShrink: 0,
                  border: '2px solid ' + (hidden ? '#475569' : cfg.color),
                  background: hidden ? 'transparent' : cfg.color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
                }}>
                  {!hidden && <span style={{ color: '#fff', fontSize: 9, fontWeight: 900, lineHeight: 1 }}>{'\u2713'}</span>}
                </div>
                <div style={{ fontSize: 8, color: hidden ? '#475569' : '#CBD5E1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, width: 0, flexGrow: 1, transition: 'color 0.15s' }}>
                  {cfg.label}
                </div>
                <div style={{ fontSize: 8, fontFamily: 'monospace', color: hidden ? '#475569' : cfg.color, flexShrink: 0, whiteSpace: 'nowrap' as const }}>
                  {g.sessions.length > 0 ? g.sessions.length + 'S' : ''}
                  {g.sessions.length > 0 && g.tables.length > 0 ? '+' : ''}
                  {g.tables.length > 0 ? g.tables.length + 'T' : ''}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Node Detail ─────────────────────────────────────────────── */}
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #1E293B', flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase' as const, letterSpacing: '0.1em' }}>
            Node Detail
          </div>
        </div>

        {selNode ? (
          <div style={{ padding: 14, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#E2E8F0', fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>
              {selNode.name}
            </div>

            {selSession && (
              <div style={{ fontSize: 9, color: '#64748B', marginBottom: 12, fontFamily: 'monospace', wordBreak: 'break-all' as const }}>
                {selSession.full}
              </div>
            )}
            {selTable && (
              <div style={{ fontSize: 9, color: '#64748B', marginBottom: 12 }}>
                {selTable.type} &middot; tier {selTable.tier}
              </div>
            )}

            {selSession && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, marginBottom: 12 }}>
                {selSession.transforms > 0 && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'rgba(59,130,246,0.12)', color: '#60A5FA' }}>{selSession.transforms} transforms</span>}
                {selSession.extReads > 0 && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'rgba(107,114,128,0.15)', color: '#9CA3AF' }}>{selSession.extReads} ext reads</span>}
                {selSession.lookupCount > 0 && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'rgba(245,158,11,0.12)', color: '#FBBF24' }}>{selSession.lookupCount} lookups</span>}
                {selSession.critical && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'rgba(239,68,68,0.15)', color: '#EF4444' }}>CRITICAL</span>}
                {sessionClusterMap.has(selSession.id) && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'rgba(168,85,247,0.12)', color: '#A855F7' }}>{sessionClusterMap.get(selSession.id)}</span>}
              </div>
            )}

            {/* Outputs */}
            {selOuts.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' as const, marginBottom: 6 }}>
                  Outputs {'\u2192'} ({selOuts.length})
                </div>
                {selOuts.slice(0, 20).map((c, i) => {
                  const tgt = allNodes.find(x => x.id === c.to);
                  const ct = connTypes[c.type] || connTypes.write_clean;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 3, borderRadius: 1, background: ct.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 9, color: ct.color, fontWeight: 600, flexShrink: 0 }}>{c.type.replace(/_/g, ' ')}</span>
                      <span style={{ fontSize: 9, color: '#CBD5E1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{'\u2192'} {tgt?.name || c.to}</span>
                    </div>
                  );
                })}
                {selOuts.length > 20 && <div style={{ fontSize: 9, color: '#64748B', marginTop: 4 }}>+ {selOuts.length - 20} more</div>}
              </div>
            )}

            {/* Inputs */}
            {selIns.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' as const, marginBottom: 6 }}>
                  Inputs {'\u2190'} ({selIns.length})
                </div>
                {selIns.slice(0, 20).map((c, i) => {
                  const src = allNodes.find(x => x.id === c.from);
                  const ct = connTypes[c.type] || connTypes.write_clean;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 3, borderRadius: 1, background: ct.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 9, color: ct.color, fontWeight: 600, flexShrink: 0 }}>{c.type.replace(/_/g, ' ')}</span>
                      <span style={{ fontSize: 9, color: '#CBD5E1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{'\u2190'} {src?.name || c.from}</span>
                    </div>
                  );
                })}
                {selIns.length > 20 && <div style={{ fontSize: 9, color: '#64748B', marginTop: 4 }}>+ {selIns.length - 20} more</div>}
              </div>
            )}
          </div>
        ) : (
          <div style={{ padding: 20, color: '#475569', fontSize: 11, textAlign: 'center' as const, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            Click a node to inspect
          </div>
        )}

        {/* ── Connection Density ───────────────────────────────────────── */}
        <div style={{ padding: '10px 14px', borderTop: '1px solid #1E293B', flexShrink: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748B', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 6 }}>
            Connection Density
          </div>
          {densityNodes.map(n => (
            <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3, cursor: 'pointer' }}
              onClick={() => setSel(p => p === n.id ? null : n.id)}>
              <div style={{ fontSize: 8, color: '#64748B', width: 12, textAlign: 'right' as const, fontFamily: 'monospace' }}>{allConnCounts[n.id] || 0}</div>
              <div style={{ flex: 1, height: 5, borderRadius: 2, background: '#1E293B', overflow: 'hidden' as const }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  width: Math.min(((allConnCounts[n.id] || 0) / 8) * 100, 100) + '%',
                  background: (allConnCounts[n.id] || 0) > 4 ? '#EF4444' : (allConnCounts[n.id] || 0) > 2 ? '#F59E0B' : '#3B82F6',
                }} />
              </div>
              <div style={{ fontSize: 8, color: sel === n.id ? '#E2E8F0' : '#94A3B8', fontFamily: 'monospace', width: 85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontWeight: sel === n.id ? 700 : 400 }}>
                {n.name}
              </div>
            </div>
          ))}
        </div>

        {/* ── Connection Legend ─────────────────────────────────────────── */}
        <div style={{ padding: '10px 14px', borderTop: '1px solid #1E293B', flexShrink: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748B', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 6 }}>
            Connection Types
          </div>
          {(Object.entries(connTypes) as [TierConn['type'], ConnTypeConfig][]).map(([k, v]) => {
            const count = connTypeCounts[k] || 0;
            if (count === 0) return null;
            return (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{ width: 16, height: 3, borderRadius: 1, background: v.color, flexShrink: 0 }} />
                <span style={{ fontSize: 8, color: '#94A3B8', flex: 1 }}>{k.replace(/_/g, ' ')}</span>
                <span style={{ fontSize: 8, color: '#64748B', fontFamily: 'monospace' }}>{count}</span>
              </div>
            );
          })}
          {data.connections.length > 500 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer', fontSize: 9, color: '#64748B' }}>
              <input type="checkbox" checked={hideMinorConns} onChange={() => setHideMinorConns(h => !h)} />
              Hide minor connections
            </label>
          )}
        </div>
      </div>
    </div>
  );
};

/* ── SessionCard (memoized) ──────────────────────────────────────────── */

interface SessionCardProps {
  s: TierMapResult['sessions'][0];
  cfg: ReturnType<typeof getTierCfg>;
  hov: string | null;
  sel: string | null;
  isConn: (id: string) => boolean;
  regRef: (id: string, el: HTMLDivElement | null) => void;
  setHov: (id: string | null) => void;
  setSel: React.Dispatch<React.SetStateAction<string | null>>;
  clusterLabel?: string;
}

const SessionCard = React.memo<SessionCardProps>(({ s, cfg, hov, sel, isConn, regRef, setHov, setSel, clusterLabel }) => (
  <div
    ref={el => regRef(s.id, el)}
    onMouseEnter={() => setHov(s.id)}
    onMouseLeave={() => setHov(null)}
    onClick={() => setSel(p => (p === s.id ? null : s.id))}
    style={{
      background: hov === s.id || sel === s.id ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.3)',
      border: (s.critical ? 2 : 1) + 'px solid ' + (sel === s.id ? '#fff' : hov === s.id ? cfg.color : s.critical ? '#EF4444' : cfg.border),
      borderRadius: 8, padding: '12px 16px', cursor: 'pointer', minWidth: 190,
      position: 'relative' as const,
      boxShadow: s.critical ? '0 0 12px rgba(239,68,68,0.2)' : 'none',
      transition: 'all 0.15s',
      opacity: (hov || sel) && hov !== s.id && sel !== s.id && !isConn(s.id) ? 0.3 : 1,
    }}
  >
    {s.critical && (
      <div style={{ position: 'absolute' as const, top: -8, right: -8, background: '#EF4444', color: '#fff', fontSize: 8, fontWeight: 800, padding: '2px 5px', borderRadius: 4 }}>
        {'\u26A0'}
      </div>
    )}
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <div style={{
        width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: cfg.color, fontSize: 10, fontWeight: 800, color: '#fff', fontFamily: 'monospace', flexShrink: 0,
      }}>
        {s.step}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#E2E8F0', fontFamily: "'JetBrains Mono', monospace" }}>
        {s.name}
      </div>
    </div>
    <div style={{ fontSize: 9, color: '#94A3B8', fontFamily: 'monospace', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: 200 }}>
      {s.full}
    </div>
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' as const }}>
      {s.transforms > 0 && <span style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3, background: 'rgba(59,130,246,0.12)', color: '#60A5FA' }}>{s.transforms} tx</span>}
      {s.extReads > 0 && <span style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3, background: 'rgba(107,114,128,0.15)', color: '#9CA3AF' }}>{s.extReads} rd</span>}
      {s.lookupCount > 0 && <span style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3, background: 'rgba(245,158,11,0.12)', color: '#FBBF24' }}>{s.lookupCount} lkp</span>}
      {clusterLabel && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'rgba(168,85,247,0.1)', color: '#A855F7' }}>{clusterLabel}</span>}
    </div>
  </div>
));

export default TierDiagram;
