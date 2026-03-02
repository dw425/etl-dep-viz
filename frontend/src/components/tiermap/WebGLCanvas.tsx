/**
 * WebGL Canvas — high-performance Canvas 2D renderer for >500 node graphs.
 *
 * Uses a virtual canvas layout sized by data density (not viewport), with
 * initial zoom-to-fit so the full tier diagram is visible. Sessions only —
 * tables are excluded to reduce clutter at scale. Tier band backgrounds
 * give visual structure at all zoom levels.
 *
 * Supports zoom/pan via D3 zoom, quadtree spatial indexing for hit detection
 * and viewport culling, and progressive LOD (dot → circle → full label).
 */

import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { SpatialIndex, type SpatialNode, type ViewportBounds } from '../../utils/spatialIndex';
import type { TierMapResult, TierSession, TierTable } from '../../types/tiermap';

// ── Constants ────────────────────────────────────────────────────────────────

const CANVAS_THRESHOLD = 500;
const NODE_RADIUS = 5;
const NODE_RADIUS_HOVER = 9;
const FONT = '11px "JetBrains Mono", monospace';
const FONT_SM = '9px "JetBrains Mono", monospace';

// Layout: minimum spacing so nodes don't overlap
const MIN_SPACING_X = 18;       // px between nodes horizontally
const MIN_BAND_HEIGHT = 50;     // px per tier band (minimum)
const LAYOUT_PADDING = 40;

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
  tierIndex: number;
  color: string;
  data: TierSession | TierTable;
}

interface LayoutEdge {
  source: LayoutNode;
  target: LayoutNode;
  type: string;
  color: string;
}

interface TierBand {
  tier: number;
  y: number;
  height: number;
  count: number;
  color: string;
  label: string;
}

interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  nodeMap: Map<string, LayoutNode>;
  virtualW: number;
  virtualH: number;
  tierBands: TierBand[];
}

/**
 * Build a tier-banded layout from the tier map result. Groups sessions by
 * integer tier, assigns x positions within each band, and creates only
 * session-to-session edges (table endpoints are skipped to reduce noise).
 * The virtual canvas is sized to fit all nodes without overlap.
 */
function buildLayout(data: TierMapResult, viewportW: number, viewportH: number): LayoutResult {
  const nodeMap = new Map<string, LayoutNode>();

  // Group sessions by tier
  const sessionsByTier = new Map<number, TierSession[]>();
  for (const s of data.sessions) {
    const tier = Math.floor(s.tier);
    if (!sessionsByTier.has(tier)) sessionsByTier.set(tier, []);
    sessionsByTier.get(tier)!.push(s);
  }

  const tiers = [...sessionsByTier.keys()].sort((a, b) => a - b);
  const maxInTier = Math.max(...tiers.map(t => sessionsByTier.get(t)!.length), 1);

  // Virtual canvas dimensions — sized by data, not viewport
  const virtualW = Math.max(viewportW, maxInTier * MIN_SPACING_X + LAYOUT_PADDING * 2);
  const virtualH = Math.max(viewportH, tiers.length * MIN_BAND_HEIGHT + LAYOUT_PADDING * 2);
  const usableW = virtualW - LAYOUT_PADDING * 2;
  const usableH = virtualH - LAYOUT_PADDING * 2;
  const bandHeight = usableH / Math.max(tiers.length, 1);

  const tierBands: TierBand[] = [];

  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    const sessions = sessionsByTier.get(tier)!;
    const bandY = LAYOUT_PADDING + ti * bandHeight;
    const centerY = bandY + bandHeight / 2;
    const color = TIER_COLORS[Math.max(0, tier - 1) % TIER_COLORS.length];

    tierBands.push({
      tier,
      y: bandY,
      height: bandHeight,
      count: sessions.length,
      color,
      label: `Tier ${tier}`,
    });

    const step = usableW / Math.max(sessions.length + 1, 2);
    for (let si = 0; si < sessions.length; si++) {
      const s = sessions[si];
      nodeMap.set(s.id, {
        id: s.id,
        x: LAYOUT_PADDING + (si + 1) * step,
        y: centerY,
        type: 'session',
        label: s.name,
        tier: s.tier,
        tierIndex: ti,
        color,
        data: s,
      });
    }
  }

  // Only include session-to-session edges (skip table endpoints = noise)
  const edges: LayoutEdge[] = [];
  for (const conn of data.connections) {
    const source = nodeMap.get(conn.from);
    const target = nodeMap.get(conn.to);
    if (source && target) {
      edges.push({ source, target, type: conn.type, color: CONN_COLORS[conn.type] || '#64748b' });
    }
  }

  return { nodes: [...nodeMap.values()], edges, nodeMap, virtualW, virtualH, tierBands };
}

