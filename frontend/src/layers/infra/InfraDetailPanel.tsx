/**
 * InfraDetailPanel — Tabbed right panel for L1A Infrastructure Topology.
 * Tabs: Overview | Sessions | Tables | Connections
 */

import React, { useMemo, useState } from 'react';
import type { SystemNode, SystemEdge, SchemaGroup } from './infraUtils';
import { ENV_COLORS, SYSTEM_ICONS, groupBySchema, inferSystem } from './infraUtils';
import type { TierMapResult } from '../../types/tiermap';

type Tab = 'overview' | 'sessions' | 'tables' | 'connections';

interface Props {
  system: SystemNode;
  edges: SystemEdge[];
  nodes: SystemNode[];
  tierData: TierMapResult;
  onNavigateView?: (view: string) => void;
}

const CAP = 8;

export default function InfraDetailPanel({ system, edges, nodes, tierData, onNavigateView }: Props) {
  const [tab, setTab] = useState<Tab>('overview');

  const connectedEdges = useMemo(
    () => edges.filter(e => e.source === system.system_id || e.target === system.system_id),
    [edges, system.system_id]
  );

  // Sessions that touch this system
  const sessions = useMemo(() => {
    const sids = new Set(system.session_ids);
    return tierData.sessions.filter(s => sids.has(s.id));
  }, [system.session_ids, tierData.sessions]);

  // Tables belonging to this system
  const systemTables = useMemo(() => {
    return tierData.tables.filter(t => inferSystem(t.name).system_id === system.system_id);
  }, [tierData.tables, system.system_id]);

  // Schema grouping from raw names
  const schemaGroups = useMemo((): SchemaGroup[] => {
    const rawNames: string[] = [];
    for (const sess of sessions) {
      const rs = (sess as any).raw_sources as string[] | undefined;
      const rt = (sess as any).raw_targets as string[] | undefined;
      const rl = (sess as any).raw_lookups as string[] | undefined;
      if (rs) rawNames.push(...rs);
      if (rt) rawNames.push(...rt);
      if (rl) rawNames.push(...rl);
    }
    if (rawNames.length === 0) return [];
    // Filter to tables that match this system
    const sysId = system.system_id;
    const relevant = rawNames.filter(raw => {
      const stripped = raw.includes('/') ? raw.split('/').pop()! : raw.includes(':') ? raw.split(':').pop()! : raw;
      const tableName = stripped.includes('.') ? stripped.split('.').pop()! : stripped;
      return inferSystem(tableName).system_id === sysId;
    });
    return groupBySchema(relevant);
  }, [sessions, system.system_id]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'sessions', label: `Sessions (${sessions.length})` },
    { id: 'tables', label: `Tables (${systemTables.length})` },
    { id: 'connections', label: `Conns (${system.sub_nodes.length})` },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-lg">{SYSTEM_ICONS[system.system_type] ?? SYSTEM_ICONS.unknown}</span>
          <div>
            <div className="text-sm font-medium text-gray-300">{system.system_type.toUpperCase()}</div>
            <div className="text-xs text-gray-500 flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: ENV_COLORS[system.environment] ?? ENV_COLORS.unknown }} />
              {system.environment}
            </div>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-700 px-1">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-2 py-1.5 text-[10px] font-medium border-b-2 transition-colors ${
              tab === t.id
                ? 'border-blue-400 text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {tab === 'overview' && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatBox label="Sessions" value={system.session_count} />
              <StatBox label="Tables" value={system.table_count} />
              <StatBox label="Conns" value={system.sub_nodes.length} />
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1.5">Connected Systems</div>
              <div className="space-y-1">
                {connectedEdges.length === 0 && (
                  <div className="text-[10px] text-gray-600">No connections</div>
                )}
                {connectedEdges.map(e => {
                  const otherId = e.source === system.system_id ? e.target : e.source;
                  const other = nodes.find(n => n.system_id === otherId);
                  const arrow = e.direction === 'bidirectional'
                    ? '\u2194'
                    : e.source === system.system_id ? '\u2192' : '\u2190';
                  return (
                    <div key={otherId} className="flex items-center gap-1.5 text-xs">
                      <span>{SYSTEM_ICONS[other?.system_type ?? 'unknown'] ?? '\u2B1C'}</span>
                      <span className="text-gray-400 text-[10px]">{arrow}</span>
                      <span className="text-gray-300 flex-1 truncate">{other?.system_type ?? otherId}</span>
                      <span className="text-gray-500 text-[10px]">{e.session_count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {tab === 'sessions' && (
          <div className="space-y-1">
            {sessions.slice(0, CAP).map(s => (
              <button
                key={s.id}
                onClick={() => onNavigateView?.('flow')}
                className="w-full text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-700/50 transition-colors group"
              >
                <span className="text-[10px] text-gray-500 font-mono w-6">{s.id}</span>
                <span className="text-xs text-gray-300 flex-1 truncate">{(s as any).name ?? s.id}</span>
                <span className="text-[10px] text-gray-600 group-hover:text-blue-400">\u2192</span>
              </button>
            ))}
            {sessions.length > CAP && (
              <div className="text-[10px] text-gray-500 px-2 pt-1">
                +{sessions.length - CAP} more sessions
              </div>
            )}
            {sessions.length === 0 && (
              <div className="text-[10px] text-gray-600">No sessions found</div>
            )}
          </div>
        )}

        {tab === 'tables' && (
          <div className="space-y-2">
            {schemaGroups.length > 0 ? (
              schemaGroups.map(sg => (
                <SchemaSection key={sg.schema} group={sg} />
              ))
            ) : (
              <>
                {systemTables.slice(0, CAP).map(t => (
                  <div key={t.id} className="text-xs text-gray-300 truncate px-1">{t.name}</div>
                ))}
                {systemTables.length > CAP && (
                  <div className="text-[10px] text-gray-500 px-1">
                    +{systemTables.length - CAP} more tables
                  </div>
                )}
                {systemTables.length === 0 && (
                  <div className="text-[10px] text-gray-600">No tables matched</div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'connections' && (
          <div className="space-y-2">
            {system.sub_nodes.length === 0 && (
              <div className="text-[10px] text-gray-600">No named connections (regex inference mode)</div>
            )}
            {system.sub_nodes.map(sn => (
              <div key={sn.connection_name} className="bg-gray-700/30 rounded p-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-300 truncate flex-1">{sn.connection_name}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-600 text-gray-400">{sn.dbtype}</span>
                </div>
                <div className="text-[10px] text-gray-500">{sn.session_count} sessions</div>
                {sn.parsed_connection && (sn.parsed_connection.host || sn.parsed_connection.database) && (
                  <div className="text-[10px] text-gray-500 font-mono space-y-0.5">
                    {sn.parsed_connection.host && (
                      <div>host: {sn.parsed_connection.host}{sn.parsed_connection.port ? `:${sn.parsed_connection.port}` : ''}</div>
                    )}
                    {sn.parsed_connection.database && <div>db: {sn.parsed_connection.database}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center bg-gray-700/50 rounded p-2">
      <div className="text-base font-bold text-gray-200">{value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}

function SchemaSection({ group }: { group: SchemaGroup }) {
  const [expanded, setExpanded] = useState(group.schema !== '(default)');
  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left flex items-center gap-1 text-[10px] font-medium text-gray-400 hover:text-gray-300"
      >
        <span className="text-gray-600">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span className="font-mono">{group.schema}</span>
        <span className="text-gray-600">({group.tables.length})</span>
      </button>
      {expanded && (
        <div className="ml-3 mt-0.5 space-y-0.5">
          {group.tables.slice(0, CAP).map(t => (
            <div key={t} className="text-xs text-gray-300 truncate">{t}</div>
          ))}
          {group.tables.length > CAP && (
            <div className="text-[10px] text-gray-500">+{group.tables.length - CAP} more</div>
          )}
        </div>
      )}
    </div>
  );
}
