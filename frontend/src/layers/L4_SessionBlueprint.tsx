/**
 * L4 Session Blueprint — single session exploded view.
 * Shows source→transform→target flow with V11 complexity breakdown.
 */

import React, { useEffect, useState } from 'react';
import { useNavigationContext } from '../navigation/NavigationProvider';
import { getL4Data } from '../api/client';
import type { TierSession } from '../types/tiermap';
import type { SessionComplexityScore, SessionCriticality } from '../types/vectors';

const DIM_LABELS: Record<string, string> = {
  D1_transform_volume: 'Transform Volume',
  D2_diversity: 'Diversity',
  D3_risk: 'Risk',
  D4_table_footprint: 'Table Footprint',
  D5_lookup_intensity: 'Lookup Intensity',
  D6_coupling: 'Coupling',
  D7_structural_depth: 'Structural Depth',
  D8_volume_proxy: 'Volume Proxy',
};

const BUCKET_COLORS: Record<string, string> = {
  Simple: '#10B981',
  Medium: '#F59E0B',
  Complex: '#F97316',
  'Very Complex': '#EF4444',
};

export default function L4_SessionBlueprint() {
  const { currentParams, tierData, vectorResults, drillDown } = useNavigationContext();
  const [l4Data, setL4Data] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  const sessionId = currentParams.sessionId || '';

  useEffect(() => {
    if (tierData && vectorResults && sessionId) {
      setLoading(true);
      getL4Data(tierData, sessionId)
        .then(d => setL4Data(d))
        .catch(err => console.error('L4 load failed:', err))
        .finally(() => setLoading(false));
    }
  }, [tierData, vectorResults, sessionId]);

  const session = l4Data?.session as TierSession | undefined;
  const complexity = l4Data?.complexity as SessionComplexityScore | undefined;
  const criticality = l4Data?.criticality as SessionCriticality | undefined;
  const upstream = (l4Data?.upstream_connections ?? []) as { from: string; to: string; type: string }[];
  const downstream = (l4Data?.downstream_connections ?? []) as { from: string; to: string; type: string }[];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <div className="p-4 text-gray-500">Session not found</div>;
  }

  return (
    <div className="flex h-full min-h-[600px]">
      {/* Left — Session Info */}
      <div className="w-72 border-r border-gray-700/50 overflow-y-auto bg-gray-900/50 p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-1">{session.name}</h3>
        <p className="text-xs text-gray-500 mb-4">{session.full}</p>

        <div className="space-y-2">
          <InfoRow label="Tier" value={session.tier} />
          <InfoRow label="Transforms" value={session.transforms} />
          <InfoRow label="External Reads" value={session.extReads} />
          <InfoRow label="Lookups" value={session.lookupCount} />
          <InfoRow label="Critical" value={session.critical ? 'Yes' : 'No'} />
        </div>

        {criticality && (
          <div className="mt-4 pt-3 border-t border-gray-700/50">
            <div className="text-xs text-gray-500 mb-2">Criticality (V9)</div>
            <InfoRow label="Blast Radius" value={criticality.blast_radius} />
            <InfoRow label="Chain Depth" value={criticality.chain_depth} />
            <InfoRow label="Criticality Score" value={Math.round(criticality.criticality_score)} />
            <InfoRow label="Tier" value={`${criticality.criticality_tier}/5`} />
            <InfoRow label="Amplification" value={`${criticality.amplification_factor.toFixed(1)}x`} />
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-gray-700/50">
          <div className="text-xs text-gray-500 mb-2">Dependencies</div>
          <InfoRow label="Upstream" value={upstream.length} />
          <InfoRow label="Downstream" value={downstream.length} />
        </div>
      </div>

      {/* Center — Flow Diagram */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          {/* Upstream Sources */}
          {upstream.length > 0 && (
            <div className="mb-6">
              <div className="text-xs text-gray-500 font-medium mb-2">Upstream Dependencies</div>
              <div className="flex flex-wrap gap-2">
                {upstream.map((c, i) => (
                  <div key={i} className="px-3 py-1.5 bg-green-500/10 border border-green-500/30 rounded text-xs text-green-400">
                    {c.from} <span className="text-gray-500">({c.type})</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-center my-2">
                <svg width="20" height="24" className="text-gray-500">
                  <line x1="10" y1="0" x2="10" y2="18" stroke="currentColor" strokeWidth="1.5" />
                  <polygon points="5,18 15,18 10,24" fill="currentColor" />
                </svg>
              </div>
            </div>
          )}

          {/* Session Box */}
          <div className="bg-gray-800 border-2 border-blue-500/50 rounded-lg p-4 text-center mb-4">
            <div className="text-lg font-medium text-blue-400">{session.name}</div>
            <div className="text-xs text-gray-400 mt-1">{session.transforms} transforms | Tier {session.tier}</div>
            {complexity && (
              <div className="mt-2 flex items-center justify-center gap-2">
                <span
                  className="px-2 py-0.5 rounded text-xs font-medium"
                  style={{ backgroundColor: `${BUCKET_COLORS[complexity.bucket]}20`, color: BUCKET_COLORS[complexity.bucket] }}
                >
                  {complexity.bucket}
                </span>
                <span className="text-sm text-gray-300">{Math.round(complexity.overall_score)}/100</span>
              </div>
            )}
          </div>

          {/* Downstream Targets */}
          {downstream.length > 0 && (
            <div className="mt-2">
              <div className="flex justify-center mb-2">
                <svg width="20" height="24" className="text-gray-500">
                  <line x1="10" y1="0" x2="10" y2="18" stroke="currentColor" strokeWidth="1.5" />
                  <polygon points="5,18 15,18 10,24" fill="currentColor" />
                </svg>
              </div>
              <div className="text-xs text-gray-500 font-medium mb-2">Downstream Dependencies</div>
              <div className="flex flex-wrap gap-2">
                {downstream.map((c, i) => (
                  <div key={i} className="px-3 py-1.5 bg-purple-500/10 border border-purple-500/30 rounded text-xs text-purple-400">
                    {c.to} <span className="text-gray-500">({c.type})</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right — Complexity Breakdown */}
      <div className="w-80 border-l border-gray-700/50 overflow-y-auto bg-gray-900/50 p-4">
        {complexity ? (
          <>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Complexity Breakdown</h3>

            <div className="flex items-center gap-3 mb-4">
              <div
                className="text-3xl font-bold"
                style={{ color: BUCKET_COLORS[complexity.bucket] }}
              >
                {Math.round(complexity.overall_score)}
              </div>
              <div>
                <div
                  className="text-sm font-medium"
                  style={{ color: BUCKET_COLORS[complexity.bucket] }}
                >
                  {complexity.bucket}
                </div>
                <div className="text-xs text-gray-500">
                  {complexity.hours_estimate_low}–{complexity.hours_estimate_high} hrs
                </div>
              </div>
            </div>

            <div className="space-y-2.5">
              {complexity.dimensions.map(d => (
                <div key={d.name}>
                  <div className="flex justify-between text-xs mb-0.5">
                    <span className="text-gray-400">{DIM_LABELS[d.name] || d.name}</span>
                    <span className="text-gray-300">{Math.round(d.normalized)}</span>
                  </div>
                  <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
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

            {complexity.top_drivers.length > 0 && (
              <div className="mt-4 pt-3 border-t border-gray-700/50">
                <div className="text-xs text-gray-500 mb-2">Top Drivers</div>
                {complexity.top_drivers.map((d, i) => (
                  <div key={i} className="text-xs text-gray-400 mb-1">
                    {i + 1}. {d}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-gray-500">
            Run vector analysis to see complexity breakdown
          </div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between text-xs mb-1">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-300">{value}</span>
    </div>
  );
}
