/**
 * MatrixView.tsx -- Sessions (rows) x Tables (columns) grid. Each cell shows
 * connection type badges. Hover highlights the entire row/column.
 *
 * Optimized for large datasets (13K+ sessions, 19K+ tables):
 * - Sparse mode (default): only shows rows/columns with connections
 * - Paginated: 50 rows x 50 columns per page
 * - Search filter for sessions and tables
 */

import React, { useState, useMemo } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import { connTypes, connShortLabel, getTierCfg } from './constants';
import TierFilterSidebar, { type TierFilters, getDefaultTierFilters, applyTierFilters } from '../shared/TierFilterSidebar';

interface Props {
  data: TierMapResult;
}

const PAGE_SIZE = 50;

const MatrixView: React.FC<Props> = ({ data }) => {
  const [hov, setHov] = useState<string | null>(null);
  const [sparseMode, setSparseMode] = useState(true);
  const [rowPage, setRowPage] = useState(0);
  const [colPage, setColPage] = useState(0);
  const [search, setSearch] = useState('');
  const [tierFilters, setTierFilters] = useState<TierFilters>(getDefaultTierFilters);

  const filteredData = useMemo(() => applyTierFilters(data, tierFilters), [data, tierFilters]);

  /* ── Connection lookup + connected node tracking ──────────────────── */

  const { connLookup, connectedSessions, connectedTables } = useMemo(() => {
    const map = new Map<string, typeof filteredData.connections>();
    const sessSet = new Set<string>();
    const tblSet = new Set<string>();
    filteredData.connections.forEach(c => {
      const keyA = c.from + '|' + c.to;
      const keyB = c.to + '|' + c.from;
      if (!map.has(keyA)) map.set(keyA, []);
      map.get(keyA)!.push(c);
      if (!map.has(keyB)) map.set(keyB, []);
      map.get(keyB)!.push(c);
      // Track which sessions and tables have connections
      sessSet.add(c.from);
      sessSet.add(c.to);
      tblSet.add(c.from);
      tblSet.add(c.to);
    });
    return { connLookup: map, connectedSessions: sessSet, connectedTables: tblSet };
  }, [filteredData.connections]);

  /* ── Filtered rows & columns ──────────────────────────────────────── */

  const lowerSearch = search.toLowerCase();

  const filteredSessions = useMemo(() => {
    let sessions = filteredData.sessions;
    if (sparseMode) {
      sessions = sessions.filter(s => connectedSessions.has(s.id));
    }
    if (lowerSearch) {
      sessions = sessions.filter(s => s.name.toLowerCase().includes(lowerSearch));
    }
    return sessions;
  }, [filteredData.sessions, sparseMode, connectedSessions, lowerSearch]);

  const filteredTables = useMemo(() => {
    let tables = filteredData.tables;
    if (sparseMode) {
      tables = tables.filter(t => connectedTables.has(t.id));
    }
    if (lowerSearch) {
      tables = tables.filter(t => t.name.toLowerCase().includes(lowerSearch));
    }
    return tables;
  }, [filteredData.tables, sparseMode, connectedTables, lowerSearch]);

  /* ── Pagination ───────────────────────────────────────────────────── */

  const totalRowPages = Math.max(1, Math.ceil(filteredSessions.length / PAGE_SIZE));
  const totalColPages = Math.max(1, Math.ceil(filteredTables.length / PAGE_SIZE));
  const safeRowPage = Math.min(rowPage, totalRowPages - 1);
  const safeColPage = Math.min(colPage, totalColPages - 1);

  const pageSessions = filteredSessions.slice(safeRowPage * PAGE_SIZE, (safeRowPage + 1) * PAGE_SIZE);
  const pageTables = filteredTables.slice(safeColPage * PAGE_SIZE, (safeColPage + 1) * PAGE_SIZE);

  /* ── Pagination controls component ────────────────────────────────── */

  const PaginationBar = ({ label, page, totalPages, setPage }: {
    label: string; page: number; totalPages: number; setPage: (p: number) => void;
  }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, color: '#94A3B8' }}>{label}:</span>
      <button
        disabled={page <= 0}
        onClick={() => setPage(page - 1)}
        style={{
          padding: '2px 8px', borderRadius: 4, border: '1px solid #334155',
          background: page <= 0 ? '#1E293B' : '#334155', color: page <= 0 ? '#475569' : '#E2E8F0',
          cursor: page <= 0 ? 'default' : 'pointer', fontSize: 11,
        }}
      >
        Prev
      </button>
      <span style={{ fontSize: 11, color: '#CBD5E1', fontFamily: 'monospace' }}>
        {page + 1} / {totalPages}
      </span>
      <button
        disabled={page >= totalPages - 1}
        onClick={() => setPage(page + 1)}
        style={{
          padding: '2px 8px', borderRadius: 4, border: '1px solid #334155',
          background: page >= totalPages - 1 ? '#1E293B' : '#334155',
          color: page >= totalPages - 1 ? '#475569' : '#E2E8F0',
          cursor: page >= totalPages - 1 ? 'default' : 'pointer', fontSize: 11,
        }}
      >
        Next
      </button>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#E2E8F0', marginBottom: 6 }}>
        Many-to-Many Relationship Matrix
      </div>
      <div style={{ fontSize: 14, color: '#64748B', marginBottom: 16 }}>
        Sessions (rows) {'\u00D7'} Tables (columns) &mdash; hover to highlight
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' as const }}>
        {(Object.entries(connTypes) as [string, typeof connTypes.write_clean][]).map(([k, ct]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 36, height: 28, borderRadius: 5, fontSize: 14, fontWeight: 800,
                background: ct.color + '33', color: ct.color,
                border: '1px solid ' + ct.color + '66',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {connShortLabel(k as any)}
            </div>
            <span style={{ fontSize: 13, color: '#94A3B8' }}>{ct.label}</span>
          </div>
        ))}
      </div>

      {/* Controls bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' as const,
        padding: '8px 12px', background: 'rgba(30,41,59,0.5)', borderRadius: 8, border: '1px solid #334155',
      }}>
        {/* Sparse toggle */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={sparseMode}
            onChange={e => { setSparseMode(e.target.checked); setRowPage(0); setColPage(0); }}
            style={{ accentColor: '#3B82F6' }}
          />
          <span style={{ fontSize: 11, color: '#CBD5E1' }}>Connected only</span>
        </label>

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setRowPage(0); setColPage(0); }}
          placeholder="Filter sessions/tables..."
          style={{
            padding: '4px 10px', borderRadius: 4, border: '1px solid #334155',
            background: '#0F172A', color: '#E2E8F0', fontSize: 11, width: 180,
          }}
        />

        {/* Stats */}
        <span style={{ fontSize: 11, color: '#64748B', fontFamily: 'monospace' }}>
          {filteredSessions.length} rows x {filteredTables.length} cols
          {(filteredSessions.length !== data.sessions.length || filteredTables.length !== data.tables.length) &&
            ` (of ${data.sessions.length} x ${data.tables.length})`}
        </span>

        {/* Row pagination */}
        <PaginationBar label="Rows" page={safeRowPage} totalPages={totalRowPages} setPage={setRowPage} />
        {/* Col pagination */}
        <PaginationBar label="Cols" page={safeColPage} totalPages={totalColPages} setPage={setColPage} />
      </div>

      {/* Matrix table */}
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            borderCollapse: 'collapse' as const,
            fontSize: 14,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  padding: '10px 16px', background: '#1E293B', color: '#64748B',
                  position: 'sticky' as const, left: 0, zIndex: 2, textAlign: 'left' as const,
                  borderBottom: '2px solid #334155', fontSize: 13,
                }}
              >
                Session {'\u2193'} / Table {'\u2192'}
              </th>
              {pageTables.map(t => (
                <th
                  key={t.id}
                  onMouseEnter={() => setHov(t.id)}
                  onMouseLeave={() => setHov(null)}
                  style={{
                    padding: '8px 8px',
                    background: hov === t.id ? 'rgba(255,255,255,0.1)' : '#1E293B',
                    color: hov === t.id ? '#fff' : '#94A3B8',
                    cursor: 'pointer',
                    writingMode: 'vertical-lr' as const,
                    textOrientation: 'mixed' as const,
                    minWidth: 48, borderBottom: '2px solid #334155',
                    borderRight: '1px solid #1a1f2e',
                    fontWeight: t.type === 'conflict' ? 700 : 500,
                    fontSize: 13, maxHeight: 200,
                  }}
                >
                  {t.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageSessions.map(s => {
              const cfg = getTierCfg(s.tier);
              return (
                <tr key={s.id}>
                  <td
                    onMouseEnter={() => setHov(s.id)}
                    onMouseLeave={() => setHov(null)}
                    style={{
                      padding: '12px 16px',
                      background: hov === s.id ? 'rgba(255,255,255,0.1)' : '#111827',
                      color: hov === s.id ? '#fff' : cfg.color,
                      position: 'sticky' as const, left: 0, zIndex: 1,
                      cursor: 'pointer', borderBottom: '1px solid #1a1f2e',
                      fontWeight: 600, whiteSpace: 'nowrap' as const, fontSize: 14,
                    }}
                  >
                    <span style={{ color: '#64748B', marginRight: 6 }}>S{s.step}</span>
                    {s.name}
                  </td>
                  {pageTables.map(t => {
                    const key1 = s.id + '|' + t.id;
                    const key2 = t.id + '|' + s.id;
                    const seen = new Set<string>();
                    const matches: typeof data.connections = [];
                    [key1, key2].forEach(k => {
                      (connLookup.get(k) || []).forEach(c => {
                        const uid = c.from + '>' + c.to + '>' + c.type;
                        if (!seen.has(uid)) {
                          seen.add(uid);
                          matches.push(c);
                        }
                      });
                    });

                    const hi = hov === s.id || hov === t.id;
                    return (
                      <td
                        key={t.id}
                        style={{
                          padding: 5,
                          background:
                            matches.length > 0
                              ? hi
                                ? 'rgba(255,255,255,0.15)'
                                : (connTypes[matches[0].type]?.color || '#3B82F6') + '18'
                              : hi
                                ? 'rgba(255,255,255,0.02)'
                                : 'transparent',
                          borderBottom: '1px solid #1a1f2e',
                          borderRight: '1px solid #1a1f2e',
                          textAlign: 'center' as const,
                          verticalAlign: 'middle' as const,
                        }}
                      >
                        {matches.map((x, i) => {
                          const ct = connTypes[x.type] || connTypes.write_clean;
                          return (
                            <div
                              key={i}
                              style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 38, height: 32, borderRadius: 5, fontSize: 14, fontWeight: 800,
                                background: ct.color + '33', color: ct.color,
                                border: '2px solid ' + ct.color + '55', margin: 2,
                              }}
                            >
                              {connShortLabel(x.type)}
                            </div>
                          );
                        })}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    <TierFilterSidebar data={data} filters={tierFilters} onChange={setTierFilters} compact />
    </div>
  );
};

export default MatrixView;