/** Compute initial zoom transform to fit virtual canvas in viewport. */
function fitTransform(virtualW: number, virtualH: number, viewW: number, viewH: number): d3.ZoomTransform {
  const scaleX = viewW / virtualW;
  const scaleY = viewH / virtualH;
  const scale = Math.min(scaleX, scaleY, 1) * 0.95; // 5% margin
  const tx = (viewW - virtualW * scale) / 2;
  const ty = (viewH - virtualH * scale) / 2;
  return d3.zoomIdentity.translate(tx, ty).scale(scale);
}

/** LOD based on zoom scale, visible node count, and total node count. */
function getLOD(zoomScale: number, totalNodes: number): 'dot' | 'circle' | 'full' {
  if (totalNodes > 5000 && zoomScale < 0.3) return 'dot';
  if (totalNodes > 2000 && zoomScale < 0.15) return 'dot';
  if (totalNodes > 1000 && zoomScale < 0.8) return 'circle';
  if (totalNodes > 500 && zoomScale < 0.5) return 'circle';
  return 'full';
}

// ── Props ────────────────────────────────────────────────────────────────────

interface WebGLCanvasProps {
  data: TierMapResult;
  onSessionSelect?: (sessionId: string) => void;
  width?: number;
  height?: number;
  hiddenTiers?: Set<number>;
  onHiddenTiersChange?: (tiers: Set<number>) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * WebGLCanvas -- high-performance Canvas 2D renderer for graphs with 500+
 * sessions. Uses a virtual canvas sized by data density (not viewport), with
 * initial zoom-to-fit so the full diagram is visible. Sessions only -- tables
 * are excluded to reduce clutter. Tier band backgrounds provide structure at
 * all zoom levels.
 *
 * Rendering features:
 *   - D3 zoom/pan with zoom extent [0.01, 20]
 *   - Quadtree spatial indexing for viewport culling and hover hit detection
 *   - Progressive LOD: dot (far zoom) -> circle (mid) -> full label (close)
 *   - HiDPI (Retina) support via devicePixelRatio scaling
 *   - requestAnimationFrame loop with dirty flag (only redraws when needed)
 *   - Edge rendering with quadratic Bezier curves, capped at maxEdges per LOD
 *
 * Sidebar: tier filter checkboxes, hovered node detail, top-connections density
 * bar, and connection type color legend.
 */
export default function WebGLCanvas({
  data,
  onSessionSelect,
  width: propWidth,
  height: propHeight,
  hiddenTiers: externalHiddenTiers,
  onHiddenTiersChange,
}: WebGLCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const hoverRef = useRef<LayoutNode | null>(null);
  const dirtyRef = useRef(true);
  const rafRef = useRef<number>(0);
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const initialFitDone = useRef(false);
  const [dims, setDims] = useState({ w: propWidth || 1200, h: propHeight || 800 });
  const [hoverNode, setHoverNode] = useState<LayoutNode | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [internalHiddenTiers, setInternalHiddenTiers] = useState<Set<number>>(new Set());
  const hiddenTiers = externalHiddenTiers ?? internalHiddenTiers;
  const setHiddenTiers = onHiddenTiersChange ?? setInternalHiddenTiers;

  // Filter data by hidden tiers
  const filteredData = useMemo(() => {
    if (hiddenTiers.size === 0) return data;
    const sessions = data.sessions.filter(s => !hiddenTiers.has(Math.floor(s.tier)));
    const sessionIds = new Set(sessions.map(s => s.id));
    const connections = data.connections.filter(c => sessionIds.has(c.from) || sessionIds.has(c.to));
    const tables = data.tables.filter(t => !hiddenTiers.has(Math.floor(t.tier)));
    return { ...data, sessions, tables, connections };
  }, [data, hiddenTiers]);

  // Tier stats for sidebar
  const tierStats = useMemo(() => {
    const stats: Record<number, { count: number; color: string }> = {};
    for (const s of data.sessions) {
      const tier = Math.floor(s.tier);
      if (!stats[tier]) stats[tier] = { count: 0, color: TIER_COLORS[(tier - 1) % TIER_COLORS.length] };
      stats[tier].count++;
    }
    return Object.entries(stats)
      .map(([t, s]) => ({ tier: Number(t), ...s }))
      .sort((a, b) => a.tier - b.tier);
  }, [data.sessions]);

  // Top density nodes
  const topNodes = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of data.connections) {
      counts[c.from] = (counts[c.from] || 0) + 1;
      counts[c.to] = (counts[c.to] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([id, count]) => {
        const s = data.sessions.find(s => s.id === id);
        return { id, name: s?.name || id, count, max: Object.values(counts).reduce((a, b) => Math.max(a, b), 1) };
      });
  }, [data]);

  // Build layout (virtual canvas sized by data density)
  const layout = useMemo(
    () => buildLayout(filteredData, dims.w, dims.h),
    [filteredData, dims.w, dims.h],
  );

  // Build spatial index
  const spatialIndex = useMemo(
    () => new SpatialIndex(layout.nodes),
    [layout.nodes],
  );

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

  // ── Initial zoom-to-fit ──
  useEffect(() => {
    if (initialFitDone.current) return;
    const canvas = canvasRef.current;
    if (!canvas || !zoomRef.current) return;
    if (layout.virtualW <= 0 || layout.virtualH <= 0) return;

    const t = fitTransform(layout.virtualW, layout.virtualH, dims.w, dims.h);
    transformRef.current = t;
    d3.select(canvas).call(zoomRef.current.transform, t);
    dirtyRef.current = true;
    initialFitDone.current = true;
  }, [layout, dims]);

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

    // Draw tier band backgrounds
    for (let i = 0; i < layout.tierBands.length; i++) {
      const band = layout.tierBands[i];
      // Alternating band backgrounds
      ctx.fillStyle = i % 2 === 0 ? 'rgba(30,41,59,0.35)' : 'rgba(15,23,42,0.2)';
      ctx.fillRect(0, band.y, layout.virtualW, band.height);

      // Tier label on left edge
      const labelSize = Math.max(10, Math.min(14, band.height * 0.25));
      ctx.fillStyle = band.color;
      ctx.globalAlpha = 0.7;
      ctx.font = `bold ${labelSize}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'left';
      ctx.fillText(`T${band.tier}`, 4, band.y + band.height / 2 + labelSize * 0.35);
      // Count on right
      ctx.textAlign = 'right';
      ctx.fillStyle = '#64748b';
      ctx.font = `${Math.max(8, labelSize - 2)}px monospace`;
      ctx.fillText(`${band.count}`, layout.virtualW - 4, band.y + band.height / 2 + labelSize * 0.35);
      ctx.globalAlpha = 1;

      // Thin separator line
      ctx.strokeStyle = 'rgba(100,116,139,0.15)';
      ctx.lineWidth = 1 / t.k;
      ctx.beginPath();
      ctx.moveTo(0, band.y + band.height);
      ctx.lineTo(layout.virtualW, band.y + band.height);
      ctx.stroke();
    }

    // Viewport culling bounds
    const bounds = SpatialIndex.viewportFromTransform(t, w, h, 50);
    const visibleNodes = spatialIndex.queryViewport(bounds);
    const visibleIds = new Set(visibleNodes.map(n => n.id));

    const lod = getLOD(t.k, layout.nodes.length);

    // Draw edges — only when zoomed enough and limit count
    const showEdges = t.k > 0.05 && layout.edges.length < 50000;
    if (showEdges) {
      const edgeAlpha = Math.min(0.4, t.k * 0.8);
      ctx.globalAlpha = edgeAlpha;
      ctx.lineWidth = Math.max(0.5, 1 / t.k);
      let edgesDrawn = 0;
      const maxEdges = t.k < 0.2 ? 2000 : t.k < 0.5 ? 8000 : 50000;
      for (const edge of layout.edges) {
        if (edgesDrawn >= maxEdges) break;
        if (!visibleIds.has(edge.source.id) && !visibleIds.has(edge.target.id)) continue;
        ctx.strokeStyle = edge.color;
        ctx.beginPath();
        ctx.moveTo(edge.source.x, edge.source.y);
        const mx = (edge.source.x + edge.target.x) / 2;
        const my = (edge.source.y + edge.target.y) / 2 - 15 / t.k;
        ctx.quadraticCurveTo(mx, my, edge.target.x, edge.target.y);
        ctx.stroke();
        edgesDrawn++;
      }
      ctx.globalAlpha = 1;
    }

    // Draw nodes
    const hover = hoverRef.current;
    for (const node of visibleNodes) {
      const isHover = hover?.id === node.id;
      const r = isHover ? NODE_RADIUS_HOVER : NODE_RADIUS;

      if (lod === 'dot') {
        ctx.fillStyle = node.color;
        const dotSize = Math.max(1.5, 3 / t.k);
        ctx.fillRect(node.x - dotSize / 2, node.y - dotSize / 2, dotSize, dotSize);
      } else if (lod === 'circle' && !isHover) {
        ctx.fillStyle = node.color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Full detail
        ctx.fillStyle = node.color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = isHover ? '#fff' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = isHover ? 2 : 0.5;
        ctx.stroke();

        // Label
        if (t.k > 0.3 || isHover) {
          ctx.fillStyle = isHover ? '#fff' : '#e2e8f0';
          ctx.font = isHover ? FONT : FONT_SM;
          ctx.textAlign = 'center';
          ctx.fillText(node.label, node.x, node.y + r + 14);
        }
      }
    }

    // Hover tooltip (screen space)
    if (hover) {
      ctx.restore();
      const [sx, sy] = t.apply([hover.x, hover.y]);
      ctx.fillStyle = 'rgba(15,23,42,0.95)';
      ctx.strokeStyle = hover.color;
      ctx.lineWidth = 1;
      const label = `${hover.label}  (Tier ${Math.floor(hover.tier)})`;
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
    ctx.fillRect(8, h - 28, 360, 22);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${layout.nodes.length} sessions | ${visibleNodes.length} visible | ${t.k.toFixed(2)}x | ${layout.tierBands.length} tiers | Scroll to zoom, drag to pan`,
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
      .scaleExtent([0.01, 20])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        dirtyRef.current = true;
      });

    zoomRef.current = zoom;
    d3.select(canvas).call(zoom);

    // Apply initial fit if layout is ready
    if (layout.virtualW > 0 && layout.virtualH > 0 && !initialFitDone.current) {
      const t = fitTransform(layout.virtualW, layout.virtualH, dims.w, dims.h);
      transformRef.current = t;
      d3.select(canvas).call(zoom.transform, t);
      dirtyRef.current = true;
      initialFitDone.current = true;
    }

    return () => { d3.select(canvas).on('.zoom', null); };
  }, [layout, dims]);

  // ── Mouse interaction ──
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const t = transformRef.current;
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
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', cursor: hoverNode ? 'pointer' : 'grab' }}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
        />
      </div>
      {showSidebar && (
        <div style={{
          width: 260, borderLeft: '1px solid #1e293b', background: '#111827',
          overflow: 'auto', flexShrink: 0, padding: 12, fontSize: 11,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 700, color: '#e2e8f0', fontSize: 12 }}>Tier Filter</span>
            <button onClick={() => setShowSidebar(false)} style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14 }}>x</button>
          </div>
          {tierStats.map(ts => (
            <label key={ts.tier} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!hiddenTiers.has(ts.tier)}
                onChange={() => {
                  const next = new Set(hiddenTiers);
                  if (next.has(ts.tier)) next.delete(ts.tier);
                  else next.add(ts.tier);
                  setHiddenTiers(next);
                }}
                style={{ accentColor: ts.color }}
              />
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: ts.color, flexShrink: 0 }} />
              <span style={{ color: '#e2e8f0', flex: 1 }}>Tier {ts.tier}</span>
              <span style={{ color: '#64748b' }}>{ts.count}</span>
            </label>
          ))}

          {/* Selected node detail */}
          {hoverNode && (
            <div style={{ marginTop: 16, padding: 10, borderRadius: 6, background: '#0f172a', border: '1px solid #1e293b' }}>
              <div style={{ fontWeight: 600, color: '#e2e8f0', marginBottom: 4 }}>{hoverNode.label}</div>
              <div style={{ color: '#64748b' }}>Type: {hoverNode.type}</div>
              <div style={{ color: '#64748b' }}>Tier: {hoverNode.tier}</div>
              {(hoverNode.data as TierSession).transforms !== undefined && (
                <div style={{ color: '#64748b' }}>Transforms: {(hoverNode.data as TierSession).transforms}</div>
              )}
              {(hoverNode.data as TierSession).critical && (
                <div style={{ color: '#EF4444' }}>Critical</div>
              )}
            </div>
          )}

          {/* Connection density */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Top Connections</div>
            {topNodes.map(n => (
              <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}>{n.name}</span>
                <div style={{ width: 60, height: 4, borderRadius: 2, background: '#1e293b', overflow: 'hidden' }}>
                  <div style={{ width: `${(n.count / n.max) * 100}%`, height: '100%', background: '#3b82f6', borderRadius: 2 }} />
                </div>
                <span style={{ color: '#64748b', fontSize: 9, minWidth: 20, textAlign: 'right' }}>{n.count}</span>
              </div>
            ))}
          </div>

          {/* Legend */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Connection Types</div>
            {Object.entries(CONN_COLORS).map(([type, color]) => (
              <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />
                <span style={{ color: '#94a3b8', fontSize: 10 }}>{type.replace(/_/g, ' ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!showSidebar && (
        <button
          onClick={() => setShowSidebar(true)}
          style={{
            position: 'absolute', right: 8, top: 8, padding: '4px 8px', borderRadius: 4,
            background: '#111827', border: '1px solid #1e293b', color: '#64748b',
            fontSize: 10, cursor: 'pointer',
          }}
        >
          Filter
        </button>
      )}
    </div>
  );
}

/** Whether canvas rendering should be used for this data size. */
export function shouldUseCanvas(sessionCount: number): boolean {
  return sessionCount >= CANVAS_THRESHOLD;
}
