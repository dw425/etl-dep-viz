/**
 * GalaxyFilterSidebar — Full filter/slicer sidebar for the Galaxy Map.
 * Lets users control what is visible at different exploration levels:
 *  - Tier filter (show/hide specific tiers)
 *  - Connection type filter (write_conflict, chain, etc.)
 *  - Session size filter (min/max transforms)
 *  - Conflict-only toggle
 *  - Min connections threshold
 *  - Table type filter
 *  - Search within galaxy
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { TierMapResult } from '../../types/tiermap';

export interface GalaxyFilters {
  tiers: Set<number>;
  connectionTypes: Set<string>;
  minTransforms: number;
  maxTransforms: number;
  conflictsOnly: boolean;
  minConnections: number;
  showEdges: boolean;
  showLabels: boolean;
  tableTypes: Set<string>;
}

interface Props {
  data: TierMapResult;
  filters: GalaxyFilters;
  onFiltersChange: (filters: GalaxyFilters) => void;
  visible: boolean;
  onToggle: () => void;
}

const CONN_TYPES: { key: string; label: string; color: string }[] = [
  { key: 'write_conflict', label: 'Write Conflict', color: '#EF4444' },
  { key: 'write_clean', label: 'Write (clean)', color: '#3B82F6' },
  { key: 'read_after_write', label: 'Read After Write', color: '#A855F7' },
  { key: 'lookup_stale', label: 'Lookup (stale)', color: '#F59E0B' },
  { key: 'chain', label: 'Chain', color: '#F97316' },
  { key: 'source_read', label: 'Source Read', color: '#10B981' },
];

const TABLE_TYPES: { key: string; label: string; color: string }[] = [
  { key: 'conflict', label: 'Conflict', color: '#EF4444' },
  { key: 'chain', label: 'Chain', color: '#F97316' },
  { key: 'independent', label: 'Independent', color: '#22C55E' },
  { key: 'source', label: 'Source', color: '#10B981' },
];

/** Build default GalaxyFilters from the data: all tiers, all connection types, full transform range, all table types enabled. */
export function getDefaultFilters(data: TierMapResult): GalaxyFilters {
  const tiers = new Set(data.sessions.map(s => s.tier));
  const connTypes = new Set(data.connections.map(c => c.type));
  const transforms = data.sessions.map(s => s.transforms);
  const tableTypes = new Set(data.tables.map(t => t.type));
  return {
    tiers,
    connectionTypes: connTypes,
    minTransforms: 0,
    maxTransforms: Math.max(1, ...transforms),
    conflictsOnly: false,
    minConnections: 0,
    showEdges: true,
    showLabels: true,
    tableTypes,
  };
}

/** Apply GalaxyFilters to a TierMapResult, returning a new result with only matching sessions, connections, and tables. */
export function applyGalaxyFilters(data: TierMapResult, filters: GalaxyFilters): TierMapResult {
  let sessions = data.sessions.filter(s => {
    if (!filters.tiers.has(s.tier)) return false;
    if (s.transforms < filters.minTransforms) return false;
    if (s.transforms > filters.maxTransforms) return false;
    if (filters.conflictsOnly && !s.critical) return false;
    return true;
  });

  if (filters.minConnections > 0) {
    const connCount = new Map<string, number>();
    data.connections.forEach(c => {
      connCount.set(c.from, (connCount.get(c.from) || 0) + 1);
      connCount.set(c.to, (connCount.get(c.to) || 0) + 1);
    });
    sessions = sessions.filter(s => (connCount.get(s.id) || 0) >= filters.minConnections);
  }

  const sessionIds = new Set(sessions.map(s => s.id));
  const connections = data.connections.filter(c =>
    filters.connectionTypes.has(c.type) &&
    (sessionIds.has(c.from) || sessionIds.has(c.to))
  );

  const tables = data.tables.filter(t => filters.tableTypes.has(t.type));

  return { ...data, sessions, tables, connections };
}

