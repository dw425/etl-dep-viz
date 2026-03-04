/**
 * AlgorithmLab — Interactive Clustering Playground.
 *
 * Lets users explore how different clustering algorithms transform raw ETL
 * dependency data. Starts with raw data (gray grid), runs algorithms iteratively,
 * visually compares results via run history, and resets back to raw.
 *
 * Layout:
 *   Left sidebar  — Algorithm picker, parameter editor, run button, quality metrics, filters
 *   Main area     — Canvas scatter plot (D3 zoom/pan, quadtree hit-testing, convex hulls)
 *   Bottom right  — Run history table (click to view past results)
 *
 * @param tierData - Parsed tier map data (sessions, tables, connections)
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import type { TierMapResult, ConstellationResult, ConstellationPoint, ConstellationChunk } from '../../types/tiermap';
import { getLabAlgorithms, runLabAlgorithm, type LabAlgorithmInfo, type LabRunResult } from '../../api/client';

// ── Constants ────────────────────────────────────────────────────────────────

const CHUNK_PALETTE = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4',
  '#EC4899', '#84CC16', '#F97316', '#8B5CF6', '#14B8A6', '#FB923C',
];

const SPEED_COLORS: Record<string, string> = { fast: '#10B981', medium: '#F59E0B', slow: '#EF4444' };

const CATEGORY_ORDER = ['modularity', 'propagation', 'hierarchical', 'information', 'inference', 'spectral', 'embedding', 'domain'];

interface HistoryEntry {
  id: number;
  result: LabRunResult;
}

interface Props {
  tierData: TierMapResult;
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function AlgorithmLab({ tierData }: Props) {
  // Algorithm registry
  const [algorithms, setAlgorithms] = useState<Record<string, LabAlgorithmInfo>>({});
  const [selectedAlgo, setSelectedAlgo] = useState('louvain');
  const [algoParams, setAlgoParams] = useState<Record<string, number>>({});
  const [lockSeed, setLockSeed] = useState(false);
  const [seedValue, setSeedValue] = useState(42);

  // Run state
  const [running, setRunning] = useState(false);
  const [currentResult, setCurrentResult] = useState<LabRunResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<number | null>(null);
  const nextId = useRef(1);

  // Filters
  const [filterTiers, setFilterTiers] = useState<Set<number>>(new Set());
  const [filterClusters, setFilterClusters] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState('');
  const [criticalOnly, setCriticalOnly] = useState(false);

  // Canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
  const transformRef = useRef(d3.zoomIdentity);
  const dirtyRef = useRef(true);
  const rafRef = useRef<number>(0);
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);

  // Hover
  const [hoveredPoint, setHoveredPoint] = useState<ConstellationPoint | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });

  // Load algorithm registry
  useEffect(() => {
    getLabAlgorithms().then(algos => {
      setAlgorithms(algos);
      if (algos[selectedAlgo]?.params) {
        const defaults: Record<string, number> = {};
        for (const [k, v] of Object.entries(algos[selectedAlgo].params!)) {
          defaults[k] = v.default;
        }
        setAlgoParams(defaults);
      }
    }).catch(() => {});
  }, []);

  // Update params when algorithm changes
  useEffect(() => {
    const info = algorithms[selectedAlgo];
    if (info?.params) {
      const defaults: Record<string, number> = {};
      for (const [k, v] of Object.entries(info.params)) {
        defaults[k] = v.default;
      }
      setAlgoParams(defaults);
    } else {
      setAlgoParams({});
    }
  }, [selectedAlgo, algorithms]);

  // Available tiers
  const allTiers = useMemo(() => {
    const tiers = new Set<number>();
    for (const s of tierData.sessions) tiers.add(s.tier);
    return Array.from(tiers).sort((a, b) => a - b);
  }, [tierData]);

  // Current constellation data (from active history entry or current result)
  const displayResult = useMemo(() => {
    if (activeHistoryId !== null) {
      const entry = history.find(h => h.id === activeHistoryId);
      return entry?.result ?? null;
    }
    return currentResult;
  }, [activeHistoryId, history, currentResult]);

  // Points and chunks for rendering
  const { points, chunks, chunkColorMap } = useMemo(() => {
    if (!displayResult) {
      // Raw grid layout
      const sessions = tierData.sessions || [];
      const n = sessions.length;
      const cols = Math.max(Math.ceil(Math.sqrt(n)), 1);
      const pts: ConstellationPoint[] = sessions.map((s, i) => ({
        session_id: s.id,
        x: (i % cols) / Math.max(cols - 1, 1),
        y: Math.floor(i / cols) / Math.max(Math.ceil(n / cols) - 1, 1),
        chunk_id: 'raw',
        tier: s.tier,
        critical: s.critical,
        name: s.name,
      }));
      return { points: pts, chunks: [] as ConstellationChunk[], chunkColorMap: new Map<string, string>() };
    }

    const cMap = new Map<string, string>();
    for (const c of displayResult.constellation.chunks) {
      cMap.set(c.id, c.color);
    }
    return {
      points: displayResult.constellation.points,
      chunks: displayResult.constellation.chunks,
      chunkColorMap: cMap,
    };
  }, [displayResult, tierData]);

  // Quadtree for hit-testing
  const quadtree = useMemo(() => {
    return d3.quadtree<ConstellationPoint>()
      .x(d => d.x)
      .y(d => d.y)
      .addAll(points);
  }, [points]);

  // Filtered point set
  const filteredIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of points) {
      if (filterTiers.size > 0 && !filterTiers.has(p.tier)) continue;
      if (filterClusters.size > 0 && !filterClusters.has(p.chunk_id)) continue;
      if (criticalOnly && !p.critical) continue;
      if (searchText) {
        const q = searchText.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !p.session_id.toLowerCase().includes(q)) continue;
      }
      ids.add(p.session_id);
    }
    return ids;
  }, [points, filterTiers, filterClusters, criticalOnly, searchText]);

  const hasFilters = filterTiers.size > 0 || filterClusters.size > 0 || criticalOnly || searchText.length > 0;

  // Convex hulls per chunk
  const chunkHulls = useMemo(() => {
    if (!displayResult) return new Map<string, [number, number][]>();
    const grouped = new Map<string, [number, number][]>();
    for (const p of points) {
      if (!grouped.has(p.chunk_id)) grouped.set(p.chunk_id, []);
      grouped.get(p.chunk_id)!.push([p.x, p.y]);
    }
    const hulls = new Map<string, [number, number][]>();
    for (const [id, pts] of grouped) {
      if (pts.length < 3) { hulls.set(id, pts); continue; }
      const hull = d3.polygonHull(pts);
      hulls.set(id, hull || pts);
    }
    return hulls;
  }, [points, displayResult]);

  // ── Canvas rendering ─────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { w, h } = canvasSize;
    const t = transformRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1a2332';
    ctx.fillRect(0, 0, w, h);

    const pad = 40;
    const cw = w - pad * 2;
    const ch = h - pad * 2;
    const sx = (nx: number) => t.applyX(pad + nx * cw);
    const sy = (ny: number) => t.applyY(pad + ny * ch);

    const isRaw = !displayResult;
    const k = t.k;

    // Draw hulls (only when clustered)
    if (!isRaw) {
      for (const [chunkId, hull] of chunkHulls) {
        if (hull.length < 3) continue;
        const color = chunkColorMap.get(chunkId) || '#5a6a7a';
        ctx.beginPath();
        ctx.moveTo(sx(hull[0][0]), sy(hull[0][1]));
        for (let i = 1; i < hull.length; i++) {
          ctx.lineTo(sx(hull[i][0]), sy(hull[i][1]));
        }
        ctx.closePath();
        ctx.fillStyle = hexToRgba(color, 0.08);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 0.25);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Draw cross-chunk edges
    if (!isRaw && displayResult) {
      const centroids = new Map<string, { x: number; y: number }>();
      for (const c of chunks) {
        const cPts = points.filter(p => p.chunk_id === c.id);
        if (cPts.length === 0) continue;
        centroids.set(c.id, {
          x: cPts.reduce((s, p) => s + p.x, 0) / cPts.length,
          y: cPts.reduce((s, p) => s + p.y, 0) / cPts.length,
        });
      }
      for (const edge of displayResult.constellation.cross_chunk_edges) {
        const from = centroids.get(edge.from_chunk);
        const to = centroids.get(edge.to_chunk);
        if (!from || !to) continue;
        const fx = sx(from.x), fy = sy(from.y);
        const tx2 = sx(to.x), ty = sy(to.y);
        const mx = (fx + tx2) / 2, my = (fy + ty) / 2;
        const dx = tx2 - fx, dy = ty - fy;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.quadraticCurveTo(mx - dy * 0.15, my + dx * 0.15, tx2, ty);
        ctx.strokeStyle = `rgba(148,163,184,${Math.min(0.4, edge.count * 0.05)})`;
        ctx.lineWidth = Math.min(Math.sqrt(edge.count) * 0.5, 4);
        ctx.stroke();
      }
    }

    // Draw points
    const dotR = isRaw ? 2.5 : (k < 1 ? 2 : k < 3 ? 3 : 4);
    for (const p of points) {
      const px = sx(p.x), py = sy(p.y);
      if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;

      const inFilter = !hasFilters || filteredIds.has(p.session_id);
      let color: string;
      if (isRaw) {
        color = inFilter ? '#8899aa' : 'rgba(100,116,139,0.1)';
      } else {
        const base = chunkColorMap.get(p.chunk_id) || '#8899aa';
        color = inFilter ? base : hexToRgba(base, 0.1);
      }

      ctx.beginPath();
      ctx.arc(px, py, dotR, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      if (p.critical && inFilter) {
        ctx.strokeStyle = '#FCD34D';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Labels at zoom
    if (!isRaw && k >= 2.5) {
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      for (const p of points) {
        const inFilter = !hasFilters || filteredIds.has(p.session_id);
        if (!inFilter) continue;
        const px = sx(p.x), py = sy(p.y);
        if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
        ctx.fillStyle = 'rgba(226,232,240,0.7)';
        ctx.fillText(p.name.slice(0, 20), px + dotR + 3, py + 3);
      }
    }

    // Hover card
    if (hoveredPoint) {
      const hx = mouseRef.current.x;
      const hy = mouseRef.current.y;
      const cardW = 220, cardH = 70;
      const cx = hx + 15, cy = Math.min(hy - 10, h - cardH - 10);
      ctx.fillStyle = 'rgba(30,41,59,0.95)';
      roundRect(ctx, cx, cy, cardW, cardH, 6);
      ctx.fill();
      ctx.strokeStyle = '#5a6a7a';
      ctx.lineWidth = 1;
      roundRect(ctx, cx, cy, cardW, cardH, 6);
      ctx.stroke();

      ctx.fillStyle = '#E2E8F0';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(hoveredPoint.name.slice(0, 28), cx + 8, cy + 18);
      ctx.fillStyle = '#94A3B8';
      ctx.font = '10px monospace';
      ctx.fillText(`Tier ${hoveredPoint.tier} | ${hoveredPoint.chunk_id}`, cx + 8, cy + 34);
      ctx.fillText(`${hoveredPoint.session_id}${hoveredPoint.critical ? ' | CRITICAL' : ''}`, cx + 8, cy + 50);
    }
  }, [canvasSize, points, chunks, chunkColorMap, chunkHulls, displayResult, hoveredPoint, hasFilters, filteredIds]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        setCanvasSize({ w: Math.round(width), h: Math.round(height) });
        dirtyRef.current = true;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Canvas setup + DPR
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.w * dpr;
    canvas.height = canvasSize.h * dpr;
    canvas.style.width = `${canvasSize.w}px`;
    canvas.style.height = `${canvasSize.h}px`;
    dirtyRef.current = true;
  }, [canvasSize]);

  // D3 zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.3, 20])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        dirtyRef.current = true;
      });
    d3.select(canvas).call(zoom);
    zoomRef.current = zoom;
    return () => { d3.select(canvas).on('.zoom', null); };
  }, []);

  // Mouse move for hit testing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      mouseRef.current = { x: mx, y: my };

      const t = transformRef.current;
      const pad = 40;
      const cw = canvasSize.w - pad * 2;
      const ch = canvasSize.h - pad * 2;
      const nx = (t.invertX(mx) - pad) / cw;
      const ny = (t.invertY(my) - pad) / ch;
      const searchR = 15 / (cw * t.k);
      const found = quadtree.find(nx, ny, searchR);
      setHoveredPoint(found ?? null);
      dirtyRef.current = true;
    };
    canvas.addEventListener('mousemove', onMove);
    return () => canvas.removeEventListener('mousemove', onMove);
  }, [quadtree, canvasSize]);

  // RAF loop
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

  // Mark dirty when data changes
  useEffect(() => { dirtyRef.current = true; }, [displayResult, hasFilters, filteredIds]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleRun = async () => {
    setRunning(true);
    try {
      const result = await runLabAlgorithm(
        tierData as unknown as Record<string, unknown>,
        selectedAlgo,
        algoParams,
        lockSeed ? seedValue : undefined,
      );
      setCurrentResult(result);
      const entry: HistoryEntry = { id: nextId.current++, result };
      setHistory(prev => [...prev, entry]);
      setActiveHistoryId(entry.id);
    } catch (e: any) {
      console.error('Lab run failed:', e);
    } finally {
      setRunning(false);
    }
  };

  const handleReset = () => {
    setCurrentResult(null);
    setHistory([]);
    setActiveHistoryId(null);
    setFilterTiers(new Set());
    setFilterClusters(new Set());
    setSearchText('');
    setCriticalOnly(false);
    // Reset zoom
    const canvas = canvasRef.current;
    if (canvas && zoomRef.current) {
      d3.select(canvas).call(zoomRef.current.transform, d3.zoomIdentity);
    }
  };

  const handleHistoryClick = (id: number) => {
    setActiveHistoryId(id);
    setFilterClusters(new Set());
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const metrics = displayResult?.quality_metrics;
  const meta = displayResult?.run_meta;

  // Group algorithms by category
  const algosByCategory = useMemo(() => {
    const grouped = new Map<string, [string, LabAlgorithmInfo][]>();
    for (const cat of CATEGORY_ORDER) grouped.set(cat, []);
    for (const [key, info] of Object.entries(algorithms)) {
      const cat = info.category || 'other';
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push([key, info]);
    }
    return grouped;
  }, [algorithms]);

  const currentChunks = displayResult?.constellation.chunks ?? [];

  return (
    <div style={{ display: 'flex', height: '100%', background: '#1a2332', color: '#E2E8F0', fontFamily: 'monospace' }}>
      {/* ── Left Sidebar ── */}
      <div style={{ width: 260, borderRight: '1px solid #3a4a5e', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
        {/* Header */}
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #3a4a5e', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Algorithm Lab</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={handleReset} style={btnStyle} title="Reset to raw">Reset</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px' }}>
          {/* Algorithm Picker */}
          <SectionLabel>Algorithm</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12 }}>
            {Array.from(algosByCategory.entries()).map(([cat, algos]) => algos.length > 0 && (
              <React.Fragment key={cat}>
                <div style={{ fontSize: 9, color: '#8899aa', textTransform: 'uppercase', letterSpacing: 1, padding: '6px 0 2px' }}>{cat}</div>
                {algos.map(([key, info]) => (
                  <button
                    key={key}
                    onClick={() => setSelectedAlgo(key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
                      background: selectedAlgo === key ? '#1E3A5F' : 'transparent',
                      border: selectedAlgo === key ? '1px solid #3B82F6' : '1px solid transparent',
                      borderRadius: 4, cursor: 'pointer', color: '#E2E8F0', fontSize: 12,
                      width: '100%', textAlign: 'left',
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: selectedAlgo === key ? '#3B82F6' : '#5a6a7a', flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{info.name}</span>
                    <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: SPEED_COLORS[info.speed] + '22', color: SPEED_COLORS[info.speed] }}>
                      {info.speed}
                    </span>
                  </button>
                ))}
              </React.Fragment>
            ))}
          </div>

          {/* Parameters */}
          {Object.keys(algoParams).length > 0 && (
            <>
              <SectionLabel>Parameters</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                {Object.entries(algorithms[selectedAlgo]?.params ?? {}).map(([key, spec]) => (
                  <div key={key}>
                    <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 2 }}>{key}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="range"
                        min={spec.min}
                        max={spec.max}
                        step={spec.type === 'float' ? 0.1 : 1}
                        value={algoParams[key] ?? spec.default}
                        onChange={e => setAlgoParams(p => ({ ...p, [key]: Number(e.target.value) }))}
                        style={{ flex: 1, accentColor: '#3B82F6' }}
                      />
                      <input
                        type="number"
                        min={spec.min}
                        max={spec.max}
                        step={spec.type === 'float' ? 0.1 : 1}
                        value={algoParams[key] ?? spec.default}
                        onChange={e => setAlgoParams(p => ({ ...p, [key]: Number(e.target.value) }))}
                        style={{ width: 50, background: '#3a4a5e', border: '1px solid #4a5a6e', borderRadius: 3, color: '#E2E8F0', padding: '2px 4px', fontSize: 11, textAlign: 'right' }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Seed control */}
          <SectionLabel>Seed</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={lockSeed} onChange={e => setLockSeed(e.target.checked)} />
              Lock
            </label>
            {lockSeed && (
              <input
                type="number"
                value={seedValue}
                onChange={e => setSeedValue(Number(e.target.value))}
                style={{ width: 60, background: '#3a4a5e', border: '1px solid #4a5a6e', borderRadius: 3, color: '#E2E8F0', padding: '2px 4px', fontSize: 11, textAlign: 'right' }}
              />
            )}
            {!lockSeed && <span style={{ fontSize: 10, color: '#8899aa' }}>Random each run</span>}
          </div>

          {/* Run button */}
          <button
            onClick={handleRun}
            disabled={running}
            style={{
              width: '100%', padding: '8px 0', marginBottom: 14,
              background: running ? '#4a5a6e' : '#3B82F6', color: '#fff',
              border: 'none', borderRadius: 5, cursor: running ? 'wait' : 'pointer',
              fontWeight: 600, fontSize: 13, fontFamily: 'monospace',
            }}
          >
            {running ? 'Running...' : '\u25B6 Run Algorithm'}
          </button>

          {/* Quality Metrics */}
          {metrics && (
            <>
              <SectionLabel>Quality Metrics</SectionLabel>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 12 }}>
                <MetricCard label="Modularity" value={metrics.modularity.toFixed(3)} color={metricColor(metrics.modularity, 0, 1)} />
                <MetricCard label="Silhouette" value={metrics.silhouette.toFixed(3)} color={metricColor(metrics.silhouette, -1, 1)} />
                <MetricCard label="Clusters" value={String(metrics.n_clusters)} color="#3B82F6" />
                <MetricCard label="Entropy" value={metrics.entropy.toFixed(2)} color="#A855F7" />
                <MetricCard label="Duration" value={`${metrics.duration_ms}ms`} color="#8899aa" />
              </div>
            </>
          )}

          {/* Filters */}
          <SectionLabel>Filters</SectionLabel>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 3 }}>Tiers</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {allTiers.map(t => (
                <button
                  key={t}
                  onClick={() => setFilterTiers(prev => {
                    const next = new Set(prev);
                    next.has(t) ? next.delete(t) : next.add(t);
                    return next;
                  })}
                  style={{
                    padding: '2px 6px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
                    background: filterTiers.has(t) ? '#3B82F6' : '#3a4a5e',
                    border: `1px solid ${filterTiers.has(t) ? '#3B82F6' : '#4a5a6e'}`,
                    color: filterTiers.has(t) ? '#fff' : '#94A3B8',
                  }}
                >
                  T{t}
                </button>
              ))}
            </div>
          </div>

          {currentChunks.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 3 }}>Clusters</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, maxHeight: 60, overflow: 'auto' }}>
                {currentChunks.slice(0, 20).map(c => (
                  <button
                    key={c.id}
                    onClick={() => setFilterClusters(prev => {
                      const next = new Set(prev);
                      next.has(c.id) ? next.delete(c.id) : next.add(c.id);
                      return next;
                    })}
                    style={{
                      padding: '2px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                      background: filterClusters.has(c.id) ? c.color : '#3a4a5e',
                      border: `1px solid ${filterClusters.has(c.id) ? c.color : '#4a5a6e'}`,
                      color: filterClusters.has(c.id) ? '#fff' : '#94A3B8',
                    }}
                  >
                    {c.session_count}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginBottom: 8 }}>
            <input
              type="text"
              placeholder="Search sessions..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              style={{ width: '100%', background: '#3a4a5e', border: '1px solid #4a5a6e', borderRadius: 3, color: '#E2E8F0', padding: '4px 6px', fontSize: 11, boxSizing: 'border-box' }}
            />
          </div>

          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', marginBottom: 12 }}>
            <input type="checkbox" checked={criticalOnly} onChange={e => setCriticalOnly(e.target.checked)} />
            Critical only
          </label>
        </div>
      </div>

      {/* ── Main area ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Canvas */}
        <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <canvas
            ref={canvasRef}
            style={{ position: 'absolute', top: 0, left: 0, cursor: hoveredPoint ? 'pointer' : 'grab' }}
          />
          {/* Algorithm badge overlay */}
          {meta && (
            <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(26,35,50,0.85)', padding: '4px 10px', borderRadius: 4, fontSize: 11, color: '#94A3B8', border: '1px solid #3a4a5e' }}>
              {algorithms[meta.algorithm]?.name ?? meta.algorithm}
              {meta.seed != null && <span style={{ marginLeft: 6, color: '#8899aa' }}>seed={meta.seed}</span>}
            </div>
          )}
          {!displayResult && (
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: '#5a6a7a', fontSize: 14, textAlign: 'center', pointerEvents: 'none' }}>
              Select an algorithm and click Run
            </div>
          )}
        </div>

        {/* Run History */}
        {history.length > 0 && (
          <div style={{ borderTop: '1px solid #3a4a5e', maxHeight: 180, overflow: 'auto', flexShrink: 0 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ color: '#8899aa', textAlign: 'left' }}>
                  <th style={thStyle}>#</th>
                  <th style={thStyle}>Algorithm</th>
                  <th style={thStyle}>Clusters</th>
                  <th style={thStyle}>Mod.</th>
                  <th style={thStyle}>Sil.</th>
                  <th style={thStyle}>Time</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry, i) => {
                  const m = entry.result.quality_metrics;
                  const rm = entry.result.run_meta;
                  const isActive = entry.id === activeHistoryId;
                  const prev = i > 0 ? history[i - 1].result.quality_metrics.n_clusters : null;
                  const delta = prev !== null ? m.n_clusters - prev : null;
                  return (
                    <tr
                      key={entry.id}
                      onClick={() => handleHistoryClick(entry.id)}
                      style={{
                        cursor: 'pointer',
                        background: isActive ? '#1E3A5F' : 'transparent',
                        borderBottom: '1px solid #3a4a5e',
                      }}
                    >
                      <td style={tdStyle}>{i + 1}</td>
                      <td style={tdStyle}>
                        {algorithms[rm.algorithm]?.name ?? rm.algorithm}
                        {Object.keys(rm.params).length > 0 && (
                          <span style={{ color: '#8899aa', marginLeft: 4 }}>
                            ({Object.entries(rm.params).map(([k, v]) => `${k}=${v}`).join(', ')})
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {m.n_clusters}
                        {delta !== null && delta !== 0 && (
                          <span style={{ marginLeft: 4, fontSize: 9, color: delta > 0 ? '#10B981' : '#EF4444' }}>
                            {delta > 0 ? '+' : ''}{delta}
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>{m.modularity.toFixed(3)}</td>
                      <td style={tdStyle}>{m.silhouette.toFixed(3)}</td>
                      <td style={tdStyle}>{m.duration_ms}ms</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color: '#8899aa', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
      {children}
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: '#3a4a5e', borderRadius: 4, padding: '6px 8px', border: '1px solid #4a5a6e' }}>
      <div style={{ fontSize: 9, color: '#8899aa', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function metricColor(value: number, min: number, max: number): string {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  if (t < 0.33) return '#EF4444';
  if (t < 0.66) return '#F59E0B';
  return '#10B981';
}

const btnStyle: React.CSSProperties = {
  padding: '3px 8px', fontSize: 10, background: '#3a4a5e',
  border: '1px solid #4a5a6e', borderRadius: 3, color: '#94A3B8',
  cursor: 'pointer', fontFamily: 'monospace',
};

const thStyle: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #4a5a6e', fontWeight: 600 };
const tdStyle: React.CSSProperties = { padding: '5px 8px', color: '#CBD5E1' };
