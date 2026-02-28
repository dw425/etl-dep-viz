/**
 * GlobalSearch — search overlay for sessions, tables, transforms, workflows.
 * Results grouped by type with click-to-navigate.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useNavigationContext } from './NavigationProvider';

interface SearchResult {
  type: 'session' | 'table' | 'workflow';
  id: string;
  name: string;
  detail?: string;
  layer: number;
  params: Record<string, string>;
}

export default function GlobalSearch({ onClose }: { onClose: () => void }) {
  const { tierData, jumpTo } = useNavigationContext();
  const [query, setQuery] = useState('');

  const results = useMemo<SearchResult[]>(() => {
    if (!tierData || query.length < 2) return [];

    const q = query.toLowerCase();
    const matches: SearchResult[] = [];

    // Search sessions
    for (const s of tierData.sessions) {
      const name = s.name?.toLowerCase() || '';
      const full = s.full?.toLowerCase() || '';
      if (name.includes(q) || full.includes(q)) {
        matches.push({
          type: 'session',
          id: s.id,
          name: s.name,
          detail: `Tier ${s.tier} | ${s.transforms} transforms`,
          layer: 4,
          params: { sessionId: s.id, sessionName: s.name },
        });
      }
    }

    // Search tables
    for (const t of tierData.tables) {
      if (t.name?.toLowerCase().includes(q)) {
        matches.push({
          type: 'table',
          id: t.id,
          name: t.name,
          detail: `${t.type} | ${t.readers} readers`,
          layer: 6,
          params: { objectType: 'table', objectId: t.id },
        });
      }
    }

    // Dedupe workflow names from sessions
    const workflows = new Set<string>();
    for (const s of tierData.sessions) {
      const full = s.full || '';
      const parts = full.split('.');
      if (parts.length > 1 && parts[0].toLowerCase().includes(q)) {
        workflows.add(parts[0]);
      }
    }
    for (const wf of workflows) {
      matches.push({
        type: 'workflow',
        id: wf,
        name: wf,
        detail: 'Workflow',
        layer: 3,
        params: { scopeType: 'workflow', scopeId: wf },
      });
    }

    return matches.slice(0, 50);
  }, [tierData, query]);

  const handleSelect = useCallback((r: SearchResult) => {
    jumpTo(r.layer, r.params);
    onClose();
  }, [jumpTo, onClose]);

  const grouped = useMemo(() => {
    const g: Record<string, SearchResult[]> = {};
    for (const r of results) {
      (g[r.type] ??= []).push(r);
    }
    return g;
  }, [results]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700">
          <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            autoFocus
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search sessions, tables, workflows..."
            className="flex-1 bg-transparent text-white text-sm outline-none placeholder-gray-500"
          />
          <kbd className="text-xs text-gray-500 border border-gray-600 rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        <div className="max-h-80 overflow-y-auto">
          {query.length < 2 ? (
            <div className="p-4 text-sm text-gray-500 text-center">
              Type at least 2 characters to search
            </div>
          ) : results.length === 0 ? (
            <div className="p-4 text-sm text-gray-500 text-center">
              No results for &ldquo;{query}&rdquo;
            </div>
          ) : (
            Object.entries(grouped).map(([type, items]) => (
              <div key={type}>
                <div className="px-4 py-1.5 text-xs font-medium text-gray-500 uppercase bg-gray-800/50">
                  {type}s ({items.length})
                </div>
                {items.map(r => (
                  <button
                    key={r.id}
                    onClick={() => handleSelect(r)}
                    className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-800 transition-colors text-left"
                  >
                    <span className="text-xs text-gray-500 bg-gray-800 rounded px-1.5 py-0.5">
                      L{r.layer}
                    </span>
                    <span className="text-sm text-white">{r.name}</span>
                    {r.detail && (
                      <span className="text-xs text-gray-500 ml-auto">{r.detail}</span>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