/**
 * GalaxyFilterSidebar -- full filter/slicer sidebar for the Galaxy Map view.
 * Provides collapsible sections for tier filter, connection type filter, session
 * filters (conflicts only, min transforms, min connections), table type filter,
 * and display toggles (show edges, show labels). Renders as a compact "Filters (N/M)"
 * button when collapsed, and a 260px-wide glass-effect sidebar when expanded.
 */
export default function GalaxyFilterSidebar({ data, filters, onFiltersChange, visible, onToggle }: Props) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['tiers', 'connections', 'sessions'])
  );

  const toggleSection = useCallback((section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section); else next.add(section);
      return next;
    });
  }, []);

  const stats = useMemo(() => {
    const tiers = [...new Set(data.sessions.map(s => s.tier))].sort((a, b) => a - b);
    const transforms = data.sessions.map(s => s.transforms);
    const maxTransforms = Math.max(1, ...transforms);
    const conflictCount = data.sessions.filter(s => s.critical).length;
    const connTypeCounts = new Map<string, number>();
    data.connections.forEach(c => connTypeCounts.set(c.type, (connTypeCounts.get(c.type) || 0) + 1));
    const tableTypeCounts = new Map<string, number>();
    data.tables.forEach(t => tableTypeCounts.set(t.type, (tableTypeCounts.get(t.type) || 0) + 1));
    const tierCounts = new Map<number, number>();
    data.sessions.forEach(s => tierCounts.set(s.tier, (tierCounts.get(s.tier) || 0) + 1));
    return { tiers, maxTransforms, conflictCount, connTypeCounts, tableTypeCounts, tierCounts };
  }, [data]);

  const filtered = useMemo(() => applyGalaxyFilters(data, filters), [data, filters]);
  const activeCount = filtered.sessions.length;
  const totalCount = data.sessions.length;

  const updateFilter = useCallback(<K extends keyof GalaxyFilters>(key: K, value: GalaxyFilters[K]) => {
    onFiltersChange({ ...filters, [key]: value });
  }, [filters, onFiltersChange]);

  const toggleSetItem = useCallback(<T,>(key: keyof GalaxyFilters, item: T) => {
    const current = filters[key] as Set<T>;
    const next = new Set(current);
    if (next.has(item)) next.delete(item); else next.add(item);
    onFiltersChange({ ...filters, [key]: next });
  }, [filters, onFiltersChange]);

  const resetFilters = useCallback(() => {
    onFiltersChange(getDefaultFilters(data));
  }, [data, onFiltersChange]);

  if (!visible) {
    return (
      <button
        onClick={onToggle}
        style={{
          position: 'absolute', top: 56, left: 8, zIndex: 15,
          padding: '6px 12px', borderRadius: 8,
          background: 'rgba(4,8,18,0.95)', border: '1px solid rgba(255,255,255,0.1)',
          color: '#8899aa', fontSize: 11, cursor: 'pointer',
        }}
      >
        Filters ({activeCount}/{totalCount})
      </button>
    );
  }

  return (
    <div style={{
      position: 'absolute', top: 48, left: 0, bottom: 0, width: 260,
      background: 'rgba(4,8,18,0.97)', backdropFilter: 'blur(12px)',
      borderRight: '1px solid rgba(255,255,255,0.08)', zIndex: 15,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>Filters & Slicers</div>
          <div style={{ fontSize: 10, color: '#8899aa', marginTop: 2 }}>
            {activeCount}/{totalCount} sessions visible
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={resetFilters} style={miniBtn}>Reset</button>
          <button onClick={onToggle} style={miniBtn}>Hide</button>
        </div>
      </div>

      {/* Scrollable filter sections */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>

        {/* ── Tier Filter ────────────────────────────────────── */}
        <FilterSection
          title="Tiers"
          expanded={expandedSections.has('tiers')}
          onToggle={() => toggleSection('tiers')}
        >
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '4px 14px 8px' }}>
            {stats.tiers.map(tier => {
              const active = filters.tiers.has(tier);
              const count = stats.tierCounts.get(tier) || 0;
              const colors = ['#3B82F6','#EAB308','#A855F7','#10B981','#F97316','#06B6D4','#EC4899','#84CC16'];
              const color = colors[Math.max(0, Math.floor(tier) - 1) % colors.length];
              return (
                <button
                  key={tier}
                  onClick={() => toggleSetItem('tiers', tier)}
                  style={{
                    padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    background: active ? `${color}20` : 'rgba(255,255,255,0.03)',
                    color: active ? color : '#4a5a6e',
                    fontSize: 10, fontWeight: 600,
                    opacity: active ? 1 : 0.5,
                  }}
                >
                  T{tier} ({count})
                </button>
              );
            })}
          </div>
          <div style={{ padding: '0 14px 8px', display: 'flex', gap: 6 }}>
            <button
              onClick={() => updateFilter('tiers', new Set(stats.tiers))}
              style={{ ...tinyBtn, color: '#3b82f6' }}
            >All</button>
            <button
              onClick={() => updateFilter('tiers', new Set())}
              style={{ ...tinyBtn, color: '#ef4444' }}
            >None</button>
          </div>
        </FilterSection>

        {/* ── Connection Types ────────────────────────────────── */}
        <FilterSection
          title="Connection Types"
          expanded={expandedSections.has('connections')}
          onToggle={() => toggleSection('connections')}
        >
          <div style={{ padding: '4px 14px 8px' }}>
            {CONN_TYPES.map(ct => {
              const active = filters.connectionTypes.has(ct.key);
              const count = stats.connTypeCounts.get(ct.key) || 0;
              if (count === 0) return null;
              return (
                <div
                  key={ct.key}
                  onClick={() => toggleSetItem('connectionTypes', ct.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '4px 0', cursor: 'pointer',
                    opacity: active ? 1 : 0.4,
                  }}
                >
                  <div style={{
                    width: 14, height: 14, borderRadius: 3,
                    border: `2px solid ${ct.color}`,
                    background: active ? `${ct.color}30` : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {active && <div style={{ width: 6, height: 6, borderRadius: 1, background: ct.color }} />}
                  </div>
                  <span style={{ fontSize: 10, color: active ? '#e2e8f0' : '#5a6a7a', flex: 1 }}>
                    {ct.label}
                  </span>
                  <span style={{ fontSize: 9, color: '#5a6a7a' }}>{count}</span>
                </div>
              );
            })}
          </div>
        </FilterSection>

        {/* ── Session Filters ────────────────────────────────── */}
        <FilterSection
          title="Sessions"
          expanded={expandedSections.has('sessions')}
          onToggle={() => toggleSection('sessions')}
        >
          <div style={{ padding: '4px 14px 8px' }}>
            {/* Conflicts only toggle */}
            <div
              onClick={() => updateFilter('conflictsOnly', !filters.conflictsOnly)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 0', cursor: 'pointer',
              }}
            >
              <div style={{
                width: 14, height: 14, borderRadius: 3,
                border: `2px solid ${filters.conflictsOnly ? '#EF4444' : '#4a5a6e'}`,
                background: filters.conflictsOnly ? '#EF444430' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {filters.conflictsOnly && <div style={{ width: 6, height: 6, borderRadius: 1, background: '#EF4444' }} />}
              </div>
              <span style={{ fontSize: 10, color: filters.conflictsOnly ? '#e2e8f0' : '#8899aa' }}>
                Conflicts only ({stats.conflictCount})
              </span>
            </div>

            {/* Min transforms */}
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 9, color: '#8899aa', marginBottom: 4 }}>
                Min transforms: {filters.minTransforms}
              </div>
              <input
                type="range"
                min={0}
                max={stats.maxTransforms}
                value={filters.minTransforms}
                onChange={e => updateFilter('minTransforms', parseInt(e.target.value))}
                style={{ width: '100%', accentColor: '#3b82f6' }}
              />
            </div>

            {/* Min connections */}
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 9, color: '#8899aa', marginBottom: 4 }}>
                Min connections: {filters.minConnections}
              </div>
              <input
                type="range"
                min={0}
                max={20}
                value={filters.minConnections}
                onChange={e => updateFilter('minConnections', parseInt(e.target.value))}
                style={{ width: '100%', accentColor: '#3b82f6' }}
              />
            </div>
          </div>
        </FilterSection>

        {/* ── Table Types ────────────────────────────────── */}
        <FilterSection
          title="Table Types"
          expanded={expandedSections.has('tables')}
          onToggle={() => toggleSection('tables')}
        >
          <div style={{ padding: '4px 14px 8px' }}>
            {TABLE_TYPES.map(tt => {
              const active = filters.tableTypes.has(tt.key);
              const count = stats.tableTypeCounts.get(tt.key) || 0;
              if (count === 0) return null;
              return (
                <div
                  key={tt.key}
                  onClick={() => toggleSetItem('tableTypes', tt.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '4px 0', cursor: 'pointer',
                    opacity: active ? 1 : 0.4,
                  }}
                >
                  <div style={{
                    width: 14, height: 14, borderRadius: 3,
                    border: `2px solid ${tt.color}`,
                    background: active ? `${tt.color}30` : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {active && <div style={{ width: 6, height: 6, borderRadius: 1, background: tt.color }} />}
                  </div>
                  <span style={{ fontSize: 10, color: active ? '#e2e8f0' : '#5a6a7a', flex: 1 }}>
                    {tt.label}
                  </span>
                  <span style={{ fontSize: 9, color: '#5a6a7a' }}>{count}</span>
                </div>
              );
            })}
          </div>
        </FilterSection>

        {/* ── Display Options ────────────────────────────────── */}
        <FilterSection
          title="Display"
          expanded={expandedSections.has('display')}
          onToggle={() => toggleSection('display')}
        >
          <div style={{ padding: '4px 14px 8px' }}>
            <ToggleOption
              label="Show edges"
              active={filters.showEdges}
              onChange={() => updateFilter('showEdges', !filters.showEdges)}
            />
            <ToggleOption
              label="Show labels"
              active={filters.showLabels}
              onChange={() => updateFilter('showLabels', !filters.showLabels)}
            />
          </div>
        </FilterSection>
      </div>
    </div>
  );
}

/** Collapsible filter section with uppercase title header and expand/collapse chevron. */
function FilterSection({ title, expanded, onToggle, children }: {
  title: string; expanded: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div
        onClick={onToggle}
        style={{
          padding: '8px 14px', cursor: 'pointer', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {title}
        </span>
        <span style={{ fontSize: 10, color: '#5a6a7a' }}>{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>
      {expanded && children}
    </div>
  );
}

/** Pill-shaped toggle switch with label (used for show edges / show labels display options). */
function ToggleOption({ label, active, onChange }: { label: string; active: boolean; onChange: () => void }) {
  return (
    <div
      onClick={onChange}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' }}
    >
      <div style={{
        width: 28, height: 14, borderRadius: 7,
        background: active ? '#3B82F6' : '#3a4a5e',
        position: 'relative', transition: 'background 0.15s',
      }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: '#fff', position: 'absolute', top: 2,
          left: active ? 16 : 2, transition: 'left 0.15s',
        }} />
      </div>
      <span style={{ fontSize: 10, color: active ? '#e2e8f0' : '#8899aa' }}>{label}</span>
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.08)',
  background: 'transparent', color: '#8899aa', fontSize: 9, cursor: 'pointer',
};

const tinyBtn: React.CSSProperties = {
  padding: '2px 6px', borderRadius: 3, border: 'none',
  background: 'rgba(255,255,255,0.05)', fontSize: 9, cursor: 'pointer',
};
