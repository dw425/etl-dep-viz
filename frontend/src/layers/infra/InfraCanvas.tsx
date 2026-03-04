/**
 * InfraCanvas — Canvas rendering for L1A Infrastructure Topology.
 * Draws environment zone backgrounds, system nodes as rounded-rect cards,
 * and directed/bidirectional edges with curved paths and arrowheads.
 */

import React, { useEffect, useRef } from 'react';
import type { SystemNode, SystemEdge } from './infraUtils';
import { ENV_COLORS, SYSTEM_ICONS } from './infraUtils';

/** A dashed-border zone rectangle grouping nodes by deployment environment. */
export interface ZoneRect {
  /** Environment key (e.g. "aws", "on-prem"). */
  env: string;
  /** Display label for the zone header (e.g. "AWS Cloud"). */
  label: string;
  /** Top-left x coordinate in canvas space. */
  x: number;
  /** Top-left y coordinate in canvas space. */
  y: number;
  /** Width of the zone rectangle. */
  w: number;
  /** Height of the zone rectangle. */
  h: number;
}

interface Props {
  nodes: SystemNode[];
  edges: SystemEdge[];
  nodePositions: Record<string, { x: number; y: number }>;
  zones: ZoneRect[];
  hoveredSystem: string | null;
  selectedSystem: SystemNode | null;
  onHover: (systemId: string | null) => void;
  onClick: (systemId: string | null) => void;
}

const NODE_W = 100;
const NODE_H = 56;

/** Draws a filled arrowhead at position (x, y) pointing in the given angle. */
function drawArrowhead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size * 0.45);
  ctx.lineTo(-size * 0.7, 0);
  ctx.lineTo(-size, size * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Traces a rounded-rectangle path without stroking or filling. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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

/** Get edge connection point on the rect boundary closest to the target. */
function edgePoint(cx: number, cy: number, tx: number, ty: number): { x: number; y: number } {
  const hw = NODE_W / 2 + 4;
  const hh = NODE_H / 2 + 4;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  // Determine which edge to intersect
  const scaleX = hw / (absDx || 1);
  const scaleY = hh / (absDy || 1);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * Canvas renderer for the infrastructure topology. Draws in three layers:
 * 1. Zone backgrounds (dashed environment borders with labels)
 * 2. Edges with curved quadratic Bezier paths and arrowheads
 * 3. Nodes as rounded-rect cards with icon, name, and stats
 *
 * Supports HiDPI rendering via devicePixelRatio scaling.
 */
export default function InfraCanvas({ nodes, edges, nodePositions, zones, hoveredSystem, selectedSystem, onHover, onClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // ── Draw zone backgrounds ──────────────────────────────────────────────
    for (const zone of zones) {
      const envColor = ENV_COLORS[zone.env] ?? ENV_COLORS.unknown;
      // Zone background
      roundRect(ctx, zone.x, zone.y, zone.w, zone.h, 8);
      ctx.fillStyle = envColor + '08';
      ctx.fill();
      // Zone border (dashed)
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = envColor + '30';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      // Zone label
      ctx.fillStyle = envColor + '80';
      ctx.font = 'bold 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(zone.label.toUpperCase(), zone.x + 10, zone.y + 16);
    }

    // ── Draw edges with curved paths ───────────────────────────────────────
    for (const edge of edges) {
      const from = nodePositions[edge.source];
      const to = nodePositions[edge.target];
      if (!from || !to) continue;

      const thickness = Math.min(Math.max(Math.log2(edge.session_count + 1), 1), 5);
      const isBidi = edge.direction === 'bidirectional';
      const color = isBidi ? '#F59E0B' : '#8899aa';

      // Edge connection points on rect boundaries
      const start = edgePoint(from.x, from.y, to.x, to.y);
      const end = edgePoint(to.x, to.y, from.x, from.y);

      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 5) continue;

      // Curve offset perpendicular to the line
      const curvature = Math.min(dist * 0.15, 30);
      const nx = -dy / dist;
      const ny = dx / dist;
      const cpx = (start.x + end.x) / 2 + nx * curvature;
      const cpy = (start.y + end.y) / 2 + ny * curvature;

      // Draw curved line
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.quadraticCurveTo(cpx, cpy, end.x, end.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = thickness;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Arrowhead at target
      const arrowAngle = Math.atan2(end.y - cpy, end.x - cpx);
      const arrowSize = Math.max(thickness * 1.8, 7);
      ctx.fillStyle = color;
      drawArrowhead(ctx, end.x, end.y, arrowAngle, arrowSize);

      // Bidirectional: arrowhead at source
      if (isBidi) {
        const revAngle = Math.atan2(start.y - cpy, start.x - cpx);
        drawArrowhead(ctx, start.x, start.y, revAngle, arrowSize);
      }

      // Edge label at midpoint of curve
      const labelX = (start.x + 2 * cpx + end.x) / 4;
      const labelY = (start.y + 2 * cpy + end.y) / 4;
      ctx.fillStyle = '#8899aa';
      ctx.font = '9px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${edge.session_count}`, labelX, labelY - 4);
    }

    // ── Draw nodes as rounded-rect cards ───────────────────────────────────
    for (const node of nodes) {
      const pos = nodePositions[node.system_id];
      if (!pos) continue;

      const isHovered = hoveredSystem === node.system_id;
      const isSelected = selectedSystem?.system_id === node.system_id;
      const envColor = ENV_COLORS[node.environment] ?? ENV_COLORS.unknown;

      const x = pos.x - NODE_W / 2;
      const y = pos.y - NODE_H / 2;

      // Shadow
      if (isHovered || isSelected) {
        ctx.shadowColor = envColor + '40';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2;
      }

      // Card background
      roundRect(ctx, x, y, NODE_W, NODE_H, 8);
      ctx.fillStyle = isSelected ? '#3a4a5e' : '#1a2332';
      ctx.fill();
      ctx.strokeStyle = isSelected ? envColor : (isHovered ? envColor + 'A0' : '#4a5a6e');
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      // Reset shadow
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // Icon + name
      const icon = SYSTEM_ICONS[node.system_type] ?? SYSTEM_ICONS.unknown;
      ctx.font = '14px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(icon, pos.x, pos.y - 6);

      ctx.fillStyle = '#E2E8F0';
      ctx.font = 'bold 10px Inter, system-ui, sans-serif';
      ctx.fillText(node.system_type.toUpperCase(), pos.x, pos.y + 8);

      // Stats line
      ctx.fillStyle = '#8899aa';
      ctx.font = '9px Inter, system-ui, sans-serif';
      ctx.fillText(`${node.session_count} sess \u00B7 ${node.table_count} tbl`, pos.x, pos.y + 20);
    }
  }, [nodes, edges, nodePositions, zones, hoveredSystem, selectedSystem]);

  const handleMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    for (const node of nodes) {
      const pos = nodePositions[node.system_id];
      if (!pos) continue;
      if (Math.abs(mx - pos.x) < NODE_W / 2 && Math.abs(my - pos.y) < NODE_H / 2) {
        onHover(node.system_id);
        canvas.style.cursor = 'pointer';
        return;
      }
    }
    onHover(null);
    canvas.style.cursor = 'default';
  };

  const handleClick = () => {
    onClick(hoveredSystem);
  };

  // Compute needed height from zone extents
  const canvasHeight = zones.length > 0
    ? Math.max(...zones.map(z => z.y + z.h)) + 24
    : 500;

  return (
    <canvas
      ref={canvasRef}
      className="w-full"
      style={{ height: canvasHeight, minHeight: 400 }}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      onMouseLeave={() => onHover(null)}
    />
  );
}
