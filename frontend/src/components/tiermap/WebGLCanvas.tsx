/**
 * WebGL Canvas — high-performance Canvas 2D renderer for >500 node graphs.
 *
 * Falls back from SVG to Canvas when session count exceeds threshold.
 * Uses quadtree spatial indexing for hit detection and viewport culling.
 * Supports zoom/pan via D3 zoom behavior.
 */

import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { SpatialIndex, getLOD, type SpatialNode, type ViewportBounds } from '../../utils/spatialIndex';
import type { TierMapResult, TierSession, TierTable, TierConn } from '../../types/tiermap';

// ── Constants ────────────────────────────────────────────────────────────────

const CANVAS_THRESHOLD = 500;  // Switch to canvas above this session count
const NODE_RADIUS = 6;
const NODE_RADIUS_HOVER = 10;
const EDGE_ALPHA = 0.3;
const FONT = '11px "JetBrains Mono", monospace';
const FONT_SM = '9px "JetBrains Mono", monospace';

const TIER_COLORS = [
  '#3B82F6', '#EAB308', '#A855F7', '#10B981',
  '#F97316', '#06B6D4', '#EC4899', '#84CC16',
];

const CONN_COLORS: Record<string, string> = {
  write_conflict: '#EF4444',
  write_clean: '#3B82F6',
  read_after_write: '#A855F7',
  lookup_stale: '#F59E0B',
  chain: '#F97316',
  source_read: '#10B981',
};

// ── Layout ───────────────────────────────────────────────────────────────────

interface LayoutNode extends SpatialNode {
  type: 'session' | 'table';
  label: string;
  tier: number;
  color: string;
  data: TierSession | TierTable;
}

interface LayoutEdge {
  source: LayoutNode;
  target: LayoutNode;
  type: string;
  color: string;
}

function buildLayout(data: TierMapResult, width: number, height: number) {
  const nodeMap = new Map<string, LayoutNode>();
  const padding = 60;
  const usableW = width - padding * 2;
  const usableH = height - padding * 2;

  // Compute tier range
  const maxTier = Math.max(
    ...data.sessions.map(s => s.tier),
    ...data.tables.map(t => t.tier),
    1,
  );

  // Layout sessions in tier bands (horizontal bands)
  const sessionsByTier = new Map<number, TierSession[]>();
  for (const s of data.sessions) {
    const tier = Math.floor(s.tier);
    if (!sessionsByTier.has(tier)) sessionsByTier.set(tier, []);
    sessionsByTier.get(tier)!.push(s);
  }

  const tiers = [...sessionsByTier.keys()].sort((a, b) => a - b);
  const bandHeight = usableH / Math.max(tiers.length, 1);

  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    const sessions = sessionsByTier.get(tier)!;
    const y = padding + ti * bandHeight + bandHeight / 2;
    const step = usableW / Math.max(sessions.length + 1, 2);
    for (let si = 0; si < sessions.length; si++) {
      const s = sessions[si];
      const node: LayoutNode = {
        id: s.id,
        x: padding + (si + 1) * step,
        y,
        type: 'session',
        label: s.name,
        tier: s.tier,
        color: TIER_COLORS[Math.max(0, Math.floor(s.tier) - 1) % TIER_COLORS.length],
        data: s,
      };
      nodeMap.set(s.id, node);
    }
  }

  // Layout tables between their connected sessions
  for (const t of data.tables) {
    const tier = Math.floor(t.tier);
    const tierIdx = tiers.indexOf(tier);
    const y = padding + (tierIdx >= 0 ? tierIdx : tiers.length) * bandHeight + bandHeight * 0.3;
    const existing = [...nodeMap.values()].filter(n => Math.abs(n.y - y) < bandHeight / 2);
    const x = padding + (existing.length + 1) * 30 + Math.random() * 40;
    const node: LayoutNode = {
      id: t.id,
      x: Math.min(x, width - padding),
      y,
      type: 'table',
      label: t.name,
      tier: t.tier,
      color: t.type === 'conflict' ? '#EF4444' : t.type === 'chain' ? '#F97316' : '#64748b',
      data: t,
    };
    nodeMap.set(t.id, node);
  }

  // Build edges
  const edges: LayoutEdge[] = [];
  for (const conn of data.connections) {
    const source = nodeMap.get(conn.from);
    const target = nodeMap.get(conn.to);
    if (source && target) {
      edges.push({
        source,
        target,
        type: conn.type,
        color: CONN_COLORS[conn.type] || '#64748b',
      });
    }
  }

  return { nodes: [...nodeMap.values()], edges, nodeMap };
}

// ── Props ────────────────────────────────────────────────────────────────────

