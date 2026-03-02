/**
 * L1 Enterprise Constellation — top-level supernode overview.
 * Shows V1 macro-resolution supernodes as large orbs with force-directed layout.
 * Click supernode → drill to L2 (domain cluster).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigationContext } from '../navigation/NavigationProvider';
import { analyzeVectors } from '../api/client';
import type { Supernode, Superedge, VectorResults } from '../types/vectors';

const COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4',
  '#EC4899', '#84CC16', '#F97316', '#8B5CF6', '#14B8A6', '#FB923C',
];

const BUCKET_COLORS: Record<string, string> = {
  Simple: '#10B981',
  Medium: '#F59E0B',
  Complex: '#F97316',
  'Very Complex': '#EF4444',
};

/**
 * Top-level enterprise view showing V1 community supernodes as color-coded orbs.
 * Three-panel layout: group list (left), supernode canvas (center), environment summary (right).
 * Triggers vector analysis on mount if results are not yet available.
 * Click a supernode to drill down to L2 (domain cluster).
 */
export default function L1_EnterpriseConstellation() {
  const { tierData, vectorResults, setVectorResults, drillDown } = useNavigationContext();
  const [loading, setLoading] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Run vectors if not available
  useEffect(() => {
    if (tierData && !vectorResults) {
      setLoading(true);
      analyzeVectors(tierData, 1)
        .then(r => setVectorResults(r))
        .catch(err => console.error('Vector analysis failed:', err))
        .finally(() => setLoading(false));
    }
  }, [tierData, vectorResults, setVectorResults]);

  const supernodes = vectorResults?.v1_communities?.supernode_graph?.supernodes ?? [];
  const superedges = vectorResults?.v1_communities?.supernode_graph?.superedges ?? [];
  const v11 = vectorResults?.v11_complexity;
  const v4 = vectorResults?.v4_wave_plan;

  const handleNodeClick = useCallback((node: Supernode) => {
    drillDown(2, {
      groupId: node.id,
      groupLabel: `Group ${node.id.replace('community_', '')} (${node.session_count} sessions)`,
      sessionCount: String(node.session_count),
    });
  }, [drillDown]);

  if (!tierData) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Upload files to begin analysis
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Running vector analysis...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[600px]">
      {/* Left Panel — Group List */}
      <div className="w-72 border-r border-gray-700/50 overflow-y-auto bg-gray-900/50">
        <div className="p-3 border-b border-gray-700/50">
          <h3 className="text-sm font-medium text-gray-300">Gravity Groups</h3>
          <p className="text-xs text-gray-500 mt-1">{supernodes.length} communities detected</p>
        </div>
        {supernodes.map((node, i) => (
          <button
            key={node.id}
            onClick={() => handleNodeClick(node)}
            onMouseEnter={() => setHoveredNode(node.id)}
            onMouseLeave={() => setHoveredNode(null)}
            className={`w-full px-3 py-2.5 text-left border-b border-gray-800 hover:bg-gray-800 transition-colors ${
              hoveredNode === node.id ? 'bg-gray-800' : ''
            }`}
          >
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: COLORS[i % COLORS.length] }}
              />
              <span className="text-sm text-gray-200 truncate">
                Group {node.id.replace('community_', '')}
              </span>
              <span className="ml-auto text-xs text-gray-500">{node.session_count}</span>
            </div>
            {node.avg_complexity !== undefined && (
              <div className="mt-1 flex items-center gap-1">
                <div className="flex-1 h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${node.avg_complexity}%`,
                      backgroundColor: node.avg_complexity > 75 ? '#EF4444'
                        : node.avg_complexity > 50 ? '#F97316'
                        : node.avg_complexity > 25 ? '#F59E0B' : '#10B981',
                    }}
                  />
                </div>
                <span className="text-[10px] text-gray-500">{Math.round(node.avg_complexity)}</span>
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Center — Supernode Visualization */}
      <div className="flex-1 relative">
        <SupernodeCanvas
          supernodes={supernodes}
          superedges={superedges}
          hoveredNode={hoveredNode}
          onNodeClick={handleNodeClick}
          onNodeHover={setHoveredNode}
        />
      </div>

      {/* Right Panel — Environment Summary */}
      <div className="w-72 border-l border-gray-700/50 overflow-y-auto bg-gray-900/50 p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Environment Summary</h3>

        <div className="space-y-3">
          <SummaryStat label="Total Sessions" value={tierData.sessions.length} />
          <SummaryStat label="Communities" value={supernodes.length} />
          <SummaryStat label="Waves" value={v4?.waves?.length ?? '—'} />
          <SummaryStat label="Cyclic Sessions" value={v4?.cyclic_session_count ?? 0} />
          <SummaryStat
            label="Hours Estimate"
            value={v11 ? `${Math.round(v11.total_hours_low)}–${Math.round(v11.total_hours_high)}` : '—'}
          />

          {v11 && (
            <div className="mt-4">
              <div className="text-xs text-gray-500 mb-2">Complexity Distribution</div>
              {Object.entries(v11.bucket_distribution).map(([bucket, count]) => (
                <div key={bucket} className="flex items-center gap-2 mb-1">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: BUCKET_COLORS[bucket] || '#6B7280' }} />
                  <span className="text-xs text-gray-400 flex-1">{bucket}</span>
                  <span className="text-xs text-gray-300 font-medium">{count}</span>
                </div>
              ))}
            </div>
          )}

          {vectorResults?.timings && (
            <div className="mt-4 pt-3 border-t border-gray-700/50">
              <div className="text-xs text-gray-500 mb-1">Analysis Timings</div>
              {Object.entries(vectorResults.timings).map(([k, v]) => (
                <div key={k} className="flex justify-between text-[10px] text-gray-500">
                  <span>{k.replace(/_/g, ' ')}</span>
                  <span>{v}s</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Label-value pair used in the right-hand environment summary panel. */
function SummaryStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-sm text-gray-200 font-medium">{value}</span>
    </div>
  );
}

/** Simple canvas-based supernode visualization */
function SupernodeCanvas({
  supernodes,
  superedges,
  hoveredNode,
  onNodeClick,
  onNodeHover,
}: {
  supernodes: Supernode[];
  superedges: Superedge[];
  hoveredNode: string | null;
  onNodeClick: (n: Supernode) => void;
  onNodeHover: (id: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Circular layout: supernodes positioned evenly around a circle,
  // with radius proportional to session_count.
  const nodePositions = useMemo(() => {
    const positions: Record<string, { x: number; y: number; r: number }> = {};
    const n = supernodes.length;
    if (n === 0) return positions;

    const cx = 400, cy = 300;
    const layoutR = Math.min(250, 100 + n * 15);
    const maxCount = Math.max(...supernodes.map(s => s.session_count), 1);

    supernodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      const r = 15 + (node.session_count / maxCount) * 40;
      positions[node.id] = {
        x: cx + layoutR * Math.cos(angle),
        y: cy + layoutR * Math.sin(angle),
        r,
      };
    });
    return positions;
  }, [supernodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width = canvas.offsetWidth * 2;
    const h = canvas.height = canvas.offsetHeight * 2;
    ctx.scale(2, 2);
    const cw = canvas.offsetWidth;
    const ch = canvas.offsetHeight;
    const sx = cw / 800;
    const sy = ch / 600;

    ctx.clearRect(0, 0, cw, ch);

    // Draw edges
    for (const edge of superedges) {
      const from = nodePositions[edge.from];
      const to = nodePositions[edge.to];
      if (!from || !to) continue;

      ctx.beginPath();
      ctx.moveTo(from.x * sx, from.y * sy);
      ctx.lineTo(to.x * sx, to.y * sy);
      ctx.strokeStyle = `rgba(100, 116, 139, ${Math.min(edge.weight * 2, 0.5)})`;
      ctx.lineWidth = Math.max(1, edge.weight * 3);
      ctx.stroke();
    }

    // Draw nodes
    supernodes.forEach((node, i) => {
      const pos = nodePositions[node.id];
      if (!pos) return;
      const x = pos.x * sx;
      const y = pos.y * sy;
      const r = pos.r * Math.min(sx, sy);
      const color = COLORS[i % COLORS.length];
      const isHovered = hoveredNode === node.id;

      // Glow
      if (isHovered) {
        const gradient = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2);
        gradient.addColorStop(0, color + '40');
        gradient.addColorStop(1, 'transparent');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, r * 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHovered ? color : color + '80';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = isHovered ? 2 : 1;
      ctx.stroke();

      // Label
      ctx.fillStyle = '#e2e8f0';
      ctx.font = `${Math.max(10, r * 0.5)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(node.session_count), x, y);
    });
  }, [supernodes, superedges, nodePositions, hoveredNode]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const sx = canvas.offsetWidth / 800;
    const sy = canvas.offsetHeight / 600;

    for (const node of supernodes) {
      const pos = nodePositions[node.id];
      if (!pos) continue;
      const x = pos.x * sx;
      const y = pos.y * sy;
      const r = pos.r * Math.min(sx, sy);
      const dist = Math.sqrt((mx - x) ** 2 + (my - y) ** 2);
      if (dist <= r) {
        onNodeClick(node);
        return;
      }
    }
  }, [supernodes, nodePositions, onNodeClick]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const sx = canvas.offsetWidth / 800;
    const sy = canvas.offsetHeight / 600;

    for (const node of supernodes) {
      const pos = nodePositions[node.id];
      if (!pos) continue;
      const x = pos.x * sx;
      const y = pos.y * sy;
      const r = pos.r * Math.min(sx, sy);
      if (Math.sqrt((mx - x) ** 2 + (my - y) ** 2) <= r) {
        onNodeHover(node.id);
        canvas.style.cursor = 'pointer';
        return;
      }
    }
    onNodeHover(null);
    canvas.style.cursor = 'default';
  }, [supernodes, nodePositions, onNodeHover]);

  return (
    <div ref={containerRef} className="w-full h-full min-h-[500px]">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => onNodeHover(null)}
      />
    </div>
  );
}
