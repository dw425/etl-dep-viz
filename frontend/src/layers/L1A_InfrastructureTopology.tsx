/**
 * L1A_InfrastructureTopology — system-level infrastructure graph.
 * Shows Oracle, Teradata, S3, Kafka instances as supernodes with session-count edges.
 * Tab alongside L1 Enterprise Constellation view.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { VectorResults } from '../types/vectors';
import type { TierMapResult } from '../types/tiermap';

interface SystemNode {
  system_id: string;
  system_type: string;
  environment: string;
  session_count: number;
  table_count: number;
  connections: string[];
}

interface SystemEdge {
  source: string;
  target: string;
  session_count: number;
  direction: 'read' | 'write' | 'bidirectional';
}

interface Props {
  tierData: TierMapResult;
  vectorResults: VectorResults | null;
}

const ENV_COLORS: Record<string, string> = {
  'on-prem': '#F59E0B',
  aws: '#FF9900',
  azure: '#0078D4',
  gcp: '#4285F4',
  unknown: '#6B7280',
};

const SYSTEM_ICONS: Record<string, string> = {
  oracle: '🔶',
  teradata: '🟠',
  postgres: '🐘',
  mysql: '🐬',
  sqlserver: '🔷',
  s3: '📦',
  kafka: '📡',
  hdfs: '💾',
  ftp: '📂',
  http: '🌐',
  unknown: '⬜',
};

export default function L1A_InfrastructureTopology({ tierData, vectorResults }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedSystem, setSelectedSystem] = useState<SystemNode | null>(null);
  const [hoveredSystem, setHoveredSystem] = useState<string | null>(null);

  // Build infrastructure graph — prefer connection_profiles when available, fallback to regex
  const connectionProfiles = (tierData as any).connection_profiles as { name: string; dbtype: string; dbsubtype?: string; connection_string?: string }[] | undefined;

  const { nodes, edges } = useMemo(() => {
    const systemMap = new Map<string, SystemNode>();
    const edgeMap = new Map<string, SystemEdge>();

    // Primary source: connection_profiles from parsed DBCONNECTION elements
    if (connectionProfiles && connectionProfiles.length > 0) {
      // Build systems from real connection profiles
      for (const cp of connectionProfiles) {
        const sysType = mapDbTypeToSystem(cp.dbtype);
        const env = mapDbTypeToEnv(cp.dbtype);
        const sysId = `${sysType}_${cp.name}`;
        if (!systemMap.has(sysId)) {
          systemMap.set(sysId, {
            system_id: sysId,
            system_type: sysType,
            environment: env,
            session_count: 0,
            table_count: 0,
            connections: [cp.name],
          });
        }
      }

      // Count sessions per system using connections_used on sessions
      for (const session of tierData.sessions) {
        const sessConns = (session as any).connections_used as { connection_name: string; dbtype: string }[] | undefined;
        if (sessConns) {
          for (const sc of sessConns) {
            const sysType = mapDbTypeToSystem(sc.dbtype);
            const matchId = Array.from(systemMap.keys()).find(k => k.startsWith(sysType) && systemMap.get(k)?.connections.includes(sc.connection_name));
            if (matchId && systemMap.has(matchId)) {
              systemMap.get(matchId)!.session_count++;
            }
          }
        }
      }
    }

    // Fallback: infer systems from table names (regex-based)
    if (systemMap.size === 0) {
      for (const table of tierData.tables) {
        const sys = inferSystem(table.name);
        if (!systemMap.has(sys.system_id)) {
          systemMap.set(sys.system_id, {
            ...sys,
            session_count: 0,
            table_count: 0,
            connections: [],
          });
        }
        systemMap.get(sys.system_id)!.table_count++;
      }

      // Count sessions per system via connection graph
      const sessionIdSet = new Set(tierData.sessions.map(s => s.id));
      const tableIdSet = new Set(tierData.tables.map(t => t.id));
      for (const session of tierData.sessions) {
        const touchedTableIds = new Set<string>();
        for (const c of tierData.connections) {
          if (c.from === session.id && tableIdSet.has(c.to)) touchedTableIds.add(c.to);
          if (c.to === session.id && tableIdSet.has(c.from)) touchedTableIds.add(c.from);
        }
        const touchedSystems = new Set<string>();
        for (const tid of touchedTableIds) {
          const tbl = tierData.tables.find(t => t.id === tid);
          if (tbl) touchedSystems.add(inferSystem(tbl.name).system_id);
        }
        for (const sysId of touchedSystems) {
          if (systemMap.has(sysId)) systemMap.get(sysId)!.session_count++;
        }
      }
    }

    // Count tables per system
    for (const table of tierData.tables) {
      const sys = inferSystem(table.name);
      if (systemMap.has(sys.system_id)) {
        systemMap.get(sys.system_id)!.table_count++;
      }
    }

    return {
      nodes: Array.from(systemMap.values()).filter(n => n.session_count > 0 || n.table_count > 0),
      edges: Array.from(edgeMap.values()).filter(e => e.session_count > 0),
    };
  }, [tierData, connectionProfiles]);

  // Layout: circular placement
  const nodePositions = useMemo(() => {
    const positions: Record<string, { x: number; y: number }> = {};
    const cx = 300;
    const cy = 250;
    const radius = 180;

    nodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
      positions[node.system_id] = {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      };
    });
    return positions;
  }, [nodes]);

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Draw edges
    for (const edge of edges) {
      const from = nodePositions[edge.source];
      const to = nodePositions[edge.target];
      if (!from || !to) continue;

      const thickness = Math.min(Math.max(edge.session_count / 5, 1), 6);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = thickness;
      ctx.stroke();

      // Edge label
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      ctx.fillStyle = '#94A3B8';
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${edge.session_count}`, midX, midY - 6);
    }

    // Draw nodes
    for (const node of nodes) {
      const pos = nodePositions[node.system_id];
      if (!pos) continue;

      const r = Math.min(Math.max(node.session_count * 2 + 15, 20), 50);
      const isHovered = hoveredSystem === node.system_id;
      const isSelected = selectedSystem?.system_id === node.system_id;
      const envColor = ENV_COLORS[node.environment] ?? ENV_COLORS.unknown;

      // Glow for hover/selection
      if (isHovered || isSelected) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 8, 0, Math.PI * 2);
        ctx.fillStyle = envColor + '25';
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? envColor + '40' : '#1E293B';
      ctx.fill();
      ctx.strokeStyle = envColor;
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.stroke();

      // Label
      ctx.fillStyle = '#E2E8F0';
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.system_type.toUpperCase(), pos.x, pos.y + 4);

      // Session count below
      ctx.fillStyle = '#94A3B8';
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.fillText(`${node.session_count} sess`, pos.x, pos.y + r + 14);
    }
  }, [nodes, edges, nodePositions, hoveredSystem, selectedSystem]);

  // Hit test
  const handleMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    for (const node of nodes) {
      const pos = nodePositions[node.system_id];
      if (!pos) continue;
      const r = Math.min(Math.max(node.session_count * 2 + 15, 20), 50);
      if (Math.sqrt((mx - pos.x) ** 2 + (my - pos.y) ** 2) < r) {
        setHoveredSystem(node.system_id);
        canvas.style.cursor = 'pointer';
        return;
      }
    }
    setHoveredSystem(null);
    canvas.style.cursor = 'default';
  };

  const handleClick = () => {
    if (hoveredSystem) {
      const node = nodes.find(n => n.system_id === hoveredSystem);
      setSelectedSystem(node ?? null);
    }
  };

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-gray-500">
        No infrastructure systems detected from table/connection names
      </div>
    );
  }

  // Group by environment
  const envGroups = nodes.reduce<Record<string, SystemNode[]>>((acc, n) => {
    (acc[n.environment] ??= []).push(n);
    return acc;
  }, {});

  return (
    <div className="flex gap-4 h-full">
      {/* Left: Environment Groups */}
      <div className="w-56 bg-gray-800 rounded-lg border border-gray-700 overflow-y-auto">
        <div className="px-3 py-2 border-b border-gray-700">
          <div className="text-sm font-medium text-gray-300">Infrastructure</div>
          <div className="text-xs text-gray-500">{nodes.length} systems detected</div>
        </div>
        {Object.entries(envGroups).map(([env, systems]) => (
          <div key={env} className="border-b border-gray-700 last:border-b-0">
            <div className="px-3 py-1.5 text-[10px] font-medium text-gray-500 uppercase">
              <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: ENV_COLORS[env] ?? ENV_COLORS.unknown }} />
              {env}
            </div>
            {systems.map(sys => (
              <button
                key={sys.system_id}
                onClick={() => setSelectedSystem(sys)}
                className={`w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-gray-700/50 transition-colors ${
                  selectedSystem?.system_id === sys.system_id ? 'bg-blue-500/10' : ''
                }`}
              >
                <span className="text-sm">{SYSTEM_ICONS[sys.system_type] ?? SYSTEM_ICONS.unknown}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-300 truncate">{sys.system_type}</div>
                  <div className="text-[10px] text-gray-500">{sys.session_count} sessions, {sys.table_count} tables</div>
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Center: Canvas */}
      <div className="flex-1 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <canvas
          ref={canvasRef}
          className="w-full"
          style={{ height: 500 }}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onMouseLeave={() => setHoveredSystem(null)}
        />
      </div>

      {/* Right: Detail Panel */}
      <div className="w-64 bg-gray-800 rounded-lg border border-gray-700 p-4">
        {selectedSystem ? (
          <div className="space-y-4">
            <div>
              <div className="text-lg">{SYSTEM_ICONS[selectedSystem.system_type] ?? SYSTEM_ICONS.unknown}</div>
              <div className="text-sm font-medium text-gray-300 mt-1">{selectedSystem.system_type.toUpperCase()}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: ENV_COLORS[selectedSystem.environment] ?? ENV_COLORS.unknown }} />
                {selectedSystem.environment}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="text-center bg-gray-700/50 rounded p-2">
                <div className="text-lg font-bold text-gray-200">{selectedSystem.session_count}</div>
                <div className="text-[10px] text-gray-500">Sessions</div>
              </div>
              <div className="text-center bg-gray-700/50 rounded p-2">
                <div className="text-lg font-bold text-gray-200">{selectedSystem.table_count}</div>
                <div className="text-[10px] text-gray-500">Tables</div>
              </div>
            </div>

            {/* Connected systems */}
            <div>
              <div className="text-xs text-gray-500 mb-2">Connected Systems</div>
              <div className="space-y-1">
                {edges
                  .filter(e => e.source === selectedSystem.system_id || e.target === selectedSystem.system_id)
                  .map(e => {
                    const otherId = e.source === selectedSystem.system_id ? e.target : e.source;
                    const other = nodes.find(n => n.system_id === otherId);
                    return (
                      <div key={otherId} className="flex items-center gap-2 text-xs">
                        <span>{SYSTEM_ICONS[other?.system_type ?? 'unknown'] ?? '⬜'}</span>
                        <span className="text-gray-300 flex-1">{other?.system_type ?? otherId}</span>
                        <span className="text-gray-500">{e.session_count} sess</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 text-sm text-gray-500">
            Select a system node
          </div>
        )}
      </div>
    </div>
  );
}

function mapDbTypeToSystem(dbtype: string): string {
  const lower = (dbtype || '').toLowerCase();
  if (lower.includes('oracle')) return 'oracle';
  if (lower.includes('teradata')) return 'teradata';
  if (lower.includes('sql server') || lower.includes('mssql') || lower.includes('sqlserver')) return 'sqlserver';
  if (lower.includes('db2')) return 'db2';
  if (lower.includes('mysql')) return 'mysql';
  if (lower.includes('postgres')) return 'postgres';
  if (lower.includes('sybase')) return 'sybase';
  if (lower.includes('informix')) return 'informix';
  if (lower.includes('odbc')) return 'odbc';
  return lower || 'unknown';
}

function mapDbTypeToEnv(dbtype: string): string {
  const lower = (dbtype || '').toLowerCase();
  if (lower.includes('s3') || lower.includes('redshift') || lower.includes('aws')) return 'aws';
  if (lower.includes('azure') || lower.includes('synapse')) return 'azure';
  if (lower.includes('bigquery') || lower.includes('gcs')) return 'gcp';
  return 'on-prem';
}

function inferSystem(name: string): { system_id: string; system_type: string; environment: string } {
  const lower = name.toLowerCase();

  const patterns: [RegExp, string, string][] = [
    [/oracle|ora_|orcl/i, 'oracle', 'on-prem'],
    [/teradata|td_|tera/i, 'teradata', 'on-prem'],
    [/postgres|pg_|pgsql/i, 'postgres', 'on-prem'],
    [/mysql|maria/i, 'mysql', 'on-prem'],
    [/sqlserver|mssql|tsql/i, 'sqlserver', 'on-prem'],
    [/s3:|s3_|aws_|amazon/i, 's3', 'aws'],
    [/redshift/i, 'redshift', 'aws'],
    [/dynamodb/i, 'dynamodb', 'aws'],
    [/azure|adls|blob/i, 'azure_storage', 'azure'],
    [/synapse/i, 'synapse', 'azure'],
    [/bigquery|bq_/i, 'bigquery', 'gcp'],
    [/gcs:/i, 'gcs', 'gcp'],
    [/kafka|confluent/i, 'kafka', 'on-prem'],
    [/hdfs|hadoop|hive/i, 'hdfs', 'on-prem'],
    [/ftp|sftp/i, 'ftp', 'on-prem'],
    [/http|rest|api/i, 'http', 'unknown'],
  ];

  for (const [regex, sysType, env] of patterns) {
    if (regex.test(lower)) {
      return { system_id: sysType, system_type: sysType, environment: env };
    }
  }

  return { system_id: 'unknown', system_type: 'unknown', environment: 'unknown' };
}
