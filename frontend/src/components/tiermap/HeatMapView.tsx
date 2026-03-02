/**
 * HeatMapView -- Canvas grid where each cell represents one ETL session,
 * colored green-to-yellow-to-red by a composite "heat" score.
 *
 * @description
 * Provides an at-a-glance overview of session risk/complexity across the entire
 * dataset. Sessions are laid out in a responsive grid (auto-sized to container
 * width), optionally grouped into labeled sections.
 *
 * Composite heat formula:
 *   heat = complexity(V11) * 0.4 + connectionDensity * 0.3 + transformScore * 0.3
 *
 *   - complexity: V11 overall_score / 100 (0..1)
 *   - connectionDensity: this session's connection count / max across all sessions
 *   - transformScore: this session's transform count / max across all sessions
 *
 * Grouping modes (radio buttons in sidebar):
 *   - None: flat grid sorted by heat or name
 *   - Gravity (V10): group by gravity group ID
 *   - Community (V1): group by macro community assignment
 *   - Wave (V4): group by migration wave number
 *   - Tier: group by execution tier
 *
 * Canvas rendering:
 *   - Uses HTML5 Canvas with DPR scaling for crisp rendering on Retina displays
 *   - Cell layout computed in cellLayout memo; positions cached for hit testing
 *   - Group headers rendered as labeled horizontal bars above each section
 *   - Critical sessions marked with a small red dot in the cell corner
 *
 * @param complexity - V11 complexity scores for all sessions
 * @param tierData - Full TierMapResult for session/connection metadata
 * @param vectorResults - Full vector results for V1/V4/V10 group lookups
 * @param onSessionSelect - Callback when user wants to drill into a session
 */

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import type { VectorResults, ComplexityResult, DimensionScore } from '../../types/vectors';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  complexity: ComplexityResult;
  tierData: TierMapResult;
  vectorResults: VectorResults;
  onSessionSelect?: (sessionId: string) => void;
}

interface SessionHeatData {
  sessionId: string;
  name: string;
  abbreviation: string;
  compositeHeat: number;
  complexityScore: number;
  connectionDensity: number;
  transformScore: number;
  tier: number;
  bucket: string;
  gravityGroup: number;
  communityMacro: number;
  waveNumber: number;
  critical: boolean;
  dimensions: DimensionScore[];
  sources: string[];
  targets: string[];
  lookups: string[];
  cohesion: number;
  coupling: number;
  prereqWaves: number[];
}

type GroupBy = 'none' | 'gravity' | 'community' | 'wave' | 'tier';
type SortMode = 'heat' | 'name';

// ── Constants ─────────────────────────────────────────────────────────────────

const CELL_SIZE = 40;
const GROUP_HEADER_H = 24;
const SIDEBAR_W = 200;
const DETAIL_W = 280;

const C = {
  bg: '#0F172A',
  surface: '#1E293B',
  border: '#334155',
  text: '#E2E8F0',
  muted: '#94A3B8',
  dim: '#475569',
};

// ── Heat color: green → yellow → red ─────────────────────────────────────────
// Two-segment linear interpolation: [0, 0.5] green→yellow, [0.5, 1.0] yellow→red.
// Input `t` is clamped to [0, 1]. Returns an RGB string.

function heatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  let r: number, g: number, b: number;
  if (clamped < 0.5) {
    const f = clamped / 0.5;
    r = Math.round(0x22 + f * (0xEA - 0x22));
    g = Math.round(0xC5 + f * (0xB3 - 0xC5));
    b = Math.round(0x5E + f * (0x08 - 0x5E));
  } else {
    const f = (clamped - 0.5) / 0.5;
    r = Math.round(0xEA + f * (0xEF - 0xEA));
    g = Math.round(0xB3 + f * (0x44 - 0xB3));
    b = Math.round(0x08 + f * (0x44 - 0x08));
  }
  return `rgb(${r},${g},${b})`;
}

