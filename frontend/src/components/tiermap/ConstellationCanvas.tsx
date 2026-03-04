/**
 * ConstellationCanvas — HTML5 Canvas renderer for 15K+ session scatter plots.
 *
 * @description
 * The primary visualization for clustered session data. Each session is a point
 * placed via force-directed layout; clusters are rendered as convex hulls with
 * centroid labels. Uses Canvas (not SVG) for performance at scale.
 *
 * Rendering pipeline (per frame):
 *   1. Clear canvas, apply DPR scaling
 *   2. Draw heat/density overlay if active (KDE grid → per-cell fill)
 *   3. Draw cluster hulls (convex hull polygons, alpha fill)
 *   4. Draw cross-chunk edge bundles (quadratic Bezier curves)
 *   5. Draw session dots (color by chunk, dim by filter state)
 *   6. Draw critical markers, pinned indicators, hover cards
 *   7. Draw labels at appropriate LOD level
 *   8. Update mini-map inset
 *
 * Level-of-detail (LOD) system:
 *   - FAR  (k < 0.8): Supernode bubbles at cluster centroids, no individual dots
 *   - MID  (0.8..3.0): Individual dots, hulls, bundled edges
 *   - CLOSE (k > 3.0): Full labels on each dot, connection lines on hover
 *
 * Key algorithms:
 *   - D3 quadtree for O(log N) spatial hit testing on hover/click
 *   - D3 polygonHull for convex cluster boundaries
 *   - Gaussian KDE (kernel density estimation) for heat/gradient overlays
 *   - BFS on adjacency graph for path tracing and proximity radar
 *   - Edge bundling: aggregate cross-chunk edges into weighted arcs
 *
 * @see GalaxyMapCanvas for the orbital SVG-based view
 * @see UMAPView for the dimensionality-reduction scatter plot
 */

import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import * as d3 from 'd3';
import type {
  ConstellationPoint,
  ConstellationChunk,
  CrossChunkEdge,
  AlgorithmKey,
  TierMapResult,
} from '../../types/tiermap';
import type { VectorResults } from '../../types/vectors';

// ── Constants ────────────────────────────────────────────────────────────────

const DOT_RADIUS = 2.5;
const DOT_RADIUS_HOVER = 5;
const CRITICAL_RING = 7;
const HULL_ALPHA = 0.08;
const LABEL_FONT = '12px "JetBrains Mono", monospace';
const LABEL_FONT_SM = '9px "JetBrains Mono", monospace';
const EDGE_ALPHA = 0.15;
const BIG_CLUSTER_THRESHOLD = 5;

// LOD zoom thresholds
const LOD_FAR_THRESHOLD = 0.8;
const LOD_CLOSE_THRESHOLD = 3.0;

const C = {
  bg: '#1a2332',
  text: '#e2e8f0',
  muted: '#8899aa',
  dim: '#5a6a7a',
};

// ── Algorithm metadata ───────────────────────────────────────────────────────

const ALGO_META: Record<AlgorithmKey, { name: string; desc: string; icon: string }> = {
  louvain:       { name: 'Louvain',              icon: '\u25CE', desc: 'Modularity-based community detection' },
  tier:          { name: 'Tier Groups',           icon: '\u2261', desc: 'Group sessions by execution tier' },
  components:    { name: 'Connected Components',  icon: '\u25C7', desc: 'Natural graph islands' },
  label_prop:    { name: 'Label Propagation',     icon: '\u21B9', desc: 'Fast iterative label spreading' },
  greedy_mod:    { name: 'Greedy Modularity',     icon: '\u25A3', desc: 'Agglomerative merge' },
  process_group: { name: 'Process Group',         icon: '\u229E', desc: 'Group by process group / workflow' },
  table_gravity: { name: 'Table Gravity',         icon: '\u2299', desc: 'Cluster around most-referenced tables' },
  gradient_scale:{ name: 'Gradient Scale',        icon: '\u25D0', desc: 'Density heatmap with peak markers' },
};

const ALGO_KEYS: AlgorithmKey[] = ['louvain', 'tier', 'components', 'label_prop', 'greedy_mod', 'process_group', 'table_gravity', 'gradient_scale'];

// ── Props ────────────────────────────────────────────────────────────────────

