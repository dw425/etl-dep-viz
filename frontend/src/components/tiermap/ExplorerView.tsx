/**
 * ExplorerView.tsx -- Session list on the left (320px), detail panel on the
 * right. Sessions sorted by execution order (step). Each session shows R/W/L
 * badge counts. Clicking a session shows its writes/reads/lookups and
 * downstream consumers. Clicking a table highlights all connected sessions.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
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
import TierFilterSidebar, { type TierFilters, getDefaultTierFilters, applyTierFilters } from '../shared/TierFilterSidebar';

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

type SortKey = 'step' | 'tier' | 'name' | 'reads' | 'writes' | 'lookups' | 'transforms';

const ExplorerView: React.FC<Props> = ({ data }) => {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('step');
  const [sortDesc, setSortDesc] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [tierFilters, setTierFilters] = useState<TierFilters>(getDefaultTierFilters);

  const filteredData = useMemo(() => applyTierFilters(data, tierFilters), [data, tierFilters]);
  const sessionData = useMemo(() => buildSessionData(filteredData), [filteredData]);
  const executionOrder = useMemo(() => buildExecutionOrder(filteredData), [filteredData]);
  const writeConflicts = useMemo(() => deriveWriteConflicts(sessionData), [sessionData]);
  const readAfterWrite = useMemo(() => deriveReadAfterWrite(sessionData), [sessionData]);
  const allTables = useMemo(() => deriveTableAggregates(sessionData), [sessionData]);

  // ── Sorted + filtered session list ────────────────────────────────────────
  // Filtering is case-insensitive on session name and short label.
  // Sorting is multi-key: the primary sort key is set by sortBy; sortDesc toggles direction.
  // sortIcon() returns ▲/▼ on the active column header button for visual feedback.
  const sortedSessions = useMemo(() => {
    let list = [...executionOrder];
    if (filterText) {
      const term = filterText.toLowerCase();
      list = list.filter(name => {
        const d = sessionData[name];
        return name.toLowerCase().includes(term) || d?.short?.toLowerCase().includes(term);
      });
    }
    list.sort((a, b) => {
      const da = sessionData[a];
      const db = sessionData[b];
      if (!da || !db) return 0;
      let cmp = 0;
      switch (sortBy) {
        case 'step': cmp = (da.step || 0) - (db.step || 0); break;
        case 'tier': cmp = (da.tier || 0) - (db.tier || 0); break;
        case 'name': cmp = (da.short || '').localeCompare(db.short || ''); break;
        case 'reads': cmp = da.sources.length - db.sources.length; break;
        case 'writes': cmp = da.targets.length - db.targets.length; break;
        case 'lookups': cmp = da.lookups.length - db.lookups.length; break;
        case 'transforms': cmp = (da.transforms || 0) - (db.transforms || 0); break;
      }
      return sortDesc ? -cmp : cmp;
    });
    return list;
  }, [executionOrder, sessionData, sortBy, sortDesc, filterText]);

  const handleSort = useCallback((key: SortKey) => {
    if (sortBy === key) setSortDesc(d => !d);
    else { setSortBy(key); setSortDesc(false); }
  }, [sortBy]);

  const sortIcon = (key: SortKey) => sortBy === key ? (sortDesc ? '\u25BC' : '\u25B2') : '';

  const sel: SessionDetail | null = selectedSession ? sessionData[selectedSession] ?? null : null;

  // Sessions that read, write, or lookup the currently-highlighted table —
  // used to dim unrelated sessions in the list when a table badge is clicked
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

  // ── Virtual scrolling ──────────────────────────────────────────────────────
  // All session cards use position:absolute inside a fixed-height spacer div,
  // so only ~(viewportHeight / ITEM_HEIGHT) cards are in the DOM at any time.
  // visibleRange adds a 2-item overscan above and 4-item overscan below to
  // prevent blank flashes during fast scrolling.
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const ITEM_HEIGHT = 90; // fixed card height (px) — must match actual card height

  // Track the scrollable list's height so visibleRange stays accurate after resize
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setContainerHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute which slice of sortedSessions should be rendered (with overscan)
  const visibleRange = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 2);
    const end = Math.min(sortedSessions.length, start + Math.ceil(containerHeight / ITEM_HEIGHT) + 4);
    return { start, end };
  }, [scrollTop, containerHeight, sortedSessions.length]);

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', overflow: 'hidden' }}>
      {/* Left: session list */}
      <div
        ref={listRef}
        onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        style={{
          width: 320,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          overflowY: 'auto',
          paddingRight: 8,
        }}
      >
        <div style={{ padding: '0 4px', marginBottom: 8 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: C.textMuted,
            textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 6,
          }}>
            Sessions ({sortedSessions.length}{filterText ? ` / ${executionOrder.length}` : ''})
          </div>
          <input
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder="Filter sessions..."
            style={{
              width: '100%', padding: '5px 8px', borderRadius: 5,
              border: `1px solid ${C.border}`, background: 'rgba(0,0,0,0.2)',
              color: C.text, fontSize: 10, outline: 'none', marginBottom: 6,
            }}
          />
          <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' as const }}>
            {([
              ['step', 'Step'], ['tier', 'Tier'], ['name', 'Name'],
              ['writes', 'W'], ['reads', 'R'], ['lookups', 'L'], ['transforms', 'Tx'],
            ] as [SortKey, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => handleSort(key)}
                style={{
                  fontSize: 9, padding: '2px 5px', borderRadius: 3,
                  border: 'none', cursor: 'pointer',
                  background: sortBy === key ? 'rgba(59,130,246,0.2)' : 'transparent',
                  color: sortBy === key ? C.accentBlue : C.textDim,
                  fontWeight: sortBy === key ? 700 : 400,
                }}
              >
                {label} {sortIcon(key)}
              </button>
            ))}
          </div>
        </div>

        {/* Spacer div provides the full scrollable height so the scrollbar is correct.
             Each card is absolutely positioned at (visibleRange.start + idx) * ITEM_HEIGHT. */}
        <div style={{ height: sortedSessions.length * ITEM_HEIGHT, position: 'relative' }}>
        {sortedSessions.slice(visibleRange.start, visibleRange.end).map((name, idx) => {
          const d = sessionData[name];
          if (!d) return null;
          const isSel = selectedSession === name;
          // isHi — session touches the highlighted table (highlight it)
          const isHi = !!selectedTable && connSessions.has(name);
          // dim — table is selected but this session is unrelated (fade it out)
          const dim = !!selectedTable && !connSessions.has(name);

          return (
            <div
              key={name}
              onClick={() => handleSessionClick(name)}
              style={{
                position: 'absolute' as const,
                top: (visibleRange.start + idx) * ITEM_HEIGHT,
                left: 0, right: 8,
                height: ITEM_HEIGHT - 8,
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
      </div>

      {/* ── Right: detail panel ────────────────────────────────────────────────
            Three states: session selected → writes/reads/lookups + downstream
                          table selected  → writers/readers/lookers for that table
                          nothing         → empty state prompt                     */}
      <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
        {sel ? (
          <div>
            {/* Session header — full path and short display name */}
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

            {/* Downstream consumers — sessions that read from this session's output tables */}
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

      {/* Right: tier filter */}
      <TierFilterSidebar data={data} filters={tierFilters} onChange={setTierFilters} compact />
    </div>
  );
};

export default ExplorerView;
