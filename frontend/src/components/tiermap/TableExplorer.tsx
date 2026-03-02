/**
 * TableExplorer — Data Harmonization view showing top 100 tables
 * with full read/write/lookup detail, similar to Lumen_Retro Explorer.
 * Left sidebar: top 100 tables ranked by reference count.
 * Right detail: writes, reads, lookups, calls for selected table.
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import TierFilterSidebar, { type TierFilters, getDefaultTierFilters, applyTierFilters } from '../shared/TierFilterSidebar';

interface Props {
  data: TierMapResult;
}

/** Aggregated profile for a single table showing all session references. */
interface TableProfile {
  name: string;
  id: string;
  /** Table type: 'conflict' | 'chain' | 'independent' | 'source' */
  type: string;
  tier: number;
  /** Sessions that write to this table */
  writers: string[];
  /** Sessions that read from this table */
  readers: string[];
  /** Sessions that use this table as a lookup */
  lookupUsers: string[];
  /** Total reference count (writers + readers + lookupUsers) */
  totalRefs: number;
}

const TYPE_COLORS: Record<string, string> = {
  conflict: '#EF4444',
  chain: '#F97316',
  independent: '#22C55E',
  source: '#10B981',
};

/**
 * TableExplorer -- table-centric explorer view. Left sidebar shows top 100
 * tables ranked by total reference count (readers + writers + lookups).
 * Right detail panel shows per-table breakdown: writers, readers, and
 * lookup users, with conflict badges for write-write conflicts.
 */
export default function TableExplorer({ data }: Props) {
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [tierFilters, setTierFilters] = useState<TierFilters>(getDefaultTierFilters);
  const filteredData = useMemo(() => applyTierFilters(data, tierFilters), [data, tierFilters]);

  // Build table profiles with all session references
  const tableProfiles = useMemo(() => {
    const profiles: Record<string, TableProfile> = {};

    // Initialize from table nodes
    for (const t of filteredData.tables) {
      profiles[t.name] = {
        name: t.name,
        id: t.id,
        type: t.type,
        tier: t.tier,
        writers: [],
        readers: [],
        lookupUsers: [],
        totalRefs: 0,
      };
    }

    // Count session references
    for (const s of filteredData.sessions) {
      for (const tbl of (s as any).sources || []) {
        if (!profiles[tbl]) profiles[tbl] = { name: tbl, id: '', type: 'source', tier: 0, writers: [], readers: [], lookupUsers: [], totalRefs: 0 };
        if (!profiles[tbl].readers.includes(s.full || s.name)) {
          profiles[tbl].readers.push(s.full || s.name);
        }
      }
      for (const tbl of (s as any).targets || []) {
        if (!profiles[tbl]) profiles[tbl] = { name: tbl, id: '', type: 'target', tier: 0, writers: [], readers: [], lookupUsers: [], totalRefs: 0 };
        if (!profiles[tbl].writers.includes(s.full || s.name)) {
          profiles[tbl].writers.push(s.full || s.name);
        }
      }
      for (const tbl of (s as any).lookups || []) {
        if (!profiles[tbl]) profiles[tbl] = { name: tbl, id: '', type: 'lookup', tier: 0, writers: [], readers: [], lookupUsers: [], totalRefs: 0 };
        if (!profiles[tbl].lookupUsers.includes(s.full || s.name)) {
          profiles[tbl].lookupUsers.push(s.full || s.name);
        }
      }
    }

    // Calculate total refs
    for (const p of Object.values(profiles)) {
      p.totalRefs = p.writers.length + p.readers.length + p.lookupUsers.length;
    }

    return profiles;
  }, [filteredData]);

  // Top 100 tables sorted by reference count
  const sortedTables = useMemo(() => {
    let tables = Object.values(tableProfiles)
      .sort((a, b) => b.totalRefs - a.totalRefs);
    if (searchTerm) {
      const term = searchTerm.toUpperCase();
      tables = tables.filter(t => t.name.includes(term));
    }
    return tables.slice(0, 100);
  }, [tableProfiles, searchTerm]);

  const selected = selectedTable ? tableProfiles[selectedTable] : null;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left sidebar: table list */}
      <div style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #1e293b' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            Top Tables ({Object.keys(tableProfiles).length} total)
          </div>
          <input
            type="text"
            placeholder="Search tables..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #1e293b',
              background: '#111827', color: '#e2e8f0', fontSize: 11, outline: 'none',
            }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {sortedTables.map((t, idx) => {
            const isSel = selectedTable === t.name;
            return (
              <div
                key={t.name}
                onClick={() => setSelectedTable(t.name === selectedTable ? null : t.name)}
                style={{
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                  background: isSel ? 'rgba(59,130,246,0.15)' : 'transparent',
                  border: `1px solid ${isSel ? 'rgba(59,130,246,0.4)' : 'transparent'}`,
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: isSel ? '#60a5fa' : '#e2e8f0', fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.name}
                    </div>
                    <div style={{ fontSize: 9, color: '#64748b', marginTop: 2 }}>
                      {t.totalRefs} references
                      {t.type === 'conflict' && <span style={{ color: '#ef4444', marginLeft: 4 }}>CONFLICT</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                    {t.readers.length > 0 && <Badge count={t.readers.length} label="R" color="#22C55E" />}
                    {t.writers.length > 0 && <Badge count={t.writers.length} label="W" color="#EF4444" />}
                    {t.lookupUsers.length > 0 && <Badge count={t.lookupUsers.length} label="L" color="#F59E0B" />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right detail panel */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {selected ? (
          <div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', fontFamily: "'JetBrains Mono', monospace" }}>
                {selected.name}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <Stat label="Type" value={selected.type} color={TYPE_COLORS[selected.type] || '#64748b'} />
                <Stat label="Tier" value={String(selected.tier)} />
                <Stat label="Total Refs" value={String(selected.totalRefs)} />
              </div>
            </div>

            {/* Writers */}
            <RefSection label="WRITES TO" icon="W" color="#EF4444" items={selected.writers} />
            {/* Readers */}
            <RefSection label="READS FROM" icon="R" color="#22C55E" items={selected.readers} />
            {/* Lookups */}
            <RefSection label="LOOKUP USERS" icon="L" color="#F59E0B" items={selected.lookupUsers} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.4 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>&#9664;</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Select a table to explore its references</div>
          </div>
        )}
      </div>
      <TierFilterSidebar data={data} filters={tierFilters} onChange={setTierFilters} compact />
    </div>
  );
}

/** Compact count badge (e.g., "3R", "2W", "1L") with color coding. */
function Badge({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <span style={{ fontSize: 9, padding: '2px 5px', borderRadius: 4, background: `${color}15`, color, fontWeight: 600 }}>
      {count}{label}
    </span>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: color || '#e2e8f0' }}>{value}</div>
      <div style={{ fontSize: 9, color: '#64748b' }}>{label}</div>
    </div>
  );
}

/** Expandable list of session references for a given relationship type (writes/reads/lookups). */
function RefSection({ label, icon, color, items }: { label: string; icon: string; color: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
        {label} ({items.length})
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map(name => (
          <span key={name} style={{
            fontSize: 10, padding: '4px 8px', borderRadius: 5, background: `${color}08`,
            color: '#e2e8f0', border: '1px solid transparent', fontFamily: "'JetBrains Mono', monospace",
          }}>
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}
