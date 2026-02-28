/**
 * TierDiagram.tsx -- Tier bands with sessions and tables. SVG Bezier curves
 * connecting them. Right sidebar with tier visibility toggles, node detail
 * panel, and connection density bars. Uses useRef for node position tracking
 * and recalculates SVG paths on scroll/resize.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { TierMapResult, TierConn } from '../../types/tiermap';
import {
  C,
  connTypes,
  getTierCfg,
  TABLE_STYLES,
  buildTierGroups,
  type TierGroup,
  type ConnTypeConfig,
} from './constants';

interface Props {
  data: TierMapResult;
}

interface LineData {
  fX: number;
  fY: number;
  tX: number;
  tY: number;
  color: string;
  dash: string;
  th: number;
  isAct: boolean;
  isDim: boolean;
  type: TierConn['type'];
}

const TierDiagram: React.FC<Props> = ({ data }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement>>({});
  const [lines, setLines] = useState<LineData[]>([]);
  const [svgDims, setSvgDims] = useState({ w: 0, h: 0 });
  const [hov, setHov] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hiddenTiers, setHiddenTiers] = useState<Set<number>>(() => new Set());

  const regRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) nodeRefs.current[id] = el;
  }, []);

  /* ── Derived data ────────────────────────────────────────────────────── */

  const tGroupsData = useMemo(() => buildTierGroups(data), [data]);

  const nodeTierMap = useMemo(() => {
    const m = new Map<string, number>();
    data.sessions.forEach(s => m.set(s.id, s.tier));
    data.tables.forEach(t => m.set(t.id, t.tier));
    return m;
  }, [data]);

  const activeConns = useMemo(
    () =>
      data.connections.filter(cn => {
        const fT = nodeTierMap.get(cn.from);
        const tT = nodeTierMap.get(cn.to);
        return fT !== undefined && !hiddenTiers.has(fT) && tT !== undefined && !hiddenTiers.has(tT);
      }),
    [data.connections, hiddenTiers, nodeTierMap],
  );

  const visibleGroups = useMemo(
    () => tGroupsData.filter(g => !hiddenTiers.has(g.tier)),
    [tGroupsData, hiddenTiers],
  );

  const connCounts = useMemo(() => {
    const c: Record<string, number> = {};
    activeConns.forEach(cn => {
      c[cn.from] = (c[cn.from] || 0) + 1;
      c[cn.to] = (c[cn.to] || 0) + 1;
    });
    return c;
  }, [activeConns]);

  const isConn = useCallback(
    (id: string) =>
      activeConns.some(
        c =>
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
    el.addEventListener('scroll', recalc);
    window.addEventListener('resize', recalc);
    return () => {
      el.removeEventListener('scroll', recalc);
      window.removeEventListener('resize', recalc);
    };
  }, [recalc]);

  /* ── Selected node detail ────────────────────────────────────────────── */

  const selSession = useMemo(
    () => (sel ? data.sessions.find(x => x.id === sel) ?? null : null),
    [data.sessions, sel],
  );
  const selTable = useMemo(
    () => (sel ? data.tables.find(x => x.id === sel) ?? null : null),
    [data.tables, sel],
  );
  const selNode = selSession || selTable;

  const selOuts = useMemo(
    () => activeConns.filter(c => c.from === sel),
    [activeConns, sel],
  );
  const selIns = useMemo(
    () => activeConns.filter(c => c.to === sel),
    [activeConns, sel],
  );

  const allNodes = useMemo(
    () => [...data.sessions, ...data.tables],
    [data.sessions, data.tables],
  );

  const densityNodes = useMemo(
    () =>
      allNodes
        .filter(n => (connCounts[n.id] || 0) > 0)
        .sort((a, b) => (connCounts[b.id] || 0) - (connCounts[a.id] || 0))
        .slice(0, 12),
    [allNodes, connCounts],
  );

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* ── Main canvas area ───────────────────────────────────────────── */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'auto',
          position: 'relative' as const,
        }}
      >
        {/* SVG overlay for connection lines */}
        <svg
          style={{
            position: 'absolute' as const,
            top: 0,
            left: 0,
            pointerEvents: 'none',
            zIndex: 1,
            overflow: 'visible',
          }}
          width={svgDims.w || undefined}
          height={svgDims.h || undefined}
        >
          <defs>
            {(Object.entries(connTypes) as [TierConn['type'], ConnTypeConfig][]).map(([k, v]) => (
              <marker
                key={k}
                id={'arr-' + k}
                viewBox="0 0 10 7"
                refX="9"
                refY="3.5"
                markerWidth="7"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0,0.5 L9,3.5 L0,6.5" fill={v.color} />
              </marker>
            ))}
          </defs>
          {lines.map((l, i) => {
            const dy = l.tY - l.fY;
            const cp = Math.max(Math.abs(dy) * 0.35, 30);
            const cpx = (l.tX - l.fX) * 0.15;
            const path =
              'M' + l.fX + ',' + l.fY +
              ' C' + (l.fX + cpx) + ',' + (l.fY + (dy > 0 ? cp : -cp)) +
              ' ' + (l.tX - cpx) + ',' + (l.tY - (dy > 0 ? cp : -cp)) +
              ' ' + l.tX + ',' + l.tY;
            return (
              <path
                key={i}
                d={path}
                fill="none"
                stroke={l.color}
                strokeWidth={l.isAct ? l.th * 1.6 : l.th}
                strokeDasharray={l.dash || undefined}
                opacity={l.isDim ? 0.08 : l.isAct ? 1 : 0.45}
                markerEnd={'url(#arr-' + l.type + ')'}
                style={{ transition: 'opacity 0.15s' }}
              />
            );
          })}
        </svg>

        {/* Tier band cards */}
        <div style={{ position: 'relative' as const, padding: '28px 40px', minWidth: 920, zIndex: 2 }}>
          {visibleGroups.map((g, gi) => {
            const cfg = getTierCfg(g.tier);
            return (
              <div
                key={gi}
                style={{
                  background: cfg.bgAlpha,
                  border: '1px solid ' + cfg.border + '33',
                  borderRadius: 12,
                  padding: '22px 28px',
                  marginBottom: 18,
                }}
              >
                {/* Tier header */}
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    color: cfg.color,
                    textTransform: 'uppercase' as const,
                    letterSpacing: '0.1em',
                    marginBottom: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      width: 4,
                      height: 16,
                      borderRadius: 2,
                      background: cfg.color,
                    }}
                  />
                  {cfg.label}
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 9,
                      color: cfg.color,
                      opacity: 0.6,
                      fontFamily: 'monospace',
                    }}
                  >
                    {g.sessions.length > 0 &&
                      g.sessions.length + ' session' + (g.sessions.length > 1 ? 's' : '')}
                    {g.sessions.length > 0 && g.tables.length > 0 && ' \u00B7 '}
                    {g.tables.length > 0 &&
                      g.tables.length + ' table' + (g.tables.length > 1 ? 's' : '')}
                  </span>
                </div>

                {/* Nodes */}
                <div
                  style={{
                    display: 'flex',
                    gap: 20,
                    flexWrap: 'wrap' as const,
                    justifyContent: 'center',
                  }}
                >
                  {/* Sessions */}
                  {g.sessions.map(s => (
                    <div
                      key={s.id}
                      ref={el => regRef(s.id, el)}
                      onMouseEnter={() => setHov(s.id)}
                      onMouseLeave={() => setHov(null)}
                      onClick={() => setSel(p => (p === s.id ? null : s.id))}
                      style={{
                        background:
                          hov === s.id || sel === s.id
                            ? 'rgba(255,255,255,0.06)'
                            : 'rgba(0,0,0,0.3)',
                        border:
                          (s.critical ? 2 : 1) +
                          'px solid ' +
                          (sel === s.id
                            ? '#fff'
                            : hov === s.id
                              ? cfg.color
                              : s.critical
                                ? '#EF4444'
                                : cfg.border),
                        borderRadius: 8,
                        padding: '12px 16px',
                        cursor: 'pointer',
                        minWidth: 190,
                        position: 'relative' as const,
                        boxShadow: s.critical ? '0 0 12px rgba(239,68,68,0.2)' : 'none',
                        transition: 'all 0.15s',
                        opacity:
                          (hov || sel) && hov !== s.id && sel !== s.id && !isConn(s.id) ? 0.3 : 1,
                      }}
                    >
                      {s.critical && (
                        <div
                          style={{
                            position: 'absolute' as const,
                            top: -8,
                            right: -8,
                            background: '#EF4444',
                            color: '#fff',
                            fontSize: 8,
                            fontWeight: 800,
                            padding: '2px 5px',
                            borderRadius: 4,
                          }}
                        >
                          {'\u26A0'}
                        </div>
                      )}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginBottom: 4,
                        }}
                      >
                        <div
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: cfg.color,
                            fontSize: 10,
                            fontWeight: 800,
                            color: '#fff',
                            fontFamily: 'monospace',
                            flexShrink: 0,
                          }}
                        >
                          {s.step}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: '#E2E8F0',
                            fontFamily: "'JetBrains Mono', monospace",
                          }}
                        >
                          {s.name}
                        </div>
                      </div>
                      <div
                        style={{
                          fontSize: 9,
                          color: '#94A3B8',
                          fontFamily: 'monospace',
                          marginBottom: 4,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap' as const,
                          maxWidth: 200,
                        }}
                      >
                        {s.full}
                      </div>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' as const }}>
                        {s.transforms > 0 && (
                          <span
                            style={{
                              fontSize: 9,
                              padding: '2px 5px',
                              borderRadius: 3,
                              background: 'rgba(59,130,246,0.12)',
                              color: '#60A5FA',
                            }}
                          >
                            {s.transforms} tx
                          </span>
                        )}
                        {s.extReads > 0 && (
                          <span
                            style={{
                              fontSize: 9,
                              padding: '2px 5px',
                              borderRadius: 3,
                              background: 'rgba(107,114,128,0.15)',
                              color: '#9CA3AF',
                            }}
                          >
                            {s.extReads} rd
                          </span>
                        )}
                        {s.lookupCount > 0 && (
                          <span
                            style={{
                              fontSize: 9,
                              padding: '2px 5px',
                              borderRadius: 3,
                              background: 'rgba(245,158,11,0.12)',
                              color: '#FBBF24',
                            }}
                          >
                            {s.lookupCount} lkp
                          </span>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Tables */}
                  {g.tables.map(t => {
                    const ts = TABLE_STYLES[t.type] || TABLE_STYLES.independent;
                    return (
                      <div
                        key={t.id}
                        ref={el => regRef(t.id, el)}
                        onMouseEnter={() => setHov(t.id)}
                        onMouseLeave={() => setHov(null)}
                        onClick={() => setSel(p => (p === t.id ? null : t.id))}
                        style={{
                          background:
                            hov === t.id || sel === t.id
                              ? 'rgba(255,255,255,0.08)'
                              : ts.bg,
                          border:
                            (t.type === 'conflict' ? 2 : 1) +
                            'px solid ' +
                            (sel === t.id ? '#fff' : hov === t.id ? '#fff' : ts.border),
                          borderRadius: 6,
                          padding: '10px 14px',
                          cursor: 'pointer',
                          minWidth: 148,
                          textAlign: 'center' as const,
                          boxShadow:
                            t.type === 'conflict'
                              ? '0 0 16px rgba(239,68,68,0.25)'
                              : 'none',
                          transition: 'all 0.15s',
                          opacity:
                            (hov || sel) && hov !== t.id && sel !== t.id && !isConn(t.id)
                              ? 0.3
                              : 1,
                        }}
                      >
                        <div style={{ fontSize: 13, marginBottom: 2 }}>{ts.icon}</div>
                        <div
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: ts.color,
                            fontFamily: "'JetBrains Mono', monospace",
                            lineHeight: 1.2,
                            wordBreak: 'break-all' as const,
                          }}
                        >
                          {t.name}
                        </div>
                        {(t.type === 'conflict' || t.readers > 0 || t.lookupUsers > 0) && (
                          <div
                            style={{
                              fontSize: 8,
                              color: ts.color,
                              marginTop: 3,
                              fontWeight: 600,
                              opacity: 0.8,
                            }}
                          >
                            {t.type === 'conflict' ? t.conflictWriters + 'W' : ''}
                            {t.readers > 0 ? ' ' + t.readers + 'R' : ''}
                            {t.lookupUsers > 0 ? ' ' + t.lookupUsers + 'L' : ''}
                          </div>
                        )}
                        <div
                          style={{
                            fontSize: 8,
                            color: '#64748B',
                            marginTop: 2,
                            textTransform: 'uppercase' as const,
                            letterSpacing: '0.05em',
                          }}
                        >
                          {t.type}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Right sidebar ──────────────────────────────────────────────── */}
      <div
        style={{
          width: 260,
          borderLeft: '1px solid #1E293B',
          background: 'rgba(15,23,42,0.6)',
          overflowY: 'auto',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column' as const,
        }}
      >
        {/* Tier visibility toggles */}
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid #1E293B',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: '#64748B',
                textTransform: 'uppercase' as const,
                letterSpacing: '0.1em',
              }}
            >
              Tier Visibility
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setHiddenTiers(new Set())}
                style={{
                  fontSize: 8,
                  padding: '2px 6px',
                  borderRadius: 3,
                  border: '1px solid #1E293B',
                  background: 'transparent',
                  color: '#64748B',
                  cursor: 'pointer',
                }}
              >
                All
              </button>
              <button
                onClick={() => setHiddenTiers(new Set(tGroupsData.map(g => g.tier)))}
                style={{
                  fontSize: 8,
                  padding: '2px 6px',
                  borderRadius: 3,
                  border: '1px solid #1E293B',
                  background: 'transparent',
                  color: '#64748B',
                  cursor: 'pointer',
                }}
              >
                None
              </button>
            </div>
          </div>

          {tGroupsData.map(g => {
            const cfg = getTierCfg(g.tier);
            const hidden = hiddenTiers.has(g.tier);
            const toggle = () =>
              setHiddenTiers(prev => {
                const next = new Set(prev);
                if (next.has(g.tier)) next.delete(g.tier);
                else next.add(g.tier);
                return next;
              });

            return (
              <div
                key={g.tier}
                onClick={toggle}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 5,
                  cursor: 'pointer',
                  userSelect: 'none' as const,
                  overflow: 'hidden' as const,
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 16,
                    minWidth: 16,
                    borderRadius: 3,
                    flexShrink: 0,
                    border: '2px solid ' + (hidden ? '#475569' : cfg.color),
                    background: hidden ? 'transparent' : cfg.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.15s',
                  }}
                >
                  {!hidden && (
                    <span style={{ color: '#fff', fontSize: 9, fontWeight: 900, lineHeight: 1 }}>
                      {'\u2713'}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 8,
                    color: hidden ? '#475569' : '#CBD5E1',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap' as const,
                    width: 0,
                    flexGrow: 1,
                    transition: 'color 0.15s',
                  }}
                >
                  {cfg.label}
                </div>
                <div
                  style={{
                    fontSize: 8,
                    fontFamily: 'monospace',
                    color: hidden ? '#475569' : cfg.color,
                    flexShrink: 0,
                    whiteSpace: 'nowrap' as const,
                  }}
                >
                  {g.sessions.length > 0 ? g.sessions.length + 'S' : ''}
                  {g.sessions.length > 0 && g.tables.length > 0 ? '+' : ''}
                  {g.tables.length > 0 ? g.tables.length + 'T' : ''}
                </div>
              </div>
            );
          })}
        </div>

        {/* Node detail header */}
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid #1E293B',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#64748B',
              textTransform: 'uppercase' as const,
              letterSpacing: '0.1em',
            }}
          >
            Node Detail
          </div>
        </div>

        {/* Node detail body */}
        {selNode ? (
          <div style={{ padding: 14, flex: 1 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 800,
                color: '#E2E8F0',
                fontFamily: "'JetBrains Mono', monospace",
                marginBottom: 4,
              }}
            >
              {selNode.name}
            </div>

            {selSession && (
              <div
                style={{
                  fontSize: 9,
                  color: '#64748B',
                  marginBottom: 12,
                  fontFamily: 'monospace',
                  wordBreak: 'break-all' as const,
                }}
              >
                {selSession.full}
              </div>
            )}
            {selTable && (
              <div style={{ fontSize: 9, color: '#64748B', marginBottom: 12 }}>
                {selTable.type} &middot; tier {selTable.tier}
              </div>
            )}

            {/* Outputs */}
            {selOuts.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: '#94A3B8',
                    textTransform: 'uppercase' as const,
                    marginBottom: 6,
                  }}
                >
                  Outputs {'\u2192'} ({selOuts.length})
                </div>
                {selOuts.map((c, i) => {
                  const tgt = allNodes.find(x => x.id === c.to);
                  const ct = connTypes[c.type] || connTypes.write_clean;
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        marginBottom: 4,
                      }}
                    >
                      <div
                        style={{
                          width: 8,
                          height: 3,
                          borderRadius: 1,
                          background: ct.color,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 9,
                          color: ct.color,
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {c.type.replace(/_/g, ' ')}
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          color: '#CBD5E1',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap' as const,
                        }}
                      >
                        {'\u2192'} {tgt?.name || c.to}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Inputs */}
            {selIns.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: '#94A3B8',
                    textTransform: 'uppercase' as const,
                    marginBottom: 6,
                  }}
                >
                  Inputs {'\u2190'} ({selIns.length})
                </div>
                {selIns.map((c, i) => {
                  const src = allNodes.find(x => x.id === c.from);
                  const ct = connTypes[c.type] || connTypes.write_clean;
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        marginBottom: 4,
                      }}
                    >
                      <div
                        style={{
                          width: 8,
                          height: 3,
                          borderRadius: 1,
                          background: ct.color,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 9,
                          color: ct.color,
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {c.type.replace(/_/g, ' ')}
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          color: '#CBD5E1',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap' as const,
                        }}
                      >
                        {'\u2190'} {src?.name || c.from}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div
            style={{
              padding: 20,
              color: '#475569',
              fontSize: 11,
              textAlign: 'center' as const,
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            Click a node to inspect
          </div>
        )}

        {/* Connection density */}
        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid #1E293B',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: '#64748B',
              textTransform: 'uppercase' as const,
              letterSpacing: '0.1em',
              marginBottom: 6,
            }}
          >
            Connection Density
          </div>
          {densityNodes.map(n => (
            <div
              key={n.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                marginBottom: 3,
              }}
            >
              <div
                style={{
                  fontSize: 8,
                  color: '#64748B',
                  width: 12,
                  textAlign: 'right' as const,
                  fontFamily: 'monospace',
                }}
              >
                {connCounts[n.id] || 0}
              </div>
              <div
                style={{
                  flex: 1,
                  height: 5,
                  borderRadius: 2,
                  background: '#1E293B',
                  overflow: 'hidden' as const,
                }}
              >
                <div
                  style={{
                    height: '100%',
                    borderRadius: 2,
                    width:
                      Math.min(((connCounts[n.id] || 0) / 8) * 100, 100) + '%',
                    background:
                      (connCounts[n.id] || 0) > 4
                        ? '#EF4444'
                        : (connCounts[n.id] || 0) > 2
                          ? '#F59E0B'
                          : '#3B82F6',
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 8,
                  color: '#94A3B8',
                  fontFamily: 'monospace',
                  width: 85,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const,
                }}
              >
                {n.name}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default TierDiagram;
