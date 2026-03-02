/**
 * WaveSimulator — "What-If" cascade simulation mode.
 * Select session → animate cascade ripple with criticality heatmap.
 *
 * Phase 2 enhancements: onboarding banner, search/sort picker, comparison mode,
 * mini cascade tree (SVG), cumulative impact summary bar.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { whatIfSimulation } from '../../api/client';
import type { TierMapResult } from '../../types/tiermap';
import type { WhatIfResult, WaveFunctionResult, SessionCriticality } from '../../types/vectors';

interface Props {
  tierData: TierMapResult;
  waveFunction?: WaveFunctionResult | null;
  onSessionSelect?: (sessionId: string) => void;
}

type SortMode = 'criticality' | 'blast' | 'name';

const GUIDE_DISMISSED_KEY = 'edv-wave-sim-guide-dismissed';

/** Criticality-tier color helper */
function tierColor(tier: number): string {
  if (tier >= 4) return '#EF4444';
  if (tier >= 3) return '#F97316';
  if (tier >= 2) return '#F59E0B';
  return '#10B981';
}

/** Hop color helper for cascade tree */
function hopColor(hop: number): string {
  if (hop <= 0) return '#EF4444';
  if (hop === 1) return '#F97316';
  if (hop === 2) return '#F59E0B';
  if (hop <= 4) return '#FBBF24';
  return '#9CA3AF';
}

// ── Mini Cascade Tree (SVG) ────────────────────────────────────────────────

interface TreeNode {
  id: string;
  hop: number;
  children: TreeNode[];
  isCollapse?: boolean;
  collapseCount?: number;
}

function buildTreeFromHops(
  hopBreakdown: Record<string, string[]>,
  sourceSession: string,
  maxVisible: number = 50,
): TreeNode {
  const root: TreeNode = { id: sourceSession, hop: 0, children: [] };
  const hops = Object.entries(hopBreakdown)
    .map(([k, v]) => [Number(k), v] as [number, string[]])
    .sort((a, b) => a[0] - b[0]);

  let totalVisible = 1; // root

  // Assign children per hop layer; parent is previous layer
  let currentLayerNodes: TreeNode[] = [root];

  for (const [hopNum, sessions] of hops) {
    const nextLayerNodes: TreeNode[] = [];
    const remaining = maxVisible - totalVisible;

    if (remaining <= 0) {
      // Collapse entirely
      if (sessions.length > 0 && currentLayerNodes.length > 0) {
        const collapseNode: TreeNode = {
          id: `+${sessions.length} more`,
          hop: hopNum,
          children: [],
          isCollapse: true,
          collapseCount: sessions.length,
        };
        currentLayerNodes[0].children.push(collapseNode);
      }
      continue;
    }

    const visibleCount = Math.min(sessions.length, remaining);
    const parentCount = currentLayerNodes.length || 1;

    // Distribute sessions across parents
    for (let i = 0; i < visibleCount; i++) {
      const node: TreeNode = { id: sessions[i], hop: hopNum, children: [] };
      const parentIdx = i % parentCount;
      currentLayerNodes[parentIdx].children.push(node);
      nextLayerNodes.push(node);
      totalVisible++;
    }

    // Add collapse node if truncated
    if (sessions.length > visibleCount) {
      const collapseNode: TreeNode = {
        id: `+${sessions.length - visibleCount} more`,
        hop: hopNum,
        children: [],
        isCollapse: true,
        collapseCount: sessions.length - visibleCount,
      };
      currentLayerNodes[0].children.push(collapseNode);
      nextLayerNodes.push(collapseNode);
      totalVisible++;
    }

    currentLayerNodes = nextLayerNodes;
  }

  return root;
}

interface LayoutNode {
  id: string;
  hop: number;
  x: number;
  y: number;
  isCollapse?: boolean;
  collapseCount?: number;
  children: LayoutNode[];
}

