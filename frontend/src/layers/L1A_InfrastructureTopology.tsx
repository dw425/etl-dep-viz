/**
 * L1A_InfrastructureTopology — system-level infrastructure graph.
 * Shows Oracle, Teradata, S3, Kafka instances as supernodes with session-count edges.
 * Orchestrates data building, layout, and delegates rendering to sub-components.
 */

import React, { useMemo, useState } from 'react';
import type { VectorResults } from '../types/vectors';
import type { TierMapResult } from '../types/tiermap';
import type { SystemNode, SystemEdge, ConnectionSubNode } from './infra/infraUtils';
import {
  ENV_COLORS,
  SYSTEM_ICONS,
  mapDbTypeToSystem,
  mapDbTypeToEnv,
  inferSystem,
  parseConnectionString,
} from './infra/infraUtils';
import InfraCanvas from './infra/InfraCanvas';
import type { ZoneRect } from './infra/InfraCanvas';
import InfraDetailPanel from './infra/InfraDetailPanel';

interface Props {
  tierData: TierMapResult;
  vectorResults: VectorResults | null;
  onNavigateView?: (view: string) => void;
}

const SUB_NODE_CAP = 8;

/**
 * Infrastructure topology view showing system-level nodes (Oracle, Teradata, S3, Kafka, etc.)
 * connected by session-count edges. Uses two detection modes:
 * 1. Connection-profile mode: aggregates by dbtype from parsed connection profiles.
 * 2. Fallback mode: infers system type from table name patterns via regex.
 *
 * Three-panel layout: sidebar with expandable connection sub-nodes (left),
 * zone-based canvas with curved edges (center), and tabbed detail panel (right).
 */
