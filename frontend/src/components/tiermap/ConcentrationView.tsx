/**
 * ConcentrationView -- V10 Concentration analysis results viewer.
 *
 * Visualizes gravity groups (clusters of tightly coupled sessions) and
 * independent sessions (safe to migrate without coordination).
 *
 * Layout:
 *   Top     — summary stats: group count, independent count, optimal K, silhouette score
 *   Left    — selectable group list + independent sessions toggle
 *   Right   — GroupProfile (metrics, core tables, session list) or IndependentList
 *
 * Key concepts:
 *   - Gravity group: sessions clustered by shared table dependencies (V10 engine)
 *   - Medoid: the most central session in a group
 *   - Cohesion: intra-group similarity (higher = tighter cluster)
 *   - Coupling: inter-group dependency (lower = more isolated)
 *   - Independent sessions: "full" (no shared deps) or "partial" (weak deps)
 *
 * @param concentration  - V10 result with gravity_groups, independent_sessions, silhouette
 * @param onSessionSelect - Callback when a session is clicked in the group or independent list
 */

import React, { useState } from 'react';
import type { ConcentrationResult, GravityGroup, IndependentSession } from '../../types/vectors';

const COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#A855F7',
  '#06B6D4', '#EC4899', '#84CC16', '#F97316', '#8B5CF6',
];

interface Props {
  concentration: ConcentrationResult;
  onSessionSelect?: (sessionId: string) => void;
}

/**
 * ConcentrationView -- V10 concentration analysis results viewer. Displays
 * gravity groups (clusters of tightly coupled sessions) and independent
 * sessions (safe to migrate without coordination). Left panel shows a
 * selectable group list; right panel shows GroupProfile (metrics, core
 * tables, session list) or IndependentList depending on selection.
 */
export default function ConcentrationView({ concentration, onSessionSelect }: Props) {
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [showIndependent, setShowIndependent] = useState(false);

  const activeGroup = selectedGroup !== null
    ? concentration.gravity_groups.find(g => g.group_id === selectedGroup)
    : null;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 px-4 py-3 bg-gray-800 rounded-lg border border-gray-700">
        <SumStat label="Groups" value={concentration.gravity_groups.length} />
        <SumStat label="Independent" value={concentration.independent_sessions.length} />
        <SumStat label="Optimal K" value={concentration.optimal_k} />
        <SumStat label="Silhouette" value={concentration.silhouette.toFixed(3)} />
      </div>

      <div className="flex gap-4">
        {/* Group List */}
        <div className="w-72">
          <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden mb-2">
            <div className="px-3 py-2 border-b border-gray-700 text-xs text-gray-500">
              Gravity Groups
            </div>
            {concentration.gravity_groups.map((g, i) => (
              <button
                key={g.group_id}
                onClick={() => setSelectedGroup(g.group_id)}
                className={`w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-gray-700/50 transition-colors ${
                  selectedGroup === g.group_id ? 'bg-blue-500/10' : ''
                }`}
              >
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                <span className="text-xs text-gray-300 flex-1">Group {g.group_id}</span>
                <span className="text-xs text-gray-500">{g.session_count}</span>
              </button>
            ))}
          </div>

          {concentration.independent_sessions.length > 0 && (
            <button
              onClick={() => setShowIndependent(!showIndependent)}
              className="w-full px-3 py-2 bg-gray-800 rounded-lg border border-gray-700 text-left flex items-center gap-2 hover:bg-gray-700/50 transition-colors"
            >
              <div className="w-3 h-3 rounded-full bg-gray-500" />
              <span className="text-xs text-gray-300 flex-1">Independent Sessions</span>
              <span className="text-xs text-gray-500">{concentration.independent_sessions.length}</span>
              <span className="text-[10px] text-gray-600">{showIndependent ? '▲' : '▼'}</span>
            </button>
          )}
        </div>

        {/* Detail Panel */}
        <div className="flex-1">
          {activeGroup ? (
            <GroupProfile group={activeGroup} colorIdx={concentration.gravity_groups.indexOf(activeGroup)} onSessionSelect={onSessionSelect} />
          ) : showIndependent ? (
            <IndependentList sessions={concentration.independent_sessions} onSessionSelect={onSessionSelect} />
          ) : (
            <div className="flex items-center justify-center h-32 text-sm text-gray-500">
              Select a gravity group to view its profile
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Detail card for a single gravity group: session count, cohesion, coupling, core tables, and clickable session list. */
function GroupProfile({ group, colorIdx, onSessionSelect }: { group: GravityGroup; colorIdx: number; onSessionSelect?: (sid: string) => void }) {
  return (
    <div className="space-y-3">
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-4 h-4 rounded-full" style={{ backgroundColor: COLORS[colorIdx % COLORS.length] }} />
          <h3 className="text-sm font-medium text-gray-300">Group {group.group_id}</h3>
          <span className="text-xs text-gray-500">Medoid: {group.medoid_session_id}</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <div className="text-lg font-bold text-gray-200">{group.session_count}</div>
            <div className="text-[10px] text-gray-500">Sessions</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-gray-200">{group.cohesion.toFixed(3)}</div>
            <div className="text-[10px] text-gray-500">Cohesion</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-gray-200">{group.coupling.toFixed(3)}</div>
            <div className="text-[10px] text-gray-500">Coupling</div>
          </div>
        </div>
      </div>

      {group.core_tables.length > 0 && (
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-3">
          <div className="text-xs text-gray-500 mb-2">Core Tables</div>
          <div className="flex flex-wrap gap-1">
            {group.core_tables.map(t => (
              <span key={t} className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded text-xs">{t}</span>
            ))}
          </div>
        </div>
      )}

      <div className="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div className="text-xs text-gray-500 mb-2">Sessions</div>
        <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
          {group.session_ids.map(sid => (
            <button
              key={sid}
              onClick={() => onSessionSelect?.(sid)}
              className="px-2 py-0.5 bg-gray-700 rounded text-xs text-gray-300 hover:bg-gray-600 transition-colors"
            >
              {sid}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Scrollable list of independent sessions with independence type badge (full/partial) and confidence percentage. */
function IndependentList({ sessions, onSessionSelect }: { sessions: IndependentSession[]; onSessionSelect?: (sid: string) => void }) {
  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <h3 className="text-sm font-medium text-gray-300 mb-3">Independent Sessions</h3>
      <p className="text-xs text-gray-500 mb-3">
        These sessions can be migrated without coordination — no shared dependencies.
      </p>
      <div className="space-y-1.5 max-h-64 overflow-y-auto">
        {sessions.map(s => (
          <button
            key={s.session_id}
            onClick={() => onSessionSelect?.(s.session_id)}
            className="w-full px-3 py-2 text-left bg-gray-700/50 rounded flex items-center gap-2 hover:bg-gray-700 transition-colors"
          >
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              s.independence_type === 'full' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
            }`}>
              {s.independence_type}
            </span>
            <span className="text-xs text-gray-300 flex-1">{s.session_id}</span>
            <span className="text-xs text-gray-500">{Math.round(s.confidence * 100)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Compact stat badge showing a large value and small label (used in the summary bar). */
function SumStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-sm font-medium text-gray-200">{value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}
