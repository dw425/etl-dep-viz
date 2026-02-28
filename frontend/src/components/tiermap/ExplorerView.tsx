/**
 * ExplorerView.tsx -- Session list on the left (320px), detail panel on the
 * right. Sessions sorted by execution order (step). Each session shows R/W/L
 * badge counts. Clicking a session shows its writes/reads/lookups and
 * downstream consumers. Clicking a table highlights all connected sessions.
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import {
  C,
  buildSessionData,
  buildExecutionOrder,
  deriveWriteConflicts,
  deriveReadAfterWrite,
  deriveTableAggregates,
  type SessionDetail,
} from './constants';

interface Props {
  data: TierMapResult;
}

/* ── Inline table badge ──────────────────────────────────────────────────── */

const BADGE_COLOR: Record<string, string> = { write: C.write, read: C.read, lookup: C.lookup };
const BADGE_BG: Record<string, string> = {
  write: 'rgba(239,68,68,0.08)',
  read: 'rgba(34,197,94,0.08)',
  lookup: 'rgba(245,158,11,0.08)',
};

interface BadgeProps {
  name: string;
  type: string;
  isHighlighted: boolean;
  hasConflict: boolean;
  onClick: () => void;
}

const Badge: React.FC<BadgeProps> = ({ name, type, isHighlighted, hasConflict, onClick }) => (
  <span
    onClick={onClick}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '3px 8px',
      borderRadius: 5,
      background: isHighlighted ? 'rgba(59,130,246,0.2)' : BADGE_BG[type] || 'transparent',
      color: isHighlighted ? C.accentBlue : BADGE_COLOR[type] || C.textMuted,
      border:
        '1px solid ' +
        (isHighlighted
          ? 'rgba(59,130,246,0.4)'
          : type === 'write' && hasConflict
            ? 'rgba(239,68,68,0.5)'
            : 'transparent'),
      cursor: 'pointer',
      fontWeight: isHighlighted ? 700 : 500,
      whiteSpace: 'nowrap' as const,
    }}
  >
    {type === 'write' && hasConflict && (
      <span style={{ color: C.conflict }}>{'\u26A0'} </span>
    )}
    {name}
  </span>
);

/* ── Main component ──────────────────────────────────────────────────────── */

