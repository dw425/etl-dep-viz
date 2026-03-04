/**
 * constants.ts -- Shared colors, connection config, tier config, palette,
 * and the buildSessionData helper used by all tier-map view components.
 */

import type { TierMapResult, TierSession, TierTable, TierConn } from '../../types/tiermap';

// ── Color tokens (dark theme) ─────────────────────────────────────────────────

export const C = {
  bg: '#1a2332',
  surface: '#243044',
  border: '#3a4a5e',
  borderActive: '#3b82f6',
  text: '#e2e8f0',
  textMuted: '#8899aa',
  textDim: '#5a6a7a',
  write: '#ef4444',
  read: '#22c55e',
  lookup: '#f59e0b',
  conflict: '#ef4444',
  chain: '#a855f7',
  accentBlue: '#60a5fa',
} as const;

// ── Connection type configuration ─────────────────────────────────────────────

export interface ConnTypeConfig {
  color: string;
  label: string;
  dash: string;
  baseWidth: number;
}

export const connTypes: Record<TierConn['type'], ConnTypeConfig> = {
  write_conflict: { color: '#EF4444', label: 'Write Conflict', dash: '', baseWidth: 3 },
  write_clean: { color: '#3B82F6', label: 'Clean Write', dash: '', baseWidth: 1.5 },
  read_after_write: { color: '#A855F7', label: 'Read-After-Write', dash: '', baseWidth: 2 },
  lookup_stale: { color: '#F59E0B', label: 'Lookup Staleness', dash: '6,3', baseWidth: 2 },
  chain: { color: '#F97316', label: 'Dependency Chain', dash: '', baseWidth: 2.5 },
  source_read: { color: '#10B981', label: 'Source Read', dash: '', baseWidth: 1.5 },
};

// ── Static tier band configuration ────────────────────────────────────────────

export interface TierCfg {
  label: string;
  color: string;
  bgAlpha: string;
  border: string;
}

export const TIER_CFG_STATIC: Record<number, TierCfg> = {
  0.5: { label: 'EXTERNAL SOURCES & REFERENCE TABLES', color: '#10B981', bgAlpha: 'rgba(16,185,129,0.06)', border: '#059669' },
  1: { label: 'TIER 1 \u2014 INDEPENDENT PARALLEL EXECUTION', color: '#3B82F6', bgAlpha: 'rgba(59,130,246,0.06)', border: '#2563EB' },
  1.5: { label: 'TIER 1 OUTPUTS', color: '#22C55E', bgAlpha: 'rgba(34,197,94,0.05)', border: '#16A34A' },
  2: { label: 'TIER 2 \u2014 DEPENDENT ON TIER 1', color: '#EAB308', bgAlpha: 'rgba(234,179,8,0.06)', border: '#CA8A04' },
  2.5: { label: 'CRITICAL GATE \u2014 WRITE CONFLICTS', color: '#EF4444', bgAlpha: 'rgba(239,68,68,0.08)', border: '#DC2626' },
  3: { label: 'TIER 3 \u2014 DOWNSTREAM CONSUMERS', color: '#A855F7', bgAlpha: 'rgba(168,85,247,0.06)', border: '#9333EA' },
  3.5: { label: 'TIER 3 OUTPUTS & CHAIN TABLES', color: '#F97316', bgAlpha: 'rgba(249,115,22,0.05)', border: '#EA580C' },
  4: { label: 'TIER 4 \u2014 DEEP DOWNSTREAM', color: '#06B6D4', bgAlpha: 'rgba(6,182,212,0.06)', border: '#0891B2' },
  4.5: { label: 'TIER 4 OUTPUTS', color: '#8B5CF6', bgAlpha: 'rgba(139,92,246,0.05)', border: '#7C3AED' },
  5: { label: 'TIER 5 \u2014 DEEP PIPELINE', color: '#EC4899', bgAlpha: 'rgba(236,72,153,0.06)', border: '#DB2777' },
  5.5: { label: 'TIER 5 OUTPUTS', color: '#84CC16', bgAlpha: 'rgba(132,204,22,0.05)', border: '#65A30D' },
  6: { label: 'TIER 6 \u2014 ADVANCED DOWNSTREAM', color: '#F43F5E', bgAlpha: 'rgba(244,63,94,0.06)', border: '#E11D48' },
  6.5: { label: 'TIER 6 OUTPUTS', color: '#14B8A6', bgAlpha: 'rgba(20,184,166,0.05)', border: '#0D9488' },
};

