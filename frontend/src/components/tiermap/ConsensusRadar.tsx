/**
 * ConsensusRadar -- V8 Ensemble consensus viewer.
 *
 * Shows how well different vector engines (V1-V8) agree on cluster assignments
 * for each session. Sessions where vectors disagree are flagged as "contested".
 *
 * Layout:
 *   Top   — summary: cluster count, contested count, high-confidence count, vectors used
 *   Left  — session list, sortable by consensus score or contested status
 *   Right — SessionConsensusDetail: score, consensus cluster, per-vector assignment table
 *
 * Color coding:
 *   - Red dot:   contested (vectors disagree on cluster)
 *   - Green dot:  high confidence (consensus_score > 0.8)
 *   - Amber dot:  moderate confidence
 *   - Per-vector badges: green checkmark = agrees with consensus, red X = disagrees
 *
 * @param ensemble        - V8 ensemble result with sessions, per_vector_assignments, scores
 * @param onSessionSelect - Callback when a session is clicked
 */

import React, { useMemo, useState } from 'react';
import type { EnsembleResult, ConsensusSession } from '../../types/vectors';

interface Props {
  ensemble: EnsembleResult;
  onSessionSelect?: (sessionId: string) => void;
}

export default function ConsensusRadar({ ensemble, onSessionSelect }: Props) {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'score' | 'contested'>('score');

  const sorted = useMemo(() => {
    const sessions = [...ensemble.sessions];
    if (sortBy === 'score') {
      return sessions.sort((a, b) => a.consensus_score - b.consensus_score);
    }
    return sessions.sort((a, b) => (b.is_contested ? 1 : 0) - (a.is_contested ? 1 : 0));
  }, [ensemble.sessions, sortBy]);

  const selected = useMemo(() => {
    if (!selectedSession) return null;
    return ensemble.sessions.find(s => s.session_id === selectedSession) ?? null;
  }, [ensemble.sessions, selectedSession]);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 px-4 py-3 bg-gray-800 rounded-lg border border-gray-700">
        <SumStat label="Clusters" value={ensemble.n_clusters} />
        <SumStat label="Contested" value={ensemble.contested_count} color="#EF4444" />
        <SumStat label="High Confidence" value={ensemble.high_confidence_count} color="#10B981" />
        <SumStat label="Vectors Used" value={ensemble.vectors_used.length} />
      </div>

      <div className="flex gap-4">
        {/* Session List */}
        <div className="w-72 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
            <span className="text-xs text-gray-500">{ensemble.sessions.length} sessions</span>
            <div className="flex gap-1">
              <button
                onClick={() => setSortBy('score')}
                className={`text-xs px-2 py-0.5 rounded ${sortBy === 'score' ? 'bg-blue-500/20 text-blue-400' : 'text-gray-500'}`}
              >
                Score
              </button>
              <button
                onClick={() => setSortBy('contested')}
                className={`text-xs px-2 py-0.5 rounded ${sortBy === 'contested' ? 'bg-blue-500/20 text-blue-400' : 'text-gray-500'}`}
              >
                Contested
              </button>
            </div>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {sorted.map(s => (
              <button
                key={s.session_id}
                onClick={() => {
                  setSelectedSession(s.session_id);
                  onSessionSelect?.(s.session_id);
                }}
                className={`w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-gray-700/50 transition-colors ${
                  selectedSession === s.session_id ? 'bg-blue-500/10' : ''
                }`}
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{
                    backgroundColor: s.is_contested ? '#EF4444'
                      : s.consensus_score > 0.8 ? '#10B981' : '#F59E0B',
                  }}
                />
                <span className="text-xs text-gray-300 truncate flex-1">{s.session_id}</span>
                <span className="text-xs text-gray-500">{(s.consensus_score * 100).toFixed(0)}%</span>
              </button>
            ))}
          </div>
        </div>

        {/* Detail Panel */}
        <div className="flex-1">
          {selected ? (
            <SessionConsensusDetail session={selected} vectorsUsed={ensemble.vectors_used} />
          ) : (
            <div className="flex items-center justify-center h-32 text-sm text-gray-500">
              Select a session to view its consensus profile
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionConsensusDetail({ session, vectorsUsed }: { session: ConsensusSession; vectorsUsed: string[] }) {
  const scoreColor = session.is_contested ? '#EF4444'
    : session.consensus_score > 0.8 ? '#10B981' : '#F59E0B';

  return (
    <div className="space-y-3">
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-medium text-gray-300">{session.session_id}</h3>
          <span
            className="text-xs px-2 py-0.5 rounded font-medium"
            style={{ backgroundColor: `${scoreColor}20`, color: scoreColor }}
          >
            {session.is_contested ? 'Contested' : session.consensus_score > 0.8 ? 'High Confidence' : 'Moderate'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="text-center">
            <div className="text-2xl font-bold" style={{ color: scoreColor }}>
              {(session.consensus_score * 100).toFixed(0)}%
            </div>
            <div className="text-[10px] text-gray-500">Consensus Score</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-200">
              C{session.consensus_cluster}
            </div>
            <div className="text-[10px] text-gray-500">Consensus Cluster</div>
          </div>
        </div>
      </div>

      {/* Per-Vector Assignments */}
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div className="text-xs text-gray-500 mb-3">Per-Vector Assignments</div>
        <div className="space-y-2">
          {vectorsUsed.map(vec => {
            const assignment = session.per_vector_assignments[vec];
            const label = vec.replace(/_/g, ' ').replace(/v(\d+)/, 'V$1');
            return (
              <div key={vec} className="flex items-center gap-2">
                <span className="text-xs text-gray-400 w-40 truncate">{label}</span>
                {assignment !== undefined ? (
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    assignment === session.consensus_cluster
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-red-500/20 text-red-400'
                  }`}>
                    Cluster {assignment}
                    {assignment === session.consensus_cluster ? ' ✓' : ' ✗'}
                  </span>
                ) : (
                  <span className="text-xs text-gray-600">—</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SumStat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <div className="text-sm font-medium" style={{ color: color ?? '#e2e8f0' }}>{value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}
