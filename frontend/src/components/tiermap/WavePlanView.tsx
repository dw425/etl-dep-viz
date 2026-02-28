/**
 * WavePlanView — migration waves as horizontal bands with session counts + hours.
 * SCC groups highlighted with warning boundaries, prerequisite arrows between waves.
 */

import React, { useMemo, useState } from 'react';
import type { WavePlan, MigrationWave, SCCGroup } from '../../types/vectors';

const WAVE_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#A855F7', '#06B6D4',
  '#EC4899', '#84CC16', '#F97316', '#8B5CF6', '#14B8A6',
];

interface Props {
  wavePlan: WavePlan;
  onSessionClick?: (sessionId: string) => void;
}

export default function WavePlanView({ wavePlan, onSessionClick }: Props) {
  const [expandedWave, setExpandedWave] = useState<number | null>(null);

  const sccSessionSet = useMemo(() => {
    const s = new Set<string>();
    for (const g of wavePlan.scc_groups) {
      if (g.is_cycle) {
        for (const sid of g.session_ids) s.add(sid);
      }
    }
    return s;
  }, [wavePlan.scc_groups]);

  const maxSessions = useMemo(() => {
    return Math.max(...wavePlan.waves.map(w => w.session_count), 1);
  }, [wavePlan.waves]);

  return (
    <div className="space-y-4">
      {/* Summary Bar */}
      <div className="flex items-center gap-4 px-4 py-3 bg-gray-800 rounded-lg border border-gray-700">
        <SumStat label="Total Waves" value={wavePlan.waves.length} />
        <SumStat label="Critical Path" value={wavePlan.critical_path_length} />
        <SumStat label="Cyclic" value={wavePlan.cyclic_session_count} />
        <SumStat label="Acyclic" value={wavePlan.acyclic_session_count} />
        <SumStat label="SCC Groups" value={wavePlan.scc_groups.filter(g => g.is_cycle).length} />
      </div>

      {/* Wave Bands */}
      <div className="space-y-2">
        {wavePlan.waves.map((wave, i) => {
          const isExpanded = expandedWave === wave.wave_number;
          const widthPct = (wave.session_count / maxSessions) * 100;
          const hasSCC = wave.session_ids.some(sid => sccSessionSet.has(sid));
          const color = WAVE_COLORS[i % WAVE_COLORS.length];

          return (
            <div key={wave.wave_number}>
              <button
                onClick={() => setExpandedWave(isExpanded ? null : wave.wave_number)}
                className={`w-full text-left rounded-lg border transition-colors ${
                  hasSCC ? 'border-amber-500/30 bg-gray-800' : 'border-gray-700 bg-gray-800'
                } hover:border-blue-500/50`}
              >
                <div className="flex items-center gap-3 px-4 py-3">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold text-white"
                    style={{ backgroundColor: color }}
                  >
                    {wave.wave_number}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-200 font-medium">
                        Wave {wave.wave_number}
                      </span>
                      <span className="text-xs text-gray-500">
                        {wave.session_count} sessions
                      </span>
                      {hasSCC && (
                        <span className="text-xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                          SCC
                        </span>
                      )}
                    </div>
                    <div className="mt-1 h-2 bg-gray-700 rounded-full overflow-hidden" style={{ width: '100%' }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${widthPct}%`, backgroundColor: color }}
                      />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-400">
                      {Math.round(wave.estimated_hours_low)}–{Math.round(wave.estimated_hours_high)} hrs
                    </div>
                    {wave.prerequisite_waves.length > 0 && (
                      <div className="text-[10px] text-gray-500">
                        After: {wave.prerequisite_waves.map(w => `W${w}`).join(', ')}
                      </div>
                    )}
                  </div>
                  <span className="text-gray-500 text-xs">{isExpanded ? '▲' : '▼'}</span>
                </div>
              </button>

              {isExpanded && (
                <div className="ml-4 mt-1 p-3 bg-gray-800/50 rounded border border-gray-700/50">
                  <div className="flex flex-wrap gap-1.5">
                    {wave.session_ids.map(sid => (
                      <button
                        key={sid}
                        onClick={() => onSessionClick?.(sid)}
                        className={`px-2 py-1 rounded text-xs transition-colors ${
                          sccSessionSet.has(sid)
                            ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        }`}
                      >
                        {sid}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* SCC Groups Detail */}
      {wavePlan.scc_groups.filter(g => g.is_cycle).length > 0 && (
        <div className="bg-gray-800 rounded-lg border border-amber-500/20 p-4">
          <h3 className="text-sm font-medium text-amber-400 mb-3">
            Strongly Connected Components (Cycles)
          </h3>
          <div className="space-y-2">
            {wavePlan.scc_groups.filter(g => g.is_cycle).map(g => (
              <div key={g.group_id} className="flex items-start gap-2">
                <span className="text-xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded mt-0.5">
                  SCC {g.group_id}
                </span>
                <div className="text-xs text-gray-400">
                  {g.session_ids.length} sessions, {g.internal_edge_count} internal edges
                  <div className="text-gray-500 mt-0.5">
                    {g.session_ids.slice(0, 10).join(', ')}
                    {g.session_ids.length > 10 && ` +${g.session_ids.length - 10} more`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SumStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-sm font-medium text-gray-200">{value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}
