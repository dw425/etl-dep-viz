/**
 * DuplicatePipelines — Detect and display near-match, exact-match, and
 * partial-match duplicate/repeat pipelines. Groups sessions into buckets
 * of similarity and lets the user inspect each group.
 */

import React, { useMemo, useState } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import TierFilterSidebar, { type TierFilters, getDefaultTierFilters, applyTierFilters } from '../shared/TierFilterSidebar';

interface Props {
  data: TierMapResult;
}

interface DuplicateGroup {
  id: string;
  matchType: 'exact' | 'near' | 'partial';
  fingerprint: string;
  sessions: Array<{ id: string; name: string; full: string; sources: string[]; targets: string[]; lookups: string[] }>;
  similarity: number;
}

function computeFingerprint(s: any): string {
  const sources = [...(s.sources || [])].sort().join(',');
  const targets = [...(s.targets || [])].sort().join(',');
  const lookups = [...(s.lookups || [])].sort().join(',');
  return `${sources}|${targets}|${lookups}`;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

function computeTableSet(s: any): Set<string> {
  return new Set([...(s.sources || []), ...(s.targets || []), ...(s.lookups || [])]);
}

export default function DuplicatePipelines({ data }: Props) {
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<'all' | 'exact' | 'near' | 'partial'>('all');
  const [tierFilters, setTierFilters] = useState<TierFilters>(getDefaultTierFilters);
  const filteredData = useMemo(() => applyTierFilters(data, tierFilters), [data, tierFilters]);

  const groups = useMemo(() => {
    const sessions = filteredData.sessions;
    const result: DuplicateGroup[] = [];
    const used = new Set<string>();

    // Phase 1: Exact matches (identical fingerprints)
    const fpMap = new Map<string, any[]>();
    for (const s of sessions) {
      const fp = computeFingerprint(s);
      if (!fpMap.has(fp)) fpMap.set(fp, []);
      fpMap.get(fp)!.push(s);
    }

    let gid = 0;
    for (const [fp, group] of fpMap) {
      if (group.length > 1) {
        result.push({
          id: `exact-${gid++}`,
          matchType: 'exact',
          fingerprint: fp,
          sessions: group.map((s: any) => ({ id: s.id, name: s.name, full: s.full, sources: s.sources || [], targets: s.targets || [], lookups: s.lookups || [] })),
          similarity: 1.0,
        });
        group.forEach((s: any) => used.add(s.id));
      }
    }

    // Phase 2: Near matches (Jaccard >= 0.7) and Partial (>= 0.4)
    // Cap at 2000 sessions to keep O(n²) Jaccard feasible
    const remaining = sessions.filter(s => !used.has(s.id)).slice(0, 2000);
    const tableSets = remaining.map(s => ({ session: s, tables: computeTableSet(s) }));

    for (let i = 0; i < tableSets.length; i++) {
      if (used.has(tableSets[i].session.id)) continue;
      const nearGroup: any[] = [tableSets[i].session];
      const partialGroup: any[] = [];

      for (let j = i + 1; j < tableSets.length; j++) {
        if (used.has(tableSets[j].session.id)) continue;
        const sim = jaccardSimilarity(tableSets[i].tables, tableSets[j].tables);
        if (sim >= 0.7) {
          nearGroup.push(tableSets[j].session);
          used.add(tableSets[j].session.id);
        } else if (sim >= 0.4) {
          partialGroup.push({ session: tableSets[j].session, similarity: sim });
        }
      }

      if (nearGroup.length > 1) {
        used.add(tableSets[i].session.id);
        result.push({
          id: `near-${gid++}`,
          matchType: 'near',
          fingerprint: '',
          sessions: nearGroup.map((s: any) => ({ id: s.id, name: s.name, full: s.full, sources: s.sources || [], targets: s.targets || [], lookups: s.lookups || [] })),
          similarity: 0.7,
        });
      }

      if (partialGroup.length > 0 && !used.has(tableSets[i].session.id)) {
        used.add(tableSets[i].session.id);
        result.push({
          id: `partial-${gid++}`,
          matchType: 'partial',
          fingerprint: '',
          sessions: [
            { id: tableSets[i].session.id, name: tableSets[i].session.name, full: tableSets[i].session.full, sources: (tableSets[i].session as any).sources || [], targets: (tableSets[i].session as any).targets || [], lookups: (tableSets[i].session as any).lookups || [] },
            ...partialGroup.map(p => ({ id: p.session.id, name: p.session.name, full: p.session.full, sources: p.session.sources || [], targets: p.session.targets || [], lookups: p.session.lookups || [] })),
          ],
          similarity: partialGroup.reduce((sum: number, p: any) => sum + p.similarity, 0) / partialGroup.length,
        });
      }
    }

    return result.sort((a, b) => b.sessions.length - a.sessions.length);
  }, [filteredData]);

  const [groupPage, setGroupPage] = useState(1);
  const allFiltered = filterType === 'all' ? groups : groups.filter(g => g.matchType === filterType);
  const filtered = allFiltered.slice(0, groupPage * 100);
  const selected = selectedGroup ? groups.find(g => g.id === selectedGroup) : null;

  const exactCount = groups.filter(g => g.matchType === 'exact').length;
  const nearCount = groups.filter(g => g.matchType === 'near').length;
  const partialCount = groups.filter(g => g.matchType === 'partial').length;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left sidebar */}
      <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #1e293b' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
            Duplicate Pipelines
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { key: 'all', label: `All (${groups.length})` },
              { key: 'exact', label: `Exact (${exactCount})`, color: '#EF4444' },
              { key: 'near', label: `Near (${nearCount})`, color: '#F59E0B' },
              { key: 'partial', label: `Partial (${partialCount})`, color: '#3B82F6' },
            ].map(f => (
              <button
                key={f.key}
                onClick={() => setFilterType(f.key as any)}
                style={{
                  fontSize: 9, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                  background: filterType === f.key ? (f.color ? `${f.color}20` : 'rgba(59,130,246,0.2)') : 'rgba(255,255,255,0.05)',
                  color: filterType === f.key ? (f.color || '#60a5fa') : '#64748b',
                  fontWeight: filterType === f.key ? 700 : 500,
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {filtered.length === 0 ? (
            <div style={{ fontSize: 11, color: '#64748b', textAlign: 'center', padding: 20 }}>
              No duplicate groups found
            </div>
          ) : (
            filtered.map(g => {
              const isSel = selectedGroup === g.id;
              const matchColor = g.matchType === 'exact' ? '#EF4444' : g.matchType === 'near' ? '#F59E0B' : '#3B82F6';
              return (
                <div
                  key={g.id}
                  onClick={() => setSelectedGroup(g.id === selectedGroup ? null : g.id)}
                  style={{
                    padding: '10px 12px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                    background: isSel ? 'rgba(59,130,246,0.15)' : 'transparent',
                    border: `1px solid ${isSel ? 'rgba(59,130,246,0.4)' : 'transparent'}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: `${matchColor}20`, color: matchColor, fontWeight: 700 }}>
                        {g.matchType.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 11, color: '#e2e8f0', marginLeft: 8, fontWeight: 600 }}>
                        {g.sessions.length} sessions
                      </span>
                    </div>
                    <span style={{ fontSize: 9, color: '#64748b' }}>
                      {Math.round(g.similarity * 100)}% match
                    </span>
                  </div>
                  <div style={{ fontSize: 9, color: '#64748b', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.sessions.slice(0, 3).map(s => s.name).join(', ')}
                    {g.sessions.length > 3 && ` +${g.sessions.length - 3} more`}
                  </div>
                </div>
              );
            })
          )}
          {filtered.length < allFiltered.length && (
            <button
              onClick={() => setGroupPage(p => p + 1)}
              style={{
                fontSize: 10, padding: '6px 12px', borderRadius: 4, border: '1px solid #334155',
                background: '#1e293b', color: '#94a3b8', cursor: 'pointer', width: '100%', marginTop: 4,
              }}
            >
              Show more ({allFiltered.length - filtered.length} remaining)
            </button>
          )}
        </div>
      </div>

      {/* Right detail */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {selected ? (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>
                {selected.matchType.charAt(0).toUpperCase() + selected.matchType.slice(1)} Match Group
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                {selected.sessions.length} sessions with {Math.round(selected.similarity * 100)}% table overlap
              </div>
            </div>

            {selected.sessions.map(s => (
              <div key={s.id} style={{
                marginBottom: 12, padding: 12, borderRadius: 8,
                background: '#111827', border: '1px solid #1e293b',
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', fontFamily: "'JetBrains Mono', monospace" }}>
                  {s.full || s.name}
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                  {s.sources.length > 0 && (
                    <div>
                      <div style={{ fontSize: 9, color: '#22C55E', fontWeight: 700 }}>READS ({s.sources.length})</div>
                      <div style={{ fontSize: 9, color: '#64748b', marginTop: 2 }}>{s.sources.join(', ')}</div>
                    </div>
                  )}
                  {s.targets.length > 0 && (
                    <div>
                      <div style={{ fontSize: 9, color: '#EF4444', fontWeight: 700 }}>WRITES ({s.targets.length})</div>
                      <div style={{ fontSize: 9, color: '#64748b', marginTop: 2 }}>{s.targets.join(', ')}</div>
                    </div>
                  )}
                  {s.lookups.length > 0 && (
                    <div>
                      <div style={{ fontSize: 9, color: '#F59E0B', fontWeight: 700 }}>LOOKUPS ({s.lookups.length})</div>
                      <div style={{ fontSize: 9, color: '#64748b', marginTop: 2 }}>{s.lookups.join(', ')}</div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.4 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>&#9664;</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Select a duplicate group to compare pipelines</div>
          </div>
        )}
      </div>
      <TierFilterSidebar data={data} filters={tierFilters} onChange={setTierFilters} compact />
    </div>
  );
}
