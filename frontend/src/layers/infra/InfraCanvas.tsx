/**
 * InfraCanvas — Canvas rendering + hit-testing for L1A Infrastructure Topology.
 * Draws system nodes as circles and directed/bidirectional edges with arrowheads.
 */

import React, { useEffect, useRef } from 'react';
import type { SystemNode, SystemEdge } from './infraUtils';
import { ENV_COLORS, SYSTEM_ICONS } from './infraUtils';

interface Props {
  nodes: SystemNode[];
  edges: SystemEdge[];
  nodePositions: Record<string, { x: number; y: number }>;
  hoveredSystem: string | null;
  selectedSystem: SystemNode | null;
  onHover: (systemId: string | null) => void;
  onClick: (systemId: string | null) => void;
}

function nodeRadius(n: SystemNode): number {
  return Math.min(Math.max(n.session_count * 2 + 15, 20), 50);
}

function drawArrowhead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size * 0.5);
  ctx.lineTo(-size, size * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export default function InfraCanvas({ nodes, edges, nodePositions, hoveredSystem, selectedSystem, onHover, onClick }: Props) {
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

    // Draw edges with directional arrowheads
    for (const edge of edges) {
      const from = nodePositions[edge.source];
      const to = nodePositions[edge.target];
      if (!from || !to) continue;

      const sourceNode = nodes.find(n => n.system_id === edge.source);
      const targetNode = nodes.find(n => n.system_id === edge.target);
      if (!sourceNode || !targetNode) continue;

      const thickness = Math.min(Math.max(edge.session_count / 5, 1), 6);
      const isBidi = edge.direction === 'bidirectional';
      const color = isBidi ? '#F59E0B' : '#475569';

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist === 0) continue;

      const ux = dx / dist;
      const uy = dy / dist;
      const angle = Math.atan2(dy, dx);

      const rFrom = nodeRadius(sourceNode);
      const rTo = nodeRadius(targetNode);
      const startX = from.x + ux * (rFrom + 4);
      const startY = from.y + uy * (rFrom + 4);
      const endX = to.x - ux * (rTo + 4);
      const endY = to.y - uy * (rTo + 4);

      // Line
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = color;
      ctx.lineWidth = thickness;
      ctx.stroke();

      // Arrowhead at target
      const arrowSize = Math.max(thickness * 2, 8);
      ctx.fillStyle = color;
      drawArrowhead(ctx, endX, endY, angle, arrowSize);

      // Bidirectional: arrowhead at source too
      if (isBidi) {
        drawArrowhead(ctx, startX, startY, angle + Math.PI, arrowSize);
      }

      // Edge label
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      ctx.fillStyle = '#94A3B8';
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${edge.session_count}`, midX, midY - 6);
    }

    // Draw nodes
    for (const node of nodes) {
      const pos = nodePositions[node.system_id];
      if (!pos) continue;

      const r = nodeRadius(node);
      const isHovered = hoveredSystem === node.system_id;
      const isSelected = selectedSystem?.system_id === node.system_id;
      const envColor = ENV_COLORS[node.environment] ?? ENV_COLORS.unknown;

      // Glow for hover/selection
      if (isHovered || isSelected) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 8, 0, Math.PI * 2);
        ctx.fillStyle = envColor + '25';
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? envColor + '40' : '#1E293B';
      ctx.fill();
      ctx.strokeStyle = envColor;
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.stroke();

      // Label
      ctx.fillStyle = '#E2E8F0';
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.system_type.toUpperCase(), pos.x, pos.y + 4);

      // Session count below
      ctx.fillStyle = '#94A3B8';
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.fillText(`${node.session_count} sess`, pos.x, pos.y + r + 14);
    }
  }, [nodes, edges, nodePositions, hoveredSystem, selectedSystem]);

  const handleMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    for (const node of nodes) {
      const pos = nodePositions[node.system_id];
      if (!pos) continue;
      const r = nodeRadius(node);
      if (Math.sqrt((mx - pos.x) ** 2 + (my - pos.y) ** 2) < r) {
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

  return (
    <canvas
      ref={canvasRef}
      className="w-full"
      style={{ height: 500 }}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      onMouseLeave={() => onHover(null)}
    />
  );
}