interface WebGLCanvasProps {
  data: TierMapResult;
  onSessionSelect?: (sessionId: string) => void;
  width?: number;
  height?: number;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function WebGLCanvas({
  data,
  onSessionSelect,
  width: propWidth,
  height: propHeight,
}: WebGLCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const hoverRef = useRef<LayoutNode | null>(null);
  const dirtyRef = useRef(true);
  const rafRef = useRef<number>(0);
  const [dims, setDims] = useState({ w: propWidth || 1200, h: propHeight || 800 });
  const [hoverNode, setHoverNode] = useState<LayoutNode | null>(null);

  // Build layout
  const layout = useMemo(
    () => buildLayout(data, dims.w, dims.h),
    [data, dims.w, dims.h],
  );

  // Build spatial index
  const spatialIndex = useMemo(
    () => new SpatialIndex(layout.nodes),
    [layout.nodes],
  );

  // Determine if we should use canvas (vs letting parent use SVG)
  const useCanvas = data.sessions.length >= CANVAS_THRESHOLD;

  // ── Resize observer ──
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) {
          setDims({ w: Math.round(width), h: Math.round(height) });
          dirtyRef.current = true;
        }
      }
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Canvas rendering ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const t = transformRef.current;
    const { w, h } = dims;

    // HiDPI support
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    // Apply zoom transform
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    // Viewport culling bounds
    const bounds = SpatialIndex.viewportFromTransform(t, w, h, 50);
    const visibleNodes = spatialIndex.queryViewport(bounds);
    const visibleIds = new Set(visibleNodes.map(n => n.id));

    const lod = getLOD(t.k, layout.nodes.length);

    // Draw edges (only for visible nodes)
    ctx.globalAlpha = EDGE_ALPHA;
    ctx.lineWidth = 1 / t.k;
    for (const edge of layout.edges) {
      if (!visibleIds.has(edge.source.id) && !visibleIds.has(edge.target.id)) continue;
      ctx.strokeStyle = edge.color;
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      // Bezier curve for nicer edges
      const mx = (edge.source.x + edge.target.x) / 2;
      const my = (edge.source.y + edge.target.y) / 2 - 20;
      ctx.quadraticCurveTo(mx, my, edge.target.x, edge.target.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Draw nodes
    const hover = hoverRef.current;
    for (const node of visibleNodes) {
      const isHover = hover?.id === node.id;
      const r = isHover ? NODE_RADIUS_HOVER / t.k : NODE_RADIUS / t.k;

      if (lod === 'dot') {
        // Minimal: just a colored dot
        ctx.fillStyle = node.color;
        ctx.fillRect(node.x - 1 / t.k, node.y - 1 / t.k, 2 / t.k, 2 / t.k);
      } else if (lod === 'circle' && !isHover) {
        // Circle only, no label
        ctx.fillStyle = node.color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Full detail: circle + label
        ctx.fillStyle = node.color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fill();

        if (node.type === 'session') {
          ctx.strokeStyle = isHover ? '#fff' : 'rgba(255,255,255,0.3)';
          ctx.lineWidth = (isHover ? 2 : 1) / t.k;
          ctx.stroke();
        }

        // Label (only when zoomed enough)
        if (t.k > 0.4 || isHover) {
          ctx.fillStyle = isHover ? '#fff' : '#e2e8f0';
          ctx.font = isHover ? FONT : FONT_SM;
          ctx.textAlign = 'center';
          ctx.fillText(node.label, node.x, node.y + r + 12 / t.k);
        }
      }
    }

    // Hover tooltip
    if (hover) {
      ctx.restore();
      // Draw tooltip in screen space
      const [sx, sy] = t.apply([hover.x, hover.y]);
      ctx.fillStyle = 'rgba(15,23,42,0.95)';
      ctx.strokeStyle = hover.color;
      ctx.lineWidth = 1;
      const label = hover.label;
      ctx.font = FONT;
      const tw = ctx.measureText(label).width + 16;
      const tx = Math.min(sx + 15, w - tw - 10);
      const ty = Math.max(sy - 30, 10);
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, 24, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(label, tx + 8, ty + 16);
    } else {
      ctx.restore();
    }

    // Stats overlay
    ctx.fillStyle = 'rgba(15,23,42,0.8)';
    ctx.fillRect(8, h - 28, 260, 22);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      `Canvas | ${layout.nodes.length} nodes | ${visibleNodes.length} visible | ${t.k.toFixed(1)}x`,
      14, h - 14,
    );

    dirtyRef.current = false;
  }, [dims, layout, spatialIndex]);

  // ── Animation loop ──
  useEffect(() => {
    const tick = () => {
      if (dirtyRef.current) draw();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  // ── D3 zoom ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.1, 10])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        dirtyRef.current = true;
      });

    d3.select(canvas).call(zoom);
    return () => { d3.select(canvas).on('.zoom', null); };
  }, []);

  // ── Mouse interaction ──
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const t = transformRef.current;
    // Convert screen coords to data coords
    const [dx, dy] = t.invert([e.clientX - rect.left, e.clientY - rect.top]);
    const nearest = spatialIndex.findNearest(dx, dy, 20 / t.k);
    if (nearest !== hoverRef.current) {
      hoverRef.current = nearest;
      setHoverNode(nearest);
      dirtyRef.current = true;
    }
  }, [spatialIndex]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const t = transformRef.current;
    const [dx, dy] = t.invert([e.clientX - rect.left, e.clientY - rect.top]);
    const nearest = spatialIndex.findNearest(dx, dy, 15 / t.k);
    if (nearest && nearest.type === 'session' && onSessionSelect) {
      onSessionSelect(nearest.id);
    }
  }, [spatialIndex, onSessionSelect]);

  if (!useCanvas) {
    return (
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <span style={{ color: '#94a3b8' }}>
          {data.sessions.length} sessions — using SVG renderer (below {CANVAS_THRESHOLD} threshold)
        </span>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', cursor: hoverNode ? 'pointer' : 'grab' }}
        onMouseMove={handleMouseMove}
        onClick={handleClick}
      />
    </div>
  );
}

/** Whether canvas rendering should be used for this data size. */
export function shouldUseCanvas(sessionCount: number): boolean {
  return sessionCount >= CANVAS_THRESHOLD;
}
