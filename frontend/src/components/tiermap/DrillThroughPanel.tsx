/**
 * DrillThroughPanel — multi-dimension filter/facet sidebar.
 * Supports slicing by any combination of V1–V11 dimensions.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { VectorResults, DrillFilter } from '../../types/vectors';

interface Props {
  vectorResults: VectorResults;
  filter: DrillFilter;
  onFilterChange: (filter: DrillFilter) => void;
  matchingCount?: number;
  uploadId?: number | null;
}

const STORAGE_PREFIX = 'edv-drill-filter-';

/**
 * DrillThroughPanel -- multi-dimension filter sidebar for slicing the session
 * population by V1-V11 vector analysis dimensions (complexity bucket, wave number,
 * criticality tier, community, independence status). Persists filter state to
 * localStorage keyed by uploadId so filters survive page reloads.
 */
export default function DrillThroughPanel({ vectorResults, filter, onFilterChange, matchingCount, uploadId }: Props) {
  // Restore persisted filters on mount (Item 72)
  useEffect(() => {
    if (!uploadId) return;
    try {
      const stored = localStorage.getItem(`${STORAGE_PREFIX}${uploadId}`);
      if (stored) {
        const parsed = JSON.parse(stored) as DrillFilter;
        if (Object.keys(parsed).length > 0) onFilterChange(parsed);
      }
    } catch { /* ignore */ }
  }, [uploadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist filter changes
  useEffect(() => {
    if (!uploadId) return;
    try {
      if (Object.keys(filter).length > 0) {
        localStorage.setItem(`${STORAGE_PREFIX}${uploadId}`, JSON.stringify(filter));
      } else {
        localStorage.removeItem(`${STORAGE_PREFIX}${uploadId}`);
      }
    } catch { /* ignore */ }
  }, [filter, uploadId]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    complexity: true,
    wave: false,
    criticality: false,
    community: false,
    independence: false,
  });

  const toggleSection = useCallback((key: string) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const updateFilter = useCallback((key: keyof DrillFilter, value: unknown) => {
    const next = { ...filter };
    if (value === undefined || value === null || value === '') {
      delete next[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
    onFilterChange(next);
  }, [filter, onFilterChange]);

  const clearAll = useCallback(() => {
    onFilterChange({});
  }, [onFilterChange]);

  const activeFilterCount = Object.keys(filter).length;

  // Bucket distribution for complexity
  const bucketDist = vectorResults.v11_complexity?.bucket_distribution ?? {};
  const waveCount = vectorResults.v4_wave_plan?.waves?.length ?? 0;
  const communityCount = Object.keys(vectorResults.v1_communities?.macro_communities ?? {}).length;

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <h3 className="text-sm font-medium text-gray-300">Drill-Through Filters</h3>
        {activeFilterCount > 0 && (
          <button
            onClick={clearAll}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            Clear ({activeFilterCount})
          </button>
        )}
      </div>

      {matchingCount !== undefined && (
        <div className="px-3 py-1.5 bg-blue-500/5 border-b border-gray-700 text-xs text-blue-400">
          {matchingCount} sessions matching
        </div>
      )}

      {/* Complexity Bucket */}
      <FilterSection
        title="Complexity"
        expanded={expanded.complexity}
        onToggle={() => toggleSection('complexity')}
      >
        <div className="space-y-1">
          {['Simple', 'Medium', 'Complex', 'Very Complex'].map(bucket => {
            const count = bucketDist[bucket] ?? 0;
            const isActive = filter.complexity_bucket === bucket;
            return (
              <button
                key={bucket}
                onClick={() => updateFilter('complexity_bucket', isActive ? undefined : bucket)}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors ${
                  isActive ? 'bg-blue-500/20 text-blue-400' : 'text-gray-400 hover:bg-gray-700'
                }`}
              >
                <div className={`w-2 h-2 rounded-full ${
                  bucket === 'Simple' ? 'bg-green-400' :
                  bucket === 'Medium' ? 'bg-yellow-400' :
                  bucket === 'Complex' ? 'bg-orange-400' : 'bg-red-400'
                }`} />
                <span className="flex-1 text-left">{bucket}</span>
                <span className="text-gray-600">{count}</span>
              </button>
            );
          })}
        </div>
      </FilterSection>

      {/* Wave Number */}
      <FilterSection
        title={`Wave (${waveCount} waves)`}
        expanded={expanded.wave}
        onToggle={() => toggleSection('wave')}
      >
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: waveCount }, (_, i) => i).map(w => {
            const isActive = filter.wave_number?.includes(w);
            return (
              <button
                key={w}
                onClick={() => {
                  const current = filter.wave_number ?? [];
                  const next = isActive ? current.filter(x => x !== w) : [...current, w];
                  updateFilter('wave_number', next.length > 0 ? next : undefined);
                }}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  isActive ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                W{w}
              </button>
            );
          })}
        </div>
      </FilterSection>

      {/* Criticality */}
      <FilterSection
        title="Criticality Tier"
        expanded={expanded.criticality}
        onToggle={() => toggleSection('criticality')}
      >
        <div className="space-y-1">
          {[1, 2, 3, 4, 5].map(tier => {
            const isActive = (filter.criticality_tier_min ?? 0) >= tier;
            return (
              <button
                key={tier}
                onClick={() => updateFilter('criticality_tier_min', isActive && filter.criticality_tier_min === tier ? undefined : tier)}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors ${
                  isActive ? 'bg-blue-500/20 text-blue-400' : 'text-gray-400 hover:bg-gray-700'
                }`}
              >
                <span className="flex-1 text-left">Tier {tier}+</span>
                <span className={`text-xs ${
                  tier >= 4 ? 'text-red-400' : tier >= 3 ? 'text-orange-400' : 'text-gray-500'
                }`}>
                  {'●'.repeat(tier)}
                </span>
              </button>
            );
          })}
        </div>
      </FilterSection>

      {/* Community */}
      <FilterSection
        title={`Community (${communityCount})`}
        expanded={expanded.community}
        onToggle={() => toggleSection('community')}
      >
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: communityCount }, (_, i) => i).map(c => {
            const isActive = filter.community_macro === c;
            return (
              <button
                key={c}
                onClick={() => updateFilter('community_macro', isActive ? undefined : c)}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  isActive ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                C{c}
              </button>
            );
          })}
        </div>
      </FilterSection>

      {/* Independence */}
      <FilterSection
        title="Independence"
        expanded={expanded.independence}
        onToggle={() => toggleSection('independence')}
      >
        <button
          onClick={() => updateFilter('is_independent', filter.is_independent ? undefined : true)}
          className={`w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors ${
            filter.is_independent ? 'bg-blue-500/20 text-blue-400' : 'text-gray-400 hover:bg-gray-700'
          }`}
        >
          <span className="flex-1 text-left">Independent only</span>
        </button>
      </FilterSection>
    </div>
  );
}

/** Collapsible filter section with title header and toggle chevron. */
function FilterSection({
  title,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-gray-700 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-700/50 transition-colors"
      >
        <span className="text-xs text-gray-400">{title}</span>
        <span className="text-xs text-gray-600">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && <div className="px-3 pb-2">{children}</div>}
    </div>
  );
}