function layoutTree(root: TreeNode, width: number, height: number): LayoutNode {
  // Count max depth
  function maxDepth(node: TreeNode): number {
    if (node.children.length === 0) return 0;
    return 1 + Math.max(...node.children.map(maxDepth));
  }
  const depth = maxDepth(root);
  const yStep = depth > 0 ? (height - 60) / depth : 0;

  // Count leaves for width allocation
  function countLeaves(node: TreeNode): number {
    if (node.children.length === 0) return 1;
    return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
  }

  function doLayout(node: TreeNode, xMin: number, xMax: number, yPos: number): LayoutNode {
    const lNode: LayoutNode = {
      id: node.id,
      hop: node.hop,
      x: (xMin + xMax) / 2,
      y: yPos,
      isCollapse: node.isCollapse,
      collapseCount: node.collapseCount,
      children: [],
    };

    if (node.children.length > 0) {
      const totalLeaves = node.children.reduce((sum, c) => sum + countLeaves(c), 0);
      let runningX = xMin;
      for (const child of node.children) {
        const childLeaves = countLeaves(child);
        const childWidth = ((xMax - xMin) * childLeaves) / totalLeaves;
        const childLayout = doLayout(child, runningX, runningX + childWidth, yPos + yStep);
        lNode.children.push(childLayout);
        runningX += childWidth;
      }
    }

    return lNode;
  }

  return doLayout(root, 20, width - 20, 24);
}

function MiniCascadeTree({
  whatIf,
  width = 600,
  height = 300,
}: {
  whatIf: WhatIfResult;
  width?: number;
  height?: number;
}) {
  const treeRoot = useMemo(
    () => buildTreeFromHops(whatIf.hop_breakdown, whatIf.source_session, 50),
    [whatIf],
  );
  const layout = useMemo(() => layoutTree(treeRoot, width, height), [treeRoot, width, height]);

  function renderEdges(node: LayoutNode): React.ReactNode[] {
    const edges: React.ReactNode[] = [];
    for (const child of node.children) {
      edges.push(
        <line
          key={`${node.id}-${child.id}`}
          x1={node.x}
          y1={node.y}
          x2={child.x}
          y2={child.y}
          stroke="#4B5563"
          strokeWidth={1}
        />,
      );
      edges.push(...renderEdges(child));
    }
    return edges;
  }

  function renderNodes(node: LayoutNode): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    const color = hopColor(node.hop);
    const radius = node.isCollapse ? 10 : node.hop === 0 ? 8 : 5;

    nodes.push(
      <g key={node.id}>
        <circle
          cx={node.x}
          cy={node.y}
          r={radius}
          fill={node.isCollapse ? '#374151' : color}
          stroke={node.isCollapse ? '#6B7280' : color}
          strokeWidth={node.hop === 0 ? 2 : 1}
          opacity={node.isCollapse ? 0.7 : 0.9}
        />
        {node.isCollapse ? (
          <text
            x={node.x}
            y={node.y + 3.5}
            textAnchor="middle"
            fill="#9CA3AF"
            fontSize={7}
            fontWeight="bold"
          >
            {node.collapseCount}
          </text>
        ) : (
          <title>{node.id}</title>
        )}
        {node.hop === 0 && (
          <text
            x={node.x}
            y={node.y - 12}
            textAnchor="middle"
            fill="#F87171"
            fontSize={9}
            fontWeight="bold"
          >
            {node.id.length > 20 ? node.id.substring(0, 18) + '...' : node.id}
          </text>
        )}
      </g>,
    );

    for (const child of node.children) {
      nodes.push(...renderNodes(child));
    }
    return nodes;
  }

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} className="block">
      {renderEdges(layout)}
      {renderNodes(layout)}
    </svg>
  );
}

// ── Simulation Results Panel ───────────────────────────────────────────────