interface ConstellationCanvasProps {
  points: ConstellationPoint[];
  chunks: ConstellationChunk[];
  crossChunkEdges: CrossChunkEdge[];
  onChunkSelect: (chunkId: string) => void;
  selectedChunkIds?: Set<string>;
  algorithm?: AlgorithmKey;
  onAlgorithmChange?: (algo: AlgorithmKey) => void;
  reclustering?: boolean;
  highlightedSessionIds?: Set<string>;
  tierData?: TierMapResult;
  vectorResults?: VectorResults | null;
  pinnedSessions?: Set<string>;
  onPinSession?: (sessionId: string) => void;
  onUnpinSession?: (sessionId: string) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ConstellationCanvas({
  points,
  chunks,
  crossChunkEdges,
  onChunkSelect,
  selectedChunkIds = new Set(),
  algorithm = 'louvain',
  onAlgorithmChange,
  reclustering = false,
  highlightedSessionIds = new Set(),
  tierData,
  vectorResults,
  pinnedSessions = new Set(),
  onPinSession,
  onUnpinSession,
}: ConstellationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniMapRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const hoverRef = useRef<ConstellationPoint | null>(null);
  const dirtyRef = useRef(true);
  const rafRef = useRef<number>(0);
  const dimsRef = useRef({ w: 800, h: 600 });
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const pulseRef = useRef(0);

  const [fisheyeEnabled, setFisheyeEnabled] = useState(false);
  const [showEdges, setShowEdges] = useState(true);
  const [showHulls, setShowHulls] = useState(true);
  const [showHeatOverlay, setShowHeatOverlay] = useState(false);

  // Search state
  const [searchTerm, setSearchTerm] = useState('');
  const [searchFocusedId, setSearchFocusedId] = useState<string | null>(null);

  // Path tracing
  const [pathStart, setPathStart] = useState<string | null>(null);
  const [pathEnd, setPathEnd] = useState<string | null>(null);
  const [tracedPath, setTracedPath] = useState<string[]>([]);

  // Proximity radar
  const [radarHops, setRadarHops] = useState(2);
  const [showRadar, setShowRadar] = useState(false);
  const [radarSession, setRadarSession] = useState<string | null>(null);
  const [radarResult, setRadarResult] = useState<Map<string, number>>(new Map());

  // ── Pre-computed lookup maps ───────────────────────────────────────────

  const chunkMap = useMemo(() => {
    const m = new Map<string, ConstellationChunk>();
    for (const c of chunks) m.set(c.id, c);
    return m;
  }, [chunks]);

  const chunkColorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of chunks) m.set(c.id, c.color);
    return m;
  }, [chunks]);

  const pointMap = useMemo(() => {
    const m = new Map<string, ConstellationPoint>();
    for (const p of points) m.set(p.session_id, p);
    return m;
  }, [points]);

  /** Average position of all points in each chunk — used for supernode placement at far zoom */
  const chunkCentroids = useMemo(() => {
    const centroids = new Map<string, { x: number; y: number; count: number }>();
    for (const p of points) {
      const c = centroids.get(p.chunk_id);
      if (c) { c.x += p.x; c.y += p.y; c.count += 1; }
      else centroids.set(p.chunk_id, { x: p.x, y: p.y, count: 1 });
    }
    const result = new Map<string, { x: number; y: number }>();
    for (const [id, c] of centroids) result.set(id, { x: c.x / c.count, y: c.y / c.count });
    return result;
  }, [points]);

  /** Convex hull boundary for each chunk — d3.polygonHull needs >= 3 points */
  const chunkHulls = useMemo(() => {
    const grouped = new Map<string, [number, number][]>();
    for (const p of points) {
      const arr = grouped.get(p.chunk_id) || [];
      arr.push([p.x, p.y]);
      if (!grouped.has(p.chunk_id)) grouped.set(p.chunk_id, arr);
    }
    const hulls = new Map<string, [number, number][]>();
    for (const [id, pts] of grouped) {
      if (pts.length < 3) { hulls.set(id, pts); continue; }
      const hull = d3.polygonHull(pts);
      hulls.set(id, hull || pts);
    }
    return hulls;
  }, [points]);

  const quadtree = useMemo(() => {
    return d3.quadtree<ConstellationPoint>().x(d => d.x).y(d => d.y).addAll(points);
  }, [points]);

  // ── Adjacency list for path tracing / proximity ────────────────────────
  // Built from tierData connections, mapping session names to their neighbors.
  // Used by BFS in path tracing (A→B shortest path) and proximity radar (N-hop neighborhood).

  const adjacency = useMemo(() => {
    if (!tierData) return new Map<string, Set<string>>();
    const adj = new Map<string, Set<string>>();
    const sessionNameToId = new Map<string, string>();
    for (const s of tierData.sessions) sessionNameToId.set(s.id, s.name);

    for (const conn of tierData.connections) {
      const fromName = sessionNameToId.get(conn.from);
      const toName = sessionNameToId.get(conn.to);
      if (fromName && toName) {
        if (!adj.has(fromName)) adj.set(fromName, new Set());
        if (!adj.has(toName)) adj.set(toName, new Set());
        adj.get(fromName)!.add(toName);
        adj.get(toName)!.add(fromName);
      }
    }
    return adj;
  }, [tierData]);

  // ── Complexity score map ───────────────────────────────────────────────

  const complexityMap = useMemo(() => {
    const m = new Map<string, number>();
    if (vectorResults?.v11_complexity?.scores) {
      for (const s of vectorResults.v11_complexity.scores) m.set(s.session_id, s.overall_score);
    }
    return m;
  }, [vectorResults]);

  const waveMap = useMemo(() => {
    const m = new Map<string, number>();
    if (vectorResults?.v4_wave_plan?.waves) {
      for (const w of vectorResults.v4_wave_plan.waves) {
        for (const sid of (w.session_ids ?? [])) m.set(sid, w.wave_number);
      }
    }
    return m;
  }, [vectorResults]);

  const gravityMap = useMemo(() => {
    const m = new Map<string, number>();
    if (vectorResults?.v10_concentration?.gravity_groups) {
      for (const g of vectorResults.v10_concentration.gravity_groups) {
        for (const sid of (g.session_ids ?? [])) m.set(sid, g.group_id);
      }
    }
    return m;
  }, [vectorResults]);

  // ── Complexity heat overlay KDE ────────────────────────────────────────
  // Gaussian KDE: each session contributes a weighted bell curve to a 60x60 grid.
  // Weight = complexity score / 100. The resulting density field is rendered as
  // a green→red heat overlay behind the session dots.

  const heatGrid = useMemo(() => {
    if (!showHeatOverlay || complexityMap.size === 0) return null;
    const gridSize = 60;
    const bandwidth = 0.05; // Controls kernel width in normalized [0,1] space
    const grid = new Float64Array(gridSize * gridSize);
    const bwCells = Math.ceil(bandwidth * gridSize * 3);

    for (const p of points) {
      const weight = (complexityMap.get(p.session_id) || 0) / 100;
      if (weight < 0.01) continue;
      const gx = p.x * (gridSize - 1);
      const gy = p.y * (gridSize - 1);
      const x0 = Math.max(0, Math.floor(gx) - bwCells);
      const x1 = Math.min(gridSize - 1, Math.ceil(gx) + bwCells);
      const y0 = Math.max(0, Math.floor(gy) - bwCells);
      const y1 = Math.min(gridSize - 1, Math.ceil(gy) + bwCells);
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          const dx = (ix / (gridSize - 1) - p.x) / bandwidth;
          const dy = (iy / (gridSize - 1) - p.y) / bandwidth;
          grid[iy * gridSize + ix] += weight * Math.exp(-0.5 * (dx * dx + dy * dy));
        }
      }
    }

    let maxVal = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > maxVal) maxVal = grid[i];
    return { grid, maxVal, gridSize };
  }, [points, complexityMap, showHeatOverlay]);

  // ── Gradient Scale density ─────────────────────────────────────────────
  // Similar KDE but for session density (unweighted) on an 80x80 grid.
  // After computing the grid, local maxima above 15% of peak are extracted
  // as "density peaks" — shown as numbered pins on the canvas.

  const densityGrid = useMemo(() => {
    if (algorithm !== 'gradient_scale') return null;
    const gridSize = 80;
    const bandwidth = 0.04;
    const grid = new Float64Array(gridSize * gridSize);
    const bwCells = Math.ceil(bandwidth * gridSize * 3);
    for (const p of points) {
      const gx = p.x * (gridSize - 1);
      const gy = p.y * (gridSize - 1);
      const x0 = Math.max(0, Math.floor(gx) - bwCells);
      const x1 = Math.min(gridSize - 1, Math.ceil(gx) + bwCells);
      const y0 = Math.max(0, Math.floor(gy) - bwCells);
      const y1 = Math.min(gridSize - 1, Math.ceil(gy) + bwCells);
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          const dx = (ix / (gridSize - 1) - p.x) / bandwidth;
          const dy = (iy / (gridSize - 1) - p.y) / bandwidth;
          grid[iy * gridSize + ix] += Math.exp(-0.5 * (dx * dx + dy * dy));
        }
      }
    }
    let maxDensity = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > maxDensity) maxDensity = grid[i];
    const rawPeaks: Array<{ x: number; y: number; density: number }> = [];
    const threshold = maxDensity * 0.15;
    for (let iy = 1; iy < gridSize - 1; iy++) {
      for (let ix = 1; ix < gridSize - 1; ix++) {
        const val = grid[iy * gridSize + ix];
        if (val < threshold) continue;
        let isMax = true;
        for (let dy = -1; dy <= 1 && isMax; dy++) {
          for (let dx = -1; dx <= 1 && isMax; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (grid[(iy + dy) * gridSize + (ix + dx)] > val) isMax = false;
          }
        }
        if (isMax) rawPeaks.push({ x: ix / (gridSize - 1), y: iy / (gridSize - 1), density: val });
      }
    }
    rawPeaks.sort((a, b) => b.density - a.density);
    return { grid, maxDensity, peaks: rawPeaks.slice(0, 10), gridSize };
  }, [points, algorithm]);

  // ── Search results ─────────────────────────────────────────────────────

  const searchResults = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const q = searchTerm.toLowerCase();
    return points.filter(p => p.name.toLowerCase().includes(q) || p.session_id.toLowerCase().includes(q)).slice(0, 20);
  }, [searchTerm, points]);

  // ── BFS for path tracing ───────────────────────────────────────────────

  useEffect(() => {
    if (!pathStart || !pathEnd || pathStart === pathEnd) { setTracedPath([]); return; }
    // BFS from pathStart to pathEnd using session names
    const startPt = pointMap.get(pathStart);
    const endPt = pointMap.get(pathEnd);
    if (!startPt || !endPt) { setTracedPath([]); return; }

    const queue: string[][] = [[startPt.name]];
    const visited = new Set([startPt.name]);
    const targetName = endPt.name;

    while (queue.length > 0) {
      const path = queue.shift()!;
      const current = path[path.length - 1];
      if (current === targetName) {
        // Convert names back to session_ids
        const nameToId = new Map(points.map(p => [p.name, p.session_id]));
        setTracedPath(path.map(n => nameToId.get(n) || n));
        return;
      }
      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const n of neighbors) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push([...path, n]);
          }
        }
      }
    }
    setTracedPath([]);
  }, [pathStart, pathEnd, adjacency, pointMap, points]);

  // ── BFS for proximity radar ────────────────────────────────────────────

  useEffect(() => {
    if (!showRadar || !radarSession) { setRadarResult(new Map()); return; }
    const pt = pointMap.get(radarSession);
    if (!pt) { setRadarResult(new Map()); return; }

    const result = new Map<string, number>();
    const nameToId = new Map(points.map(p => [p.name, p.session_id]));
    const queue: [string, number][] = [[pt.name, 0]];
    const visited = new Set([pt.name]);

    while (queue.length > 0) {
      const [current, hop] = queue.shift()!;
      const sid = nameToId.get(current);
      if (sid) result.set(sid, hop);
      if (hop >= radarHops) continue;
      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const n of neighbors) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push([n, hop + 1]);
          }
        }
      }
    }
    setRadarResult(result);
  }, [showRadar, radarSession, radarHops, adjacency, pointMap, points]);

  // ── Edge bundles ───────────────────────────────────────────────────────
  // Aggregate individual cross-chunk edges into chunk-to-chunk bundles with
  // combined counts. Rendered as weighted arcs between chunk centroids.

  const edgeBundles = useMemo(() => {
    const bundles = new Map<string, { from: string; to: string; count: number }>();
    for (const edge of crossChunkEdges) {
      const key = [edge.from_chunk, edge.to_chunk].sort().join('|');
      const existing = bundles.get(key);
      if (existing) existing.count += edge.count;
      else bundles.set(key, { from: edge.from_chunk, to: edge.to_chunk, count: edge.count });
    }
    return Array.from(bundles.values());
  }, [crossChunkEdges]);

  // ── Drawing ────────────────────────────────────────────────────────────
  // Main render function called on every animation frame when dirtyRef is set.
  // Handles DPR-aware canvas sizing, viewport transforms, and the full
  // layered rendering pipeline (overlays → hulls → edges → dots → labels → UI).

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { w, h } = dimsRef.current;
    const t = transformRef.current;
    const hover = hoverRef.current;
    const k = t.k; // zoom level

    const pad = 40;
    const cw = w - pad * 2;
    const ch = h - pad * 2;
    const sx = (nx: number) => t.applyX(pad + nx * cw);
    const sy = (ny: number) => t.applyY(pad + ny * ch);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    const hasFilter = selectedChunkIds.size > 0;
    const hasHighlight = highlightedSessionIds.size > 0;
    const isGradient = algorithm === 'gradient_scale';
    const isRadarActive = showRadar && radarResult.size > 0;
    const hasTracedPath = tracedPath.length > 1;
    const tracedSet = new Set(tracedPath);
    const focusedPt = searchFocusedId ? pointMap.get(searchFocusedId) : null;

    // ── Complexity heat overlay ──────────────────────────────────────────
    // Render the KDE grid as colored cells — green(low) to red(high complexity).
    // Each cell's color is interpolated linearly between green and red.
    if (showHeatOverlay && heatGrid && !isGradient) {
      const { grid, maxVal, gridSize } = heatGrid;
      const cellW = cw / gridSize;
      const cellH = ch / gridSize;
      for (let iy = 0; iy < gridSize; iy++) {
        for (let ix = 0; ix < gridSize; ix++) {
          const val = grid[iy * gridSize + ix];
          if (val < maxVal * 0.02) continue;
          const norm = val / maxVal;
          const px = sx(ix / (gridSize - 1)) - cellW * k / 2;
          const py = sy(iy / (gridSize - 1)) - cellH * k / 2;
          const r = Math.round(34 + norm * (239 - 34));
          const g = Math.round(197 + norm * (68 - 197));
          const b = Math.round(94 + norm * (68 - 94));
          ctx.fillStyle = `rgba(${r},${g},${b},${0.08 + norm * 0.25})`;
          ctx.fillRect(px, py, cellW * k + 1, cellH * k + 1);
        }
      }
    }

    // ── GRADIENT SCALE MAP MODE ─────────────────────────────────────────
    // Alternative rendering: density-based heatmap with peak markers.
    // Uses HSL lightness to encode density, with numbered pin markers at peaks.
    if (isGradient && densityGrid) {
      const { grid, maxDensity, peaks, gridSize } = densityGrid;
      const cellW = cw / gridSize;
      const cellH = ch / gridSize;
      const densityThreshold = maxDensity * 0.01;
      for (let iy = 0; iy < gridSize; iy++) {
        for (let ix = 0; ix < gridSize; ix++) {
          const val = grid[iy * gridSize + ix];
          if (val < densityThreshold) continue;
          const norm = val / maxDensity;
          const lightness = 90 - norm * 65;
          const alpha = 0.15 + norm * 0.6;
          const px = sx(ix / (gridSize - 1)) - cellW * k / 2;
          const py = sy(iy / (gridSize - 1)) - cellH * k / 2;
          ctx.fillStyle = `hsla(220, 80%, ${lightness}%, ${alpha})`;
          ctx.fillRect(px, py, cellW * k + 1, cellH * k + 1);
        }
      }
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(sx(p.x), sy(p.y), DOT_RADIUS * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.3)';
        ctx.fill();
      }
      for (let i = 0; i < peaks.length; i++) {
        const peak = peaks[i];
        const px = sx(peak.x);
        const py = sy(peak.y);
        const headR = 10 - i * 0.4;
        const br = 1.0 - i * 0.04;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + 12);
        ctx.strokeStyle = `rgba(239, 68, 68, ${br * 0.6})`; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, headR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(239, 68, 68, ${br * 0.8})`; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = `bold ${headR > 7 ? 9 : 7}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), px, py);
      }
      const legendX = w - 140; const legendY = h - 80;
      ctx.fillStyle = 'rgba(26,35,50,0.85)'; roundRect(ctx, legendX - 8, legendY - 6, 120, 36, 6); ctx.fill();
      const grad = ctx.createLinearGradient(legendX, 0, legendX + 100, 0);
      grad.addColorStop(0, 'hsl(220,80%,85%)'); grad.addColorStop(1, 'hsl(220,80%,25%)');
      ctx.fillStyle = grad; roundRect(ctx, legendX, legendY, 100, 12, 3); ctx.fill();
      ctx.font = '8px "JetBrains Mono", monospace'; ctx.fillStyle = C.muted;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('Low', legendX, legendY + 16);
      ctx.textAlign = 'right'; ctx.fillText('High', legendX + 100, legendY + 16);
    } else {
      // ── NORMAL MODE ───────────────────────────────────────────────────

      const totalSess = points.length;
      const labelThreshold = totalSess > 500 ? Math.max(BIG_CLUSTER_THRESHOLD, Math.ceil(totalSess * 0.005)) : BIG_CLUSTER_THRESHOLD;
      const chunkSizeMap = new Map<string, number>();
      for (const chunk of chunks) chunkSizeMap.set(chunk.id, chunk.session_count);

      // ── LOD: FAR (k < 0.8) — Supernode bubbles ──
      // At far zoom, individual dots are too small to see. Instead, render
      // each cluster as a single bubble at its centroid, sized by sqrt(session_count).
      if (k < LOD_FAR_THRESHOLD) {
        // Draw hulls dimly
        if (showHulls) {
          for (const [chunkId, hull] of chunkHulls) {
            if (hull.length < 3) continue;
            const color = chunkColorMap.get(chunkId) || '#3B82F6';
            const isSelected = !hasFilter || selectedChunkIds.has(chunkId);
            ctx.beginPath();
            ctx.moveTo(sx(hull[0][0]), sy(hull[0][1]));
            for (let i = 1; i < hull.length; i++) ctx.lineTo(sx(hull[i][0]), sy(hull[i][1]));
            ctx.closePath();
            ctx.fillStyle = hexToRgba(color, isSelected ? 0.04 : 0.01);
            ctx.fill();
          }
        }

        // Draw supernode bubbles at centroids
        for (const chunk of chunks) {
          const centroid = chunkCentroids.get(chunk.id);
          if (!centroid) continue;
          const isSelected = !hasFilter || selectedChunkIds.has(chunk.id);
          if (hasFilter && !isSelected) continue;
          const cx = sx(centroid.x);
          const cy = sy(centroid.y);
          const r = Math.max(8, Math.sqrt(chunk.session_count) * 2.5);
          const color = chunk.color;

          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, 0.3); ctx.fill();
          ctx.strokeStyle = hexToRgba(color, 0.6); ctx.lineWidth = 1.5; ctx.stroke();

          // Label
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = '10px "JetBrains Mono", monospace';
          ctx.fillStyle = hexToRgba(color, 0.9);
          const label = chunk.label.split(':')[0];
          ctx.fillText(label.slice(0, 14), cx, cy - 5);
          ctx.font = '8px "JetBrains Mono", monospace';
          ctx.fillStyle = hexToRgba(color, 0.6);
          ctx.fillText(`${chunk.session_count}`, cx, cy + 7);
        }

        // Draw bundled edges between supernodes
        if (showEdges) {
          for (const bundle of edgeBundles) {
            const from = chunkCentroids.get(bundle.from);
            const to = chunkCentroids.get(bundle.to);
            if (!from || !to) continue;
            if (hasFilter && !selectedChunkIds.has(bundle.from) && !selectedChunkIds.has(bundle.to)) continue;
            const fx = sx(from.x); const fy = sy(from.y);
            const tx = sx(to.x); const ty = sy(to.y);
            const mx = (fx + tx) / 2;
            const my = (fy + ty) / 2;
            const dx = tx - fx; const dy = ty - fy;
            const perpX = -dy * 0.15; const perpY = dx * 0.15;
            ctx.beginPath();
            ctx.moveTo(fx, fy);
            ctx.quadraticCurveTo(mx + perpX, my + perpY, tx, ty);
            ctx.strokeStyle = `rgba(148, 163, 184, ${Math.min(0.4, bundle.count * 0.05)})`;
            ctx.lineWidth = Math.min(Math.sqrt(bundle.count) * 0.5, 4);
            ctx.stroke();
          }
        }
      } else {
        // ── LOD: MEDIUM & CLOSE ─────────────────────────────────────────

        // Draw cluster hulls
        if (showHulls) {
          for (const [chunkId, hull] of chunkHulls) {
            if (hull.length < 3) continue;
            const color = chunkColorMap.get(chunkId) || '#3B82F6';
            const isSelected = !hasFilter || selectedChunkIds.has(chunkId);
            const hullAlpha = isSelected ? HULL_ALPHA : HULL_ALPHA * 0.15;
            ctx.beginPath();
            ctx.moveTo(sx(hull[0][0]), sy(hull[0][1]));
            for (let i = 1; i < hull.length; i++) ctx.lineTo(sx(hull[i][0]), sy(hull[i][1]));
            ctx.closePath();
            ctx.fillStyle = hexToRgba(color, hullAlpha);
            ctx.fill();
            if (isSelected) {
              ctx.strokeStyle = hexToRgba(color, 0.2 + (selectedChunkIds.has(chunkId) ? 0.4 : 0));
              ctx.lineWidth = selectedChunkIds.has(chunkId) ? 2 : 1;
              ctx.stroke();
            }
          }
        }

        // Draw edges (bundled curves)
        if (showEdges) {
          for (const bundle of edgeBundles) {
            const from = chunkCentroids.get(bundle.from);
            const to = chunkCentroids.get(bundle.to);
            if (!from || !to) continue;
            if (hasFilter && !selectedChunkIds.has(bundle.from) && !selectedChunkIds.has(bundle.to)) continue;
            const fx = sx(from.x); const fy = sy(from.y);
            const tx = sx(to.x); const ty = sy(to.y);
            const mx = (fx + tx) / 2;
            const my = (fy + ty) / 2;
            const dx = tx - fx; const dy = ty - fy;
            const perpX = -dy * 0.12; const perpY = dx * 0.12;
            const edgeAlpha = hasFilter
              ? (selectedChunkIds.has(bundle.from) || selectedChunkIds.has(bundle.to) ? 0.35 : 0.03)
              : EDGE_ALPHA;
            ctx.beginPath();
            ctx.moveTo(fx, fy);
            ctx.quadraticCurveTo(mx + perpX, my + perpY, tx, ty);
            ctx.strokeStyle = `rgba(148, 163, 184, ${edgeAlpha})`;
            ctx.lineWidth = Math.min(Math.sqrt(bundle.count) * 0.5, 3);
            ctx.stroke();
          }
        }

        // ── Proximity radar circles ──
        if (isRadarActive && radarSession) {
          const radarPt = pointMap.get(radarSession);
          if (radarPt) {
            const rpx = sx(radarPt.x);
            const rpy = sy(radarPt.y);
            for (let hop = radarHops; hop >= 1; hop--) {
              const radius = hop * 40 * k;
              ctx.beginPath(); ctx.arc(rpx, rpy, radius, 0, Math.PI * 2);
              const hopColor = hop === 1 ? 'rgba(239,68,68,0.12)' : hop === 2 ? 'rgba(249,115,22,0.08)' : 'rgba(234,179,8,0.05)';
              ctx.fillStyle = hopColor; ctx.fill();
              ctx.strokeStyle = hop === 1 ? 'rgba(239,68,68,0.3)' : 'rgba(249,115,22,0.2)';
              ctx.lineWidth = 1; ctx.stroke();
            }
          }
        }

        // Draw dots
        for (const p of points) {
          const px = sx(p.x);
          const py = sy(p.y);
          const color = chunkColorMap.get(p.chunk_id) || '#3B82F6';
          const isHover = hover && hover.session_id === p.session_id;
          const isInSelected = !hasFilter || selectedChunkIds.has(p.chunk_id);
          const isHighlighted = hasHighlight ? highlightedSessionIds.has(p.session_id) : null;
          const isPinned = pinnedSessions.has(p.session_id);
          const isFocused = searchFocusedId === p.session_id;
          const isInPath = hasTracedPath && tracedSet.has(p.session_id);
          const isRadarHit = isRadarActive ? radarResult.get(p.session_id) : undefined;
          const cSize = chunkSizeMap.get(p.chunk_id) || 1;
          const baseR = cSize >= labelThreshold ? DOT_RADIUS + Math.min(Math.log2(cSize) * 0.4, 2) : DOT_RADIUS;

          // Radar dimming: if radar active and NOT in radar, dim heavily
          if (isRadarActive && isRadarHit === undefined) {
            ctx.beginPath(); ctx.arc(px, py, baseR * 0.4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(100, 116, 139, 0.05)'; ctx.fill();
            continue;
          }

          // Highlight dimming
          if (isHighlighted === false) {
            ctx.beginPath(); ctx.arc(px, py, baseR * 0.5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(100, 116, 139, 0.08)'; ctx.fill();
            continue;
          }

          // Path tracing: dim non-path points when tracing
          if (hasTracedPath && !isInPath && !isHover) {
            ctx.beginPath(); ctx.arc(px, py, baseR * 0.4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(100, 116, 139, 0.06)'; ctx.fill();
            continue;
          }

          // Highlighted amber ring
          if (isHighlighted === true) {
            ctx.beginPath(); ctx.arc(px, py, baseR + 4, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)'; ctx.lineWidth = 2; ctx.stroke();
          }

          // Pinned session: amber diamond
          if (isPinned) {
            ctx.save();
            ctx.translate(px, py - baseR - 5);
            ctx.rotate(Math.PI / 4);
            ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
            ctx.fillRect(-3, -3, 6, 6);
            ctx.restore();
          }

          // Focused (search result) — pulsing ring
          if (isFocused) {
            const pulse = Math.sin(pulseRef.current * 3) * 0.3 + 0.7;
            ctx.beginPath(); ctx.arc(px, py, baseR + 8, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(245, 158, 11, ${pulse})`;
            ctx.lineWidth = 2.5; ctx.stroke();
          }

          const r = isHover ? DOT_RADIUS_HOVER : (isInSelected ? baseR : baseR * 0.6);

          // Critical marker
          if (p.critical && isInSelected) {
            ctx.beginPath(); ctx.arc(px, py, CRITICAL_RING, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
          }

          // Radar hop coloring
          let dotColor = isHover ? '#ffffff' : color;
          if (isRadarHit !== undefined && isRadarHit > 0) {
            dotColor = isRadarHit === 1 ? '#EF4444' : isRadarHit === 2 ? '#F97316' : '#EAB308';
          }
          if (isInPath) dotColor = '#60A5FA';

          ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fillStyle = dotColor;
          ctx.globalAlpha = isInSelected ? (cSize >= labelThreshold ? 1.0 : 0.6) : 0.08;
          ctx.fill(); ctx.globalAlpha = 1.0;

          if (isHover) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); }

          // LOD CLOSE: Show session names
          if (k >= LOD_CLOSE_THRESHOLD && isInSelected) {
            ctx.font = '8px "JetBrains Mono", monospace';
            ctx.fillStyle = 'rgba(226, 232, 240, 0.7)';
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(p.name.slice(0, 12), px + r + 3, py);
          }
        }

        // ── Path tracing polyline ──
        if (hasTracedPath) {
          ctx.beginPath();
          for (let i = 0; i < tracedPath.length; i++) {
            const pt = pointMap.get(tracedPath[i]);
            if (!pt) continue;
            const px = sx(pt.x); const py = sy(pt.y);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.strokeStyle = '#60A5FA';
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 3]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Path length badge
          const midIdx = Math.floor(tracedPath.length / 2);
          const midPt = pointMap.get(tracedPath[midIdx]);
          if (midPt) {
            const mpx = sx(midPt.x); const mpy = sy(midPt.y);
            ctx.fillStyle = 'rgba(26,35,50,0.9)';
            roundRect(ctx, mpx - 20, mpy - 22, 40, 16, 4);
            ctx.fill();
            ctx.fillStyle = '#60A5FA'; ctx.font = 'bold 9px "JetBrains Mono", monospace';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(`${tracedPath.length - 1} hops`, mpx, mpy - 14);
          }
        }

        // ── Cluster labels (medium LOD only) ──
        if (k >= LOD_FAR_THRESHOLD && k < LOD_CLOSE_THRESHOLD) {
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          for (const chunk of chunks) {
            const isThisSelected = selectedChunkIds.has(chunk.id);
            if (!isThisSelected && chunk.session_count < labelThreshold) continue;
            if (hasFilter && !isThisSelected) continue;
            const centroid = chunkCentroids.get(chunk.id);
            if (!centroid) continue;
            const lx = sx(centroid.x); const ly = sy(centroid.y);
            const label = chunk.label.split(':')[0];
            const countLabel = `${chunk.session_count} sessions`;
            ctx.font = LABEL_FONT;
            const tw = ctx.measureText(label).width + 16;
            const pillH = 32;
            ctx.fillStyle = isThisSelected ? 'rgba(8, 12, 20, 0.9)' : 'rgba(8, 12, 20, 0.75)';
            roundRect(ctx, lx - tw / 2, ly - pillH / 2 - 4, tw, pillH, 6);
            ctx.fill();
            if (isThisSelected) {
              ctx.strokeStyle = hexToRgba(chunk.color, 0.6); ctx.lineWidth = 1.5; ctx.stroke();
            }
            ctx.fillStyle = hexToRgba(chunk.color, isThisSelected ? 1.0 : 0.9);
            ctx.font = LABEL_FONT; ctx.fillText(label, lx, ly - 6);
            ctx.font = LABEL_FONT_SM;
            ctx.fillStyle = hexToRgba(chunk.color, isThisSelected ? 0.8 : 0.6);
            ctx.fillText(countLabel, lx, ly + 10);
          }
        }
      }
    }

    // ── Rich hover card ──────────────────────────────────────────────────
    if (hover) {
      const px = sx(hover.x);
      const py = sy(hover.y);
      const chunk = chunkMap.get(hover.chunk_id);
      const comp = complexityMap.get(hover.session_id);
      const wave = waveMap.get(hover.session_id);
      const grav = gravityMap.get(hover.session_id);

      const cardW = 240;
      const cardH = comp !== undefined ? 140 : 80;
      const tx = Math.min(px + 12, w - cardW - 8);
      const ty = Math.max(py - cardH - 8, 8);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
      ctx.lineWidth = 1;
      roundRect(ctx, tx, ty, cardW, cardH, 8);
      ctx.fill(); ctx.stroke();

      let yOff = ty + 10;
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(hover.name.slice(0, 28), tx + 10, yOff, cardW - 20);
      yOff += 16;

      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillStyle = '#94a3b8';
      const tierText = `Tier ${hover.tier}${hover.critical ? ' (critical)' : ''}`;
      const clusterText = isGradient ? '' : (chunk ? ` | ${chunk.label.split(':')[0]}` : '');
      ctx.fillText(tierText + clusterText, tx + 10, yOff, cardW - 20);
      yOff += 14;

      if (comp !== undefined) {
        // Complexity bar
        ctx.fillStyle = '#8899aa'; ctx.font = '8px "JetBrains Mono", monospace';
        ctx.fillText(`Complexity: ${Math.round(comp)}`, tx + 10, yOff);
        yOff += 12;
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        roundRect(ctx, tx + 10, yOff, cardW - 20, 6, 3); ctx.fill();
        const barColor = comp > 75 ? '#EF4444' : comp > 50 ? '#F97316' : comp > 25 ? '#F59E0B' : '#10B981';
        ctx.fillStyle = barColor;
        roundRect(ctx, tx + 10, yOff, (cardW - 20) * (comp / 100), 6, 3); ctx.fill();
        yOff += 14;
      }

      // Info badges
      const badges: string[] = [];
      if (wave !== undefined) badges.push(`Wave ${wave}`);
      if (grav !== undefined) badges.push(`G${grav}`);
      if (pinnedSessions.has(hover.session_id)) badges.push('Pinned');

      if (badges.length > 0) {
        ctx.font = '8px "JetBrains Mono", monospace';
        let bx = tx + 10;
        for (const badge of badges) {
          const bw = ctx.measureText(badge).width + 8;
          ctx.fillStyle = 'rgba(59,130,246,0.15)';
          roundRect(ctx, bx, yOff, bw, 14, 3); ctx.fill();
          ctx.fillStyle = '#60A5FA';
          ctx.fillText(badge, bx + 4, yOff + 3);
          bx += bw + 4;
        }
        yOff += 20;
      }

      // Transforms/reads/lookups from tierData
      if (tierData) {
        const sess = tierData.sessions.find(s => s.name === hover.name);
        if (sess) {
          ctx.font = '8px "JetBrains Mono", monospace';
          ctx.fillStyle = '#8899aa';
          ctx.fillText(`Transforms: ${sess.transforms} | ExtReads: ${sess.extReads} | Lookups: ${sess.lookupCount}`, tx + 10, yOff, cardW - 20);
        }
      }
    }

    // ── Fisheye lens ─────────────────────────────────────────────────────
    const mousePos = mousePosRef.current;
    if (fisheyeEnabled && mousePos && !isGradient) {
      const lensR = 80; const mag = 2.5;
      const mx = mousePos.x; const my = mousePos.y;
      ctx.save();
      ctx.beginPath(); ctx.arc(mx, my, lensR, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = 'rgba(8, 12, 20, 0.9)';
      ctx.fillRect(mx - lensR, my - lensR, lensR * 2, lensR * 2);
      for (const p of points) {
        const ppx = sx(p.x); const ppy = sy(p.y);
        const ddx = ppx - mx; const ddy = ppy - my;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist > lensR * mag) continue;
        const nd = dist / (lensR * mag);
        const fd = nd < 1 ? nd * nd * lensR : dist;
        const angle = Math.atan2(ddy, ddx);
        const fpx = mx + Math.cos(angle) * fd;
        const fpy = my + Math.sin(angle) * fd;
        const color = chunkColorMap.get(p.chunk_id) || '#3B82F6';
        ctx.beginPath(); ctx.arc(fpx, fpy, DOT_RADIUS * mag, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        if (dist < lensR) {
          ctx.font = '9px "JetBrains Mono", monospace';
          ctx.fillStyle = '#e2e8f0'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(p.name.slice(0, 16), fpx + DOT_RADIUS * mag + 3, fpy);
        }
      }
      ctx.restore();
      ctx.beginPath(); ctx.arc(mx, my, lensR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)'; ctx.lineWidth = 2; ctx.stroke();
    }

    ctx.restore();

    // ── Mini-map ─────────────────────────────────────────────────────────
    const miniCanvas = miniMapRef.current;
    if (miniCanvas) {
      const mCtx = miniCanvas.getContext('2d');
      if (mCtx) {
        const mw = 160; const mh = 120;
        const mdpr = window.devicePixelRatio || 1;
        miniCanvas.width = mw * mdpr; miniCanvas.height = mh * mdpr;
        miniCanvas.style.width = `${mw}px`; miniCanvas.style.height = `${mh}px`;
        mCtx.setTransform(mdpr, 0, 0, mdpr, 0, 0);

        mCtx.fillStyle = 'rgba(8, 12, 20, 0.9)';
        mCtx.fillRect(0, 0, mw, mh);

        // Draw all points as 1px dots
        const mPad = 4;
        const mcw = mw - mPad * 2; const mch = mh - mPad * 2;
        for (const p of points) {
          mCtx.fillStyle = chunkColorMap.get(p.chunk_id) || '#3B82F6';
          mCtx.fillRect(mPad + p.x * mcw, mPad + p.y * mch, 1, 1);
        }

        // Viewport rectangle
        const vx0 = (t.invertX(0) - pad) / cw;
        const vy0 = (t.invertY(0) - pad) / ch;
        const vx1 = (t.invertX(w) - pad) / cw;
        const vy1 = (t.invertY(h) - pad) / ch;
        const rx = mPad + Math.max(0, vx0) * mcw;
        const ry = mPad + Math.max(0, vy0) * mch;
        const rw = Math.min(mcw, (vx1 - Math.max(0, vx0)) * mcw);
        const rh = Math.min(mch, (vy1 - Math.max(0, vy0)) * mch);
        mCtx.strokeStyle = 'rgba(59, 130, 246, 0.7)';
        mCtx.lineWidth = 1.5;
        mCtx.strokeRect(rx, ry, rw, rh);

        mCtx.strokeStyle = 'rgba(100, 116, 139, 0.3)';
        mCtx.lineWidth = 1;
        mCtx.strokeRect(0, 0, mw, mh);
      }
    }
  }, [points, chunks, crossChunkEdges, chunkHulls, chunkCentroids, chunkColorMap, chunkMap,
      quadtree, fisheyeEnabled, selectedChunkIds, showEdges, showHulls, algorithm, densityGrid,
      highlightedSessionIds, tierData, vectorResults, complexityMap, waveMap, gravityMap,
      pointMap, pinnedSessions, searchFocusedId, tracedPath, showRadar, radarSession,
      radarResult, radarHops, edgeBundles, showHeatOverlay, heatGrid]);

  // ── Pulse animation for search focus ───────────────────────────────────

  useEffect(() => {
    if (!searchFocusedId) return;
    let frame: number;
    const animate = () => {
      pulseRef.current += 0.016;
      dirtyRef.current = true;
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [searchFocusedId]);

  // ── Animation loop ────────────────────────────────────────────────────

  useEffect(() => {
    const loop = () => {
      if (dirtyRef.current) { dirtyRef.current = false; draw(); }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  // ── Resize observer ───────────────────────────────────────────────────

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
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      dirtyRef.current = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container); resize();
    return () => ro.disconnect();
  }, []);

  // ── D3 zoom ───────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.3, 20])
      .on('zoom', (event) => { transformRef.current = event.transform; dirtyRef.current = true; });
    zoomRef.current = zoom;
    d3.select(canvas).call(zoom);
    return () => { d3.select(canvas).on('.zoom', null); };
  }, []);

  // ── Fly-to function ───────────────────────────────────────────────────

  const flyTo = useCallback((sessionId: string) => {
    const canvas = canvasRef.current;
    const zoom = zoomRef.current;
    const pt = pointMap.get(sessionId);
    if (!canvas || !zoom || !pt) return;
    const { w, h } = dimsRef.current;
    const pad = 40;
    const cw = w - pad * 2; const ch = h - pad * 2;
    const tx = pad + pt.x * cw;
    const ty = pad + pt.y * ch;
    const targetK = 5;
    const targetTransform = d3.zoomIdentity.translate(w / 2 - tx * targetK, h / 2 - ty * targetK).scale(targetK);
    d3.select(canvas).transition().duration(600).call(zoom.transform as any, targetTransform);
    setSearchFocusedId(sessionId);
  }, [pointMap]);

  // ── Mouse hit-test ────────────────────────────────────────────────────

  const hitTest = useCallback((clientX: number, clientY: number): ConstellationPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas || points.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left; const my = clientY - rect.top;
    const t = transformRef.current;
    const { w, h } = dimsRef.current;
    const pad = 40; const cw = w - pad * 2; const ch = h - pad * 2;
    const nx = (t.invertX(mx) - pad) / cw;
    const ny = (t.invertY(my) - pad) / ch;
    const searchR = (DOT_RADIUS_HOVER * 2) / (Math.min(cw, ch) * t.k);
    return quadtree.find(nx, ny, searchR) || null;
  }, [points, quadtree]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (fisheyeEnabled) dirtyRef.current = true;
    }

    // Alt+hover for proximity radar
    if (e.altKey && showRadar) {
      const pt = hitTest(e.clientX, e.clientY);
      if (pt && pt.session_id !== radarSession) {
        setRadarSession(pt.session_id);
        dirtyRef.current = true;
      }
    }

    const pt = hitTest(e.clientX, e.clientY);
    if (pt !== hoverRef.current) {
      hoverRef.current = pt;
      dirtyRef.current = true;
      if (canvas) canvas.style.cursor = pt ? 'pointer' : 'grab';
    }
  }, [hitTest, fisheyeEnabled, showRadar, radarSession]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const pt = hitTest(e.clientX, e.clientY);
    if (pt) {
      // Shift+click for path tracing
      if (e.shiftKey) {
        if (!pathStart) {
          setPathStart(pt.session_id);
        } else if (!pathEnd) {
          setPathEnd(pt.session_id);
        } else {
          // Reset and start new path
          setPathStart(pt.session_id);
          setPathEnd(null);
          setTracedPath([]);
        }
        return;
      }
      onChunkSelect(pt.chunk_id);
    }
  }, [hitTest, onChunkSelect, pathStart, pathEnd]);

  // ── Mini-map click → navigate ──────────────────────────────────────────

  const handleMiniMapClick = useCallback((e: React.MouseEvent) => {
    const miniCanvas = miniMapRef.current;
    const canvas = canvasRef.current;
    const zoom = zoomRef.current;
    if (!miniCanvas || !canvas || !zoom) return;
    const rect = miniCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    const { w, h } = dimsRef.current;
    const pad = 40; const cw = w - pad * 2; const ch = h - pad * 2;
    const tx = pad + mx * cw;
    const ty = pad + my * ch;
    const currentK = transformRef.current.k;
    const targetTransform = d3.zoomIdentity.translate(w / 2 - tx * currentK, h / 2 - ty * currentK).scale(currentK);
    d3.select(canvas).transition().duration(300).call(zoom.transform as any, targetTransform);
  }, []);

  // ── Stats ──────────────────────────────────────────────────────────────

  const totalSessions = points.length;
  const totalChunks = chunks.length;
  const criticalCount = points.filter(p => p.critical).length;
  const isGradient = algorithm === 'gradient_scale';

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative', background: C.bg }}>
      {/* Canvas area */}
      <div ref={containerRef} style={{ flex: 1, height: '100%', position: 'relative' }}>
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          style={{ display: 'block', cursor: 'grab' }}
        />

        {/* Search bar (floating, top center) */}
        <div style={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 15, display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}>
          <input
            type="text"
            placeholder="Search sessions or tables..."
            value={searchTerm}
            onChange={e => { setSearchTerm(e.target.value); setSearchFocusedId(null); }}
            style={{
              width: 280, padding: '6px 12px', borderRadius: 6,
              border: '1px solid rgba(100,116,139,0.3)', background: 'rgba(26,35,50,0.9)',
              color: '#e2e8f0', fontSize: 11, outline: 'none',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          />
          {searchResults.length > 0 && (
            <div style={{
              width: 280, maxHeight: 200, overflowY: 'auto', marginTop: 2,
              background: 'rgba(26,35,50,0.95)', border: '1px solid rgba(100,116,139,0.3)',
              borderRadius: 6,
            }}>
              {searchResults.map(p => (
                <div
                  key={p.session_id}
                  onClick={() => { flyTo(p.session_id); setSearchTerm(''); }}
                  style={{
                    padding: '4px 10px', cursor: 'pointer', fontSize: 10,
                    color: searchFocusedId === p.session_id ? '#F59E0B' : '#e2e8f0',
                    background: searchFocusedId === p.session_id ? 'rgba(245,158,11,0.1)' : 'transparent',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(59,130,246,0.1)')}
                  onMouseLeave={e => (e.currentTarget.style.background = searchFocusedId === p.session_id ? 'rgba(245,158,11,0.1)' : 'transparent')}
                >
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  <div style={{ fontSize: 8, color: '#8899aa' }}>Tier {p.tier} | {chunkMap.get(p.chunk_id)?.label.split(':')[0] || p.chunk_id}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Path tracing indicator */}
        {(pathStart || pathEnd) && (
          <div style={{
            position: 'absolute', top: 52, left: '50%', transform: 'translateX(-50%)',
            padding: '4px 12px', borderRadius: 6, background: 'rgba(59,130,246,0.15)',
            border: '1px solid rgba(59,130,246,0.3)', color: '#60A5FA', fontSize: 10, zIndex: 15,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span>Path: {pathStart ? pointMap.get(pathStart)?.name.slice(0, 15) : '?'} → {pathEnd ? pointMap.get(pathEnd)?.name.slice(0, 15) : '(Shift+click target)'}</span>
            {tracedPath.length > 1 && <span style={{ fontWeight: 700 }}>{tracedPath.length - 1} hops</span>}
            <button onClick={() => { setPathStart(null); setPathEnd(null); setTracedPath([]); dirtyRef.current = true; }}
              style={{ background: 'transparent', border: 'none', color: '#60A5FA', cursor: 'pointer', fontSize: 10, textDecoration: 'underline' }}>
              Clear
            </button>
          </div>
        )}

        {/* Reclustering overlay */}
        {reclustering && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(8, 12, 20, 0.7)', zIndex: 10,
          }}>
            <div style={{
              padding: '16px 32px', borderRadius: 12,
              background: 'rgba(15, 23, 42, 0.95)', border: '1px solid rgba(59, 130, 246, 0.3)',
              color: '#60A5FA', fontSize: 13, fontWeight: 600,
            }}>Re-clustering...</div>
          </div>
        )}

        {/* Mini-map (bottom-left corner) */}
        <canvas
          ref={miniMapRef}
          onClick={handleMiniMapClick}
          style={{
            position: 'absolute', bottom: 40, left: 12,
            width: 160, height: 120, borderRadius: 6, cursor: 'crosshair',
            border: '1px solid rgba(100,116,139,0.3)', zIndex: 10,
          }}
        />

        {/* Zoom controls */}
        <div style={{
          position: 'absolute', bottom: 52, right: 12,
          display: 'flex', flexDirection: 'column', gap: 4, zIndex: 10,
        }}>
          {[{ label: '+', scale: 1.5 }, { label: '-', scale: 0.67 }].map(b => (
            <button key={b.label} onClick={() => {
              const canvas = canvasRef.current;
              const zoom = zoomRef.current;
              if (canvas && zoom) d3.select(canvas).transition().duration(200).call(zoom.scaleBy as any, b.scale);
            }} style={{
              width: 28, height: 28, borderRadius: 5, border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(26,35,50,0.85)', color: '#94a3b8', fontSize: 14,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{b.label}</button>
          ))}
          <button
            onClick={() => setFisheyeEnabled(f => !f)}
            title={fisheyeEnabled ? 'Disable fisheye' : 'Enable fisheye'}
            style={{
              width: 28, height: 28, borderRadius: 5,
              border: `1px solid ${fisheyeEnabled ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.1)'}`,
              background: fisheyeEnabled ? 'rgba(59,130,246,0.2)' : 'rgba(26,35,50,0.85)',
              color: fisheyeEnabled ? '#60A5FA' : '#94a3b8',
              fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >{'\u25CE'}</button>
        </div>

        {/* Stats overlay */}
        <div style={{
          position: 'absolute', bottom: 12, left: 180,
          padding: '6px 14px', borderRadius: 8,
          background: 'rgba(15, 23, 42, 0.85)', border: '1px solid rgba(30, 41, 59, 0.6)',
          display: 'flex', gap: 16, fontSize: 10, color: C.muted,
        }}>
          <span><strong style={{ color: C.text }}>{totalSessions.toLocaleString()}</strong> Sessions</span>
          {isGradient ? (
            <>
              <span style={{ color: '#3B82F6', fontWeight: 600 }}>Gradient Scale Map</span>
              {densityGrid && <span><strong style={{ color: '#EF4444' }}>{densityGrid.peaks.length}</strong> peaks</span>}
            </>
          ) : (
            <>
              <span><strong style={{ color: '#3B82F6' }}>{totalChunks}</strong> Clusters</span>
              {criticalCount > 0 && <span><strong style={{ color: '#EF4444' }}>{criticalCount}</strong> Critical</span>}
            </>
          )}
          <span style={{ color: C.dim }}>Scroll/drag · Shift+click=path · Alt+hover=radar</span>
        </div>
      </div>

      {/* Algorithm selector sidebar */}
      {onAlgorithmChange && (
        <div style={{
          width: 220, flexShrink: 0, borderLeft: '1px solid rgba(30, 41, 59, 0.6)',
          background: 'rgba(15, 23, 42, 0.6)', overflowY: 'auto',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(30, 41, 59, 0.6)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#10B981', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Clustering Algorithm
            </div>
          </div>

          <div style={{ padding: '8px 10px', flex: 1 }}>
            {ALGO_KEYS.map(key => {
              const meta = ALGO_META[key];
              const isActive = key === algorithm;
              return (
                <div key={key} onClick={() => !reclustering && onAlgorithmChange(key)}
                  style={{
                    padding: '10px 12px', marginBottom: 6, borderRadius: 8,
                    cursor: reclustering ? 'wait' : 'pointer',
                    background: isActive ? 'rgba(16, 185, 129, 0.1)' : 'rgba(0, 0, 0, 0.2)',
                    border: `1px solid ${isActive ? '#10B981' : 'rgba(30, 41, 59, 0.4)'}`,
                    transition: 'all 0.15s',
                    opacity: reclustering && !isActive ? 0.5 : 1,
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, lineHeight: 1, color: isActive ? '#34D399' : '#8899aa' }}>{meta.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: isActive ? '#34D399' : '#CBD5E1' }}>{meta.name}</span>
                    {isActive && (
                      <span style={{ marginLeft: 'auto', fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(16,185,129,0.2)', color: '#34D399' }}>ACTIVE</span>
                    )}
                  </div>
                  <div style={{ fontSize: 9, color: isActive ? 'rgba(52,211,153,0.7)' : '#5a6a7a', lineHeight: 1.4 }}>{meta.desc}</div>
                </div>
              );
            })}
          </div>

          {/* Display section */}
          <div style={{ padding: '12px 14px', borderTop: '1px solid rgba(30, 41, 59, 0.6)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#10B981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>
              Display
            </div>
            {[
              { label: 'Connection Lines', value: showEdges, setter: setShowEdges },
              { label: 'Cluster Shading', value: showHulls, setter: setShowHulls },
              { label: 'Heat Overlay', value: showHeatOverlay, setter: setShowHeatOverlay },
            ].map(({ label, value, setter }) => (
              <div key={label} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8,
                opacity: isGradient && label !== 'Heat Overlay' ? 0.3 : 1,
                pointerEvents: isGradient && label !== 'Heat Overlay' ? 'none' : 'auto',
              }}>
                <span style={{ fontSize: 10, color: '#CBD5E1' }}>{label}</span>
                <div onClick={() => setter(v => !v)} style={{
                  width: 28, height: 16, borderRadius: 8, cursor: 'pointer',
                  background: value ? '#10B981' : '#4a5a6e',
                  position: 'relative', transition: 'background 0.15s',
                }}>
                  <div style={{
                    width: 12, height: 12, borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: 2, left: value ? 14 : 2, transition: 'left 0.15s',
                  }} />
                </div>
              </div>
            ))}

            {/* Proximity Radar */}
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: '#CBD5E1' }}>Radar (Alt+hover)</span>
                <div onClick={() => { setShowRadar(v => !v); if (showRadar) { setRadarSession(null); setRadarResult(new Map()); dirtyRef.current = true; } }}
                  style={{
                    width: 28, height: 16, borderRadius: 8, cursor: 'pointer',
                    background: showRadar ? '#F59E0B' : '#4a5a6e',
                    position: 'relative', transition: 'background 0.15s',
                  }}>
                  <div style={{
                    width: 12, height: 12, borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: 2, left: showRadar ? 14 : 2, transition: 'left 0.15s',
                  }} />
                </div>
              </div>
              {showRadar && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: C.muted }}>
                  <span>Hops:</span>
                  {[1, 2, 3, 4, 5].map(n => (
                    <button key={n} onClick={() => setRadarHops(n)} style={{
                      width: 18, height: 18, borderRadius: 3, border: 'none', cursor: 'pointer',
                      background: radarHops === n ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.03)',
                      color: radarHops === n ? '#F59E0B' : C.dim, fontSize: 9, fontWeight: 600,
                    }}>{n}</button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Pinned Sessions */}
          {pinnedSessions.size > 0 && (
            <div style={{ padding: '12px 14px', borderTop: '1px solid rgba(30, 41, 59, 0.6)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#F59E0B', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                Pinned ({pinnedSessions.size})
              </div>
              {Array.from(pinnedSessions).slice(0, 10).map(sid => {
                const pt = pointMap.get(sid);
                return (
                  <div key={sid} style={{
                    display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4,
                    fontSize: 9, color: C.text,
                  }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace" }}>
                      {pt?.name || sid}
                    </span>
                    <button onClick={() => flyTo(sid)} style={{
                      background: 'transparent', border: 'none', color: '#60A5FA', cursor: 'pointer', fontSize: 8,
                    }}>Go</button>
                    <button onClick={() => onUnpinSession?.(sid)} style={{
                      background: 'transparent', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 8,
                    }}>x</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
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
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