const ExplorerView: React.FC<Props> = ({ data }) => {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const sessionData = useMemo(() => buildSessionData(data), [data]);
  const executionOrder = useMemo(() => buildExecutionOrder(data), [data]);
  const writeConflicts = useMemo(() => deriveWriteConflicts(sessionData), [sessionData]);
  const readAfterWrite = useMemo(() => deriveReadAfterWrite(sessionData), [sessionData]);
  const allTables = useMemo(() => deriveTableAggregates(sessionData), [sessionData]);

  const sel: SessionDetail | null = selectedSession ? sessionData[selectedSession] ?? null : null;

  /* Sessions connected to the currently-highlighted table */
  const connSessions = useMemo(() => {
    if (!selectedTable) return new Set<string>();
    const s = new Set<string>();
    Object.entries(sessionData).forEach(([n, d]) => {
      if (
        d.sources.includes(selectedTable) ||
        d.targets.includes(selectedTable) ||
        d.lookups.includes(selectedTable)
      ) {
        s.add(n);
      }
    });
    return s;
  }, [selectedTable, sessionData]);

  const handleSessionClick = useCallback(
    (name: string) => {
      setSelectedSession(prev => (prev === name ? null : name));
      setSelectedTable(null);
    },
    [],
  );

  const handleTableClick = useCallback(
    (name: string) => {
      setSelectedTable(prev => (prev === name ? null : name));
      setSelectedSession(null);
    },
    [],
  );

  const handleDownstreamClick = useCallback(
    (name: string) => {
      setSelectedSession(name);
      setSelectedTable(null);
    },
    [],
  );

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', overflow: 'hidden' }}>
      {/* Left: session list */}
      <div
        style={{
          width: 320,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          overflowY: 'auto',
          paddingRight: 8,
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: C.textMuted,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.1em',
            padding: '0 4px',
            marginBottom: 4,
          }}
        >
          Sessions ({executionOrder.length})
        </div>

        {executionOrder.map(name => {
          const d = sessionData[name];
          if (!d) return null;
          const isSel = selectedSession === name;
          const isHi = !!selectedTable && connSessions.has(name);
          const dim = !!selectedTable && !connSessions.has(name);

          return (
            <div
              key={name}
              onClick={() => handleSessionClick(name)}
              style={{
                background: isSel
                  ? 'rgba(59,130,246,0.15)'
                  : isHi
                    ? 'rgba(59,130,246,0.06)'
                    : C.surface,
                border:
                  '1px solid ' +
                  (isSel ? C.borderActive : isHi ? 'rgba(59,130,246,0.3)' : C.border),
                borderRadius: 10,
                padding: '12px 16px',
                cursor: 'pointer',
                opacity: dim ? 0.3 : 1,
                transition: 'all 0.2s',
                position: 'relative' as const,
                overflow: 'hidden' as const,
              }}
            >
              {isSel && (
                <div
                  style={{
                    position: 'absolute' as const,
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: 'linear-gradient(90deg,#3b82f6,#8b5cf6)',
                  }}
                />
              )}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      fontWeight: 700,
                      color: isSel ? C.accentBlue : C.text,
                    }}
                  >
                    {d.short}
                  </div>
                  <div
                    style={{
                      fontSize: 9,
                      color: C.textDim,
                      marginTop: 3,
                      fontFamily: 'monospace',
                    }}
                  >
                    Step {d.step} &middot; Tier {d.tier}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {d.sources.length > 0 && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'rgba(34,197,94,0.1)',
                        color: C.read,
                        fontWeight: 600,
                      }}
                    >
                      {d.sources.length}R
                    </span>
                  )}
                  {d.targets.length > 0 && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'rgba(239,68,68,0.1)',
                        color: C.write,
                        fontWeight: 600,
                      }}
                    >
                      {d.targets.length}W
                    </span>
                  )}
                  {d.lookups.length > 0 && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'rgba(245,158,11,0.1)',
                        color: C.lookup,
                        fontWeight: 600,
                      }}
                    >
                      {d.lookups.length}L
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' as const }}>
                <span
                  style={{
                    fontSize: 8,
                    color: C.textDim,
                    background: 'rgba(255,255,255,0.03)',
                    padding: '1px 5px',
                    borderRadius: 3,
                  }}
                >
                  {d.transforms} transforms
                </span>
                {d.extReads > 0 && (
                  <span
                    style={{
                      fontSize: 8,
                      color: C.textDim,
                      background: 'rgba(255,255,255,0.03)',
                      padding: '1px 5px',
                      borderRadius: 3,
                    }}
                  >
                    {d.extReads} ext reads
                  </span>
                )}
                {d.lookupCount > 0 && (
                  <span
                    style={{
                      fontSize: 8,
                      color: C.textDim,
                      background: 'rgba(255,255,255,0.03)',
                      padding: '1px 5px',
                      borderRadius: 3,
                    }}
                  >
                    {d.lookupCount} lookups
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Right: detail panel */}
      <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
        {sel ? (
          <div>
            {/* Header */}
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: C.text,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {sel.short}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: C.textDim,
                  fontFamily: 'monospace',
                  marginTop: 2,
                }}
              >
                {selectedSession}
              </div>
            </div>

            {/* Writes / Reads / Lookups groups */}
            {(
              [
                { label: 'WRITES TO', items: sel.targets, type: 'write', color: C.write },
                { label: 'READS FROM', items: sel.sources, type: 'read', color: C.read },
                { label: 'LOOKUPS', items: sel.lookups, type: 'lookup', color: C.lookup },
              ] as const
            )
              .filter(g => g.items.length > 0)
              .map(g => (
                <div key={g.label} style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: g.color,
                      textTransform: 'uppercase' as const,
                      letterSpacing: '0.1em',
                      marginBottom: 8,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: g.color,
                      }}
                    />
                    {g.label} ({g.items.length})
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
                    {g.items.map((t, i) => (
                      <Badge
                        key={t + i}
                        name={t}
                        type={g.type}
                        isHighlighted={selectedTable === t}
                        hasConflict={!!writeConflicts[t]}
                        onClick={() => handleTableClick(t)}
                      />
                    ))}
                  </div>
                </div>
              ))}

            {/* Downstream consumers */}
            {sel.targets.some(t => !!readAfterWrite[t]) && (
              <div
                style={{
                  background: 'rgba(168,85,247,0.06)',
                  border: '1px solid rgba(168,85,247,0.2)',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <div
                  style={{ fontSize: 10, fontWeight: 700, color: C.chain, marginBottom: 6 }}
                >
                  {'\u26D3'} DOWNSTREAM CONSUMERS
                </div>
                {sel.targets
                  .filter(t => !!readAfterWrite[t])
                  .map(t => (
                    <div
                      key={t}
                      style={{ fontSize: 10, color: C.textMuted, marginBottom: 4 }}
                    >
                      <span style={{ color: C.write }}>{t}</span>
                      {' \u2192 '}
                      {readAfterWrite[t].readers.map((r, i) => (
                        <span key={r}>
                          <span
                            style={{
                              color: C.accentBlue,
                              cursor: 'pointer',
                            }}
                            onClick={() => handleDownstreamClick(r)}
                          >
                            {sessionData[r]?.short || r}
                          </span>
                          {i < readAfterWrite[t].readers.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                    </div>
                  ))}
              </div>
            )}
          </div>
        ) : selectedTable ? (
          <div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: C.text,
                fontFamily: "'JetBrains Mono', monospace",
                marginBottom: 8,
              }}
            >
              {selectedTable}
            </div>

            {writeConflicts[selectedTable] && (
              <div
                style={{
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: C.conflict,
                    marginBottom: 4,
                  }}
                >
                  {'\u26A0'} WRITE-WRITE CONFLICT
                </div>
                <div style={{ fontSize: 10, color: C.textMuted }}>
                  Writers:{' '}
                  {writeConflicts[selectedTable]
                    .map(s => sessionData[s]?.short || s)
                    .join(', ')}
                </div>
              </div>
            )}

            {allTables[selectedTable] &&
              (['writes', 'reads', 'lookups'] as const).map(rel => {
                const items = allTables[selectedTable][rel];
                if (!items || items.length === 0) return null;
                const colors: Record<string, string> = {
                  writes: C.write,
                  reads: C.read,
                  lookups: C.lookup,
                };
                return (
                  <div key={rel} style={{ marginBottom: 8 }}>
                    <span
                      style={{
                        fontSize: 9,
                        color: colors[rel],
                        fontWeight: 700,
                        textTransform: 'uppercase' as const,
                      }}
                    >
                      {rel}:{' '}
                    </span>
                    {items.map(s => (
                      <span
                        key={s}
                        onClick={() => handleDownstreamClick(s)}
                        style={{
                          fontSize: 10,
                          color: C.accentBlue,
                          cursor: 'pointer',
                          marginRight: 8,
                        }}
                      >
                        {sessionData[s]?.short || s}
                      </span>
                    ))}
                  </div>
                );
              })}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column' as const,
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              opacity: 0.4,
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>{'\u2190'}</div>
            <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center' as const }}>
              Select a session to explore
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ExplorerView;
