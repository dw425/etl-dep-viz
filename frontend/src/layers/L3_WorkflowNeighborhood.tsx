/**
 * L3 Workflow Neighborhood — sessions in a sub-cluster or workflow.
 * Shows tier diagram filtered to 10-80 sessions with cascade animation.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigationContext } from '../navigation/NavigationProvider';
import { getL3Data, whatIfSimulation } from '../api/client';
import type { TierSession, TierConn } from '../types/tiermap';
import type { WhatIfResult } from '../types/vectors';

export default function L3_WorkflowNeighborhood() {
  const { currentParams, tierData, vectorResults, drillDown } = useNavigationContext();
  const [l3Data, setL3Data] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [whatIf, setWhatIf] = useState<WhatIfResult | null>(null);
  const [cascadeSource, setCascadeSource] = useState<string | null>(null);

  const { groupId = '', scopeType = '', scopeId = '' } = currentParams;

  useEffect(() => {
    if (tierData && vectorResults && groupId) {
      setLoading(true);
      getL3Data(tierData, groupId, scopeType, scopeId)
        .then(d => setL3Data(d))
        .catch(err => console.error('L3 load failed:', err))
        .finally(() => setLoading(false));
    }
  }, [tierData, vectorResults, groupId, scopeType, scopeId]);

  const sessions = (l3Data?.sessions ?? []) as TierSession[];
  const connections = (l3Data?.connections ?? []) as TierConn[];
  const cascadeData = (l3Data?.cascade_data ?? []) as { session_id: string; criticality_score: number; blast_radius: number }[];
  const sccGroups = (l3Data?.scc_groups ?? []) as { group_id: number; session_ids: string[]; is_cycle: boolean }[];

  const sccSessionSet = useMemo(() => {
    const s = new Set<string>();
    for (const g of sccGroups) {
      if (g.is_cycle) {
        for (const sid of g.session_ids) s.add(sid);
      }
    }
    return s;
  }, [sccGroups]);

  const critMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of cascadeData) m[c.session_id] = c.criticality_score;
    return m;
  }, [cascadeData]);

  const affectedSet = useMemo(() => {
    if (!whatIf) return new Set<string>();
    return new Set(whatIf.affected_sessions);
  }, [whatIf]);

  const handleCascade = useCallback(async (sessionId: string) => {
    if (!tierData) return;
    setCascadeSource(sessionId);
    try {
      const result = await whatIfSimulation(tierData, sessionId);
      setWhatIf(result);
    } catch (err) {
      console.error('What-if failed:', err);
    }
  }, [tierData]);

  const handleSessionClick = useCallback((s: TierSession) => {
    drillDown(4, { sessionId: s.id, sessionName: s.name });
  }, [drillDown]);

  // Group sessions by tier
  const tiers = useMemo(() => {
    const grouped: Record<number, TierSession[]> = {};
    for (const s of sessions) (grouped[s.tier] ??= []).push(s);
    return Object.entries(grouped).sort(([a], [b]) => Number(a) - Number(b));
  }, [sessions]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[600px]">
      {/* Left — Session list with filters */}
      <div className="w-64 border-r border-gray-700/50 overflow-y-auto bg-gray-900/50">
        <div className="p-3 border-b border-gray-700/50">
          <h3 className="text-sm font-medium text-gray-300">{sessions.length} Sessions</h3>
          {sccGroups.filter(g => g.is_cycle).length > 0 && (
            <p className="text-xs text-amber-400 mt-1">
              {sccGroups.filter(g => g.is_cycle).length} SCC cycles detected
            </p>
          )}
        </div>
        {sessions.map(s => {
          const isSCC = sccSessionSet.has(s.id);
          const isAffected = affectedSet.has(s.id);
          const isSource = cascadeSource === s.id;
          return (
            <div key={s.id} className="border-b border-gray-800">
              <button
                onClick={() => handleSessionClick(s)}
                className={`w-full px-3 py-2 text-left hover:bg-gray-800 transition-colors ${
                  isSource ? 'bg-red-500/10' : isAffected ? 'bg-amber-500/10' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  {isSCC && <span className="text-amber-400 text-xs" title="In SCC cycle">&#x21BB;</span>}
                  <span className="text-sm text-gray-200 truncate flex-1">{s.name}</span>
                  <span className="text-xs text-gray-500">T{s.tier}</span>
                </div>
              </button>
              <button
                onClick={() => handleCascade(s.id)}
                className="w-full px-3 py-0.5 text-[10px] text-gray-500 hover:text-blue-400 text-left transition-colors"
              >
                Cascade from here
              </button>
            </div>
          );
        })}
      </div>

      {/* Center — Tier Diagram */}
      <div className="flex-1 overflow-y-auto p-4">
        {tiers.map(([tier, tierSessions]) => (
          <div key={tier} className="mb-4">
            <div className="text-xs text-gray-500 font-medium mb-2 px-1">
              Tier {tier} ({tierSessions.length} sessions)
            </div>
            <div className="flex flex-wrap gap-2">
              {tierSessions.map(s => {
                const crit = critMap[s.id] ?? 0;
                const isSCC = sccSessionSet.has(s.id);
                const isAffected = affectedSet.has(s.id);
                const isSource = cascadeSource === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => handleSessionClick(s)}
                    className={`px-3 py-2 rounded text-xs transition-all border ${
                      isSource ? 'bg-red-500/20 border-red-500 text-red-300 ring-2 ring-red-500/30' :
                      isAffected ? 'bg-amber-500/15 border-amber-500/50 text-amber-300' :
                      isSCC ? 'bg-gray-800 border-amber-500/30 text-gray-300' :
                      'bg-gray-800 border-gray-700 text-gray-300 hover:border-blue-500/50'
                    }`}
                    title={`Criticality: ${Math.round(crit)}`}
                  >
                    <div className="font-medium">{s.name}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">{s.transforms} transforms</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Right — Cascade Details */}
      <div className="w-64 border-l border-gray-700/50 overflow-y-auto bg-gray-900/50 p-4">
        {whatIf ? (
          <>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Cascade Analysis</h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">Source</span>
                <span className="text-red-400">{whatIf.source_session}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Blast Radius</span>
                <span className="text-gray-200">{whatIf.blast_radius}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Max Depth</span>
                <span className="text-gray-200">{whatIf.max_depth}</span>
              </div>
            </div>
            {Object.entries(whatIf.hop_breakdown).length > 0 && (
              <div className="mt-4">
                <div className="text-xs text-gray-500 mb-2">Hop Breakdown</div>
                {Object.entries(whatIf.hop_breakdown).map(([hop, sids]) => (
                  <div key={hop} className="flex justify-between text-xs mb-1">
                    <span className="text-gray-400">Hop {hop}</span>
                    <span className="text-gray-300">{sids.length} sessions</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-gray-500">
            Click &ldquo;Cascade from here&rdquo; on a session to simulate failure propagation
          </div>
        )}
      </div>
    </div>
  );
}
