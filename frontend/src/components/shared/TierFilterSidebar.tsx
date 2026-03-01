/**
 * Reusable Tier Filter Sidebar — collapsible tier checkboxes + search for any view.
 * Provide sessions/tables/connections and get back a filtered TierMapResult.
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import { getTierCfg, connTypes } from '../tiermap/constants';

function tierColor(t: number): string {
  return getTierCfg(t).color;
}

const CONN_TYPES = Object.entries(connTypes).map(([key, cfg]) => ({
  key,
  label: cfg.label,
  color: cfg.color,
}));

export interface TierFilters {
  hiddenTiers: Set<number>;
  search: string;
  hiddenConnTypes: Set<string>;
}

export function getDefaultTierFilters(): TierFilters {
  return { hiddenTiers: new Set(), search: '', hiddenConnTypes: new Set() };
}

export function applyTierFilters(data: TierMapResult, filters: TierFilters): TierMapResult {
  let sessions = data.sessions;
  let tables = data.tables;
  let connections = data.connections;

  if (filters.hiddenTiers.size > 0) {
    sessions = sessions.filter(s => !filters.hiddenTiers.has(s.tier));
    tables = tables.filter(t => !filters.hiddenTiers.has(Math.round(t.tier)));
  }

  if (filters.search.trim()) {
    const q = filters.search.toLowerCase();
    sessions = sessions.filter(s =>
      s.name.toLowerCase().includes(q) || s.full.toLowerCase().includes(q)
    );
  }

  if (filters.hiddenConnTypes.size > 0) {
    connections = connections.filter(c => !filters.hiddenConnTypes.has(c.type));
  }

  const sIds = new Set(sessions.map(s => s.id));
  const tIds = new Set(tables.map(t => t.id));
  connections = connections.filter(c =>
    (sIds.has(c.from) || tIds.has(c.from)) && (sIds.has(c.to) || tIds.has(c.to))
  );

  return { ...data, sessions, tables, connections };
}

interface Props {
  data: TierMapResult;
  filters: TierFilters;
  onChange: (filters: TierFilters) => void;
  compact?: boolean;
}

export default function TierFilterSidebar({ data, filters, onChange, compact }: Props) {
  const [expanded, setExpanded] = useState(!compact);

  const tiers = useMemo(() => {
    const tierMap = new Map<number, number>();
    data.sessions.forEach(s => tierMap.set(s.tier, (tierMap.get(s.tier) || 0) + 1));
    return [...tierMap.entries()].sort((a, b) => a[0] - b[0]);
  }, [data.sessions]);

  const connCounts = useMemo(() => {
    const m = new Map<string, number>();
    data.connections.forEach(c => m.set(c.type, (m.get(c.type) || 0) + 1));
    return m;
  }, [data.connections]);

  const toggleTier = useCallback((tier: number) => {
    const next = new Set(filters.hiddenTiers);
    if (next.has(tier)) next.delete(tier); else next.add(tier);
    onChange({ ...filters, hiddenTiers: next });
  }, [filters, onChange]);

  const toggleConn = useCallback((type: string) => {
    const next = new Set(filters.hiddenConnTypes);
    if (next.has(type)) next.delete(type); else next.add(type);
    onChange({ ...filters, hiddenConnTypes: next });
  }, [filters, onChange]);

  const setSearch = useCallback((search: string) => {
    onChange({ ...filters, search });
  }, [filters, onChange]);

  const resetAll = useCallback(() => {
    onChange(getDefaultTierFilters());
  }, [onChange]);

  const activeCount = filters.hiddenTiers.size > 0 || filters.search || filters.hiddenConnTypes.size > 0;

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        style={{
          padding: '4px 10px', borderRadius: 4, border: '1px solid #1e293b',
          background: activeCount ? 'rgba(59,130,246,0.1)' : 'rgba(0,0,0,0.2)',
          color: activeCount ? '#60A5FA' : '#64748b', fontSize: 10,
          cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        Tier Filter{activeCount ? ' *' : ''}
      </button>
    );
  }

  return (
    <div style={{
      width: 200, borderLeft: '1px solid #1e293b', background: 'rgba(8,12,20,0.95)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Tier Filter
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {activeCount && (
            <button onClick={resetAll} style={miniBtn}>Reset</button>
          )}
          <button onClick={() => setExpanded(false)} style={miniBtn}>Hide</button>
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #1e293b' }}>
        <input
          type="text"
          placeholder="Filter sessions…"
          value={filters.search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%', padding: '4px 8px', borderRadius: 4,
            border: '1px solid #1e293b', background: 'rgba(0,0,0,0.3)',
            color: '#e2e8f0', fontSize: 10, outline: 'none',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
        {/* Tier checkboxes */}
        <div style={{ padding: '4px 10px' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', marginBottom: 4, textTransform: 'uppercase' }}>
            Tiers
          </div>
          {tiers.map(([tier, count]) => {
            const active = !filters.hiddenTiers.has(tier);
            const color = tierColor(tier);
            return (
              <div
                key={tier}
                onClick={() => toggleTier(tier)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '3px 0', cursor: 'pointer', opacity: active ? 1 : 0.4,
                }}
              >
                <div style={{
                  width: 12, height: 12, borderRadius: 2,
                  border: `2px solid ${color}`,
                  background: active ? `${color}30` : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {active && <div style={{ width: 5, height: 5, borderRadius: 1, background: color }} />}
                </div>
                <span style={{ fontSize: 10, color: active ? '#e2e8f0' : '#475569', flex: 1 }}>
                  Tier {tier}
                </span>
                <span style={{ fontSize: 9, color: '#475569' }}>{count}</span>
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button onClick={() => onChange({ ...filters, hiddenTiers: new Set() })} style={{ ...tinyBtn, color: '#3b82f6' }}>All</button>
            <button onClick={() => onChange({ ...filters, hiddenTiers: new Set(tiers.map(([t]) => t)) })} style={{ ...tinyBtn, color: '#ef4444' }}>None</button>
          </div>
        </div>

        {/* Connection type toggles */}
        <div style={{ padding: '8px 10px', borderTop: '1px solid #1e293b', marginTop: 4 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', marginBottom: 4, textTransform: 'uppercase' }}>
            Connections
          </div>
          {CONN_TYPES.map(ct => {
            const count = connCounts.get(ct.key) || 0;
            if (count === 0) return null;
            const active = !filters.hiddenConnTypes.has(ct.key);
            return (
              <div
                key={ct.key}
                onClick={() => toggleConn(ct.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '3px 0', cursor: 'pointer', opacity: active ? 1 : 0.4,
                }}
              >
                <div style={{
                  width: 12, height: 12, borderRadius: 2,
                  border: `2px solid ${ct.color}`,
                  background: active ? `${ct.color}30` : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {active && <div style={{ width: 5, height: 5, borderRadius: 1, background: ct.color }} />}
                </div>
                <span style={{ fontSize: 10, color: active ? '#e2e8f0' : '#475569', flex: 1 }}>
                  {ct.label}
                </span>
                <span style={{ fontSize: 9, color: '#475569' }}>{count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  padding: '2px 6px', borderRadius: 3, border: '1px solid rgba(255,255,255,0.08)',
  background: 'transparent', color: '#64748b', fontSize: 9, cursor: 'pointer',
};

const tinyBtn: React.CSSProperties = {
  padding: '2px 6px', borderRadius: 3, border: 'none',
  background: 'rgba(255,255,255,0.05)', fontSize: 9, cursor: 'pointer',
};
