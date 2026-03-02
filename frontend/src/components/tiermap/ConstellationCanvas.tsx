/**
 * Constellation Canvas — HTML5 Canvas renderer for 15K session points.
 * Uses D3 zoom/pan + quadtree for O(log N) hover/click hit detection.
 * Renders cluster hulls, labels, cross-chunk edges, and critical markers.
 * Supports: multi-select, display toggles, gradient scale map, session highlight.
 */

import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import * as d3 from 'd3';
import type {
  ConstellationPoint,
  ConstellationChunk,
  CrossChunkEdge,
  AlgorithmKey,
} from '../../types/tiermap';

// ── Constants ────────────────────────────────────────────────────────────────

const DOT_RADIUS = 2.5;
const DOT_RADIUS_HOVER = 5;
const CRITICAL_RING = 7;
const HULL_ALPHA = 0.08;
const LABEL_FONT = '12px "JetBrains Mono", monospace';
const LABEL_FONT_SM = '9px "JetBrains Mono", monospace';
const LABEL_ZOOM_THRESHOLD = 1.8; // hide labels when zoomed in past this
const EDGE_ALPHA = 0.15;

/** Minimum session count for a cluster to get a label at default zoom. */
const BIG_CLUSTER_THRESHOLD = 5;

const C = {
  bg: '#080C14',
  text: '#e2e8f0',
  muted: '#64748b',
  dim: '#475569',
};

// ── Algorithm metadata (matches backend ALGORITHMS dict) ─────────────────────

