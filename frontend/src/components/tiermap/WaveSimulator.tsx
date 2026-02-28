/**
 * WaveSimulator — "What-If" cascade simulation mode.
 * Select session → animate cascade ripple with criticality heatmap.
 */

import React, { useCallback, useState } from 'react';
import { whatIfSimulation } from '../../api/client';
import type { TierMapResult } from '../../types/tiermap';
import type { WhatIfResult, WaveFunctionResult } from '../../types/vectors';

interface Props {
  tierData: TierMapResult;
  waveFunction?: WaveFunctionResult | null;
  onSessionSelect?: (sessionId: string) => void;
}

export default function WaveSimulator({ tierData, waveFunction, onSessionSelect }: Props) {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [whatIf, setWhatIf] = useState<WhatIfResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSimulate = useCallback(async (sessionId: string) => {
    setSelectedSession(sessionId);
    setLoading(true);
    try {
      const result = await whatIfSimulation(tierData, sessionId);
      setWhatIf(result);
    } catch (err) {
      console.error('What-if simulation failed:', err);
    } finally {
      setLoading(false);
    }
  }, [tierData]);

  // Sort sessions by criticality score
  const sortedSessions = [...(waveFunction?.sessions ?? [])].sort(
    (a, b) => b.criticality_score - a.criticality_score,
  );

  return (
    <div className="space-y-4">
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-1">Wave Cascade Simulator</h3>
        <p className="text-xs text-gray-500">
          Select a session to simulate its failure cascade through the dependency graph
        </p>
      </div>

      <div className="flex gap-4">
        {/* Session Picker */}
        <div className="w-72 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-700 text-xs text-gray-500">
            Sessions by Criticality ({sortedSessions.length})
          </div>
          <div className="max-h-96 overflow-y-auto">
            {sortedSessions.map(s => (
              <button
                key={s.session_id}
                onClick={() => handleSimulate(s.session_id)}
                className={`w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-gray-700/50 transition-colors ${
                  selectedSession === s.session_id ? 'bg-blue-500/10' : ''
                }`}
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{
                    backgroundColor: s.criticality_tier >= 4 ? '#EF4444'
                      : s.criticality_tier >= 3 ? '#F97316'
                      : s.criticality_tier >= 2 ? '#F59E0B' : '#10B981',
                  }}
                />
                <span className="text-xs text-gray-300 truncate flex-1">{s.session_id}</span>
                <span className="text-xs text-gray-500">
                  {Math.round(s.criticality_score)}
                </span>
                <span className="text-[10px] text-gray-600">
                  r{s.blast_radius}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Simulation Results */}
        <div className="flex-1">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : whatIf ? (
            <div className="space-y-3">
              <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-sm font-medium text-red-400">{whatIf.source_session}</span>
                  <span className="text-xs text-gray-500">failure cascade</span>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="text-center">
                    <div className="text-xl font-bold text-gray-200">{whatIf.blast_radius}</div>
                    <div className="text-[10px] text-gray-500">Blast Radius</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xl font-bold text-gray-200">{whatIf.max_depth}</div>
                    <div className="text-[10px] text-gray-500">Max Depth</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xl font-bold text-gray-200">
                      {Object.keys(whatIf.hop_breakdown).length}
                    </div>
                    <div className="text-[10px] text-gray-500">Hop Layers</div>
                  </div>
                </div>
              </div>

              {/* Hop Breakdown */}
              {Object.entries(whatIf.hop_breakdown).map(([hop, sessions]) => (
                <div key={hop} className="bg-gray-800 rounded-lg border border-gray-700 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium"
                      style={{
                        backgroundColor: Number(hop) <= 1 ? '#EF444420' : Number(hop) <= 3 ? '#F9731620' : '#F59E0B20',
                        color: Number(hop) <= 1 ? '#EF4444' : Number(hop) <= 3 ? '#F97316' : '#F59E0B',
                      }}
                    >
                      Hop {hop}
                    </span>
                    <span className="text-xs text-gray-500">{sessions.length} sessions</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {sessions.map(sid => (
                      <button
                        key={sid}
                        onClick={() => onSessionSelect?.(sid)}
                        className="px-1.5 py-0.5 bg-gray-700 rounded text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
                      >
                        {sid}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {/* Amplitude Decay Chart */}
              {whatIf.amplitude_decay.length > 0 && (
                <div className="bg-gray-800 rounded-lg border border-gray-700 p-3">
                  <div className="text-xs text-gray-500 mb-2">Amplitude Decay</div>
                  <div className="flex items-end gap-1 h-16">
                    {whatIf.amplitude_decay.slice(0, 20).map((d, i) => (
                      <div
                        key={i}
                        className="flex-1 bg-blue-500/50 rounded-t"
                        style={{ height: `${d.amplitude * 100}%` }}
                        title={`Hop ${d.hop}: ${d.amplitude.toFixed(3)}`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-sm text-gray-500">
              Select a session to simulate its failure cascade
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
