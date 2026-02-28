/**
 * L2 Domain Cluster — sessions within one community group.
 * Shows meso sub-clusters as colored groups with session list.
 * Toggle between Orb and Tier views.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigationContext } from '../navigation/NavigationProvider';
import { getL2Data } from '../api/client';
import type { TierSession, TierConn } from '../types/tiermap';

const COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4',
  '#EC4899', '#84CC16', '#F97316', '#8B5CF6', '#14B8A6', '#FB923C',
];

export default function L2_DomainCluster() {
  const { currentParams, tierData, vectorResults, drillDown, drillUp } = useNavigationContext();
  const [l2Data, setL2Data] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'tier'>('list');

  const groupId = currentParams.groupId || '';

  useEffect(() => {
    if (tierData && vectorResults && groupId) {
      setLoading(true);
      getL2Data(tierData, groupId)
        .then(d => setL2Data(d))
        .catch(err => console.error('L2 load failed:', err))
        .finally(() => setLoading(false));
    }
  }, [tierData, vectorResults, groupId]);

  const sessions = (l2Data?.sessions ?? []) as TierSession[];
  const subClusters = (l2Data?.sub_clusters ?? {}) as Record<string, string[]>;
  const connections = (l2Data?.connections ?? []) as TierConn[];
  const complexityScores = (l2Data?.complexity_scores ?? []) as { session_id: string; overall_score: number; bucket: string }[];

  const complexityMap = useMemo(() => {
    const map: Record<string, { score: number; bucket: string }> = {};
    for (const c of complexityScores) {
      map[c.session_id] = { score: c.overall_score, bucket: c.bucket };
    }
    return map;
  }, [complexityScores]);

  // Assign sub-cluster color to each session
  const sessionCluster = useMemo(() => {
    const map: Record<string, number> = {};
    Object.entries(subClusters).forEach(([cid, sids], i) => {
      for (const sid of sids) map[sid] = i;
    });
    return map;
  }, [subClusters]);

  const handleSessionClick = useCallback((s: TierSession) => {
    drillDown(4, { sessionId: s.id, sessionName: s.name });
  }, [drillDown]);

  const handleSubClusterClick = useCallback((clusterId: string, sids: string[]) => {
    drillDown(3, {
      groupId,
      scopeType: 'sub_cluster',
      scopeId: clusterId,
      scopeLabel: `Sub-cluster ${clusterId} (${sids.length} sessions)`,
    });
  }, [drillDown, groupId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[600px]">
      {/* Left Panel — Sub-clusters + Workflows */}
      <div className="w-72 border-r border-gray-700/50 overflow-y-auto bg-gray-900/50">
        <div className="p-3 border-b border-gray-700/50">
          <h3 className="text-sm font-medium text-gray-300">Sub-clusters</h3>
          <p className="text-xs text-gray-500 mt-1">{Object.keys(subClusters).length} sub-clusters</p>
        </div>
        {Object.entries(subClusters).map(([cid, sids], i) => (
          <button
            key={cid}
            onClick={() => handleSubClusterClick(cid, sids)}
            className="w-full px-3 py-2 text-left border-b border-gray-800 hover:bg-gray-800 transition-colors"
          >
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
              <span className="text-sm text-gray-200">Cluster {cid}</span>
              <span className="ml-auto text-xs text-gray-500">{sids.length}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Center — Session List / Tier View */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700/50">
          <span className="text-sm text-gray-300 font-medium">
            {sessions.length} Sessions
          </span>
          <div className="ml-auto flex gap-1">
            <button
              onClick={() => setViewMode('list')}
              className={`px-2.5 py-1 text-xs rounded ${viewMode === 'list' ? 'bg-blue-500/20 text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              List
            </button>
            <button
              onClick={() => setViewMode('tier')}
              className={`px-2.5 py-1 text-xs rounded ${viewMode === 'tier' ? 'bg-blue-500/20 text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              Tier
            </button>
          </div>
        </div>

        {viewMode === 'list' ? (
          <div className="divide-y divide-gray-800">
            {sessions.map(s => {
              const cx = complexityMap[s.id];
              const clusterIdx = sessionCluster[s.id] ?? 0;
              return (
                <button
                  key={s.id}
                  onClick={() => handleSessionClick(s)}
                  className="w-full px-4 py-2.5 text-left hover:bg-gray-800/50 transition-colors flex items-center gap-3"
                >
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[clusterIdx % COLORS.length] }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-200 truncate">{s.name}</div>
                    <div className="text-xs text-gray-500 truncate">{s.full}</div>
                  </div>
                  <span className="text-xs text-gray-500">T{s.tier}</span>
                  {cx && (
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      cx.bucket === 'Very Complex' ? 'bg-red-500/20 text-red-400' :
                      cx.bucket === 'Complex' ? 'bg-orange-500/20 text-orange-400' :
                      cx.bucket === 'Medium' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-green-500/20 text-green-400'
                    }`}>
                      {Math.round(cx.score)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <TierView sessions={sessions} connections={connections} onSessionClick={handleSessionClick} />
        )}
      </div>

      {/* Right Panel — Domain Profile */}
      <div className="w-72 border-l border-gray-700/50 overflow-y-auto bg-gray-900/50 p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Domain Profile</h3>
        <div className="space-y-2">
          <ProfileStat label="Sessions" value={sessions.length} />
          <ProfileStat label="Sub-clusters" value={Object.keys(subClusters).length} />
          <ProfileStat label="Connections" value={connections.length} />
          {complexityScores.length > 0 && (
            <ProfileStat
              label="Avg Complexity"
              value={Math.round(complexityScores.reduce((s, c) => s + c.overall_score, 0) / complexityScores.length)}
            />
          )}
        </div>

        <div className="mt-4">
          <div className="text-xs text-gray-500 mb-2">Tier Distribution</div>
          {Object.entries(sessions.reduce<Record<number, number>>((acc, s) => {
            acc[s.tier] = (acc[s.tier] || 0) + 1;
            return acc;
          }, {})).sort(([a], [b]) => Number(a) - Number(b)).map(([tier, count]) => (
            <div key={tier} className="flex justify-between text-xs mb-0.5">
              <span className="text-gray-400">Tier {tier}</span>
              <span className="text-gray-300">{count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProfileStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-sm text-gray-200 font-medium">{value}</span>
    </div>
  );
}

function TierView({ sessions, connections, onSessionClick }: {
  sessions: TierSession[];
  connections: TierConn[];
  onSessionClick: (s: TierSession) => void;
}) {
  const tiers = useMemo(() => {
    const grouped: Record<number, TierSession[]> = {};
    for (const s of sessions) {
      (grouped[s.tier] ??= []).push(s);
    }
    return Object.entries(grouped).sort(([a], [b]) => Number(a) - Number(b));
  }, [sessions]);

  return (
    <div className="p-4 space-y-4">
      {tiers.map(([tier, tierSessions]) => (
        <div key={tier}>
          <div className="text-xs text-gray-500 font-medium mb-1">Tier {tier}</div>
          <div className="flex flex-wrap gap-2">
            {tierSessions.map(s => (
              <button
                key={s.id}
                onClick={() => onSessionClick(s)}
                className="px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-xs text-gray-300 transition-colors border border-gray-700"
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
