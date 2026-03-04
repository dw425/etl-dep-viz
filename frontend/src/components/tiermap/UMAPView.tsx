/**
 * UMAPView — 2D scatter plot from V3 dimensionality reduction.
 * Color by community, domain, complexity, or wave. D3 zoom/pan,
 * quadtree hit-testing, search with fly-to, rectangle select,
 * vector dimension filter, onboarding overlay, and detail panel.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { VectorResults } from '../../types/vectors';

// ── Constants ────────────────────────────────────────────────────────────────

const CLUSTER_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4',
  '#EC4899', '#84CC16', '#F97316', '#8B5CF6', '#14B8A6', '#FB923C',
];

const DOT_RADIUS = 4;
const DOT_RADIUS_HOVER = 6;
const PULSE_RING_MAX = 18;
const PULSE_DURATION = 1200; // ms per pulse cycle
const PAD = 40;

const C = {
  bg: '#1a2332',
  text: '#e2e8f0',
  muted: '#8899aa',
  dim: '#5a6a7a',
};

const ONBOARDING_KEY = 'edv-umap-guide-dismissed';

type ColorMode = 'cluster' | 'complexity' | 'wave' | 'criticality';

type FilterDimension =
  | 'none'
  | 'high_complexity'
  | 'low_complexity'
  | 'critical'
  | 'independent'
  | `wave_${number}`;

interface CoordPoint {
  session_id: string;
  x: number;
  y: number;
  cluster: number;
}

interface Props {
  vectorResults: VectorResults;
  onSessionSelect?: (sessionId: string) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * UMAPView -- 2D scatter plot of V3 dimensionality reduction projections.
 * Renders sessions as colored dots on an HTML Canvas with D3 zoom/pan,
 * quadtree-based hover hit-testing, and multiple interaction modes.
 *
 * Color modes: cluster, complexity, wave, criticality.
 * Scale modes: local, balanced, global (from V3 projections).
 *
 * Interaction features:
 *   - Hover: nearest-neighbor detection via d3.quadtree, glow ring + label
 *   - Click: opens detail panel with cluster, complexity, wave, criticality info
 *   - Search: text search with fly-to animation (zoom transition to target point)
 *   - Rectangle select: drag to lasso multiple points, shown in summary panel
 *   - Filter dimension: highlight only high/low complexity, critical, independent,
 *     or specific wave sessions (dims non-matching points to 10% opacity)
 *   - Focus pulse: animated ring on the fly-to target session
 *   - Onboarding overlay: first-visit guide (dismissed to localStorage)
 *   - Zoom controls: +/- buttons and 1:1 reset
 */
