/**
 * ComplexityOverlay — color-coded complexity badges on tier diagram sessions.
 * Shows score card with 8-dimension breakdown and bucket distribution bar chart.
 */

import React, { useMemo, useState } from 'react';
import type { ComplexityResult, SessionComplexityScore } from '../../types/vectors';

const BUCKET_COLORS: Record<string, string> = {
  Simple: '#10B981',
  Medium: '#F59E0B',
  Complex: '#F97316',
  'Very Complex': '#EF4444',
};

const DIM_LABELS: Record<string, string> = {
  D1_transform_volume: 'Transform Volume',
  D2_diversity: 'Diversity',
  D3_risk: 'Risk',
  D4_io_volume: 'IO Volume',
  D5_lookup_intensity: 'Lookup Intensity',
  D6_coupling: 'Coupling',
  D7_structural_depth: 'Structural Depth',
  D8_external_reads: 'External Reads',
};

interface Props {
  complexity: ComplexityResult;
  selectedSessionId?: string | null;
  onSessionSelect?: (sessionId: string) => void;
}

export default function ComplexityOverlay({ complexity, selectedSessionId, onSessionSelect }: Props) {
  const [sortBy, setSortBy] = useState<'score' | 'name'>('score');

  const sorted = useMemo(() => {
    const scores = [...complexity.scores];
    return sortBy === 'score'
      ? scores.sort((a, b) => b.overall_score - a.overall_score)
      : scores.sort((a, b) => a.name.localeCompare(b.name));
  }, [complexity.scores, sortBy]);

  const selected = useMemo(() => {
    if (!selectedSessionId) return null;
    return complexity.scores.find(s => s.session_id === selectedSessionId) ?? null;
  }, [complexity.scores, selectedSessionId]);

  const totalSessions = complexity.scores.length;

  return (
    <div className="space-y-4">
      {/* Bucket Distribution */}
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Complexity Distribution</h3>
        <div className="flex gap-1 rounded overflow-hidden">
          {Object.entries(complexity.bucket_distribution).map(([bucket, count]) => {
            const pct = (count / totalSessions) * 100;
            if (pct === 0) return null;
            return (
              <div key={bucket} className="transition-all" style={{ width: `${pct}%` }}>
                <div
                  className="h-6 rounded-sm"
                  style={{ backgroundColor: BUCKET_COLORS[bucket] }}
                  title={`${bucket}: ${count} (${Math.round(pct)}%)`}
                />
                <div className="flex items-center gap-1 mt-1.5 text-xs">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: BUCKET_COLORS[bucket] }} />
                  <span className="text-gray-400 truncate">{bucket}</span>
                  <span className="text-gray-500 shrink-0">({count})</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Aggregate Stats */}
      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Mean" value={complexity.aggregate_stats.mean_score} />
        <StatCard label="Median" value={complexity.aggregate_stats.median_score} />
        <StatCard label="Std Dev" value={complexity.aggregate_stats.std_dev} />
        <StatCard
          label="Est. Hours"
          value={`${Math.round(complexity.total_hours_low)}–${Math.round(complexity.total_hours_high)}`}
        />
      </div>

      {/* Selected Session Detail */}
      {selected && (
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-medium text-gray-300">{selected.name}</h3>
            <span
              className="text-xs px-2 py-0.5 rounded font-medium"
              style={{ backgroundColor: `${BUCKET_COLORS[selected.bucket]}20`, color: BUCKET_COLORS[selected.bucket] }}
            >
              {selected.bucket} ({Math.round(selected.overall_score)})
            </span>
          </div>
          <div className="space-y-2">
            {selected.dimensions.map(d => (
              <div key={d.name}>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-gray-400">{DIM_LABELS[d.name] || d.name}</span>
                  <span className="text-gray-300">{Math.round(d.normalized)}</span>
                </div>
                <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${d.normalized}%`,
                      backgroundColor: d.normalized > 75 ? '#EF4444'
                        : d.normalized > 50 ? '#F97316'
                        : d.normalized > 25 ? '#F59E0B' : '#10B981',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Session List */}
      <div className="bg-gray-800 rounded-lg border border-gray-700">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
          <span className="text-xs text-gray-500">{totalSessions} sessions</span>
          <div className="flex gap-1">
            <button
              onClick={() => setSortBy('score')}
              className={`text-xs px-2 py-0.5 rounded ${sortBy === 'score' ? 'bg-blue-500/20 text-blue-400' : 'text-gray-500'}`}
            >
              Score
            </button>
            <button
              onClick={() => setSortBy('name')}
              className={`text-xs px-2 py-0.5 rounded ${sortBy === 'name' ? 'bg-blue-500/20 text-blue-400' : 'text-gray-500'}`}
            >
              Name
            </button>
          </div>
        </div>
        <div className="max-h-60 overflow-y-auto">
          {sorted.map(s => (
            <button
              key={s.session_id}
              onClick={() => onSessionSelect?.(s.session_id)}
              className={`w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-gray-700/50 transition-colors ${
                selectedSessionId === s.session_id ? 'bg-gray-700/50' : ''
              }`}
            >
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: BUCKET_COLORS[s.bucket] }} />
              <span className="text-xs text-gray-300 truncate flex-1">{s.name}</span>
              <span className="text-xs text-gray-500">{Math.round(s.overall_score)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-gray-800 rounded border border-gray-700 p-2 text-center">
      <div className="text-sm font-medium text-gray-200">{typeof value === 'number' ? Math.round(value) : value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}
