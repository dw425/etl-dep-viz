/**
 * HeatMapView — Canvas grid: X=tier, Y=complexity bucket, cell color=session count intensity.
 * Data sourced from V11 complexity scores (vw_complexity_scores table).
 */

import { useMemo, useRef, useEffect } from 'react';

interface ComplexityScore {
  session_id: string;
  name?: string;
  tier?: number;
  overall_score?: number;
  bucket?: string;
}

interface Props {
  complexity: {
    scores?: ComplexityScore[];
    sessions?: ComplexityScore[];
  };
}

const BUCKETS = ['low', 'medium', 'high', 'critical'] as const;
const BUCKET_COLORS = {
  low: [52, 211, 153],      // emerald
  medium: [251, 191, 36],   // amber
  high: [249, 115, 22],     // orange
  critical: [239, 68, 68],  // red
} as const;

export default function HeatMapView({ complexity }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scores = complexity?.scores || complexity?.sessions || [];

  // Build grid data: tier x bucket → count
  const { grid, tiers, maxCount } = useMemo(() => {
    const g: Record<string, Record<string, number>> = {};
    const tierSet = new Set<number>();
    let max = 0;

    for (const s of scores) {
      const tier = Math.round(s.tier ?? 1);
      const bucket = (s.bucket || 'low').toLowerCase();
      tierSet.add(tier);
      if (!g[tier]) g[tier] = {};
      g[tier][bucket] = (g[tier][bucket] || 0) + 1;
      max = Math.max(max, g[tier][bucket]);
    }

    return { grid: g, tiers: Array.from(tierSet).sort((a, b) => a - b), maxCount: max };
  }, [scores]);

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tiers.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cellW = 80;
    const cellH = 60;
    const labelW = 80;
    const labelH = 30;
    const w = labelW + tiers.length * cellW;
    const h = labelH + BUCKETS.length * cellH;

    canvas.width = w * 2; // retina
    canvas.height = h * 2;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(2, 2);

    // Background
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, w, h);

    // Column headers (tiers)
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#94A3B8';
    for (let i = 0; i < tiers.length; i++) {
      ctx.fillText(`Tier ${tiers[i]}`, labelW + i * cellW + cellW / 2, labelH - 8);
    }

    // Row headers (buckets) + cells
    ctx.textAlign = 'right';
    for (let r = 0; r < BUCKETS.length; r++) {
      const bucket = BUCKETS[r];
      const y = labelH + r * cellH;

      // Row label
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(bucket, labelW - 8, y + cellH / 2 + 4);

      // Cells
      for (let c = 0; c < tiers.length; c++) {
        const tier = tiers[c];
        const count = grid[tier]?.[bucket] || 0;
        const x = labelW + c * cellW;
        const intensity = maxCount > 0 ? count / maxCount : 0;
        const [br, bg, bb] = BUCKET_COLORS[bucket];

        // Cell background
        ctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, ${Math.max(0.05, intensity * 0.9)})`;
        ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);

        // Cell border
        ctx.strokeStyle = `rgba(${br}, ${bg}, ${bb}, 0.3)`;
        ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4);

        // Cell text
        if (count > 0) {
          ctx.fillStyle = intensity > 0.5 ? '#FFFFFF' : '#94A3B8';
          ctx.textAlign = 'center';
          ctx.font = 'bold 14px monospace';
          ctx.fillText(String(count), x + cellW / 2, y + cellH / 2 + 5);
          ctx.font = '11px monospace';
        }
      }
    }
  }, [grid, tiers, maxCount]);

  if (!scores.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>
        No complexity data available. Run Phase 1 vectors first.
      </div>
    );
  }

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#E2E8F0' }}>
        Complexity Heat Map — Tier x Bucket ({scores.length} sessions)
      </div>
      <canvas ref={canvasRef} />
      <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: '#94A3B8' }}>
        {BUCKETS.map(b => {
          const [r, g, bl] = BUCKET_COLORS[b];
          const count = scores.filter(s => (s.bucket || 'low').toLowerCase() === b).length;
          return (
            <span key={b} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${r},${g},${bl})`, display: 'inline-block' }} />
              {b}: {count}
            </span>
          );
        })}
      </div>
    </div>
  );
}
