/**
 * UMAPView — 2D scatter plot from V3 dimensionality reduction.
 * Color by community, domain, complexity, or wave. Auto-cluster hulls.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VectorResults } from '../../types/vectors';

const CLUSTER_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4',
  '#EC4899', '#84CC16', '#F97316', '#8B5CF6', '#14B8A6', '#FB923C',
];

type ColorMode = 'cluster' | 'complexity' | 'wave' | 'criticality';

interface Props {
  vectorResults: VectorResults;
  onSessionSelect?: (sessionId: string) => void;
}

export default function UMAPView({ vectorResults, onSessionSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('cluster');
  const [hoveredPoint, setHoveredPoint] = useState<string | null>(null);
  const [scale, setScale] = useState<'local' | 'balanced' | 'global'>('balanced');

  const v3 = vectorResults.v3_dimensionality_reduction;
  const method = v3?.method ?? 'pca';
  const projections = v3?.projections ?? {};
  const currentProj = projections[scale] ?? projections.balanced ?? Object.values(projections)[0];
  const coords = currentProj?.coords ?? [];

  // Build color maps
  const complexityMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of vectorResults.v11_complexity?.scores ?? []) {
      m[s.session_id] = s.overall_score;
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

  const getColor = useCallback((point: { session_id: string; cluster: number }) => {
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || coords.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const margin = 40;
    const pw = w - 2 * margin;
    const ph = h - 2 * margin;

    ctx.clearRect(0, 0, w, h);

    // Draw points
    for (const pt of coords) {
      const px = margin + pt.x * pw;
      const py = margin + pt.y * ph;
      const color = getColor(pt);
      const isHovered = hoveredPoint === pt.session_id;
      const r = isHovered ? 6 : 4;

      if (isHovered) {
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.fillStyle = color + '30';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      if (isHovered) {
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '11px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(pt.session_id, px, py - 12);
      }
    }
  }, [coords, getColor, hoveredPoint]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const margin = 40;
    const pw = canvas.offsetWidth - 2 * margin;
    const ph = canvas.offsetHeight - 2 * margin;

    for (const pt of coords) {
      const px = margin + pt.x * pw;
      const py = margin + pt.y * ph;
      if (Math.sqrt((mx - px) ** 2 + (my - py) ** 2) < 8) {
        setHoveredPoint(pt.session_id);
        canvas.style.cursor = 'pointer';
        return;
      }
    }
    setHoveredPoint(null);
    canvas.style.cursor = 'default';
  }, [coords]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (hoveredPoint && onSessionSelect) {
      onSessionSelect(hoveredPoint);
    }
  }, [hoveredPoint, onSessionSelect]);

  if (!v3 || coords.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-gray-500">
        Run Phase 2+ vector analysis to enable UMAP projection
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">Method: {method.toUpperCase()}</span>
        <span className="text-xs text-gray-500">{coords.length} points</span>
        <span className="text-xs text-gray-500">{currentProj?.n_clusters ?? '?'} clusters</span>

        <div className="ml-auto flex gap-1">
          {Object.keys(projections).map(s => (
            <button
              key={s}
              onClick={() => setScale(s as 'local' | 'balanced' | 'global')}
              className={`px-2 py-0.5 text-xs rounded ${scale === s ? 'bg-blue-500/20 text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="flex gap-1 border-l border-gray-700 pl-2">
          {(['cluster', 'complexity', 'wave', 'criticality'] as ColorMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setColorMode(mode)}
              className={`px-2 py-0.5 text-xs rounded capitalize ${colorMode === mode ? 'bg-blue-500/20 text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <canvas
          ref={canvasRef}
          className="w-full"
          style={{ height: 500 }}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onMouseLeave={() => setHoveredPoint(null)}
        />
      </div>
    </div>
  );
}