export default function UMAPView({ vectorResults, onSessionSelect }: Props) {
  // Canvas / container refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const dirtyRef = useRef(true);
  const rafRef = useRef<number>(0);
  const dimsRef = useRef({ w: 800, h: 600 });
  const hoverRef = useRef<CoordPoint | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);

  // UI state
  const [colorMode, setColorMode] = useState<ColorMode>('cluster');
  const [scale, setScale] = useState<'local' | 'balanced' | 'global'>('balanced');
  const [filterDimension, setFilterDimension] = useState<FilterDimension>('none');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const focusTimeRef = useRef(0); // timestamp when focus was set, for pulsing

  // Rectangle select
  const [rectSelectMode, setRectSelectMode] = useState(false);
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);
  const rectEndRef = useRef<{ x: number; y: number } | null>(null);
  const [selectedPoints, setSelectedPoints] = useState<Set<string>>(new Set());
  const isDraggingRectRef = useRef(false);

  // Detail panel
  const [detailSession, setDetailSession] = useState<string | null>(null);

  // Onboarding
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return !localStorage.getItem(ONBOARDING_KEY); } catch { return false; }
  });

  // ── Data extraction ──────────────────────────────────────────────────────

  const v3 = vectorResults.v3_dimensionality_reduction;
  const method = v3?.method ?? 'pca';
  const projections = v3?.projections ?? {};
  const currentProj = projections[scale] ?? projections.balanced ?? Object.values(projections)[0];
  const coords: CoordPoint[] = currentProj?.coords ?? [];

  // ── Lookup maps ──────────────────────────────────────────────────────────

  const complexityMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of vectorResults.v11_complexity?.scores ?? []) {
      m[s.session_id] = s.overall_score;
    }
    return m;
  }, [vectorResults.v11_complexity]);

  const complexityBucketMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of vectorResults.v11_complexity?.scores ?? []) {
      m[s.session_id] = s.bucket;
    }
    return m;
  }, [vectorResults.v11_complexity]);

  const waveMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const w of vectorResults.v4_wave_plan?.waves ?? []) {
      for (const sid of w.session_ids) m[sid] = w.wave_number;
    }
    return m;
  }, [vectorResults.v4_wave_plan]);

  const critMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of vectorResults.v9_wave_function?.sessions ?? []) {
      m[s.session_id] = s.criticality_score;
    }
    return m;
  }, [vectorResults.v9_wave_function]);

  const independentSet = useMemo(() => {
    const s = new Set<string>();
    for (const ind of vectorResults.v10_concentration?.independent_sessions ?? []) {
      s.add(ind.session_id);
    }
    return s;
  }, [vectorResults.v10_concentration]);

  // ── Quadtree ─────────────────────────────────────────────────────────────

  const quadtree = useMemo(() => {
    return d3.quadtree<CoordPoint>()
      .x(d => d.x)
      .y(d => d.y)
      .addAll(coords);
  }, [coords]);

  // ── Dimension filter matching ────────────────────────────────────────────

  const filterMatchSet = useMemo(() => {
    if (filterDimension === 'none') return null;
    const s = new Set<string>();
    for (const pt of coords) {
      const sid = pt.session_id;
      switch (filterDimension) {
        case 'high_complexity':
          if ((complexityMap[sid] ?? 0) > 60) s.add(sid);
          break;
        case 'low_complexity':
          if ((complexityMap[sid] ?? 100) <= 25) s.add(sid);
          break;
        case 'critical':
          if ((critMap[sid] ?? 0) > 50) s.add(sid);
          break;
        case 'independent':
          if (independentSet.has(sid)) s.add(sid);
          break;
        default:
          if (filterDimension.startsWith('wave_')) {
            const wn = parseInt(filterDimension.slice(5), 10);
            if (waveMap[sid] === wn) s.add(sid);
          }
          break;
      }
    }
    return s;
  }, [filterDimension, coords, complexityMap, critMap, waveMap, independentSet]);

  // ── Available waves for filter dropdown ──────────────────────────────────

  const availableWaves = useMemo(() => {
    const waveNums = new Set<number>();
    for (const w of vectorResults.v4_wave_plan?.waves ?? []) {
      waveNums.add(w.wave_number);
    }
    return Array.from(waveNums).sort((a, b) => a - b);
  }, [vectorResults.v4_wave_plan]);

  // ── Search results ───────────────────────────────────────────────────────

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return coords
      .filter(pt => pt.session_id.toLowerCase().includes(q))
      .slice(0, 20);
  }, [searchQuery, coords]);

  // ── Color function ───────────────────────────────────────────────────────

  const getColor = useCallback((point: CoordPoint) => {
    switch (colorMode) {
      case 'cluster':
        return CLUSTER_COLORS[point.cluster % CLUSTER_COLORS.length];
      case 'complexity': {
        const score = complexityMap[point.session_id] ?? 50;
        if (score > 75) return '#EF4444';
        if (score > 50) return '#F97316';
        if (score > 25) return '#F59E0B';
        return '#10B981';
      }
      case 'wave': {
        const w = waveMap[point.session_id] ?? 0;
        return CLUSTER_COLORS[w % CLUSTER_COLORS.length];
      }
      case 'criticality': {
        const c = critMap[point.session_id] ?? 0;
        const t = Math.min(c / 100, 1);
        const r = Math.round(16 + t * (239 - 16));
        const g = Math.round(185 + t * (68 - 185));
        const b = Math.round(129 + t * (68 - 129));
        return `rgb(${r},${g},${b})`;
      }
      default:
        return '#3B82F6';
    }
  }, [colorMode, complexityMap, waveMap, critMap]);

  // ── Coordinate mapping helpers ───────────────────────────────────────────

  const sx = useCallback((nx: number) => {
    const { w } = dimsRef.current;
    const cw = w - PAD * 2;
    return transformRef.current.applyX(PAD + nx * cw);
  }, []);

  const sy = useCallback((ny: number) => {
    const { h } = dimsRef.current;
    const ch = h - PAD * 2;
    return transformRef.current.applyY(PAD + ny * ch);
  }, []);

  // ── Drawing ──────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { w, h } = dimsRef.current;
    const t = transformRef.current;
    const hover = hoverRef.current;
    const now = performance.now();

    const cw = w - PAD * 2;
    const ch = h - PAD * 2;
    const sxl = (nx: number) => t.applyX(PAD + nx * cw);
    const syl = (ny: number) => t.applyY(PAD + ny * ch);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    if (coords.length === 0) {
      ctx.restore();
      return;
    }

    const hasFilter = filterMatchSet !== null;
    const hasSelection = selectedPoints.size > 0;

    // Draw points
    for (const pt of coords) {
      const px = sxl(pt.x);
      const py = syl(pt.y);
      const color = getColor(pt);
      const isHover = hover && hover.session_id === pt.session_id;
      const isFocused = focusedSessionId === pt.session_id;
      const isSelected = hasSelection && selectedPoints.has(pt.session_id);

      // Determine opacity: dim non-matching if filter active
      let alpha = 1.0;
      if (hasFilter && !filterMatchSet!.has(pt.session_id)) {
        alpha = 0.1;
      }

      const r = isHover ? DOT_RADIUS_HOVER : DOT_RADIUS;

      // Selected highlight ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(px, py, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(245, 158, 11, ${alpha})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Hover glow
      if (isHover) {
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.fillStyle = color + '30';
        ctx.fill();
      }

      // Dot
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1.0;

      // Focused: pulsing ring
      if (isFocused) {
        const elapsed = now - focusTimeRef.current;
        const cycle = (elapsed % PULSE_DURATION) / PULSE_DURATION;
        const pulseR = r + 4 + cycle * (PULSE_RING_MAX - r - 4);
        const pulseAlpha = 1.0 - cycle;
        ctx.beginPath();
        ctx.arc(px, py, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(59, 130, 246, ${pulseAlpha * 0.8})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        // Keep animating while focused
        dirtyRef.current = true;
      }

      // Hover label
      if (isHover) {
        ctx.fillStyle = C.text;
        ctx.font = '11px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(pt.session_id, px, py - 14);
      }
    }

    // Draw rectangle selection overlay
    const rStart = rectStartRef.current;
    const rEnd = rectEndRef.current;
    if (rStart && rEnd) {
      const rx = Math.min(rStart.x, rEnd.x);
      const ry = Math.min(rStart.y, rEnd.y);
      const rw = Math.abs(rEnd.x - rStart.x);
      const rh = Math.abs(rEnd.y - rStart.y);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
      ctx.fillRect(rx, ry, rw, rh);
    }

    ctx.restore();
  }, [coords, getColor, filterMatchSet, selectedPoints, focusedSessionId]);

  // ── Animation loop ───────────────────────────────────────────────────────

  useEffect(() => {
    const loop = () => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        draw();
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  // ── Resize observer ──────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      dimsRef.current = { w, h };
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      dirtyRef.current = true;
    };

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();
    return () => ro.disconnect();
  }, []);

  // ── D3 zoom ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.5, 15])
      .filter((event) => {
        // In rect select mode, only allow zoom via scroll wheel, not drag
        if (rectSelectMode && event.type === 'mousedown') return false;
        return true;
      })
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        dirtyRef.current = true;
      });

    zoomRef.current = zoom;
    d3.select(canvas).call(zoom);

    return () => {
      d3.select(canvas).on('.zoom', null);
    };
  }, [rectSelectMode]);

  // ── Hit-test via quadtree ────────────────────────────────────────────────

  const hitTest = useCallback((clientX: number, clientY: number): CoordPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas || coords.length === 0) return null;

    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    const t = transformRef.current;
    const { w, h } = dimsRef.current;
    const cw = w - PAD * 2;
    const ch = h - PAD * 2;

    const nx = (t.invertX(mx) - PAD) / cw;
    const ny = (t.invertY(my) - PAD) / ch;

    const searchR = (DOT_RADIUS_HOVER * 2) / (Math.min(cw, ch) * t.k);

    const found = quadtree.find(nx, ny, searchR);
    return found || null;
  }, [coords, quadtree]);

  // ── Mouse handlers ───────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // If dragging rectangle
    if (rectSelectMode && isDraggingRectRef.current) {
      const rect = canvas.getBoundingClientRect();
      rectEndRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      dirtyRef.current = true;
      return;
    }

    const pt = hitTest(e.clientX, e.clientY);
    if (pt !== hoverRef.current) {
      hoverRef.current = pt;
      dirtyRef.current = true;
      canvas.style.cursor = rectSelectMode ? 'crosshair' : (pt ? 'pointer' : 'grab');
    }
  }, [hitTest, rectSelectMode]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!rectSelectMode) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    rectStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    rectEndRef.current = null;
    isDraggingRectRef.current = true;
  }, [rectSelectMode]);

  const handleMouseUp = useCallback((_e: React.MouseEvent) => {
    if (!rectSelectMode || !isDraggingRectRef.current) return;
    isDraggingRectRef.current = false;

    const rStart = rectStartRef.current;
    const rEnd = rectEndRef.current;
    if (!rStart || !rEnd) {
      rectStartRef.current = null;
      rectEndRef.current = null;
      dirtyRef.current = true;
      return;
    }

    // Find all points inside the rectangle (screen coords)
    const t = transformRef.current;
    const { w, h } = dimsRef.current;
    const cw = w - PAD * 2;
    const ch = h - PAD * 2;

    const minX = Math.min(rStart.x, rEnd.x);
    const maxX = Math.max(rStart.x, rEnd.x);
    const minY = Math.min(rStart.y, rEnd.y);
    const maxY = Math.max(rStart.y, rEnd.y);

    const selected = new Set<string>();
    for (const pt of coords) {
      const px = t.applyX(PAD + pt.x * cw);
      const py = t.applyY(PAD + pt.y * ch);
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
        selected.add(pt.session_id);
      }
    }

    setSelectedPoints(selected);
    rectStartRef.current = null;
    rectEndRef.current = null;
    dirtyRef.current = true;
  }, [rectSelectMode, coords]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (rectSelectMode) return; // handled by mouse up
    const pt = hitTest(e.clientX, e.clientY);
    if (pt) {
      setDetailSession(pt.session_id);
      if (onSessionSelect) {
        onSessionSelect(pt.session_id);
      }
    } else {
      setDetailSession(null);
    }
  }, [hitTest, rectSelectMode, onSessionSelect]);

  const handleMouseLeave = useCallback(() => {
    if (isDraggingRectRef.current) {
      isDraggingRectRef.current = false;
      rectStartRef.current = null;
      rectEndRef.current = null;
      dirtyRef.current = true;
    }
    if (hoverRef.current) {
      hoverRef.current = null;
      dirtyRef.current = true;
    }
  }, []);

  // ── Fly-to search result ─────────────────────────────────────────────────

  const flyTo = useCallback((sessionId: string) => {
    const canvas = canvasRef.current;
    const zoom = zoomRef.current;
    if (!canvas || !zoom) return;

    const pt = coords.find(p => p.session_id === sessionId);
    if (!pt) return;

    const { w, h } = dimsRef.current;
    const cw = w - PAD * 2;
    const ch = h - PAD * 2;
    const targetX = PAD + pt.x * cw;
    const targetY = PAD + pt.y * ch;

    const targetScale = 5;
    const newTransform = d3.zoomIdentity
      .translate(w / 2 - targetX * targetScale, h / 2 - targetY * targetScale)
      .scale(targetScale);

    d3.select(canvas)
      .transition()
      .duration(500)
      .call(zoom.transform as any, newTransform);

    setFocusedSessionId(sessionId);
    focusTimeRef.current = performance.now();
    setDetailSession(sessionId);
    setSearchOpen(false);
    setSearchQuery('');
  }, [coords]);

  // ── Dismiss onboarding ──────────────────────────────────────────────────

  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* noop */ }
  }, []);

  // ── Detail panel data ────────────────────────────────────────────────────

  const detailData = useMemo(() => {
    if (!detailSession) return null;
    const pt = coords.find(p => p.session_id === detailSession);
    if (!pt) return null;
    return {
      session_id: detailSession,
      cluster: pt.cluster,
      complexity_score: complexityMap[detailSession] ?? null,
      complexity_bucket: complexityBucketMap[detailSession] ?? null,
      wave: waveMap[detailSession] ?? null,
      criticality: critMap[detailSession] ?? null,
    };
  }, [detailSession, coords, complexityMap, complexityBucketMap, waveMap, critMap]);

  // ── Mark dirty on relevant state changes ─────────────────────────────────

  useEffect(() => {
    dirtyRef.current = true;
  }, [colorMode, scale, filterDimension, selectedPoints, focusedSessionId]);

  // ── No data ──────────────────────────────────────────────────────────────

  if (!v3 || coords.length === 0) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 256, fontSize: 13, color: C.muted,
      }}>
        Run Phase 2+ vector analysis to enable UMAP projection
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: C.bg }}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
        borderBottom: '1px solid rgba(30, 41, 59, 0.6)', flexWrap: 'wrap',
        background: 'rgba(15, 23, 42, 0.6)', flexShrink: 0,
      }}>
        {/* Info badges */}
        <span style={{ fontSize: 10, color: C.muted }}>Method: {method.toUpperCase()}</span>
        <span style={{ fontSize: 10, color: C.muted }}>{coords.length} points</span>
        <span style={{ fontSize: 10, color: C.muted }}>{currentProj?.n_clusters ?? '?'} clusters</span>

        {/* Search */}
        <div style={{ position: 'relative', marginLeft: 8 }}>
          <input
            type="text"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            style={{
              width: 180, padding: '4px 8px', fontSize: 11, borderRadius: 4,
              border: '1px solid rgba(100, 116, 139, 0.3)', background: 'rgba(15, 23, 42, 0.8)',
              color: C.text, outline: 'none',
            }}
          />
          {searchOpen && searchResults.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, width: 260, maxHeight: 300,
              overflowY: 'auto', background: 'rgba(15, 23, 42, 0.97)',
              border: '1px solid rgba(100, 116, 139, 0.3)', borderRadius: 6,
              zIndex: 100, marginTop: 2,
            }}>
              {searchResults.map(pt => (
                <div
                  key={pt.session_id}
                  onClick={() => flyTo(pt.session_id)}
                  style={{
                    padding: '6px 10px', fontSize: 11, color: C.text, cursor: 'pointer',
                    borderBottom: '1px solid rgba(30, 41, 59, 0.4)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(59, 130, 246, 0.15)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ color: '#3B82F6' }}>{pt.session_id}</span>
                  <span style={{ color: C.dim, marginLeft: 8, fontSize: 9 }}>
                    cluster {pt.cluster}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Close search dropdown on blur */}
        {searchOpen && (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 50 }}
            onClick={() => setSearchOpen(false)}
          />
        )}

        {/* Filter dropdown */}
        <select
          value={filterDimension}
          onChange={e => setFilterDimension(e.target.value as FilterDimension)}
          style={{
            fontSize: 10, padding: '3px 6px', borderRadius: 4,
            border: '1px solid rgba(100, 116, 139, 0.3)', background: 'rgba(15, 23, 42, 0.8)',
            color: filterDimension === 'none' ? C.muted : '#3B82F6', cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option value="none">Filter: None</option>
          <option value="high_complexity">High Complexity</option>
          <option value="low_complexity">Low Complexity</option>
          <option value="critical">Critical</option>
          <option value="independent">Independent</option>
          {availableWaves.map(w => (
            <option key={w} value={`wave_${w}`}>Wave {w}</option>
          ))}
        </select>

        {/* Rect select toggle */}
        <button
          onClick={() => {
            setRectSelectMode(m => !m);
            setSelectedPoints(new Set());
            rectStartRef.current = null;
            rectEndRef.current = null;
            dirtyRef.current = true;
          }}
          title={rectSelectMode ? 'Disable rectangle select' : 'Enable rectangle select'}
          style={{
            padding: '3px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
            border: `1px solid ${rectSelectMode ? 'rgba(59,130,246,0.5)' : 'rgba(100,116,139,0.3)'}`,
            background: rectSelectMode ? 'rgba(59,130,246,0.15)' : 'rgba(26,35,50,0.8)',
            color: rectSelectMode ? '#60A5FA' : C.muted,
          }}
        >
          Rect Select
        </button>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Scale selector */}
        <div style={{ display: 'flex', gap: 2 }}>
          {Object.keys(projections).map(s => (
            <button
              key={s}
              onClick={() => setScale(s as 'local' | 'balanced' | 'global')}
              style={{
                padding: '2px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                border: 'none',
                background: scale === s ? 'rgba(59,130,246,0.2)' : 'transparent',
                color: scale === s ? '#60A5FA' : C.muted,
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Color mode selector */}
        <div style={{ display: 'flex', gap: 2, borderLeft: '1px solid rgba(100,116,139,0.3)', paddingLeft: 8 }}>
          {(['cluster', 'complexity', 'wave', 'criticality'] as ColorMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setColorMode(mode)}
              style={{
                padding: '2px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                border: 'none', textTransform: 'capitalize',
                background: colorMode === mode ? 'rgba(59,130,246,0.2)' : 'transparent',
                color: colorMode === mode ? '#60A5FA' : C.muted,
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main area: canvas + optional detail panel ─────────────────── */}
      <div style={{ display: 'flex', flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Canvas container */}
        <div ref={containerRef} style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <canvas
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onClick={handleClick}
            onMouseLeave={handleMouseLeave}
            style={{ display: 'block', cursor: rectSelectMode ? 'crosshair' : 'grab' }}
          />

          {/* Zoom controls */}
          <div style={{
            position: 'absolute', bottom: 50, right: 12,
            display: 'flex', flexDirection: 'column', gap: 4, zIndex: 10,
          }}>
            {[
              { label: '+', factor: 1.5 },
              { label: '-', factor: 0.67 },
            ].map(b => (
              <button key={b.label} onClick={() => {
                const canvas = canvasRef.current;
                const zoom = zoomRef.current;
                if (canvas && zoom) {
                  d3.select(canvas).transition().duration(200).call(zoom.scaleBy as any, b.factor);
                }
              }} style={{
                width: 28, height: 28, borderRadius: 5,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(26,35,50,0.85)', color: '#94a3b8', fontSize: 14,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{b.label}</button>
            ))}
            {/* Reset zoom */}
            <button onClick={() => {
              const canvas = canvasRef.current;
              const zoom = zoomRef.current;
              if (canvas && zoom) {
                d3.select(canvas).transition().duration(300).call(zoom.transform as any, d3.zoomIdentity);
              }
              setFocusedSessionId(null);
            }} title="Reset zoom" style={{
              width: 28, height: 28, borderRadius: 5,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(26,35,50,0.85)', color: '#94a3b8', fontSize: 10,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>1:1</button>
          </div>

          {/* Stats overlay */}
          <div style={{
            position: 'absolute', bottom: 12, left: 12,
            padding: '6px 14px', borderRadius: 8,
            background: 'rgba(15, 23, 42, 0.85)', border: '1px solid rgba(30, 41, 59, 0.6)',
            display: 'flex', gap: 16, fontSize: 10, color: C.muted,
          }}>
            <span><strong style={{ color: C.text }}>{coords.length.toLocaleString()}</strong> Points</span>
            <span><strong style={{ color: '#3B82F6' }}>{currentProj?.n_clusters ?? '?'}</strong> Clusters</span>
            {filterMatchSet && (
              <span><strong style={{ color: '#F59E0B' }}>{filterMatchSet.size}</strong> matched</span>
            )}
            {selectedPoints.size > 0 && (
              <span><strong style={{ color: '#A855F7' }}>{selectedPoints.size}</strong> selected</span>
            )}
            <span style={{ color: C.dim }}>Scroll to zoom · Drag to pan</span>
          </div>

          {/* Rectangle selection summary panel */}
          {selectedPoints.size > 0 && (
            <div style={{
              position: 'absolute', top: 12, left: 12, width: 240,
              maxHeight: 300, overflowY: 'auto',
              background: 'rgba(15, 23, 42, 0.95)',
              border: '1px solid rgba(168, 85, 247, 0.4)', borderRadius: 8,
              padding: 12, zIndex: 20,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#A855F7' }}>
                  {selectedPoints.size} sessions selected
                </span>
                <button
                  onClick={() => { setSelectedPoints(new Set()); dirtyRef.current = true; }}
                  style={{
                    fontSize: 9, padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
                    background: 'rgba(100,116,139,0.2)', border: 'none', color: C.muted,
                  }}
                >Clear</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {Array.from(selectedPoints).slice(0, 50).map(sid => (
                  <div
                    key={sid}
                    onClick={() => { setDetailSession(sid); onSessionSelect?.(sid); }}
                    style={{
                      fontSize: 10, color: C.text, padding: '3px 6px', borderRadius: 3,
                      cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(59, 130, 246, 0.15)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {sid}
                  </div>
                ))}
                {selectedPoints.size > 50 && (
                  <div style={{ fontSize: 9, color: C.dim, padding: '3px 6px' }}>
                    ...and {selectedPoints.size - 50} more
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Onboarding overlay */}
          {showOnboarding && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: 'rgba(8, 12, 20, 0.8)', zIndex: 30,
            }}>
              <div style={{
                maxWidth: 420, padding: '24px 28px', borderRadius: 12,
                background: 'rgba(15, 23, 42, 0.98)',
                border: '1px solid rgba(59, 130, 246, 0.3)',
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 }}>
                  Projection Scatter Plot
                </div>
                <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7, marginBottom: 20 }}>
                  This scatter plot projects sessions into 2D space based on structural similarity.
                  Sessions that appear close together share similar dependency patterns, complexity,
                  and table usage.
                </div>
                <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.6, marginBottom: 20 }}>
                  <div style={{ marginBottom: 4 }}><strong style={{ color: '#60A5FA' }}>Scroll</strong> to zoom, <strong style={{ color: '#60A5FA' }}>drag</strong> to pan</div>
                  <div style={{ marginBottom: 4 }}><strong style={{ color: '#60A5FA' }}>Click</strong> a point for details</div>
                  <div style={{ marginBottom: 4 }}><strong style={{ color: '#60A5FA' }}>Search</strong> to find and fly to a session</div>
                  <div><strong style={{ color: '#60A5FA' }}>Rect Select</strong> to select multiple sessions</div>
                </div>
                <button
                  onClick={dismissOnboarding}
                  style={{
                    padding: '8px 20px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                    background: 'rgba(59, 130, 246, 0.2)', border: '1px solid rgba(59, 130, 246, 0.4)',
                    color: '#60A5FA', cursor: 'pointer',
                  }}
                >
                  Got it
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Detail panel (right side) ──────────────────────────────────── */}
        {detailData && (
          <div style={{
            width: 280, flexShrink: 0, borderLeft: '1px solid rgba(30, 41, 59, 0.6)',
            background: 'rgba(15, 23, 42, 0.6)', overflowY: 'auto',
            padding: 16, display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#10B981', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                Session Detail
              </div>
              <button
                onClick={() => setDetailSession(null)}
                style={{
                  fontSize: 14, background: 'none', border: 'none', color: C.muted,
                  cursor: 'pointer', lineHeight: 1, padding: 0,
                }}
              >x</button>
            </div>

            {/* Session name */}
            <div style={{
              fontSize: 12, fontWeight: 600, color: C.text, wordBreak: 'break-all',
              padding: '8px 10px', borderRadius: 6, background: 'rgba(0,0,0,0.3)',
            }}>
              {detailData.session_id}
            </div>

            {/* Cluster */}
            <DetailRow label="Cluster" value={String(detailData.cluster)} color={CLUSTER_COLORS[detailData.cluster % CLUSTER_COLORS.length]} />

            {/* Complexity */}
            {detailData.complexity_score !== null && (
              <DetailRow
                label="Complexity"
                value={`${detailData.complexity_score.toFixed(1)} — ${detailData.complexity_bucket ?? 'N/A'}`}
                color={detailData.complexity_score > 75 ? '#EF4444' : detailData.complexity_score > 50 ? '#F97316' : detailData.complexity_score > 25 ? '#F59E0B' : '#10B981'}
              />
            )}

            {/* Wave */}
            {detailData.wave !== null && (
              <DetailRow label="Wave" value={`Wave ${detailData.wave}`} color={CLUSTER_COLORS[detailData.wave % CLUSTER_COLORS.length]} />
            )}

            {/* Criticality */}
            {detailData.criticality !== null && (
              <DetailRow
                label="Criticality"
                value={detailData.criticality.toFixed(1)}
                color={detailData.criticality > 70 ? '#EF4444' : detailData.criticality > 40 ? '#F97316' : '#10B981'}
              />
            )}

            {/* Independent */}
            {independentSet.has(detailData.session_id) && (
              <div style={{
                fontSize: 10, padding: '6px 10px', borderRadius: 4,
                background: 'rgba(6, 182, 212, 0.1)', border: '1px solid rgba(6, 182, 212, 0.3)',
                color: '#06B6D4',
              }}>
                Independent Session
              </div>
            )}

            {/* Open in Flow Walker */}
            <button
              onClick={() => onSessionSelect?.(detailData.session_id)}
              style={{
                marginTop: 8, padding: '8px 16px', fontSize: 11, fontWeight: 600,
                borderRadius: 6, cursor: 'pointer',
                background: 'rgba(59, 130, 246, 0.15)', border: '1px solid rgba(59, 130, 246, 0.4)',
                color: '#60A5FA', width: '100%',
              }}
            >
              Open in Flow Walker
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Detail row sub-component ─────────────────────────────────────────────────

/** Single key-value row in the session detail panel with colored value text. */
function DetailRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: C.muted }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color }}>{value}</span>
    </div>
  );
}