function SimulationResults({
  whatIf,
  tierData,
  onSessionSelect,
  label,
}: {
  whatIf: WhatIfResult;
  tierData: TierMapResult;
  onSessionSelect?: (sessionId: string) => void;
  label?: string;
}) {
  // Compute cascading tables: unique `to` targets in connections where `from`
  // is an affected session ID (including the source)
  const cascadingTableCount = useMemo(() => {
    const affectedSet = new Set(whatIf.affected_sessions);
    affectedSet.add(whatIf.source_session);
    // Map session names to IDs for lookup
    const sessionNameToId = new Map<string, string>();
    const sessionIdSet = new Set<string>();
    for (const s of tierData.sessions) {
      sessionNameToId.set(s.name, s.id);
      sessionNameToId.set(s.id, s.id);
      sessionIdSet.add(s.id);
    }
    // Build set of affected session IDs (both name and id form)
    const affectedIds = new Set<string>();
    for (const a of affectedSet) {
      affectedIds.add(a);
      const mapped = sessionNameToId.get(a);
      if (mapped) affectedIds.add(mapped);
    }
    const uniqueTargets = new Set<string>();
    for (const conn of tierData.connections) {
      if (affectedIds.has(conn.from)) {
        // Only count table targets (not session targets)
        if (!sessionIdSet.has(conn.to)) {
          uniqueTargets.add(conn.to);
        }
      }
    }
    return uniqueTargets.size;
  }, [whatIf, tierData]);

  const impactPercent = tierData.stats.session_count > 0
    ? Math.round((whatIf.affected_sessions.length / tierData.stats.session_count) * 100)
    : 0;

  return (
    <div className="space-y-3">
      {label && (
        <div className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</div>
      )}

      {/* Summary Stats */}
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-sm font-medium text-red-400">{whatIf.source_session}</span>
          <span className="text-xs text-gray-500">failure cascade</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <div className="text-xl font-bold text-gray-200">{whatIf.blast_radius}</div>
            <div className="text-[10px] text-gray-500">Blast Radius</div>
          </div>
          <div className="text-center">
            <div className="text-xl font-bold text-gray-200">{whatIf.max_depth}</div>
            <div className="text-[10px] text-gray-500">Max Depth</div>
          </div>
          <div className="text-center">
            <div className="text-xl font-bold text-gray-200">
              {Object.keys(whatIf.hop_breakdown).length}
            </div>
            <div className="text-[10px] text-gray-500">Hop Layers</div>
          </div>
        </div>
      </div>

      {/* Cumulative Impact Summary Bar */}
      <div className="bg-gray-800/60 rounded-lg border border-gray-600 px-4 py-2 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-gray-300 font-medium">Total Impact:</span>
        <span className="text-gray-200 font-bold">{whatIf.affected_sessions.length} sessions</span>
        <span className="text-gray-500">({impactPercent}% of all)</span>
        <span className="text-gray-600">|</span>
        <span className="text-gray-300">Max Depth:</span>
        <span className="text-gray-200 font-bold">{whatIf.max_depth} hops</span>
        <span className="text-gray-600">|</span>
        <span className="text-gray-300">Cascading Tables:</span>
        <span className="text-gray-200 font-bold">{cascadingTableCount}</span>
      </div>

      {/* Mini Cascade Tree */}
      {Object.keys(whatIf.hop_breakdown).length > 0 && (
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-3">
          <div className="text-xs text-gray-500 mb-2">Cascade Tree</div>
          <MiniCascadeTree whatIf={whatIf} height={300} />
        </div>
      )}

      {/* Hop Breakdown */}
      {Object.entries(whatIf.hop_breakdown).map(([hop, sessions]) => (
        <div key={hop} className="bg-gray-800 rounded-lg border border-gray-700 p-3">
          <div className="flex items-center gap-2 mb-2">
            <span
              className="text-xs px-2 py-0.5 rounded font-medium"
              style={{
                backgroundColor: Number(hop) <= 1 ? '#EF444420' : Number(hop) <= 3 ? '#F9731620' : '#F59E0B20',
                color: Number(hop) <= 1 ? '#EF4444' : Number(hop) <= 3 ? '#F97316' : '#F59E0B',
              }}
            >
              Hop {hop}
            </span>
            <span className="text-xs text-gray-500">{sessions.length} sessions</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {sessions.map(sid => (
              <button
                key={sid}
                onClick={() => onSessionSelect?.(sid)}
                className="px-1.5 py-0.5 bg-gray-700 rounded text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
              >
                {sid}
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* Amplitude Decay Chart */}
      {whatIf.amplitude_decay.length > 0 && (
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-3">
          <div className="text-xs text-gray-500 mb-2">Amplitude Decay</div>
          <div className="flex items-end gap-1 h-16">
            {whatIf.amplitude_decay.slice(0, 20).map((d, i) => (
              <div
                key={i}
                className="flex-1 bg-blue-500/50 rounded-t"
                style={{ height: `${d.amplitude * 100}%` }}
                title={`Hop ${d.hop}: ${d.amplitude.toFixed(3)}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function WaveSimulator({ tierData, waveFunction, onSessionSelect }: Props) {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [whatIf, setWhatIf] = useState<WhatIfResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Comparison state
  const [compareSession, setCompareSession] = useState<string | null>(null);
  const [compareWhatIf, setCompareWhatIf] = useState<WhatIfResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  // Search + sort
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('criticality');

  // Onboarding banner
  const [guideDismissed, setGuideDismissed] = useState(() => {
    try {
      return localStorage.getItem(GUIDE_DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const dismissGuide = useCallback(() => {
    setGuideDismissed(true);
    try {
      localStorage.setItem(GUIDE_DISMISSED_KEY, 'true');
    } catch {
      // storage unavailable
    }
  }, []);

  const handleSimulate = useCallback(async (sessionId: string) => {
    setSelectedSession(sessionId);
    setLoading(true);
    try {
      const result = await whatIfSimulation(tierData, sessionId);
      setWhatIf(result);
    } catch (err) {
      console.error('What-if simulation failed:', err);
    } finally {
      setLoading(false);
    }
  }, [tierData]);

  const handleCompare = useCallback(async (sessionId: string) => {
    setCompareSession(sessionId);
    setCompareLoading(true);
    try {
      const result = await whatIfSimulation(tierData, sessionId);
      setCompareWhatIf(result);
    } catch (err) {
      console.error('Compare simulation failed:', err);
    } finally {
      setCompareLoading(false);
    }
  }, [tierData]);

  const clearCompare = useCallback(() => {
    setCompareSession(null);
    setCompareWhatIf(null);
  }, []);

  // Sort + filter sessions
  const sortedSessions = useMemo(() => {
    let sessions = [...(waveFunction?.sessions ?? [])];

    // Filter by search
    if (search.trim()) {
      const lc = search.trim().toLowerCase();
      sessions = sessions.filter(s => s.session_id.toLowerCase().includes(lc));
    }

    // Sort
    switch (sortMode) {
      case 'criticality':
        sessions.sort((a, b) => b.criticality_score - a.criticality_score);
        break;
      case 'blast':
        sessions.sort((a, b) => b.blast_radius - a.blast_radius);
        break;
      case 'name':
        sessions.sort((a, b) => a.session_id.localeCompare(b.session_id));
        break;
    }

    return sessions;
  }, [waveFunction, search, sortMode]);

  // Delta badges for comparison
  const deltaAffected = useMemo(() => {
    if (!whatIf || !compareWhatIf) return null;
    return compareWhatIf.affected_sessions.length - whatIf.affected_sessions.length;
  }, [whatIf, compareWhatIf]);

  const isComparing = compareSession !== null;

  return (
    <div className="space-y-4">
      {/* Onboarding Banner */}
      {!guideDismissed && (
        <div className="bg-blue-900/30 rounded-lg border border-blue-700/50 p-4 relative">
          <button
            onClick={dismissGuide}
            className="absolute top-2 right-2 text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none px-1"
            title="Dismiss"
          >
            x
          </button>
          <h3 className="text-sm font-semibold text-blue-300 mb-2">
            What-If Failure Cascade Simulator
          </h3>
          <p className="text-xs text-gray-400 mb-3 leading-relaxed">
            Select any session to simulate what happens if it fails. See the blast radius,
            cascade depth, and exactly which downstream sessions are affected at each hop.
          </p>
          <div className="flex flex-wrap gap-4 text-[11px] text-gray-500">
            <span className="flex items-center gap-1">
              <span className="text-red-400 font-bold">1.</span> Single points of failure
            </span>
            <span className="flex items-center gap-1">
              <span className="text-orange-400 font-bold">2.</span> Change impact analysis
            </span>
            <span className="flex items-center gap-1">
              <span className="text-amber-400 font-bold">3.</span> Test prioritization
            </span>
          </div>
        </div>
      )}

      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-1">Wave Cascade Simulator</h3>
            <p className="text-xs text-gray-500">
              Select a session to simulate its failure cascade through the dependency graph
            </p>
          </div>
          {isComparing && (
            <button
              onClick={clearCompare}
              className="text-xs px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 text-gray-400 transition-colors"
            >
              Exit Compare
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-4">
        {/* Session Picker */}
        <div className="w-80 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden flex-shrink-0">
          {/* Search input */}
          <div className="px-3 py-2 border-b border-gray-700">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sessions..."
              className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          {/* Sort buttons */}
          <div className="px-3 py-1.5 border-b border-gray-700 flex items-center gap-1">
            <span className="text-[10px] text-gray-600 mr-1">Sort:</span>
            {(['criticality', 'blast', 'name'] as SortMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => setSortMode(mode)}
                className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                  sortMode === mode
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                {mode === 'criticality' ? 'Criticality' : mode === 'blast' ? 'Blast Radius' : 'Name'}
              </button>
            ))}
          </div>

          {/* Count header */}
          <div className="px-3 py-1.5 border-b border-gray-700 text-xs text-gray-500">
            Sessions ({sortedSessions.length})
          </div>

          {/* Session list */}
          <div className="max-h-96 overflow-y-auto">
            {sortedSessions.map(s => (
              <div
                key={s.session_id}
                className={`flex items-center gap-1 hover:bg-gray-700/50 transition-colors ${
                  selectedSession === s.session_id ? 'bg-blue-500/10' : ''
                } ${compareSession === s.session_id ? 'bg-purple-500/10' : ''}`}
              >
                <button
                  onClick={() => handleSimulate(s.session_id)}
                  className="flex-1 px-3 py-2 text-left flex items-center gap-2 min-w-0"
                >
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: tierColor(s.criticality_tier) }}
                  />
                  <span className="text-xs text-gray-300 truncate flex-1">{s.session_id}</span>
                  <span className="text-xs text-gray-500 flex-shrink-0">
                    {Math.round(s.criticality_score)}
                  </span>
                  <span className="text-[10px] text-gray-600 flex-shrink-0">
                    r{s.blast_radius}
                  </span>
                </button>
                {/* Compare button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (compareSession === s.session_id) {
                      clearCompare();
                    } else {
                      handleCompare(s.session_id);
                    }
                  }}
                  className={`text-[9px] px-1.5 py-0.5 mr-2 rounded transition-colors flex-shrink-0 ${
                    compareSession === s.session_id
                      ? 'bg-purple-500/30 text-purple-300'
                      : 'bg-gray-700 text-gray-500 hover:text-gray-300 hover:bg-gray-600'
                  }`}
                  title={compareSession === s.session_id ? 'Remove comparison' : 'Compare with primary'}
                >
                  {compareSession === s.session_id ? 'Cmp' : 'Cmp'}
                </button>
              </div>
            ))}
            {sortedSessions.length === 0 && (
              <div className="px-3 py-4 text-xs text-gray-600 text-center">
                {search ? 'No sessions match search' : 'No sessions available'}
              </div>
            )}
          </div>
        </div>

        {/* Simulation Results */}
        <div className="flex-1 min-w-0">
          {loading && !isComparing ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : whatIf && !isComparing ? (
            <SimulationResults
              whatIf={whatIf}
              tierData={tierData}
              onSessionSelect={onSessionSelect}
            />
          ) : isComparing ? (
            <div className="space-y-3">
              {/* Delta badge */}
              {whatIf && compareWhatIf && deltaAffected !== null && (
                <div className="flex items-center gap-2 px-3 py-2 bg-gray-800 rounded-lg border border-gray-700">
                  <span className="text-xs text-gray-500">Comparison delta:</span>
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded ${
                      deltaAffected > 0
                        ? 'bg-red-500/20 text-red-400'
                        : deltaAffected < 0
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-gray-700 text-gray-400'
                    }`}
                  >
                    {deltaAffected > 0 ? `+${deltaAffected} more affected` : deltaAffected < 0 ? `${deltaAffected} fewer affected` : 'Same impact'}
                  </span>
                </div>
              )}

              {/* Side-by-side columns */}
              <div className="grid grid-cols-2 gap-3">
                {/* Primary */}
                <div className="min-w-0">
                  {loading ? (
                    <div className="flex items-center justify-center h-32">
                      <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : whatIf ? (
                    <SimulationResults
                      whatIf={whatIf}
                      tierData={tierData}
                      onSessionSelect={onSessionSelect}
                      label="Primary"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-32 text-sm text-gray-500">
                      Select a primary session
                    </div>
                  )}
                </div>

                {/* Compare */}
                <div className="min-w-0">
                  {compareLoading ? (
                    <div className="flex items-center justify-center h-32">
                      <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : compareWhatIf ? (
                    <SimulationResults
                      whatIf={compareWhatIf}
                      tierData={tierData}
                      onSessionSelect={onSessionSelect}
                      label="Compare"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-32 text-sm text-gray-500">
                      Loading comparison...
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-sm text-gray-500">
              Select a session to simulate its failure cascade
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