export const PALETTE = [
  '#3B82F6', '#EAB308', '#A855F7', '#10B981', '#F97316',
  '#06B6D4', '#EC4899', '#84CC16', '#F43F5E', '#8B5CF6',
  '#14B8A6', '#FB923C', '#818CF8', '#34D399', '#F87171',
];

export function getTierCfg(tier: number): TierCfg {
  if (TIER_CFG_STATIC[tier]) return TIER_CFG_STATIC[tier];
  const isHalf = tier % 1 !== 0;
  const base = Math.floor(tier);
  const color = PALETTE[(base - 1) % PALETTE.length];
  return {
    label: isHalf ? 'TIER ' + base + ' OUTPUTS' : 'TIER ' + base + ' \u2014 PIPELINE STAGE',
    color,
    bgAlpha: color + '0F',
    border: color,
  };
}

// ── Session detail type ───────────────────────────────────────────────────────

export interface SessionDetail {
  short: string;
  step: number;
  tier: number;
  transforms: number;
  extReads: number;
  lookupCount: number;
  critical: boolean;
  sources: string[];
  targets: string[];
  lookups: string[];
  transformDetail: Record<string, number>;
}

// ── Table aggregate ───────────────────────────────────────────────────────────

export interface TableAggregate {
  writes: string[];
  reads: string[];
  lookups: string[];
}

// ── Tier group (sessions + tables sharing a tier value) ───────────────────────

export interface TierGroup {
  tier: number;
  sessions: TierSession[];
  tables: TierTable[];
}

// ── Table style lookup ────────────────────────────────────────────────────────

export interface TableStyle {
  bg: string;
  border: string;
  color: string;
  icon: string;
}

export const TABLE_STYLES: Record<TierTable['type'], TableStyle> = {
  conflict: { bg: 'rgba(239,68,68,0.12)', border: '#EF4444', color: '#FCA5A5', icon: '\u26A0' },
  chain: { bg: 'rgba(249,115,22,0.10)', border: '#F97316', color: '#FDBA74', icon: '\u26D3' },
  independent: { bg: 'rgba(34,197,94,0.08)', border: '#22C55E', color: '#86EFAC', icon: '\u2713' },
  source: { bg: 'rgba(16,185,129,0.08)', border: '#10B981', color: '#6EE7B7', icon: '\u2193' },
};

// ── Connection type short label ───────────────────────────────────────────────

export function connShortLabel(type: TierConn['type']): string {
  const map: Record<string, string> = {
    write_conflict: 'W\u26A0',
    write_clean: 'W',
    read_after_write: 'R',
    lookup_stale: 'L',
    chain: '\u26D3',
    source_read: 'SR',
  };
  return map[type] || '?';
}

// ── Build session detail map from TierMapResult ───────────────────────────────

export function buildSessionData(data: TierMapResult): Record<string, SessionDetail> {
  const tableIdToName = new Map<string, string>();
  data.tables.forEach(t => tableIdToName.set(t.id, t.name));

  const result: Record<string, SessionDetail> = {};
  data.sessions.forEach(s => {
    const targets: string[] = [];
    const sources: string[] = [];
    const lookups: string[] = [];

    data.connections.forEach(c => {
      // Session -> Table = write/chain target
      if (c.from === s.id && tableIdToName.has(c.to)) {
        const tName = tableIdToName.get(c.to)!;
        if (!targets.includes(tName)) targets.push(tName);
      }
      // Table -> Session = read/lookup source
      if (c.to === s.id && tableIdToName.has(c.from)) {
        const tName = tableIdToName.get(c.from)!;
        if (c.type === 'read_after_write' || c.type === 'source_read') {
          if (!sources.includes(tName)) sources.push(tName);
        } else if (c.type === 'lookup_stale') {
          if (!lookups.includes(tName)) lookups.push(tName);
        }
      }
    });

    result[s.full] = {
      short: s.name,
      step: s.step,
      tier: s.tier,
      transforms: s.transforms,
      extReads: s.extReads,
      lookupCount: s.lookupCount,
      critical: s.critical,
      sources,
      targets,
      lookups,
      transformDetail: {},
    };
  });
  return result;
}

