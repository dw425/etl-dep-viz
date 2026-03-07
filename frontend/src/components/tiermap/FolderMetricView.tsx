/**
 * FolderMetricView — Shows how sessions are bucketed into Informatica folders.
 * Displays folder cards with session counts, tier distribution, and allows
 * filtering by folder name. Click a folder to see its sessions.
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { TierMapResult, TierSession } from '../../types/tiermap';
import { useCommitSearch } from '../../hooks/useCommitSearch';

interface FolderBucket {
  name: string;
  sessions: TierSession[];
  tiers: Map<number, number>;
  workflows: Set<string>;
  avgTier: number;
  critical: number;
}

const T = {
  bg: '#0f172a', surface: '#1e293b', border: '#334155',
  text: '#e2e8f0', muted: '#94a3b8', accent: '#3b82f6',
  accentBg: 'rgba(59,130,246,0.1)',
};

function tierColor(t: number): string {
  const p = ['#3B82F6','#EAB308','#A855F7','#10B981','#F97316','#06B6D4','#EC4899','#84CC16'];
  return p[Math.max(0, Math.floor(t) - 1) % p.length];
}

export default function FolderMetricView({ data }: { data: TierMapResult }) {
  const { committedValue: search, inputProps: searchInputProps } = useCommitSearch();
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'sessions' | 'name' | 'tier'>('sessions');
  const [sessionSearch, setSessionSearch] = useState('');

  // Build folder buckets from session data
  const folders = useMemo(() => {
    const map = new Map<string, FolderBucket>();
    for (const s of data.sessions) {
      const fname = s.folder || s.full.split('.')[0] || '(unknown)';
      let bucket = map.get(fname);
      if (!bucket) {
        bucket = { name: fname, sessions: [], tiers: new Map(), workflows: new Set(), avgTier: 0, critical: 0 };
        map.set(fname, bucket);
      }
      bucket.sessions.push(s);
      bucket.tiers.set(Math.floor(s.tier), (bucket.tiers.get(Math.floor(s.tier)) || 0) + 1);
      if (s.workflow) bucket.workflows.add(s.workflow);
      if (s.critical) bucket.critical++;
    }
    for (const b of map.values()) {
      b.avgTier = b.sessions.reduce((acc, s) => acc + s.tier, 0) / b.sessions.length;
    }
    return Array.from(map.values());
  }, [data.sessions]);

  // Filter + sort
  const filtered = useMemo(() => {
    let result = folders;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(f => f.name.toLowerCase().includes(q));
    }
    result.sort((a, b) => {
      if (sortBy === 'sessions') return b.sessions.length - a.sessions.length;
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      return a.avgTier - b.avgTier;
    });
    return result;
  }, [folders, search, sortBy]);

  const selectedBucket = useMemo(() => {
    if (!selectedFolder) return null;
    return folders.find(f => f.name === selectedFolder) || null;
  }, [selectedFolder, folders]);

  const filteredSessions = useMemo(() => {
    if (!selectedBucket) return [];
    if (!sessionSearch.trim()) return selectedBucket.sessions;
    const q = sessionSearch.toLowerCase();
    return selectedBucket.sessions.filter(s =>
      s.name.toLowerCase().includes(q) || s.full.toLowerCase().includes(q)
    );
  }, [selectedBucket, sessionSearch]);

  const handleFolderClick = useCallback((name: string) => {
    setSelectedFolder(prev => prev === name ? null : name);
    setSessionSearch('');
  }, []);

  // Stats
  const totalFolders = folders.length;
  const maxSessions = folders.reduce((m, f) => Math.max(m, f.sessions.length), 0);

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: "'JetBrains Mono', monospace" }}>
      {/* ── Left: Folder list ── */}
      <div style={{ width: 420, borderRight: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: 12, borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
              Folders ({totalFolders})
            </span>
            <span style={{ fontSize: 10, color: T.muted }}>
              {data.sessions.length} sessions total
            </span>
          </div>
          <input
            type="text"
            {...searchInputProps}
            placeholder="Filter folders... (Enter to search)"
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6,
              border: `1px solid ${T.border}`, background: T.bg, color: T.text,
              fontSize: 11, outline: 'none', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {(['sessions', 'name', 'tier'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                style={{
                  padding: '3px 8px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
                  border: `1px solid ${sortBy === s ? T.accent : T.border}`,
                  background: sortBy === s ? T.accentBg : 'transparent',
                  color: sortBy === s ? T.accent : T.muted,
                }}
              >
                {s === 'sessions' ? '# Sessions' : s === 'name' ? 'Name' : 'Avg Tier'}
              </button>
            ))}
          </div>
        </div>

        {/* Folder cards */}
        <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
          {filtered.map(f => {
            const isSelected = selectedFolder === f.name;
            const pct = maxSessions > 0 ? (f.sessions.length / maxSessions) * 100 : 0;
            return (
              <div
                key={f.name}
                onClick={() => handleFolderClick(f.name)}
                style={{
                  padding: '10px 12px', marginBottom: 6, borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${isSelected ? T.accent : T.border}`,
                  background: isSelected ? T.accentBg : T.surface,
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: isSelected ? T.accent : T.text, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: T.accent }}>
                    {f.sessions.length}
                  </span>
                </div>

                {/* Bar */}
                <div style={{ height: 4, borderRadius: 2, background: T.bg, marginBottom: 6 }}>
                  <div style={{ height: '100%', borderRadius: 2, background: T.accent, width: `${pct}%`, transition: 'width 0.3s' }} />
                </div>

                {/* Tier chips */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {Array.from(f.tiers.entries()).sort((a, b) => a[0] - b[0]).map(([tier, count]) => (
                    <span key={tier} style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 3,
                      background: `${tierColor(tier)}20`, color: tierColor(tier),
                    }}>
                      T{tier}: {count}
                    </span>
                  ))}
                  {f.critical > 0 && (
                    <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: '#ef444420', color: '#ef4444' }}>
                      {f.critical} critical
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <span style={{ fontSize: 9, color: T.muted }}>{f.workflows.size} workflow{f.workflows.size !== 1 ? 's' : ''}</span>
                  <span style={{ fontSize: 9, color: T.muted }}>avg tier {f.avgTier.toFixed(1)}</span>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: T.muted, fontSize: 12 }}>
              No folders match filter
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Session detail ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedBucket ? (
          <>
            {/* Folder header */}
            <div style={{ padding: 16, borderBottom: `1px solid ${T.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, color: T.text }}>{selectedBucket.name}</h3>
                  <span style={{ fontSize: 11, color: T.muted }}>
                    {selectedBucket.sessions.length} sessions · {selectedBucket.workflows.size} workflows · avg tier {selectedBucket.avgTier.toFixed(1)}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedFolder(null)}
                  style={{ background: 'none', border: `1px solid ${T.border}`, borderRadius: 4, padding: '4px 10px', color: T.muted, cursor: 'pointer', fontSize: 11 }}
                >
                  ✕ Close
                </button>
              </div>
              <input
                type="text"
                value={sessionSearch}
                onChange={e => setSessionSearch(e.target.value)}
                placeholder="Filter sessions in this folder..."
                style={{
                  width: '100%', padding: '6px 10px', borderRadius: 6, marginTop: 10,
                  border: `1px solid ${T.border}`, background: T.bg, color: T.text,
                  fontSize: 11, outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Session list */}
            <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', color: T.muted, fontWeight: 600 }}>Session</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', color: T.muted, fontWeight: 600 }}>Workflow</th>
                    <th style={{ textAlign: 'center', padding: '6px 8px', color: T.muted, fontWeight: 600 }}>Tier</th>
                    <th style={{ textAlign: 'center', padding: '6px 8px', color: T.muted, fontWeight: 600 }}>Transforms</th>
                    <th style={{ textAlign: 'center', padding: '6px 8px', color: T.muted, fontWeight: 600 }}>Sources</th>
                    <th style={{ textAlign: 'center', padding: '6px 8px', color: T.muted, fontWeight: 600 }}>Targets</th>
                    <th style={{ textAlign: 'center', padding: '6px 8px', color: T.muted, fontWeight: 600 }}>Critical</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map(s => (
                    <tr key={s.id} style={{ borderBottom: `1px solid ${T.border}22` }}>
                      <td style={{ padding: '6px 8px', color: T.text, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.full}>
                        {s.name}
                      </td>
                      <td style={{ padding: '6px 8px', color: T.muted, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.workflow || '-'}
                      </td>
                      <td style={{ textAlign: 'center', padding: '6px 8px' }}>
                        <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: 10, background: `${tierColor(s.tier)}20`, color: tierColor(s.tier) }}>
                          T{Math.floor(s.tier)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center', padding: '6px 8px', color: T.muted }}>{s.transforms}</td>
                      <td style={{ textAlign: 'center', padding: '6px 8px', color: T.muted }}>{s.sources?.length || 0}</td>
                      <td style={{ textAlign: 'center', padding: '6px 8px', color: T.muted }}>{s.targets?.length || 0}</td>
                      <td style={{ textAlign: 'center', padding: '6px 8px' }}>
                        {s.critical ? <span style={{ color: '#ef4444' }}>●</span> : <span style={{ color: T.border }}>○</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredSessions.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', color: T.muted, fontSize: 12 }}>
                  No sessions match filter
                </div>
              )}
            </div>
          </>
        ) : (
          /* Empty state */
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 32, opacity: 0.3 }}>📁</span>
            <span style={{ fontSize: 13, color: T.muted }}>Select a folder to see its sessions</span>
            <span style={{ fontSize: 11, color: T.border }}>
              {totalFolders} folders · {data.sessions.length} sessions
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
