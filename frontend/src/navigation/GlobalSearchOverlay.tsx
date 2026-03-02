/**
 * Global Search Overlay — Ctrl+K fuzzy search across sessions, tables, and views.
 *
 * Opens as a modal overlay with instant search results.
 * Navigate with arrow keys, Enter to select, Esc to close.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { TierMapResult, TierSession, TierTable } from '../types/tiermap';

/** A single match in the global search results. */
interface SearchResult {
  /** Object category: session, table, or view. */
  type: 'session' | 'table' | 'view';
  /** Unique identifier for routing/selection. */
  id: string;
  /** Display name shown in the results list. */
  label: string;
  /** Secondary detail text (e.g. "Tier 3 | 5R 2L"). */
  detail: string;
  /** Tier level for sessions and tables (used for visual hints). */
  tier?: number;
}

/** Props for the GlobalSearchOverlay component. */
interface GlobalSearchOverlayProps {
  /** Whether the overlay is visible. */
  open: boolean;
  /** Callback to close the overlay (Esc, backdrop click). */
  onClose: () => void;
  /** Current tier data for searching sessions and tables. */
  data?: TierMapResult | null;
  /** Callback when a session result is selected. */
  onSelectSession?: (sessionId: string) => void;
  /** Callback when a table result is selected. */
  onSelectTable?: (tableName: string) => void;
  /** Callback when a view result is selected. */
  onSelectView?: (viewId: string) => void;
}

const VIEW_OPTIONS = [
  { id: 'tier', label: 'Tier Diagram', detail: 'Session tier band visualization' },
  { id: 'galaxy', label: 'Galaxy Map', detail: 'Orbital session layout' },
  { id: 'constellation', label: 'Constellation', detail: 'Cluster visualization' },
  { id: 'explorer', label: 'Explorer', detail: 'Session list with details' },
  { id: 'conflicts', label: 'Conflicts', detail: 'Write conflict matrix' },
  { id: 'layers', label: 'Layer Navigator', detail: '6-layer progressive disclosure' },
  { id: 'flowwalker', label: 'Flow Walker', detail: 'End-to-end data flow' },
  { id: 'complexity', label: 'Complexity', detail: 'Session complexity scoring' },
  { id: 'waves', label: 'Wave Plan', detail: 'Migration wave planning' },
];

/**
 * Ctrl+K-style global search overlay used from DependencyApp.
 * Shows view shortcuts when empty, and session/table/view matches when typing.
 * Supports keyboard navigation (arrow keys, Enter, Esc) and mouse selection.
 * Results are capped at 30 to keep the list manageable.
 */
export default function GlobalSearchOverlay({
  open,
  onClose,
  data,
  onSelectSession,
  onSelectTable,
  onSelectView,
}: GlobalSearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Build search results
  const results = useMemo((): SearchResult[] => {
    const q = query.toLowerCase().trim();
    if (!q) {
      // Show views when no query
      return VIEW_OPTIONS.map(v => ({
        type: 'view' as const,
        id: v.id,
        label: v.label,
        detail: v.detail,
      }));
    }

    const matches: SearchResult[] = [];

    // Search views
    for (const v of VIEW_OPTIONS) {
      if (v.label.toLowerCase().includes(q) || v.detail.toLowerCase().includes(q)) {
        matches.push({ type: 'view', id: v.id, label: v.label, detail: v.detail });
      }
    }

    if (data) {
      // Search sessions
      for (const s of data.sessions) {
        const name = s.name?.toLowerCase() ?? '';
        const full = (s as any).full?.toLowerCase() ?? '';
        if (name.includes(q) || full.includes(q) || s.id.toLowerCase().includes(q)) {
          matches.push({
            type: 'session',
            id: s.id,
            label: s.name,
            detail: `Tier ${s.tier} | ${s.extReads}R ${s.lookupCount}L`,
            tier: s.tier,
          });
        }
        if (matches.length > 50) break; // cap results
      }

      // Search tables
      const seenTables = new Set<string>();
      for (const t of data.tables) {
        if (seenTables.has(t.name)) continue;
        if (t.name.toLowerCase().includes(q)) {
          seenTables.add(t.name);
          matches.push({
            type: 'table',
            id: t.id,
            label: t.name,
            detail: `${t.type} | Tier ${t.tier}`,
            tier: t.tier,
          });
        }
        if (matches.length > 80) break;
      }
    }

    return matches.slice(0, 30); // cap display
  }, [query, data]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(s => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(s => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && results[selected]) {
      e.preventDefault();
      const r = results[selected];
      if (r.type === 'session') onSelectSession?.(r.id);
      else if (r.type === 'table') onSelectTable?.(r.label);
      else if (r.type === 'view') onSelectView?.(r.id);
      onClose();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [results, selected, onSelectSession, onSelectTable, onSelectView, onClose]);

  if (!open) return null;

  const typeIcons: Record<string, string> = {
    session: 'S',
    table: 'T',
    view: '>',
  };
  const typeColors: Record<string, string> = {
    session: '#3B82F6',
    table: '#10B981',
    view: '#A855F7',
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', justifyContent: 'center', paddingTop: 120,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 560, maxHeight: 480,
          background: '#1e293b', borderRadius: 12,
          border: '1px solid #334155',
          boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #334155' }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search sessions, tables, views..."
            style={{
              width: '100%', background: 'transparent', border: 'none',
              color: '#e2e8f0', fontSize: 16, outline: 'none',
              fontFamily: '"JetBrains Mono", monospace',
            }}
          />
        </div>

        {/* Results */}
        <div style={{ maxHeight: 360, overflowY: 'auto', padding: '4px 0' }}>
          {results.length === 0 && (
            <div style={{ padding: '16px 20px', color: '#64748b', textAlign: 'center' }}>
              No results found
            </div>
          )}
          {results.map((r, i) => (
            <div
              key={`${r.type}-${r.id}`}
              style={{
                padding: '8px 16px',
                display: 'flex', alignItems: 'center', gap: 10,
                cursor: 'pointer',
                background: i === selected ? '#334155' : 'transparent',
              }}
              onMouseEnter={() => setSelected(i)}
              onClick={() => {
                if (r.type === 'session') onSelectSession?.(r.id);
                else if (r.type === 'table') onSelectTable?.(r.label);
                else if (r.type === 'view') onSelectView?.(r.id);
                onClose();
              }}
            >
              <span style={{
                width: 22, height: 22, borderRadius: 4,
                background: typeColors[r.type], color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, flexShrink: 0,
              }}>
                {typeIcons[r.type]}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  color: '#e2e8f0', fontSize: 13,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {r.label}
                </div>
                <div style={{ color: '#64748b', fontSize: 11 }}>{r.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: '8px 16px', borderTop: '1px solid #334155',
          display: 'flex', gap: 16, color: '#475569', fontSize: 11,
        }}>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