// ── Derive write conflicts (tables with >1 writer) ───────────────────────────

export function deriveWriteConflicts(
  sessionData: Record<string, SessionDetail>,
): Record<string, string[]> {
  const allTargets: Record<string, string[]> = {};
  Object.entries(sessionData).forEach(([name, s]) => {
    s.targets.forEach(t => {
      if (!allTargets[t]) allTargets[t] = [];
      allTargets[t].push(name);
    });
  });
  const conflicts: Record<string, string[]> = {};
  Object.entries(allTargets).forEach(([t, writers]) => {
    if (writers.length > 1) conflicts[t] = writers;
  });
  return conflicts;
}

// ── Derive read-after-write chains ────────────────────────────────────────────

export interface RAWChain {
  writers: string[];
  readers: string[];
}

export function deriveReadAfterWrite(
  sessionData: Record<string, SessionDetail>,
): Record<string, RAWChain> {
  const allTargets: Record<string, string[]> = {};
  const allSources: Record<string, string[]> = {};
  Object.entries(sessionData).forEach(([name, s]) => {
    s.targets.forEach(t => {
      if (!allTargets[t]) allTargets[t] = [];
      allTargets[t].push(name);
    });
    [...s.sources, ...s.lookups].forEach(t => {
      if (!allSources[t]) allSources[t] = [];
      if (!allSources[t].includes(name)) allSources[t].push(name);
    });
  });
  const raw: Record<string, RAWChain> = {};
  Object.entries(allTargets).forEach(([t, writers]) => {
    const readers = (allSources[t] || []).filter(x => !writers.includes(x));
    if (readers.length > 0) raw[t] = { writers, readers };
  });
  return raw;
}

// ── Derive table aggregates ───────────────────────────────────────────────────

export function deriveTableAggregates(
  sessionData: Record<string, SessionDetail>,
): Record<string, TableAggregate> {
  const allTables: Record<string, TableAggregate> = {};
  Object.entries(sessionData).forEach(([name, s]) => {
    s.targets.forEach(t => {
      if (!allTables[t]) allTables[t] = { writes: [], reads: [], lookups: [] };
      allTables[t].writes.push(name);
    });
    s.sources.forEach(t => {
      if (!allTables[t]) allTables[t] = { writes: [], reads: [], lookups: [] };
      allTables[t].reads.push(name);
    });
    s.lookups.forEach(t => {
      if (!allTables[t]) allTables[t] = { writes: [], reads: [], lookups: [] };
      if (!allTables[t].lookups.includes(name)) allTables[t].lookups.push(name);
    });
  });
  return allTables;
}

// ── Build tier groups from TierMapResult ──────────────────────────────────────

export function buildTierGroups(data: TierMapResult): TierGroup[] {
  const allTierNums = new Set<number>();
  data.sessions.forEach(s => allTierNums.add(s.tier));
  data.tables.forEach(t => allTierNums.add(t.tier));
  return Array.from(allTierNums)
    .sort((a, b) => a - b)
    .map(tier => ({
      tier,
      sessions: data.sessions.filter(s => s.tier === tier),
      tables: data.tables.filter(t => t.tier === tier),
    }))
    .filter(g => g.sessions.length > 0 || g.tables.length > 0);
}

// ── Derive execution order (session full names sorted by step) ────────────────

export function buildExecutionOrder(data: TierMapResult): string[] {
  return data.sessions
    .slice()
    .sort((a, b) => a.step - b.step)
    .map(s => s.full);
}
