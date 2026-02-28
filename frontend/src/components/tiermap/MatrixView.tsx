/**
 * MatrixView.tsx -- Sessions (rows) x Tables (columns) grid. Each cell shows
 * connection type badges. Hover highlights the entire row/column.
 */

import React, { useState, useMemo } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import { connTypes, connShortLabel, getTierCfg } from './constants';

interface Props {
  data: TierMapResult;
}

const MatrixView: React.FC<Props> = ({ data }) => {
  const [hov, setHov] = useState<string | null>(null);

  const connLookup = useMemo(() => {
    const map = new Map<string, typeof data.connections>();
    data.connections.forEach(c => {
      const keyA = c.from + '|' + c.to;
      const keyB = c.to + '|' + c.from;
      if (!map.has(keyA)) map.set(keyA, []);
      map.get(keyA)!.push(c);
      if (!map.has(keyB)) map.set(keyB, []);
      map.get(keyB)!.push(c);
    });
    return map;
  }, [data.connections]);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#E2E8F0', marginBottom: 6 }}>
        Many-to-Many Relationship Matrix
      </div>
      <div style={{ fontSize: 14, color: '#64748B', marginBottom: 16 }}>
        Sessions (rows) {'\u00D7'} Tables (columns) &mdash; hover to highlight
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' as const }}>
        {(Object.entries(connTypes) as [string, typeof connTypes.write_clean][]).map(([k, ct]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 36,
                height: 28,
                borderRadius: 5,
                fontSize: 14,
                fontWeight: 800,
                background: ct.color + '33',
                color: ct.color,
                border: '1px solid ' + ct.color + '66',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {connShortLabel(k as any)}
            </div>
            <span style={{ fontSize: 13, color: '#94A3B8' }}>{ct.label}</span>
          </div>
        ))}
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
                  padding: '10px 16px',
                  background: '#1E293B',
                  color: '#64748B',
                  position: 'sticky' as const,
                  left: 0,
                  zIndex: 2,
                  textAlign: 'left' as const,
                  borderBottom: '2px solid #334155',
                  fontSize: 13,
                }}
              >
                Session {'\u2193'} / Table {'\u2192'}
              </th>
              {data.tables.map(t => (
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
                    minWidth: 48,
                    borderBottom: '2px solid #334155',
                    borderRight: '1px solid #1a1f2e',
                    fontWeight: t.type === 'conflict' ? 700 : 500,
                    fontSize: 13,
                    maxHeight: 200,
                  }}
                >
                  {t.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.sessions.map(s => {
              const cfg = getTierCfg(s.tier);
              return (
                <tr key={s.id}>
                  <td
                    onMouseEnter={() => setHov(s.id)}
                    onMouseLeave={() => setHov(null)}
                    style={{
                      padding: '12px 16px',
                      background:
                        hov === s.id ? 'rgba(255,255,255,0.1)' : '#111827',
                      color: hov === s.id ? '#fff' : cfg.color,
                      position: 'sticky' as const,
                      left: 0,
                      zIndex: 1,
                      cursor: 'pointer',
                      borderBottom: '1px solid #1a1f2e',
                      fontWeight: 600,
                      whiteSpace: 'nowrap' as const,
                      fontSize: 14,
                    }}
                  >
                    <span style={{ color: '#64748B', marginRight: 6 }}>S{s.step}</span>
                    {s.name}
                  </td>
                  {data.tables.map(t => {
                    const key1 = s.id + '|' + t.id;
                    const key2 = t.id + '|' + s.id;
                    // Deduplicate: get unique connections between this session and table
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
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: 38,
                                height: 32,
                                borderRadius: 5,
                                fontSize: 14,
                                fontWeight: 800,
                                background: ct.color + '33',
                                color: ct.color,
                                border: '2px solid ' + ct.color + '55',
                                margin: 2,
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
  );
};

export default MatrixView;