const ALGO_META: Record<AlgorithmKey, { name: string; desc: string; icon: string }> = {
  louvain:       { name: 'Louvain',              icon: '\u25CE', desc: 'Modularity-based community detection \u2014 best for densely connected table groups' },
  tier:          { name: 'Tier Groups',           icon: '\u2261', desc: 'Group sessions by execution tier \u2014 shows pipeline depth layers' },
  components:    { name: 'Connected Components',  icon: '\u25C7', desc: 'Natural graph islands \u2014 zero-overlap sessions become separate clusters' },
  label_prop:    { name: 'Label Propagation',     icon: '\u21B9', desc: 'Fast iterative label spreading \u2014 good for loosely connected graphs' },
  greedy_mod:    { name: 'Greedy Modularity',     icon: '\u25A3', desc: 'Agglomerative merge \u2014 produces fewer, larger clusters' },
  process_group: { name: 'Process Group',         icon: '\u229E', desc: 'Group by NiFi process group / Informatica workflow' },
  table_gravity: { name: 'Table Gravity',         icon: '\u2299', desc: 'Cluster around most referenced tables \u2014 reveals critical shared dependencies' },
  gradient_scale:{ name: 'Gradient Scale',        icon: '\u25D0', desc: 'Density heatmap \u2014 darker = higher session concentration, with top-10 peak markers' },
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
}: ConstellationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const hoverRef = useRef<ConstellationPoint | null>(null);
  const dirtyRef = useRef(true);
  const rafRef = useRef<number>(0);
  const dimsRef = useRef({ w: 800, h: 600 });
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const [fisheyeEnabled, setFisheyeEnabled] = useState(false);
  const [showEdges, setShowEdges] = useState(true);
  const [showHulls, setShowHulls] = useState(true);

  // ── Pre-computed chunk lookup maps ────────────────────────────────────────
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

  const chunkCentroids = useMemo(() => {
    const centroids = new Map<string, { x: number; y: number; count: number }>();
    for (const p of points) {
      const c = centroids.get(p.chunk_id);
      if (c) {
        c.x += p.x;
        c.y += p.y;
        c.count += 1;
      } else {
        centroids.set(p.chunk_id, { x: p.x, y: p.y, count: 1 });
      }
    }
    const result = new Map<string, { x: number; y: number }>();
    for (const [id, c] of centroids) {
      result.set(id, { x: c.x / c.count, y: c.y / c.count });
    }
    return result;
  }, [points]);

  const chunkHulls = useMemo(() => {
    const grouped = new Map<string, [number, number][]>();
    for (const p of points) {
      const arr = grouped.get(p.chunk_id) || [];
      arr.push([p.x, p.y]);
      if (!grouped.has(p.chunk_id)) grouped.set(p.chunk_id, arr);
    }
    const hulls = new Map<string, [number, number][]>();
    for (const [id, pts] of grouped) {
      if (pts.length < 3) {
        hulls.set(id, pts);
        continue;
      }
      const hull = d3.polygonHull(pts);
      if (hull) hulls.set(id, hull);
      else hulls.set(id, pts);
    }
    return hulls;
  }, [points]);

  const quadtree = useMemo(() => {
    return d3.quadtree<ConstellationPoint>()
      .x((d) => d.x)
      .y((d) => d.y)
      .addAll(points);
  }, [points]);

  // ── Gradient Scale Map: KDE density computation ──────────────────────────
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
          const kernel = Math.exp(-0.5 * (dx * dx + dy * dy));
          grid[iy * gridSize + ix] += kernel;
        }
      }
    }

    let maxDensity = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] > maxDensity) maxDensity = grid[i];
    }

    // Find local maxima (peaks)
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
    const peaks = rawPeaks.slice(0, 10);

    return { grid, maxDensity, peaks, gridSize };
  }, [points, algorithm]);

  // ── Drawing ───────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { w, h } = dimsRef.current;
    const t = transformRef.current;
    const hover = hoverRef.current;

    const pad = 40;
    const cw = w - pad * 2;
    const ch = h - pad * 2;
    const sx = (nx: number) => t.applyX(pad + nx * cw);
    const sy = (ny: number) => t.applyY(pad + ny * ch);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    const hasFilter = selectedChunkIds.size > 0;
    const hasHighlight = highlightedSessionIds.size > 0;
    const isGradient = algorithm === 'gradient_scale';

    // ── GRADIENT SCALE MAP MODE ──────────────────────────────────────────
    if (isGradient && densityGrid) {
      const { grid, maxDensity, peaks, gridSize } = densityGrid;
      const cellW = cw / gridSize;
      const cellH = ch / gridSize;
      const densityThreshold = maxDensity * 0.01;

      // Draw density cells
      for (let iy = 0; iy < gridSize; iy++) {
        for (let ix = 0; ix < gridSize; ix++) {
          const val = grid[iy * gridSize + ix];
          if (val < densityThreshold) continue;
          const norm = val / maxDensity;
          const lightness = 90 - norm * 65; // 90% (sparse) → 25% (dense)
          const alpha = 0.15 + norm * 0.6; // 0.15 → 0.75
          const px = sx(ix / (gridSize - 1)) - cellW * t.k / 2;
          const py = sy(iy / (gridSize - 1)) - cellH * t.k / 2;
          ctx.fillStyle = `hsla(220, 80%, ${lightness}%, ${alpha})`;
          ctx.fillRect(px, py, cellW * t.k + 1, cellH * t.k + 1);
        }
      }

      // Draw session dots (dimmed, uniform gray)
      for (const p of points) {
        const px = sx(p.x);
        const py = sy(p.y);
        ctx.beginPath();
        ctx.arc(px, py, DOT_RADIUS * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.3)';
        ctx.fill();
        if (p.critical) {
          ctx.beginPath();
          ctx.arc(px, py, CRITICAL_RING * 0.7, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // Draw top-10 peak markers (red pins)
      for (let i = 0; i < peaks.length; i++) {
        const peak = peaks[i];
        const px = sx(peak.x);
        const py = sx !== undefined ? sy(peak.y) : 0;
        const rank = i + 1;
        const headR = 10 - i * 0.4;
        const brightness = 1.0 - i * 0.04;

        // Pin stem
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + 12);
        ctx.strokeStyle = `rgba(239, 68, 68, ${brightness * 0.6})`;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Pin head
        ctx.beginPath();
        ctx.arc(px, py, headR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(239, 68, 68, ${brightness * 0.8})`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Rank number
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${headR > 7 ? 9 : 7}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(rank), px, py);
      }

      // Density legend (bottom-right, above zoom controls)
      const legendX = w - 140;
      const legendY = h - 80;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      roundRect(ctx, legendX - 8, legendY - 6, 120, 36, 6);
      ctx.fill();
      const grad = ctx.createLinearGradient(legendX, 0, legendX + 100, 0);
      grad.addColorStop(0, 'hsl(220, 80%, 85%)');
      grad.addColorStop(1, 'hsl(220, 80%, 25%)');
      ctx.fillStyle = grad;
      roundRect(ctx, legendX, legendY, 100, 12, 3);
      ctx.fill();
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = C.muted;
      ctx.fillText('Low', legendX, legendY + 16);
      ctx.textAlign = 'right';
      ctx.fillText('High', legendX + 100, legendY + 16);
      ctx.textAlign = 'center';
      ctx.fillText(`${peaks.length} peaks`, legendX + 50, legendY + 16);

    } else {
      // ── NORMAL MODE ────────────────────────────────────────────────────

      // Draw cluster hulls
      if (showHulls) {
        for (const [chunkId, hull] of chunkHulls) {
          if (hull.length < 3) continue;
          const color = chunkColorMap.get(chunkId) || '#3B82F6';
          const isSelected = !hasFilter || selectedChunkIds.has(chunkId);
          const hullAlpha = isSelected ? HULL_ALPHA : HULL_ALPHA * 0.15;
          const strokeAlpha = isSelected ? 0.2 : 0.04;
          ctx.beginPath();
          ctx.moveTo(sx(hull[0][0]), sy(hull[0][1]));
          for (let i = 1; i < hull.length; i++) {
            ctx.lineTo(sx(hull[i][0]), sy(hull[i][1]));
          }
          ctx.closePath();
          ctx.fillStyle = hexToRgba(color, hullAlpha);
          ctx.fill();
          if (isSelected) {
            ctx.strokeStyle = hexToRgba(color, strokeAlpha + (selectedChunkIds.has(chunkId) ? 0.4 : 0));
            ctx.lineWidth = selectedChunkIds.has(chunkId) ? 2 : 1;
            ctx.stroke();
          }
        }
      }

      // Draw cross-chunk edges
      if (showEdges) {
        for (const edge of crossChunkEdges) {
          if (hasFilter && !selectedChunkIds.has(edge.from_chunk) && !selectedChunkIds.has(edge.to_chunk)) continue;
          const from = chunkCentroids.get(edge.from_chunk);
          const to = chunkCentroids.get(edge.to_chunk);
          if (!from || !to) continue;
          const edgeAlpha = hasFilter
            ? (selectedChunkIds.has(edge.from_chunk) || selectedChunkIds.has(edge.to_chunk) ? 0.4 : 0.03)
            : EDGE_ALPHA;
          ctx.beginPath();
          ctx.moveTo(sx(from.x), sy(from.y));
          ctx.lineTo(sx(to.x), sy(to.y));
          ctx.strokeStyle = `rgba(148, 163, 184, ${edgeAlpha})`;
          ctx.lineWidth = Math.min(edge.count * 0.3, 3);
          ctx.stroke();
        }
      }

      // ── Determine which clusters are "big" (enough to label) ──
      const totalSess = points.length;
      const labelThreshold = totalSess > 500
        ? Math.max(BIG_CLUSTER_THRESHOLD, Math.ceil(totalSess * 0.005))
        : BIG_CLUSTER_THRESHOLD;

      const chunkSizeMap = new Map<string, number>();
      for (const chunk of chunks) chunkSizeMap.set(chunk.id, chunk.session_count);

      // Draw dots
      for (const p of points) {
        const px = sx(p.x);
        const py = sy(p.y);
        const color = chunkColorMap.get(p.chunk_id) || '#3B82F6';
        const isHover = hover && hover.session_id === p.session_id;
        const isInSelected = !hasFilter || selectedChunkIds.has(p.chunk_id);
        const isHighlighted = hasHighlight ? highlightedSessionIds.has(p.session_id) : null;
        const cSize = chunkSizeMap.get(p.chunk_id) || 1;
        const baseR = cSize >= labelThreshold
          ? DOT_RADIUS + Math.min(Math.log2(cSize) * 0.4, 2)
          : DOT_RADIUS;

        // If highlight mode active and this point is NOT highlighted, dim it
        if (isHighlighted === false) {
          ctx.beginPath();
          ctx.arc(px, py, baseR * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(100, 116, 139, 0.08)';
          ctx.fill();
          continue;
        }

        // If highlighted, draw amber ring
        if (isHighlighted === true) {
          ctx.beginPath();
          ctx.arc(px, py, baseR + 4, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        const r = isHover ? DOT_RADIUS_HOVER : (isInSelected ? baseR : baseR * 0.6);

        // Critical marker ring
        if (p.critical && isInSelected) {
          ctx.beginPath();
          ctx.arc(px, py, CRITICAL_RING, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = isHover ? '#ffffff' : color;
        ctx.globalAlpha = isInSelected ? (cSize >= labelThreshold ? 1.0 : 0.6) : 0.08;
        ctx.fill();
        ctx.globalAlpha = 1.0;

        if (isHover) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // Draw cluster labels
      if (t.k < LABEL_ZOOM_THRESHOLD) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const chunk of chunks) {
          const isThisSelected = selectedChunkIds.has(chunk.id);
          if (!isThisSelected && chunk.session_count < labelThreshold) continue;
          if (hasFilter && !isThisSelected) continue;
          const centroid = chunkCentroids.get(chunk.id);
          if (!centroid) continue;
          const lx = sx(centroid.x);
          const ly = sy(centroid.y);

          const label = chunk.label.split(':')[0];
          const countLabel = `${chunk.session_count} sessions`;
          ctx.font = LABEL_FONT;
          const tw = ctx.measureText(label).width + 16;
          const pillH = 32;
          ctx.fillStyle = isThisSelected ? 'rgba(8, 12, 20, 0.9)' : 'rgba(8, 12, 20, 0.75)';
          roundRect(ctx, lx - tw / 2, ly - pillH / 2 - 4, tw, pillH, 6);
          ctx.fill();
          if (isThisSelected) {
            ctx.strokeStyle = hexToRgba(chunk.color, 0.6);
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }

          ctx.fillStyle = hexToRgba(chunk.color, isThisSelected ? 1.0 : 0.9);
          ctx.font = LABEL_FONT;
          ctx.fillText(label, lx, ly - 6);

          ctx.font = LABEL_FONT_SM;
          ctx.fillStyle = hexToRgba(chunk.color, isThisSelected ? 0.8 : 0.6);
          ctx.fillText(countLabel, lx, ly + 10);
        }
      }
    }

    // Draw hover tooltip (works in both modes)
    if (hover) {
      const px = sx(hover.x);
      const py = sy(hover.y);
      const chunk = chunkMap.get(hover.chunk_id);
      const lines = [
        hover.name,
        `Tier ${hover.tier}${hover.critical ? ' (critical)' : ''}`,
        isGradient ? '(density view)' : (chunk ? chunk.label : hover.chunk_id),
      ];
      const lineH = 16;
      const tooltipW = 220;
      const tooltipH = lines.length * lineH + 12;
      const tx = Math.min(px + 12, w - tooltipW - 8);
      const ty = Math.max(py - tooltipH - 8, 8);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
      ctx.lineWidth = 1;
      roundRect(ctx, tx, ty, tooltipW, tooltipH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? '#e2e8f0' : '#94a3b8';
        ctx.fillText(line, tx + 8, ty + 6 + i * lineH, tooltipW - 16);
      });
    }

    // ── Fisheye lens overlay ──────────────────────────────────────────────
    const mousePos = mousePosRef.current;
    if (fisheyeEnabled && mousePos) {
      const lensR = 80;
      const magnification = 2.5;
      const mx = mousePos.x;
      const my = mousePos.y;

      ctx.save();
      ctx.beginPath();
      ctx.arc(mx, my, lensR, 0, Math.PI * 2);
      ctx.clip();

      ctx.fillStyle = 'rgba(8, 12, 20, 0.9)';
      ctx.fillRect(mx - lensR, my - lensR, lensR * 2, lensR * 2);

      for (const p of points) {
        const px = sx(p.x);
        const py = sy(p.y);
        const dx = px - mx;
        const dy = py - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > lensR * magnification) continue;

        const nd = dist / (lensR * magnification);
        const fisheyeDist = nd < 1 ? nd * nd * lensR : dist;
        const angle = Math.atan2(dy, dx);
        const fpx = mx + Math.cos(angle) * fisheyeDist;
        const fpy = my + Math.sin(angle) * fisheyeDist;

        const color = chunkColorMap.get(p.chunk_id) || '#3B82F6';
        const r = DOT_RADIUS * magnification;
        ctx.beginPath();
        ctx.arc(fpx, fpy, r, 0, Math.PI * 2);
        ctx.fillStyle = isGradient ? 'rgba(148, 163, 184, 0.6)' : color;
        ctx.fill();

        if (dist < lensR) {
          ctx.font = '9px "JetBrains Mono", monospace';
          ctx.fillStyle = '#e2e8f0';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.name.slice(0, 16), fpx + r + 3, fpy);
        }
      }

      ctx.restore();

      ctx.beginPath();
      ctx.arc(mx, my, lensR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(mx - 6, my); ctx.lineTo(mx + 6, my);
      ctx.moveTo(mx, my - 6); ctx.lineTo(mx, my + 6);
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.restore();
  }, [points, chunks, crossChunkEdges, chunkHulls, chunkCentroids, chunkColorMap, chunkMap, quadtree, fisheyeEnabled, selectedChunkIds, showEdges, showHulls, algorithm, densityGrid, highlightedSessionIds]);

  // ── Animation loop ─────────────────────────────────────────────────────
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

  // ── Resize observer ────────────────────────────────────────────────────
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

  // ── D3 zoom ────────────────────────────────────────────────────────────
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

    return () => {
      d3.select(canvas).on('.zoom', null);
    };
  }, []);

  // ── Mouse hit-test ─────────────────────────────────────────────────────
  const hitTest = useCallback((clientX: number, clientY: number): ConstellationPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas || points.length === 0) return null;

    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    const t = transformRef.current;
    const { w, h } = dimsRef.current;
    const pad = 40;
    const cw = w - pad * 2;
    const ch = h - pad * 2;

    const nx = (t.invertX(mx) - pad) / cw;
    const ny = (t.invertY(my) - pad) / ch;

    const searchR = (DOT_RADIUS_HOVER * 2) / (Math.min(cw, ch) * t.k);

    const found = quadtree.find(nx, ny, searchR);
    return found || null;
  }, [points, quadtree]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (fisheyeEnabled) dirtyRef.current = true;
    }
    const pt = hitTest(e.clientX, e.clientY);
    if (pt !== hoverRef.current) {
      hoverRef.current = pt;
      dirtyRef.current = true;
      if (canvas) canvas.style.cursor = pt ? 'pointer' : 'grab';
    }
  }, [hitTest, fisheyeEnabled]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const pt = hitTest(e.clientX, e.clientY);
    if (pt) {
      onChunkSelect(pt.chunk_id);
    }
  }, [hitTest, onChunkSelect]);

  // ── Stats bar ─────────────────────────────────────────────────────────

  const totalSessions = points.length;
  const totalChunks = chunks.length;
  const criticalCount = points.filter((p) => p.critical).length;
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

        {/* Reclustering overlay */}
        {reclustering && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(8, 12, 20, 0.7)', zIndex: 10,
          }}>
            <div style={{
              padding: '16px 32px', borderRadius: 12,
              background: 'rgba(15, 23, 42, 0.95)', border: '1px solid rgba(59, 130, 246, 0.3)',
              color: '#60A5FA', fontSize: 13, fontWeight: 600,
            }}>
              Re-clustering\u2026
            </div>
          </div>
        )}

        {/* Zoom controls */}
        <div style={{
          position: 'absolute', bottom: 52, right: 12,
          display: 'flex', flexDirection: 'column', gap: 4, zIndex: 10,
        }}>
          {[
            { label: '+', scale: 1.5 },
            { label: '-', scale: 0.67 },
          ].map(b => (
            <button key={b.label} onClick={() => {
              const canvas = canvasRef.current;
              if (canvas) d3.select(canvas).transition().duration(200).call(
                d3.zoom<HTMLCanvasElement, unknown>().scaleExtent([0.3, 20]).scaleBy as any, b.scale
              );
            }} style={{
              width: 28, height: 28, borderRadius: 5, border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(15,23,42,0.85)', color: '#94a3b8', fontSize: 14,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{b.label}</button>
          ))}
          {/* Fisheye toggle */}
          <button
            onClick={() => setFisheyeEnabled(f => !f)}
            title={fisheyeEnabled ? 'Disable fisheye lens' : 'Enable fisheye lens'}
            style={{
              width: 28, height: 28, borderRadius: 5,
              border: `1px solid ${fisheyeEnabled ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.1)'}`,
              background: fisheyeEnabled ? 'rgba(59,130,246,0.2)' : 'rgba(15,23,42,0.85)',
              color: fisheyeEnabled ? '#60A5FA' : '#94a3b8',
              fontSize: 12, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {'\u25CE'}
          </button>
        </div>

        {/* Stats overlay */}
        <div style={{
          position: 'absolute', bottom: 12, left: 12,
          padding: '6px 14px', borderRadius: 8,
          background: 'rgba(15, 23, 42, 0.85)', border: '1px solid rgba(30, 41, 59, 0.6)',
          display: 'flex', gap: 16, fontSize: 10, color: C.muted,
        }}>
          <span><strong style={{ color: C.text }}>{totalSessions.toLocaleString()}</strong> Sessions</span>
          {isGradient ? (
            <>
              <span style={{ color: '#3B82F6', fontWeight: 600 }}>Gradient Scale Map</span>
              {densityGrid && <span><strong style={{ color: '#EF4444' }}>{densityGrid.peaks.length}</strong> density peaks</span>}
            </>
          ) : (
            <>
              <span><strong style={{ color: '#3B82F6' }}>{totalChunks}</strong> Clusters</span>
              {criticalCount > 0 && <span><strong style={{ color: '#EF4444' }}>{criticalCount}</strong> Critical</span>}
            </>
          )}
          <span style={{ color: C.dim }}>Scroll to zoom · Drag to pan · Click to drill in</span>
        </div>
      </div>

      {/* Algorithm selector sidebar */}
      {onAlgorithmChange && (
        <div style={{
          width: 220, flexShrink: 0, borderLeft: '1px solid rgba(30, 41, 59, 0.6)',
          background: 'rgba(15, 23, 42, 0.6)', overflowY: 'auto',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '12px 14px', borderBottom: '1px solid rgba(30, 41, 59, 0.6)',
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, color: '#10B981',
              textTransform: 'uppercase', letterSpacing: '0.1em',
            }}>
              Clustering Algorithm
            </div>
          </div>

          <div style={{ padding: '8px 10px', flex: 1 }}>
            {ALGO_KEYS.map((key) => {
              const meta = ALGO_META[key];
              const isActive = key === algorithm;
              return (
                <div
                  key={key}
                  onClick={() => !reclustering && onAlgorithmChange(key)}
                  style={{
                    padding: '10px 12px', marginBottom: 6, borderRadius: 8,
                    cursor: reclustering ? 'wait' : 'pointer',
                    background: isActive ? 'rgba(16, 185, 129, 0.1)' : 'rgba(0, 0, 0, 0.2)',
                    border: `1px solid ${isActive ? '#10B981' : 'rgba(30, 41, 59, 0.4)'}`,
                    transition: 'all 0.15s',
                    opacity: reclustering && !isActive ? 0.5 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{
                      fontSize: 14, lineHeight: 1,
                      color: isActive ? '#34D399' : '#64748b',
                    }}>
                      {meta.icon}
                    </span>
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: isActive ? '#34D399' : '#CBD5E1',
                    }}>
                      {meta.name}
                    </span>
                    {isActive && (
                      <span style={{
                        marginLeft: 'auto', fontSize: 8, fontWeight: 700,
                        padding: '1px 5px', borderRadius: 3,
                        background: 'rgba(16, 185, 129, 0.2)', color: '#34D399',
                      }}>
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <div style={{
                    fontSize: 9, color: isActive ? 'rgba(52, 211, 153, 0.7)' : '#475569',
                    lineHeight: 1.4,
                  }}>
                    {meta.desc}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Display section */}
          <div style={{
            padding: '12px 14px', borderTop: '1px solid rgba(30, 41, 59, 0.6)',
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, color: '#10B981',
              textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10,
            }}>
              Display
            </div>
            {[
              { label: 'Connection Lines', value: showEdges, setter: setShowEdges },
              { label: 'Cluster Shading', value: showHulls, setter: setShowHulls },
            ].map(({ label, value, setter }) => (
              <div key={label} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginBottom: 8,
                opacity: isGradient ? 0.3 : 1,
                pointerEvents: isGradient ? 'none' : 'auto',
              }}>
                <span style={{ fontSize: 10, color: '#CBD5E1' }}>{label}</span>
                <div
                  onClick={() => setter(v => !v)}
                  style={{
                    width: 28, height: 16, borderRadius: 8, cursor: 'pointer',
                    background: value && !isGradient ? '#10B981' : '#334155',
                    position: 'relative', transition: 'background 0.15s',
                  }}
                >
                  <div style={{
                    width: 12, height: 12, borderRadius: '50%',
                    background: '#fff', position: 'absolute', top: 2,
                    left: value && !isGradient ? 14 : 2,
                    transition: 'left 0.15s',
                  }} />
                </div>
              </div>
            ))}
          </div>
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

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
