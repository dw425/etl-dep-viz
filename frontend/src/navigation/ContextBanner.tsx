/**
 * ContextBanner — per-layer summary strip always visible below breadcrumb.
 * Shows key stats for the current navigation context.
 */

import React from 'react';
import { useNavigationContext } from './NavigationProvider';

/**
 * Renders a per-layer summary strip below the breadcrumb, showing key statistics
 * for the current navigation context (e.g. session count, wave count at L1;
 * group name at L2; scope at L3; session name at L4).
 */
export default function ContextBanner() {
  const { currentLayer, vectorResults, tierData, currentParams } = useNavigationContext();

  if (!tierData) return null;

  const stats = vectorResults;
  const v11 = stats?.v11_complexity;
  const v4 = stats?.v4_wave_plan;
  const v10 = stats?.v10_concentration;

  let content: React.ReactNode;

  switch (currentLayer) {
    case 1:
      content = (
        <span className="flex items-center gap-3 flex-wrap">
          <Stat label="Sessions" value={tierData.sessions.length} />
          <Stat label="Groups" value={stats?.v1_communities?.supernode_graph?.supernodes?.length ?? '—'} />
          <Stat label="Independent" value={v10?.independent_sessions?.length ?? '—'} />
          <Stat label="Waves" value={v4?.waves?.length ?? '—'} />
          <Stat label="Est. Hours" value={
            v11 ? `${Math.round(v11.total_hours_low)}–${Math.round(v11.total_hours_high)}` : '—'
          } />
        </span>
      );
      break;
    case 2:
      content = (
        <span className="flex items-center gap-3">
          <Stat label="Group" value={currentParams.groupLabel || currentParams.groupId || ''} />
          <Stat label="Sessions" value={currentParams.sessionCount || '—'} />
        </span>
      );
      break;
    case 3:
      content = (
        <span className="flex items-center gap-3">
          <Stat label="Scope" value={currentParams.scopeLabel || currentParams.scopeId || ''} />
        </span>
      );
      break;
    case 4:
      content = (
        <span className="flex items-center gap-3">
          <Stat label="Session" value={currentParams.sessionName || currentParams.sessionId || ''} />
        </span>
      );
      break;
    default:
      content = <span className="text-gray-500">Layer {currentLayer}</span>;
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs bg-gray-800/50 border-b border-gray-700/30 text-gray-400">
      <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium text-[10px]">
        L{currentLayer}
      </span>
      {content}
    </div>
  );
}

/** Inline label: value stat pair used within the banner. */
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span>
      <span className="text-gray-500">{label}:</span>{' '}
      <span className="text-gray-300 font-medium">{value}</span>
    </span>
  );
}