export default function L1A_InfrastructureTopology({ tierData, vectorResults, onNavigateView }: Props) {
  const [selectedSystem, setSelectedSystem] = useState<SystemNode | null>(null);
  const [hoveredSystem, setHoveredSystem] = useState<string | null>(null);
  const [expandedSidebar, setExpandedSidebar] = useState<string | null>(null);

  const connectionProfiles = (tierData as any).connection_profiles as
    | { name: string; dbtype: string; dbsubtype?: string; connection_string?: string }[]
    | undefined;

  // ── Build infrastructure graph ─────────────────────────────────────────────
  const { nodes, edges } = useMemo(() => {
    const systemMap = new Map<string, SystemNode>();
    // Track directed edges: key = "source->target"
    const directedCounts = new Map<string, { session_ids: Set<string> }>();

    const ensureSystem = (sysId: string, sysType: string, env: string): SystemNode => {
      if (!systemMap.has(sysId)) {
        systemMap.set(sysId, {
          system_id: sysId,
          system_type: sysType,
          environment: env,
          session_count: 0,
          table_count: 0,
          connections: [],
          sub_nodes: [],
          session_ids: [],
        });
      }
      return systemMap.get(sysId)!;
    };

    const addDirectedEdge = (fromSys: string, toSys: string, sessionId: string) => {
      if (fromSys === toSys) return;
      const key = `${fromSys}->${toSys}`;
      if (!directedCounts.has(key)) {
        directedCounts.set(key, { session_ids: new Set() });
      }
      directedCounts.get(key)!.session_ids.add(sessionId);
    };

    // Build connection name → system type lookup
    const connNameToSystem = new Map<string, string>();
    if (connectionProfiles && connectionProfiles.length > 0) {
      for (const cp of connectionProfiles) {
        const sysType = mapDbTypeToSystem(cp.dbtype);
        connNameToSystem.set(cp.name.toUpperCase(), sysType);
      }
    }

    const useConnectionMode = connectionProfiles && connectionProfiles.length > 0;

    if (useConnectionMode) {
      // ── Connection-profile mode: aggregate by system type ──────────────────
      // Build sub-nodes per system from connection profiles
      const systemSubNodes = new Map<string, ConnectionSubNode[]>();

      for (const cp of connectionProfiles!) {
        const sysType = mapDbTypeToSystem(cp.dbtype);
        const env = mapDbTypeToEnv(cp.dbtype);
        ensureSystem(sysType, sysType, env);
        if (!systemSubNodes.has(sysType)) systemSubNodes.set(sysType, []);

        // Check if sub-node already exists
        const existing = systemSubNodes.get(sysType)!.find(sn => sn.connection_name === cp.name);
        if (!existing) {
          systemSubNodes.get(sysType)!.push({
            connection_name: cp.name,
            dbtype: cp.dbtype,
            dbsubtype: cp.dbsubtype,
            connection_string: cp.connection_string,
            parsed_connection: parseConnectionString(cp.connection_string),
            session_count: 0,
            session_ids: [],
          });
        }

        // Add connection name to system
        const sys = systemMap.get(sysType)!;
        if (!sys.connections.includes(cp.name)) {
          sys.connections.push(cp.name);
        }
      }

      // Count sessions per system and sub-node, derive edges
      for (const session of tierData.sessions) {
        const sessConns = (session as any).connections_used as
          | { connection_name: string; dbtype: string }[]
          | undefined;

        // Systems this session touches (via connections)
        const touchedSystems = new Set<string>();

        if (sessConns) {
          for (const sc of sessConns) {
            const sysType = mapDbTypeToSystem(sc.dbtype);
            touchedSystems.add(sysType);

            // Update sub-node
            const subNodes = systemSubNodes.get(sysType);
            if (subNodes) {
              const sn = subNodes.find(s => s.connection_name === sc.connection_name);
              if (sn) {
                sn.session_count++;
                sn.session_ids.push(session.id);
              }
            }
          }
        }

        // Count session on each touched system
        for (const sysId of touchedSystems) {
          if (systemMap.has(sysId)) {
            const sys = systemMap.get(sysId)!;
            sys.session_count++;
            sys.session_ids.push(session.id);
          }
        }

        // Derive edges: source systems → target systems from session.sources/targets
        const sourceSystems = new Set<string>();
        const targetSystems = new Set<string>();

        for (const src of (session as any).sources ?? []) {
          const inf = inferSystem(src);
          if (touchedSystems.has(inf.system_id)) {
            sourceSystems.add(inf.system_id);
          }
        }
        for (const tgt of (session as any).targets ?? []) {
          const inf = inferSystem(tgt);
          if (touchedSystems.has(inf.system_id)) {
            targetSystems.add(inf.system_id);
          }
        }

        // If we couldn't map tables to connection systems, use the connections directly
        if (sourceSystems.size === 0 && targetSystems.size === 0 && touchedSystems.size > 1) {
          const arr = Array.from(touchedSystems);
          for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
              addDirectedEdge(arr[i], arr[j], session.id);
            }
          }
        } else {
          for (const src of sourceSystems) {
            for (const tgt of targetSystems) {
              addDirectedEdge(src, tgt, session.id);
            }
          }
        }
      }

      // Attach sub-nodes to system nodes
      for (const [sysId, subNodes] of systemSubNodes) {
        if (systemMap.has(sysId)) {
          systemMap.get(sysId)!.sub_nodes = subNodes.filter(sn => sn.session_count > 0);
        }
      }
    }

    // ── Fallback: infer systems from table names ─────────────────────────────
    if (systemMap.size === 0) {
      const tables = tierData?.tables || [];
      const tableIdSet = new Set(tables.map(t => t.id));

      for (const table of tables) {
        const sys = inferSystem(table.name);
        ensureSystem(sys.system_id, sys.system_type, sys.environment);
        systemMap.get(sys.system_id)!.table_count++;
      }

      for (const session of tierData.sessions) {
        // Find tables this session touches via connections
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
          if (systemMap.has(sysId)) {
            const sys = systemMap.get(sysId)!;
            sys.session_count++;
            sys.session_ids.push(session.id);
          }
        }

        // Derive edges from source/target tables
        const sourceSystems = new Set<string>();
        const targetSystems = new Set<string>();
        for (const src of (session as any).sources ?? []) {
          sourceSystems.add(inferSystem(src).system_id);
        }
        for (const tgt of (session as any).targets ?? []) {
          targetSystems.add(inferSystem(tgt).system_id);
        }
        for (const srcSys of sourceSystems) {
          for (const tgtSys of targetSystems) {
            addDirectedEdge(srcSys, tgtSys, session.id);
          }
        }
      }
    }

    // Count tables per system (connection-profile mode too)
    if (useConnectionMode) {
      for (const table of tierData.tables) {
        const sys = inferSystem(table.name);
        if (systemMap.has(sys.system_id)) {
          systemMap.get(sys.system_id)!.table_count++;
        }
      }
    }

    // ── Merge directed edges into SystemEdge[] ───────────────────────────────
    const edgeMap = new Map<string, SystemEdge>();

    for (const [key, data] of directedCounts) {
      const [source, target] = key.split('->');
      const reverseKey = `${target}->${source}`;
      const canonKey = source < target ? `${source}|${target}` : `${target}|${source}`;

      if (edgeMap.has(canonKey)) continue; // already merged

      const reverseData = directedCounts.get(reverseKey);
      const allSessions = new Set(data.session_ids);
      let direction: 'directed' | 'bidirectional' = 'directed';

      if (reverseData) {
        for (const sid of reverseData.session_ids) allSessions.add(sid);
        direction = 'bidirectional';
      }

      edgeMap.set(canonKey, {
        source,
        target,
        session_count: allSessions.size,
        session_ids: Array.from(allSessions),
        direction,
      });
    }

    return {
      nodes: Array.from(systemMap.values()).filter(n => n.session_count > 0 || n.table_count > 0),
      edges: Array.from(edgeMap.values()).filter(e => e.session_count > 0),
    };
  }, [tierData, connectionProfiles]);

  // ── Layout: tiered zone grid (infrastructure architecture style) ────────────
  // Environment priority order: cloud on top, on-prem middle, unknown bottom
  const ENV_ORDER: Record<string, number> = { aws: 0, azure: 1, gcp: 2, 'on-prem': 3, unknown: 4 };
  const ENV_LABELS: Record<string, string> = {
    aws: 'AWS Cloud', azure: 'Azure Cloud', gcp: 'Google Cloud',
    'on-prem': 'On-Premises', unknown: 'Unclassified',
  };

  const { nodePositions, zones } = useMemo(() => {
    const positions: Record<string, { x: number; y: number }> = {};
    const zoneRects: ZoneRect[] = [];

    // Group nodes by environment, sorted by priority
    const envGroups = new Map<string, SystemNode[]>();
    for (const node of nodes) {
      const env = node.environment;
      if (!envGroups.has(env)) envGroups.set(env, []);
      envGroups.get(env)!.push(node);
    }
    // Sort each group by session_count descending
    for (const group of envGroups.values()) {
      group.sort((a, b) => b.session_count - a.session_count);
    }

    const sortedEnvs = Array.from(envGroups.keys()).sort(
      (a, b) => (ENV_ORDER[a] ?? 5) - (ENV_ORDER[b] ?? 5)
    );

    const ZONE_PAD = 20;
    const NODE_SPACE_X = 130;
    const NODE_SPACE_Y = 80;
    const ZONE_GAP = 16;
    const CANVAS_PAD = 24;
    let currentY = CANVAS_PAD;

    for (const env of sortedEnvs) {
      const group = envGroups.get(env)!;
      const cols = Math.min(group.length, 4);
      const rows = Math.ceil(group.length / cols);

      const zoneW = cols * NODE_SPACE_X + ZONE_PAD * 2;
      const zoneH = rows * NODE_SPACE_Y + ZONE_PAD * 2 + 14; // +14 for label

      zoneRects.push({
        env,
        label: ENV_LABELS[env] ?? env,
        x: CANVAS_PAD,
        y: currentY,
        w: Math.max(zoneW, 280),
        h: zoneH,
      });

      const contentStartY = currentY + ZONE_PAD + 14;
      const zoneActualW = Math.max(zoneW, 280);

      group.forEach((node, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        // Center the grid within the zone
        const gridW = cols * NODE_SPACE_X;
        const offsetX = (zoneActualW - gridW) / 2;
        positions[node.system_id] = {
          x: CANVAS_PAD + offsetX + col * NODE_SPACE_X + NODE_SPACE_X / 2,
          y: contentStartY + row * NODE_SPACE_Y + NODE_SPACE_Y / 2,
        };
      });

      currentY += zoneH + ZONE_GAP;
    }

    return { nodePositions: positions, zones: zoneRects };
  }, [nodes]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleHover = (systemId: string | null) => setHoveredSystem(systemId);

  const handleClick = (systemId: string | null) => {
    if (systemId) {
      const node = nodes.find(n => n.system_id === systemId);
      setSelectedSystem(node ?? null);
      setExpandedSidebar(systemId);
    }
  };

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-gray-500">
        No infrastructure systems detected from table/connection names
      </div>
    );
  }

  // Group by environment for sidebar
  const envGroups = nodes.reduce<Record<string, SystemNode[]>>((acc, n) => {
    (acc[n.environment] ??= []).push(n);
    return acc;
  }, {});

  return (
    <div className="flex gap-4 h-full">
      {/* Left: Environment Groups + Connection Sub-Nodes */}
      <div className="w-56 bg-gray-800 rounded-lg border border-gray-700 overflow-y-auto">
        <div className="px-3 py-2 border-b border-gray-700">
          <div className="text-sm font-medium text-gray-300">Infrastructure</div>
          <div className="text-xs text-gray-500">
            {nodes.length} systems, {edges.length} flows
          </div>
        </div>
        {Object.entries(envGroups).map(([env, systems]) => (
          <div key={env} className="border-b border-gray-700 last:border-b-0">
            <div className="px-3 py-1.5 text-[10px] font-medium text-gray-500 uppercase">
              <span
                className="inline-block w-2 h-2 rounded-full mr-1.5"
                style={{ backgroundColor: ENV_COLORS[env] ?? ENV_COLORS.unknown }}
              />
              {env}
            </div>
            {systems.map(sys => (
              <div key={sys.system_id}>
                <button
                  onClick={() => {
                    setSelectedSystem(sys);
                    setExpandedSidebar(expandedSidebar === sys.system_id ? null : sys.system_id);
                  }}
                  className={`w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-gray-700/50 transition-colors ${
                    selectedSystem?.system_id === sys.system_id ? 'bg-blue-500/10' : ''
                  }`}
                >
                  <span className="text-sm">{SYSTEM_ICONS[sys.system_type] ?? SYSTEM_ICONS.unknown}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-300 truncate">{sys.system_type}</div>
                    <div className="text-[10px] text-gray-500">
                      {sys.session_count} sessions, {sys.table_count} tables
                    </div>
                  </div>
                  {sys.sub_nodes.length > 0 && (
                    <span className="text-[10px] text-gray-600">
                      {expandedSidebar === sys.system_id ? '\u25BC' : '\u25B6'}
                    </span>
                  )}
                </button>

                {/* Expanded connection sub-nodes */}
                {expandedSidebar === sys.system_id && sys.sub_nodes.length > 0 && (
                  <div className="bg-gray-900/50 border-t border-gray-700/50">
                    {sys.sub_nodes.slice(0, SUB_NODE_CAP).map(sn => (
                      <div
                        key={sn.connection_name}
                        className="px-5 py-1 flex items-center gap-2 text-[10px]"
                      >
                        <span className="text-gray-600">\u2514</span>
                        <span className="text-gray-400 truncate flex-1">{sn.connection_name}</span>
                        <span className="text-gray-600">{sn.session_count}</span>
                      </div>
                    ))}
                    {sys.sub_nodes.length > SUB_NODE_CAP && (
                      <div className="px-5 py-1 text-[10px] text-gray-600">
                        +{sys.sub_nodes.length - SUB_NODE_CAP} more
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Center: Canvas */}
      <div className="flex-1 bg-gray-800 rounded-lg border border-gray-700 overflow-auto">
        <InfraCanvas
          nodes={nodes}
          edges={edges}
          nodePositions={nodePositions}
          zones={zones}
          hoveredSystem={hoveredSystem}
          selectedSystem={selectedSystem}
          onHover={handleHover}
          onClick={handleClick}
        />
      </div>

      {/* Right: Detail Panel */}
      <div className="w-64 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        {selectedSystem ? (
          <InfraDetailPanel
            system={selectedSystem}
            edges={edges}
            nodes={nodes}
            tierData={tierData}
            onNavigateView={onNavigateView}
          />
        ) : (
          <div className="flex items-center justify-center h-32 text-sm text-gray-500">
            Select a system node
          </div>
        )}
      </div>
    </div>
  );
}