function contrastText(t: number): string {
  return t > 0.55 ? '#FFFFFF' : '#1E293B';
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function HeatMapView({ complexity, tierData, vectorResults, onSessionSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [sortMode, setSortMode] = useState<SortMode>('heat');
  const [minHeat, setMinHeat] = useState(0);
  const [bucketFilter, setBucketFilter] = useState<Set<string>>(new Set(['Simple', 'Medium', 'Complex', 'Very Complex']));
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [hoveredSession, setHoveredSession] = useState<SessionHeatData | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [selectedSession, setSelectedSession] = useState<SessionHeatData | null>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  // ── Build session heat data ─────────────────────────────────────────────
  // Merges data from V11 complexity scores, tierData sessions/connections, and
  // V1/V4/V10 vector results into a flat array of SessionHeatData. Each entry
  // carries the composite heat score plus all the metadata needed for grouping,
  // filtering, tooltips, and the detail panel.

  const sessionHeatData = useMemo((): SessionHeatData[] => {
    const scores = complexity?.scores || [];
    if (scores.length === 0) return [];

    // Build lookup maps
    const sessionMap = new Map(tierData.sessions.map(s => [s.name, s]));
    const sessionById = new Map(tierData.sessions.map(s => [s.id, s]));

    // Connection density per session
    const connCounts = new Map<string, number>();
    for (const conn of tierData.connections) {
      const fromSess = sessionById.get(conn.from);
      const toSess = sessionById.get(conn.to);
      if (fromSess) connCounts.set(fromSess.name, (connCounts.get(fromSess.name) || 0) + 1);
      if (toSess) connCounts.set(toSess.name, (connCounts.get(toSess.name) || 0) + 1);
    }
    const maxConn = Math.max(1, ...Array.from(connCounts.values()));

    // Transform count normalization
    const maxTransforms = Math.max(1, ...tierData.sessions.map(s => s.transforms));

    // V10 gravity group lookup
    const gravityMap = new Map<string, { groupId: number; cohesion: number; coupling: number }>();
    if (vectorResults.v10_concentration?.gravity_groups) {
      for (const g of vectorResults.v10_concentration.gravity_groups) {
        for (const sid of g.session_ids) {
          gravityMap.set(sid, { groupId: g.group_id, cohesion: g.cohesion, coupling: g.coupling });
        }
      }
    }

    // V1 community macro lookup
    const communityMap = new Map<string, number>();
    if (vectorResults.v1_communities?.assignments) {
      for (const a of vectorResults.v1_communities.assignments) {
        communityMap.set(a.session_id, a.macro);
      }
    }

    // V4 wave lookup
    const waveMap = new Map<string, { waveNumber: number; prereqs: number[] }>();
    if (vectorResults.v4_wave_plan?.waves) {
      for (const w of vectorResults.v4_wave_plan.waves) {
        for (const sid of w.session_ids) {
          waveMap.set(sid, { waveNumber: w.wave_number, prereqs: w.prerequisite_waves });
        }
      }
    }

    // Build source/target/lookup per session
    const sessionSources = new Map<string, string[]>();
    const sessionTargets = new Map<string, string[]>();
    const sessionLookups = new Map<string, string[]>();
    for (const conn of tierData.connections) {
      const fromSess = sessionById.get(conn.from);
      const toTable = tierData.tables.find(t => t.id === conn.to);
      const toSess = sessionById.get(conn.to);
      const fromTable = tierData.tables.find(t => t.id === conn.from);

      if (fromSess && toTable) {
        if (conn.type === 'write_conflict' || conn.type === 'write_clean') {
          const arr = sessionTargets.get(fromSess.name) || [];
          arr.push(toTable.name);
          sessionTargets.set(fromSess.name, arr);
        } else if (conn.type === 'lookup_stale') {
          const arr = sessionLookups.get(fromSess.name) || [];
          arr.push(toTable.name);
          sessionLookups.set(fromSess.name, arr);
        }
      }
      if (toSess && fromTable && conn.type === 'read_after_write') {
        const arr = sessionSources.get(toSess.name) || [];
        arr.push(fromTable.name);
        sessionSources.set(toSess.name, arr);
      }
    }

    return scores.map(score => {
      const sess = sessionMap.get(score.name) || sessionMap.get(score.session_id);
      const name = score.name || score.session_id;
      const connDensity = (connCounts.get(name) || 0) / maxConn;
      const transformScore = sess ? sess.transforms / maxTransforms : 0;
      const complexityScore = (score.overall_score || 0) / 100;

      const compositeHeat = complexityScore * 0.4 + connDensity * 0.3 + transformScore * 0.3;

      const gravity = gravityMap.get(score.session_id);
      const wave = waveMap.get(score.session_id);

      return {
        sessionId: score.session_id,
        name,
        abbreviation: name.slice(0, 6).toUpperCase(),
        compositeHeat,
        complexityScore: score.overall_score || 0,
        connectionDensity: connDensity,
        transformScore,
        tier: sess?.tier ?? Math.round(score.overall_score / 25) + 1,
        bucket: score.bucket || 'Simple',
        gravityGroup: gravity?.groupId ?? -1,
        communityMacro: communityMap.get(score.session_id) ?? -1,
        waveNumber: wave?.waveNumber ?? -1,
        critical: sess?.critical ?? false,
        dimensions: score.dimensions || [],
        sources: [...new Set(sessionSources.get(name) || [])],
        targets: [...new Set(sessionTargets.get(name) || [])],
        lookups: [...new Set(sessionLookups.get(name) || [])],
        cohesion: gravity?.cohesion ?? 0,
        coupling: gravity?.coupling ?? 0,
        prereqWaves: wave?.prereqs ?? [],
      };
    });
  }, [complexity, tierData, vectorResults]);

  // ── Filter sessions ──────────────────────────────────────────────────────

  const filteredSessions = useMemo(() => {
    return sessionHeatData.filter(s => {
      if (s.compositeHeat * 100 < minHeat) return false;
      if (!bucketFilter.has(s.bucket)) return false;
      if (criticalOnly && !s.critical) return false;
      return true;
    });
  }, [sessionHeatData, minHeat, bucketFilter, criticalOnly]);

  // ── Group + sort sessions ────────────────────────────────────────────────

  const groupedSessions = useMemo(() => {
    const sorted = [...filteredSessions].sort((a, b) =>
      sortMode === 'heat' ? b.compositeHeat - a.compositeHeat : a.name.localeCompare(b.name)
    );

    if (groupBy === 'none') return [{ label: '', sessions: sorted }];

    const groups = new Map<string, SessionHeatData[]>();
    for (const s of sorted) {
      let key: string;
      switch (groupBy) {
        case 'gravity': key = s.gravityGroup >= 0 ? `Gravity ${s.gravityGroup}` : 'Ungrouped'; break;
        case 'community': key = s.communityMacro >= 0 ? `Community ${s.communityMacro}` : 'Ungrouped'; break;
        case 'wave': key = s.waveNumber >= 0 ? `Wave ${s.waveNumber}` : 'Ungrouped'; break;
        case 'tier': key = `Tier ${s.tier}`; break;
        default: key = 'All';
      }
      const arr = groups.get(key) || [];
      arr.push(s);
      groups.set(key, arr);
    }

    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([label, sessions]) => ({ label, sessions }));
  }, [filteredSessions, groupBy, sortMode]);

  // ── Canvas cell layout ───────────────────────────────────────────────────
  // Computes (x, y) positions for each session cell in a grid layout.
  // Groups add a GROUP_HEADER_H gap before their first row.
  // Returns: cells array (for rendering + hit testing), total canvas height, column count.

  const cellLayout = useMemo(() => {
    const availableW = containerWidth - 4; // slight padding
    const cols = Math.max(1, Math.floor(availableW / CELL_SIZE));
    const cells: Array<{ session: SessionHeatData; x: number; y: number }> = [];
    let curY = 4;

    for (const group of groupedSessions) {
      if (group.label) {
        curY += GROUP_HEADER_H;
      }
      let col = 0;
      for (const session of group.sessions) {
        cells.push({
          session,
          x: col * CELL_SIZE + 2,
          y: curY,
        });
        col++;
        if (col >= cols) {
          col = 0;
          curY += CELL_SIZE;
        }
      }
      if (col > 0) curY += CELL_SIZE;
      curY += 4;
    }

    return { cells, totalHeight: curY + 8, cols };
  }, [groupedSessions, containerWidth]);

  // ── Resize observer ──────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) setContainerWidth(Math.floor(e.contentRect.width));
    });
    obs.observe(container);
    setContainerWidth(container.clientWidth);
    return () => obs.disconnect();
  }, []);

  // ── Canvas render ────────────────────────────────────────────────────────
  // Redraws the entire canvas when layout, data, or hover/selection changes.
  // Two passes: 1) group headers as labeled bars, 2) individual cells with
  // heat color fill, hover/selection borders, critical dots, and abbreviations.

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = containerWidth;
    const h = cellLayout.totalHeight;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    // Draw group headers
    let curY = 4;
    for (const group of groupedSessions) {
      if (group.label) {
        ctx.fillStyle = 'rgba(30, 41, 59, 0.8)';
        ctx.fillRect(0, curY, w, GROUP_HEADER_H);
        ctx.fillStyle = C.muted;
        ctx.font = 'bold 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${group.label} (${group.sessions.length})`, 8, curY + GROUP_HEADER_H / 2);
        curY += GROUP_HEADER_H;
      }

      const cols = Math.max(1, Math.floor((w - 4) / CELL_SIZE));
      let col = 0;
      for (const _session of group.sessions) {
        col++;
        if (col >= cols) {
          col = 0;
          curY += CELL_SIZE;
        }
      }
      if (col > 0) curY += CELL_SIZE;
      curY += 4;
    }

    // Draw cells
    for (const { session: s, x, y } of cellLayout.cells) {
      const isHovered = hoveredSession?.sessionId === s.sessionId;
      const isSelected = selectedSession?.sessionId === s.sessionId;
      const color = heatColor(s.compositeHeat);
      const gap = 1;

      // Cell fill
      ctx.fillStyle = color;
      ctx.fillRect(x + gap, y + gap, CELL_SIZE - gap * 2, CELL_SIZE - gap * 2);

      // Selection/hover border
      if (isSelected) {
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + gap, y + gap, CELL_SIZE - gap * 2, CELL_SIZE - gap * 2);
      } else if (isHovered) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + gap, y + gap, CELL_SIZE - gap * 2, CELL_SIZE - gap * 2);
      }

      // Critical indicator
      if (s.critical) {
        ctx.fillStyle = '#EF4444';
        ctx.beginPath();
        ctx.arc(x + CELL_SIZE - 5, y + 5, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Abbreviation
      ctx.fillStyle = contrastText(s.compositeHeat);
      ctx.font = '7px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.abbreviation, x + CELL_SIZE / 2, y + CELL_SIZE / 2);
    }
  }, [cellLayout, groupedSessions, containerWidth, hoveredSession, selectedSession]);

  // ── Hit testing ──────────────────────────────────────────────────────────

  const hitTest = useCallback((mx: number, my: number): SessionHeatData | null => {
    for (const { session, x, y } of cellLayout.cells) {
      if (mx >= x && mx <= x + CELL_SIZE && my >= y && my <= y + CELL_SIZE) {
        return session;
      }
    }
    return null;
  }, [cellLayout]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = hitTest(mx, my);
    setHoveredSession(hit);
    setHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    canvas.style.cursor = hit ? 'pointer' : 'default';
  }, [hitTest]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    setSelectedSession(hit);
  }, [hitTest]);

  // ── Bucket toggle ────────────────────────────────────────────────────────

  const toggleBucket = useCallback((bucket: string) => {
    setBucketFilter(prev => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }, []);

  // ── Empty state ──────────────────────────────────────────────────────────

  if (!sessionHeatData.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: C.dim }}>
        No complexity data available. Run Phase 1 vectors first.
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: '100%', background: C.bg, color: C.text, overflow: 'hidden' }}>
      {/* ── Left Sidebar ── */}
      <div style={{
        width: SIDEBAR_W, flexShrink: 0, borderRight: `1px solid ${C.border}`,
        background: 'rgba(15,23,42,0.6)', padding: 12, display: 'flex', flexDirection: 'column', gap: 14,
        overflowY: 'auto',
      }}>
        {/* Title */}
        <div style={{ fontSize: 11, fontWeight: 700, color: '#10B981', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Session Heat Map
        </div>

        {/* Session count */}
        <div style={{ fontSize: 10, color: C.muted }}>
          {filteredSessions.length} / {sessionHeatData.length} sessions
        </div>

        {/* Group By */}
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Group By
          </div>
          {([['none', 'None'], ['gravity', 'Gravity (V10)'], ['community', 'Community (V1)'], ['wave', 'Wave (V4)'], ['tier', 'Tier']] as [GroupBy, string][]).map(([key, label]) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: C.text, marginBottom: 4, cursor: 'pointer' }}>
              <input
                type="radio"
                name="groupBy"
                checked={groupBy === key}
                onChange={() => setGroupBy(key)}
                style={{ accentColor: '#10B981' }}
              />
              {label}
            </label>
          ))}
        </div>

        {/* Sort */}
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Sort
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {([['heat', 'Heat'], ['name', 'Name']] as [SortMode, string][]).map(([key, label]) => (
              <button key={key} onClick={() => setSortMode(key)} style={{
                padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                background: sortMode === key ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.03)',
                color: sortMode === key ? '#34D399' : C.dim, fontSize: 9, fontWeight: 600,
              }}>{label}</button>
            ))}
          </div>
        </div>

        {/* Min Heat Threshold */}
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Min Heat: {minHeat}%
          </div>
          <input
            type="range"
            min={0} max={100} value={minHeat}
            onChange={e => setMinHeat(Number(e.target.value))}
            style={{ width: '100%', accentColor: '#10B981' }}
          />
        </div>

        {/* Bucket Filter */}
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Bucket Filter
          </div>
          {['Simple', 'Medium', 'Complex', 'Very Complex'].map(b => (
            <label key={b} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: C.text, marginBottom: 3, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={bucketFilter.has(b)}
                onChange={() => toggleBucket(b)}
                style={{ accentColor: '#10B981' }}
              />
              {b}
            </label>
          ))}
        </div>

        {/* Critical Only */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, color: C.text }}>Critical Only</span>
          <div
            onClick={() => setCriticalOnly(v => !v)}
            style={{
              width: 28, height: 16, borderRadius: 8, cursor: 'pointer',
              background: criticalOnly ? '#EF4444' : '#334155',
              position: 'relative', transition: 'background 0.15s',
            }}
          >
            <div style={{
              width: 12, height: 12, borderRadius: '50%', background: '#fff',
              position: 'absolute', top: 2, left: criticalOnly ? 14 : 2,
              transition: 'left 0.15s',
            }} />
          </div>
        </div>

        {/* Heat scale legend */}
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Heat Scale
          </div>
          <div style={{
            height: 10, borderRadius: 4, overflow: 'hidden',
            background: 'linear-gradient(90deg, #22C55E, #EAB308, #EF4444)',
          }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: C.dim, marginTop: 2 }}>
            <span>Low</span><span>High</span>
          </div>
        </div>
      </div>

      {/* ── Canvas area ── */}
      <div ref={containerRef} style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onMouseLeave={() => setHoveredSession(null)}
          style={{ display: 'block' }}
        />

        {/* Hover tooltip */}
        {hoveredSession && (
          <div style={{
            position: 'absolute',
            left: Math.min(hoverPos.x + 12, containerWidth - 240),
            top: hoverPos.y + 12,
            width: 220, padding: 10, borderRadius: 8, zIndex: 20,
            background: 'rgba(15,23,42,0.95)', border: `1px solid ${C.border}`,
            pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {hoveredSession.name}
            </div>
            {/* Composite heat bar */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C.muted, marginBottom: 2 }}>
                <span>Composite Heat</span>
                <span style={{ fontWeight: 700, color: heatColor(hoveredSession.compositeHeat) }}>
                  {Math.round(hoveredSession.compositeHeat * 100)}%
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)' }}>
                <div style={{ height: '100%', borderRadius: 3, width: `${hoveredSession.compositeHeat * 100}%`, background: heatColor(hoveredSession.compositeHeat) }} />
              </div>
            </div>
            {/* Breakdown */}
            {[
              { label: 'Complexity (40%)', value: hoveredSession.complexityScore / 100 },
              { label: 'Density (30%)', value: hoveredSession.connectionDensity },
              { label: 'Transforms (30%)', value: hoveredSession.transformScore },
            ].map(d => (
              <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                <span style={{ fontSize: 8, color: C.dim, width: 90, flexShrink: 0 }}>{d.label}</span>
                <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)' }}>
                  <div style={{ height: '100%', borderRadius: 2, width: `${d.value * 100}%`, background: '#60A5FA' }} />
                </div>
                <span style={{ fontSize: 8, color: C.muted, width: 24, textAlign: 'right' }}>{Math.round(d.value * 100)}</span>
              </div>
            ))}
            {/* Group membership */}
            <div style={{ marginTop: 6, fontSize: 8, color: C.dim, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {hoveredSession.gravityGroup >= 0 && <span style={{ padding: '1px 4px', borderRadius: 3, background: 'rgba(59,130,246,0.12)' }}>G{hoveredSession.gravityGroup}</span>}
              {hoveredSession.communityMacro >= 0 && <span style={{ padding: '1px 4px', borderRadius: 3, background: 'rgba(168,85,247,0.12)' }}>C{hoveredSession.communityMacro}</span>}
              {hoveredSession.waveNumber >= 0 && <span style={{ padding: '1px 4px', borderRadius: 3, background: 'rgba(245,158,11,0.12)' }}>W{hoveredSession.waveNumber}</span>}
              <span style={{ padding: '1px 4px', borderRadius: 3, background: 'rgba(16,185,129,0.12)' }}>T{hoveredSession.tier}</span>
              {hoveredSession.critical && <span style={{ padding: '1px 4px', borderRadius: 3, background: 'rgba(239,68,68,0.2)', color: '#FCA5A5' }}>Critical</span>}
            </div>
          </div>
        )}
      </div>

      {/* ── Right Detail Panel ── */}
      {selectedSession && (
        <div style={{
          width: DETAIL_W, flexShrink: 0, borderLeft: `1px solid ${C.border}`,
          background: 'rgba(15,23,42,0.6)', overflowY: 'auto', padding: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {selectedSession.name}
            </div>
            <button onClick={() => setSelectedSession(null)} style={{
              background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 14, padding: '2px 6px',
            }}>x</button>
          </div>

          <div style={{ fontSize: 9, color: C.dim, marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>
            {selectedSession.sessionId}
          </div>

          {/* Composite heat */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 4 }}>
              <span style={{ color: C.muted }}>Composite Heat</span>
              <span style={{ fontWeight: 700, color: heatColor(selectedSession.compositeHeat) }}>
                {Math.round(selectedSession.compositeHeat * 100)}%
              </span>
            </div>
            <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)' }}>
              <div style={{ height: '100%', borderRadius: 4, width: `${selectedSession.compositeHeat * 100}%`, background: heatColor(selectedSession.compositeHeat) }} />
            </div>
          </div>

          {/* Complexity dimensions */}
          {selectedSession.dimensions.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Complexity Dimensions
              </div>
              {selectedSession.dimensions.map(d => (
                <div key={d.name} style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 2 }}>
                    <span style={{ color: C.text }}>{d.name}</span>
                    <span style={{ color: C.muted }}>{Math.round(d.normalized * 100)}%</span>
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.06)' }}>
                    <div style={{
                      height: '100%', borderRadius: 3, width: `${d.normalized * 100}%`,
                      background: d.normalized > 0.7 ? '#EF4444' : d.normalized > 0.4 ? '#F59E0B' : '#10B981',
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Info badges */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 14 }}>
            <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.12)', color: '#34D399' }}>
              Tier {selectedSession.tier}
            </span>
            <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.12)', color: '#60A5FA' }}>
              {selectedSession.bucket}
            </span>
            {selectedSession.critical && (
              <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: '#FCA5A5' }}>
                Critical
              </span>
            )}
          </div>

          {/* Tables */}
          {selectedSession.sources.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#10B981', marginBottom: 4 }}>Sources ({selectedSession.sources.length})</div>
              {selectedSession.sources.slice(0, 8).map(t => (
                <div key={t} style={{ fontSize: 8, color: C.dim, fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t}</div>
              ))}
              {selectedSession.sources.length > 8 && <div style={{ fontSize: 8, color: C.dim }}>+{selectedSession.sources.length - 8} more</div>}
            </div>
          )}
          {selectedSession.targets.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#EF4444', marginBottom: 4 }}>Targets ({selectedSession.targets.length})</div>
              {selectedSession.targets.slice(0, 8).map(t => (
                <div key={t} style={{ fontSize: 8, color: C.dim, fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t}</div>
              ))}
              {selectedSession.targets.length > 8 && <div style={{ fontSize: 8, color: C.dim }}>+{selectedSession.targets.length - 8} more</div>}
            </div>
          )}
          {selectedSession.lookups.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#06B6D4', marginBottom: 4 }}>Lookups ({selectedSession.lookups.length})</div>
              {selectedSession.lookups.slice(0, 5).map(t => (
                <div key={t} style={{ fontSize: 8, color: C.dim, fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t}</div>
              ))}
            </div>
          )}

          {/* Gravity group */}
          {selectedSession.gravityGroup >= 0 && (
            <div style={{ marginBottom: 10, padding: 8, borderRadius: 6, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#60A5FA', marginBottom: 4 }}>Gravity Group {selectedSession.gravityGroup}</div>
              <div style={{ fontSize: 8, color: C.dim }}>Cohesion: {selectedSession.cohesion.toFixed(3)}</div>
              <div style={{ fontSize: 8, color: C.dim }}>Coupling: {selectedSession.coupling.toFixed(3)}</div>
            </div>
          )}

          {/* Wave */}
          {selectedSession.waveNumber >= 0 && (
            <div style={{ marginBottom: 10, padding: 8, borderRadius: 6, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#F59E0B', marginBottom: 4 }}>Wave {selectedSession.waveNumber}</div>
              {selectedSession.prereqWaves.length > 0 && (
                <div style={{ fontSize: 8, color: C.dim }}>Prerequisites: {selectedSession.prereqWaves.join(', ')}</div>
              )}
            </div>
          )}

          {/* Open in Flow Walker */}
          {onSessionSelect && (
            <button
              onClick={() => onSessionSelect(selectedSession.sessionId)}
              style={{
                width: '100%', padding: '8px 12px', borderRadius: 6,
                border: '1px solid #10B981', background: 'rgba(16,185,129,0.1)',
                color: '#34D399', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                marginTop: 8,
              }}
            >
              Open in Flow Walker
            </button>
          )}
        </div>
      )}
    </div>
  );
}
