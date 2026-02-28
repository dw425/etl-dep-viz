/**
 * Session Comparison — side-by-side radar chart comparison of two sessions.
 *
 * Compares sessions across dimensions: complexity, connectivity,
 * read count, write count, lookup count, tier depth, transforms.
 */

import React, { useMemo, useRef, useEffect } from 'react';
import * as d3 from 'd3';
import type { TierSession } from '../../types/tiermap';

interface SessionComparisonProps {
  sessionA: TierSession;
  sessionB: TierSession;
  onClose: () => void;
}

interface Dimension {
  key: string;
  label: string;
  valueA: number;
  valueB: number;
  maxVal: number;
}

export default function SessionComparison({ sessionA, sessionB, onClose }: SessionComparisonProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const dimensions = useMemo((): Dimension[] => {
    const dims = [
      { key: 'tier', label: 'Tier', valueA: sessionA.tier, valueB: sessionB.tier },
      { key: 'transforms', label: 'Transforms', valueA: sessionA.transforms, valueB: sessionB.transforms },
      { key: 'reads', label: 'Reads', valueA: sessionA.extReads, valueB: sessionB.extReads },
      { key: 'lookups', label: 'Lookups', valueA: sessionA.lookupCount, valueB: sessionB.lookupCount },
      { key: 'step', label: 'Step', valueA: sessionA.step, valueB: sessionB.step },
      { key: 'critical', label: 'Critical', valueA: sessionA.critical ? 1 : 0, valueB: sessionB.critical ? 1 : 0 },
    ];
    return dims.map(d => ({
      ...d,
      maxVal: Math.max(d.valueA, d.valueB, 1),
    }));
  }, [sessionA, sessionB]);

  // Draw radar chart
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const size = 300;
    const cx = size / 2;
    const cy = size / 2;
    const radius = 110;
    const n = dimensions.length;

    const d3svg = d3.select(svg);
    d3svg.selectAll('*').remove();

    const g = d3svg.append('g').attr('transform', `translate(${cx},${cy})`);

    // Background rings
    for (let r = 0.25; r <= 1; r += 0.25) {
      const points = dimensions.map((_, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        return [Math.cos(angle) * radius * r, Math.sin(angle) * radius * r] as [number, number];
      });
      g.append('polygon')
        .attr('points', points.map(p => p.join(',')).join(' '))
        .attr('fill', 'none')
        .attr('stroke', '#334155')
        .attr('stroke-width', 0.5);
    }

    // Axis lines and labels
    dimensions.forEach((dim, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      g.append('line')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', x).attr('y2', y)
        .attr('stroke', '#334155').attr('stroke-width', 0.5);
      g.append('text')
        .attr('x', Math.cos(angle) * (radius + 18))
        .attr('y', Math.sin(angle) * (radius + 18))
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('fill', '#94a3b8')
        .attr('font-size', 10)
        .text(dim.label);
    });

    // Session A polygon
    const pointsA = dimensions.map((dim, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = (dim.valueA / dim.maxVal) * radius;
      return [Math.cos(angle) * r, Math.sin(angle) * r] as [number, number];
    });
    g.append('polygon')
      .attr('points', pointsA.map(p => p.join(',')).join(' '))
      .attr('fill', 'rgba(59,130,246,0.2)')
      .attr('stroke', '#3B82F6')
      .attr('stroke-width', 2);

    // Session B polygon
    const pointsB = dimensions.map((dim, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = (dim.valueB / dim.maxVal) * radius;
      return [Math.cos(angle) * r, Math.sin(angle) * r] as [number, number];
    });
    g.append('polygon')
      .attr('points', pointsB.map(p => p.join(',')).join(' '))
      .attr('fill', 'rgba(168,85,247,0.2)')
      .attr('stroke', '#A855F7')
      .attr('stroke-width', 2);

    // Data points
    pointsA.forEach(p => {
      g.append('circle').attr('cx', p[0]).attr('cy', p[1]).attr('r', 3).attr('fill', '#3B82F6');
    });
    pointsB.forEach(p => {
      g.append('circle').attr('cx', p[0]).attr('cy', p[1]).attr('r', 3).attr('fill', '#A855F7');
    });
  }, [dimensions]);

  return (
    <div style={{
      padding: 16, color: '#e2e8f0',
      fontFamily: '"JetBrains Mono", monospace',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Session Comparison</h3>
        <button onClick={onClose} style={{
          background: 'transparent', border: '1px solid #475569',
          borderRadius: 4, color: '#94a3b8', cursor: 'pointer', padding: '4px 8px',
        }}>
          Close
        </button>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 12, fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 12, background: '#3B82F6', borderRadius: 2, display: 'inline-block' }} />
          {sessionA.name} (S{sessionA.id.replace('S', '')})
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 12, background: '#A855F7', borderRadius: 2, display: 'inline-block' }} />
          {sessionB.name} (S{sessionB.id.replace('S', '')})
        </div>
      </div>

      {/* Radar chart */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <svg ref={svgRef} width={300} height={300} />
      </div>

      {/* Detail table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #334155' }}>
            <th style={{ textAlign: 'left', padding: '6px 8px', color: '#94a3b8' }}>Metric</th>
            <th style={{ textAlign: 'right', padding: '6px 8px', color: '#3B82F6' }}>{sessionA.name}</th>
            <th style={{ textAlign: 'right', padding: '6px 8px', color: '#A855F7' }}>{sessionB.name}</th>
            <th style={{ textAlign: 'right', padding: '6px 8px', color: '#94a3b8' }}>Diff</th>
          </tr>
        </thead>
        <tbody>
          {dimensions.map(d => (
            <tr key={d.key} style={{ borderBottom: '1px solid #1e293b' }}>
              <td style={{ padding: '4px 8px' }}>{d.label}</td>
              <td style={{ padding: '4px 8px', textAlign: 'right' }}>{d.valueA}</td>
              <td style={{ padding: '4px 8px', textAlign: 'right' }}>{d.valueB}</td>
              <td style={{
                padding: '4px 8px', textAlign: 'right',
                color: d.valueA > d.valueB ? '#3B82F6' : d.valueB > d.valueA ? '#A855F7' : '#64748b',
              }}>
                {d.valueA === d.valueB ? '=' : d.valueA > d.valueB ? `+${d.valueA - d.valueB}` : `-${d.valueB - d.valueA}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
