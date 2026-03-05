/**
 * DecisionTreeView -- Single-session deep dive rendering the Informatica mapping
 * as a visual decision tree (DAG) using D3 tree layout.
 *
 * @description
 * Shows the internal structure of one ETL session: sources, transforms, routers,
 * filters, joiners, lookups, aggregators, and targets arranged left-to-right as
 * a tree. Each node is shape/color-coded by type. Clicking a node shows its
 * fields, expressions, conditions, and metadata in a detail panel.
 *
 * Layout (three-panel):
 *   Left  (240px) — Session picker with search, tier/complexity badges, transform count
 *   Center (flex)  — SVG decision tree with D3 zoom/pan, horizontal left-to-right flow
 *   Right (280px)  — Node detail panel: fields, expressions, join/filter conditions
 *
 * Tree construction algorithm (buildDecisionTree):
 *   1. Parse instances from mapping_detail, classify each by type
 *   2. Build a directed edge list from connectors (from_instance → to_instance)
 *   3. Topological sort via Kahn's algorithm to determine execution order
 *   4. Group source instances into a virtual root; connect transforms via edges
 *   5. Attach orphan nodes (no parents) to the nearest upstream by topo order
 *   6. D3 d3.tree() computes the (x,y) layout; SVG renders nodes and curved links
 *
 * Node types and their visual encoding:
 *   source_group — green circle   | transform — blue rounded-rect
 *   router       — amber diamond  | filter    — orange triangle
 *   joiner       — purple hexagon | lookup    — cyan pentagon
 *   aggregator   — pink octagon   | target    — red square
 *
 * @param tierData - Full TierMapResult for session listing
 * @param vectorResults - Optional vector data for complexity badges
 * @param uploadId - Current upload ID for API calls
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as d3 from 'd3';
import type { TierMapResult } from '../../types/tiermap';
import type { VectorResults } from '../../types/vectors';
import { getFlowData } from '../../api/client';

// ── Tree node interface ──────────────────────────────────────────────────
interface TreeNode {
  id: string;
  name: string;
  nodeType: 'source_group' | 'transform' | 'router' | 'filter' | 'joiner' | 'lookup' | 'aggregator' | 'target_group';
  tables?: string[];
  children: TreeNode[];
  conditions?: { name: string; expression: string }[];
  filterCondition?: string;
  joinCondition?: string;
  lookupTable?: string;
  fieldCount: number;
  expressionCount: number;
  executionOrder: number;
  // Additional metadata for detail panel
  transformationType?: string;
  fields?: Record<string, unknown>[];
  incomingEdges?: number;
  outgoingEdges?: number;
  instanceName?: string;
}

// ── Flow data shape (mirrors FlowWalker) ─────────────────────────────────
interface FlowData {
  session: Record<string, unknown>;
  upstream: { session_id: string; name: string; tier: number; via_table?: string }[];
  downstream: { session_id: string; name: string; tier: number; via_table?: string }[];
  mapping_detail: Record<string, unknown> | null;
  tables_touched: Record<string, unknown>[];
  complexity: Record<string, unknown> | null;
  wave_info: Record<string, unknown> | null;
  scc: Record<string, unknown> | null;
  upstream_count: number;
  downstream_count: number;
}

interface Props {
  tierData: TierMapResult;
  vectorResults: VectorResults | null;
  uploadId?: number | null;
}

// ── Color palette ────────────────────────────────────────────────────────
const NODE_COLORS: Record<TreeNode['nodeType'], string> = {
  source_group: '#22C55E',
  transform: '#3B82F6',
  router: '#F59E0B',
  filter: '#F97316',
  joiner: '#A855F7',
  lookup: '#06B6D4',
  aggregator: '#EC4899',
  target_group: '#EF4444',
};

const NODE_LABELS: Record<TreeNode['nodeType'], string> = {
  source_group: 'Source',
  transform: 'Transform',
  router: 'Router',
  filter: 'Filter',
  joiner: 'Joiner',
  lookup: 'Lookup',
  aggregator: 'Aggregator',
  target_group: 'Target',
};

// ── Theme ────────────────────────────────────────────────────────────────
const THEME = {
  bg: '#1a2332',
  surface: '#243044',
  text: '#E2E8F0',
  muted: '#94A3B8',
  border: '#3a4a5e',
  dimText: '#8899aa',
  highlight: 'rgba(59,130,246,0.15)',
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Classify an instance's transformation type into a TreeNode nodeType */
function classifyNodeType(
  inst: Record<string, unknown>,
  routerGroupNames: Set<string>,
  filterNames: Set<string>,
  joinNames: Set<string>,
  lookupNames: Set<string>,
): TreeNode['nodeType'] {
  const instType = ((inst.type as string) || '').toLowerCase();
  const tType = ((inst.transformation_type as string) || '').toLowerCase();
  const name = (inst.name as string) || (inst.transformation_name as string) || '';

  if (instType === 'source') return 'source_group';
  if (instType === 'target') return 'target_group';
  if (routerGroupNames.has(name)) return 'router';
  if (filterNames.has(name)) return 'filter';
  if (joinNames.has(name)) return 'joiner';
  if (lookupNames.has(name)) return 'lookup';
  if (tType.includes('aggregator') || tType.includes('agg')) return 'aggregator';
  if (tType.includes('router')) return 'router';
  if (tType.includes('filter')) return 'filter';
  if (tType.includes('joiner') || tType.includes('join')) return 'joiner';
  if (tType.includes('lookup') || tType.includes('lkp')) return 'lookup';
  return 'transform';
}

/** Topological sort using Kahn's algorithm. Returns ordered node IDs. */
function topoSort(nodeIds: string[], edges: { from: string; to: string }[]): string[] {
  const inDeg: Record<string, number> = {};
  const adj: Record<string, string[]> = {};
  for (const id of nodeIds) {
    inDeg[id] = 0;
    adj[id] = [];
  }
  for (const e of edges) {
    if (adj[e.from] && inDeg[e.to] !== undefined) {
      adj[e.from].push(e.to);
      inDeg[e.to]++;
    }
  }
  const queue: string[] = [];
  for (const id of nodeIds) {
    if (inDeg[id] === 0) queue.push(id);
  }
  const sorted: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    sorted.push(n);
    for (const nb of adj[n]) {
      inDeg[nb]--;
      if (inDeg[nb] === 0) queue.push(nb);
    }
  }
  // If there are cycles, append remaining nodes
  for (const id of nodeIds) {
    if (!sorted.includes(id)) sorted.push(id);
  }
  return sorted;
}

/**
 * Build a tree structure from the Informatica mapping_detail.
 *
 * Steps:
 *   1. Create TreeNodes from each instance, classifying by type
 *   2. Deduplicate connectors into instance-level edges
 *   3. Collapse multiple source instances into grouped source nodes
 *   4. Topological sort (Kahn's) to assign execution order
 *   5. Wire children based on edge direction; attach orphans
 *   6. Return virtual root containing the full tree
 *
 * @param md - Raw mapping_detail object from the flow API
 * @returns Root TreeNode, or null if no instances exist
 */
function buildDecisionTree(md: Record<string, unknown>): TreeNode | null {
  const instances = (md.instances as Record<string, unknown>[]) || [];
  const connectors = (md.connectors as Record<string, unknown>[]) || [];
  const fields = (md.fields as Record<string, unknown>[]) || [];
  const routerGroups = (md.router_groups as Record<string, unknown>[]) || [];
  const filterConditions = (md.filter_conditions as Record<string, unknown>[]) || [];
  const joinConditions = (md.join_conditions as Record<string, unknown>[]) || [];
  const lookupConfigs = (md.lookup_configs as Record<string, unknown>[]) || [];

  if (instances.length === 0) return null;

  // Build lookup sets for classification
  const routerGroupNames = new Set<string>();
  for (const rg of routerGroups) {
    const name = (rg.router as string) || (rg.name as string) || '';
    if (name) routerGroupNames.add(name);
  }
  const filterNames = new Set<string>();
  for (const fc of filterConditions) {
    const name = (fc.filter as string) || (fc.name as string) || '';
    if (name) filterNames.add(name);
  }
  const joinNames = new Set<string>();
  for (const jc of joinConditions) {
    const name = (jc.joiner as string) || (jc.name as string) || '';
    if (name) joinNames.add(name);
  }
  const lookupNames = new Set<string>();
  for (const lc of lookupConfigs) {
    const name = (lc.lookup as string) || (lc.name as string) || '';
    if (name) lookupNames.add(name);
  }

  // Group fields by transform
  const fieldsByTransform: Record<string, Record<string, unknown>[]> = {};
  for (const f of fields) {
    const t = (f.transform as string) || '';
    if (!fieldsByTransform[t]) fieldsByTransform[t] = [];
    fieldsByTransform[t].push(f);
  }

  // Create nodes for each instance
  const nodeMap: Record<string, TreeNode> = {};
  const sourceNodes: string[] = [];
  const targetNodes: string[] = [];

  for (const inst of instances) {
    const name = (inst.name as string) || (inst.transformation_name as string) || `inst_${Object.keys(nodeMap).length}`;
    const nodeType = classifyNodeType(inst, routerGroupNames, filterNames, joinNames, lookupNames);
    const instFields = fieldsByTransform[inst.transformation_name as string] || fieldsByTransform[name] || [];
    const exprCount = instFields.filter(f => f.expression && (f.expression as string).trim() !== '').length;

    // Router conditions
    let conditions: { name: string; expression: string }[] | undefined;
    if (nodeType === 'router') {
      conditions = routerGroups
        .filter(rg => (rg.router as string) === name || (rg.name as string) === name)
        .map(rg => ({
          name: (rg.group_name as string) || (rg.name as string) || 'Group',
          expression: (rg.condition as string) || '',
        }));
    }

    // Filter condition
    let filterCondition: string | undefined;
    if (nodeType === 'filter') {
      const fc = filterConditions.find(f => (f.filter as string) === name || (f.name as string) === name);
      filterCondition = (fc?.condition as string) || undefined;
    }

    // Join condition
    let joinCondition: string | undefined;
    if (nodeType === 'joiner') {
      const jc = joinConditions.find(j => (j.joiner as string) === name || (j.name as string) === name);
      joinCondition = (jc?.condition as string) || undefined;
    }

    // Lookup table
    let lookupTable: string | undefined;
    if (nodeType === 'lookup') {
      const lc = lookupConfigs.find(l => (l.lookup as string) === name || (l.name as string) === name);
      lookupTable = (lc?.table as string) || undefined;
    }

    const node: TreeNode = {
      id: name,
      name,
      nodeType,
      children: [],
      fieldCount: instFields.length,
      expressionCount: exprCount,
      executionOrder: 0,
      transformationType: (inst.transformation_type as string) || (inst.type as string) || '',
      fields: instFields,
      conditions,
      filterCondition,
      joinCondition,
      lookupTable,
      instanceName: (inst.transformation_name as string) || name,
      incomingEdges: 0,
      outgoingEdges: 0,
    };

    // Track tables for source/target groups
    if (nodeType === 'source_group') {
      node.tables = [(inst.transformation_name as string) || name];
      sourceNodes.push(name);
    } else if (nodeType === 'target_group') {
      node.tables = [(inst.transformation_name as string) || name];
      targetNodes.push(name);
    }

    nodeMap[name] = node;
  }

  // Deduplicate connectors to instance-level edges
  const edgeSet = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  for (const c of connectors) {
    const fromInst = c.from_instance as string;
    const toInst = c.to_instance as string;
    if (!fromInst || !toInst || fromInst === toInst) continue;
    const key = `${fromInst}->${toInst}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({ from: fromInst, to: toInst });
      if (nodeMap[fromInst]) nodeMap[fromInst].outgoingEdges = (nodeMap[fromInst].outgoingEdges || 0) + 1;
      if (nodeMap[toInst]) nodeMap[toInst].incomingEdges = (nodeMap[toInst].incomingEdges || 0) + 1;
    }
  }

  // Collapse source instances into groups
  // Group sources that share the same downstream target
  const sourceGroups: Record<string, string[]> = {};
  for (const sn of sourceNodes) {
    const downstream = edges.filter(e => e.from === sn).map(e => e.to).sort().join(',');
    const key = downstream || sn;
    if (!sourceGroups[key]) sourceGroups[key] = [];
    sourceGroups[key].push(sn);
  }

  // Merge source groups with >1 member
  for (const [, group] of Object.entries(sourceGroups)) {
    if (group.length > 1) {
      const groupName = `Sources (${group.length})`;
      const tables = group.map(s => nodeMap[s]?.tables?.[0] || s).filter(Boolean);
      const totalFields = group.reduce((acc, s) => acc + (nodeMap[s]?.fieldCount || 0), 0);
      const mergedNode: TreeNode = {
        id: groupName,
        name: groupName,
        nodeType: 'source_group',
        tables,
        children: [],
        fieldCount: totalFields,
        expressionCount: 0,
        executionOrder: 0,
      };
      nodeMap[groupName] = mergedNode;

      // Redirect edges from individual sources to group
      for (const e of edges) {
        if (group.includes(e.from)) {
          e.from = groupName;
        }
      }
      // Remove individual source nodes
      for (const s of group) {
        delete nodeMap[s];
      }
    }
  }

  // Collapse target instances into groups similarly
  const targetGroups: Record<string, string[]> = {};
  for (const tn of targetNodes) {
    if (!nodeMap[tn]) continue; // already removed
    const upstream = edges.filter(e => e.to === tn).map(e => e.from).sort().join(',');
    const key = upstream || tn;
    if (!targetGroups[key]) targetGroups[key] = [];
    targetGroups[key].push(tn);
  }

  for (const [, group] of Object.entries(targetGroups)) {
    if (group.length > 1) {
      const groupName = `Targets (${group.length})`;
      const tables = group.map(t => nodeMap[t]?.tables?.[0] || t).filter(Boolean);
      const totalFields = group.reduce((acc, t) => acc + (nodeMap[t]?.fieldCount || 0), 0);
      const mergedNode: TreeNode = {
        id: groupName,
        name: groupName,
        nodeType: 'target_group',
        tables,
        children: [],
        fieldCount: totalFields,
        expressionCount: 0,
        executionOrder: 0,
      };
      nodeMap[groupName] = mergedNode;

      for (const e of edges) {
        if (group.includes(e.to)) {
          e.to = groupName;
        }
      }
      for (const t of group) {
        delete nodeMap[t];
      }
    }
  }

  // Deduplicate edges again after group merging
  const finalEdgeSet = new Set<string>();
  const finalEdges: { from: string; to: string }[] = [];
  for (const e of edges) {
    if (!nodeMap[e.from] || !nodeMap[e.to]) continue;
    if (e.from === e.to) continue;
    const key = `${e.from}->${e.to}`;
    if (!finalEdgeSet.has(key)) {
      finalEdgeSet.add(key);
      finalEdges.push(e);
    }
  }

  // Topological sort
  const nodeIds = Object.keys(nodeMap);
  if (nodeIds.length === 0) return null;

  const sorted = topoSort(nodeIds, finalEdges);
  sorted.forEach((id, i) => {
    if (nodeMap[id]) nodeMap[id].executionOrder = i;
  });

  // Build parent-child relationships from edges
  const childrenOf: Record<string, string[]> = {};
  const hasParent = new Set<string>();
  for (const e of finalEdges) {
    if (!childrenOf[e.from]) childrenOf[e.from] = [];
    childrenOf[e.from].push(e.to);
    hasParent.add(e.to);
  }

  // Wire children
  for (const [parentId, childIds] of Object.entries(childrenOf)) {
    if (nodeMap[parentId]) {
      // Sort children by execution order
      nodeMap[parentId].children = childIds
        .filter(cid => nodeMap[cid])
        .map(cid => nodeMap[cid])
        .sort((a, b) => a.executionOrder - b.executionOrder);
    }
  }

  // Find root nodes (no incoming edges)
  const roots = nodeIds.filter(id => !hasParent.has(id)).sort((a, b) => (nodeMap[a]?.executionOrder || 0) - (nodeMap[b]?.executionOrder || 0));

  if (roots.length === 0) {
    // All nodes in a cycle — pick the first sorted node
    const first = nodeMap[sorted[0]];
    return first || null;
  }

  if (roots.length === 1) {
    return nodeMap[roots[0]];
  }

  // Multiple roots — create a virtual root
  const virtualRoot: TreeNode = {
    id: '__root__',
    name: 'Pipeline',
    nodeType: 'source_group',
    children: roots.map(r => nodeMap[r]),
    fieldCount: 0,
    expressionCount: 0,
    executionOrder: -1,
  };

  return virtualRoot;
}

/** Flatten a tree into a list of all nodes (for edge rendering) */
function flattenTree(node: TreeNode): TreeNode[] {
  const result: TreeNode[] = [node];
  for (const child of node.children) {
    result.push(...flattenTree(child));
  }
  return result;
}

/** Collect all edges from parent->child in the tree */
function collectEdges(node: TreeNode): { from: string; to: string }[] {
  const result: { from: string; to: string }[] = [];
  for (const child of node.children) {
    result.push({ from: node.id, to: child.id });
    result.push(...collectEdges(child));
  }
  return result;
}

// ── Node shape rendering ─────────────────────────────────────────────────

function renderNodeShape(
  nodeType: TreeNode['nodeType'],
  color: string,
  w: number,
  h: number,
): string {
  const hw = w / 2;
  const hh = h / 2;

  switch (nodeType) {
    case 'router':
      // Diamond
      return `M 0 ${-hh} L ${hw} 0 L 0 ${hh} L ${-hw} 0 Z`;
    case 'filter':
      // Hexagon
      {
        const sx = hw * 0.7;
        return `M ${-sx} ${-hh} L ${sx} ${-hh} L ${hw} 0 L ${sx} ${hh} L ${-sx} ${hh} L ${-hw} 0 Z`;
      }
    case 'aggregator':
      // Wide rounded rect (as path)
      {
        const r = 6;
        return `M ${-hw + r} ${-hh} L ${hw - r} ${-hh} Q ${hw} ${-hh} ${hw} ${-hh + r} L ${hw} ${hh - r} Q ${hw} ${hh} ${hw - r} ${hh} L ${-hw + r} ${hh} Q ${-hw} ${hh} ${-hw} ${hh - r} L ${-hw} ${-hh + r} Q ${-hw} ${-hh} ${-hw + r} ${-hh} Z`;
      }
    default:
      // Rounded rect
      {
        const r = 8;
        return `M ${-hw + r} ${-hh} L ${hw - r} ${-hh} Q ${hw} ${-hh} ${hw} ${-hh + r} L ${hw} ${hh - r} Q ${hw} ${hh} ${hw - r} ${hh} L ${-hw + r} ${hh} Q ${-hw} ${hh} ${-hw} ${hh - r} L ${-hw} ${-hh + r} Q ${-hw} ${-hh} ${-hw + r} ${-hh} Z`;
      }
  }
}

// ── Main Component ───────────────────────────────────────────────────────

export default function DecisionTreeView({ tierData, vectorResults, uploadId }: Props) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [flowData, setFlowData] = useState<FlowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<{ from: string; to: string } | null>(null);
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  const sessions = useMemo(() => tierData?.sessions || [], [tierData]);
  const filteredSessions = useMemo(() => {
    let list = sessions;
    const term = searchTerm.toLowerCase();
    if (term) {
      list = list.filter(s =>
        s.full?.toLowerCase().includes(term) || s.name?.toLowerCase().includes(term)
      );
    }
    if (tierFilter !== 'all') {
      const [lo, hi] = tierFilter.split('-').map(Number);
      list = list.filter(s => s.tier >= lo && s.tier <= hi);
    }
    if (criticalOnly) {
      list = list.filter(s => s.critical);
    }
    return list.slice(0, 50);
  }, [sessions, searchTerm, tierFilter, criticalOnly]);

  // Complexity scores for session badges
  const complexityScores = useMemo(() => {
    const map: Record<string, { score: number; bucket: string }> = {};
    if (vectorResults?.v11_complexity?.scores) {
      for (const s of vectorResults.v11_complexity.scores) {
        map[s.session_id] = { score: s.overall_score, bucket: s.bucket };
      }
    }
    return map;
  }, [vectorResults]);

  // Load flow data for a session
  const loadFlow = useCallback(async (sessionId: string) => {
    setLoading(true);
    setLoadError(null);
    setSelectedNode(null);
    setCollapsedNodes(new Set());
    try {
      const data = await getFlowData(tierData, sessionId, uploadId);
      setFlowData(data as unknown as FlowData);
      setSelectedSessionId(sessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Flow load error:', msg);
      setLoadError(msg);
      setFlowData(null);
    } finally {
      setLoading(false);
    }
  }, [tierData, uploadId]);

  // Auto-load first session
  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      loadFlow(sessions[0].id);
    }
  }, [sessions, selectedSessionId, loadFlow]);

  // Build tree from mapping detail
  const tree = useMemo(() => {
    if (!flowData?.mapping_detail) return null;
    return buildDecisionTree(flowData.mapping_detail as Record<string, unknown>);
  }, [flowData]);

  // Apply collapsed state to tree for rendering
  const displayTree = useMemo(() => {
    if (!tree) return null;
    // Deep clone and prune collapsed subtrees
    function cloneWithCollapse(node: TreeNode): TreeNode {
      const clone = { ...node };
      if (collapsedNodes.has(node.id)) {
        clone.children = [];
      } else {
        clone.children = node.children.map(c => cloneWithCollapse(c));
      }
      return clone;
    }
    return cloneWithCollapse(tree);
  }, [tree, collapsedNodes]);

  // Collect all edges and nodes for highlight logic
  const allEdges = useMemo(() => {
    if (!displayTree) return [];
    return collectEdges(displayTree);
  }, [displayTree]);

  const allNodes = useMemo(() => {
    if (!displayTree) return [];
    return flattenTree(displayTree);
  }, [displayTree]);

  // Get connected node IDs for a hovered node
  const connectedToHovered = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    const connected = new Set<string>([hoveredNode]);
    for (const e of allEdges) {
      if (e.from === hoveredNode) connected.add(e.to);
      if (e.to === hoveredNode) connected.add(e.from);
    }
    return connected;
  }, [hoveredNode, allEdges]);

  // Edge field detail for hover tooltip
  const edgeFieldCounts = useMemo(() => {
    if (!flowData?.mapping_detail) return {};
    const connectors = (flowData.mapping_detail as Record<string, unknown>).connectors as Record<string, unknown>[] || [];
    const counts: Record<string, { count: number; fields: string[] }> = {};
    for (const c of connectors) {
      const key = `${c.from_instance}->${c.to_instance}`;
      if (!counts[key]) counts[key] = { count: 0, fields: [] };
      counts[key].count++;
      const fieldName = `${c.from_field} -> ${c.to_field}`;
      if (counts[key].fields.length < 5) counts[key].fields.push(fieldName);
    }
    return counts;
  }, [flowData]);

  // ── D3 tree layout and SVG rendering ───────────────────────────────────
  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !displayTree) return;

    const svg = d3.select(svgRef.current);
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    svg.attr('width', width).attr('height', height);

    // Clear previous
    svg.selectAll('g.tree-root').remove();

    const g = svg.append('g').attr('class', 'tree-root');

    // Convert our TreeNode to d3 hierarchy
    const root = d3.hierarchy(displayTree, d => d.children);

    // Node sizing
    const nodeW = 140;
    const nodeH = 50;
    const nodeSpacingX = 200;
    const nodeSpacingY = 70;

    // Use d3.tree layout
    const treeLayout = d3.tree<TreeNode>()
      .nodeSize([nodeSpacingY, nodeSpacingX])
      .separation((a, b) => a.parent === b.parent ? 1 : 1.2);

    treeLayout(root);

    // Horizontal layout: swap x/y (tree gives vertical by default)
    const nodes = root.descendants();
    const links = root.links();

    // Calculate bounds
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      // In horizontal layout: y=horizontal position, x=vertical position
      const px = n.y!; // horizontal
      const py = n.x!; // vertical
      if (px - nodeW / 2 < minX) minX = px - nodeW / 2;
      if (px + nodeW / 2 > maxX) maxX = px + nodeW / 2;
      if (py - nodeH / 2 < minY) minY = py - nodeH / 2;
      if (py + nodeH / 2 > maxY) maxY = py + nodeH / 2;
    }

    const treePadding = 60;
    const treeWidth = maxX - minX + treePadding * 2;
    const treeHeight = maxY - minY + treePadding * 2;

    // Initial transform to center
    const scale = Math.min(width / treeWidth, height / treeHeight, 1);
    const tx = (width - treeWidth * scale) / 2 - minX * scale + treePadding * scale;
    const ty = (height - treeHeight * scale) / 2 - minY * scale + treePadding * scale;

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform.toString());
      });

    svg.call(zoom);
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    zoomRef.current = zoom;

    // Draw edges (bezier curves)
    const linkGenerator = d3.linkHorizontal<d3.HierarchyLink<TreeNode>, d3.HierarchyPointNode<TreeNode>>()
      .x(d => d.y!)
      .y(d => d.x!);

    g.selectAll('path.tree-link')
      .data(links)
      .enter()
      .append('path')
      .attr('class', 'tree-link')
      .attr('d', d => linkGenerator(d as any) || '')
      .attr('fill', 'none')
      .attr('stroke', d => {
        const fromId = d.source.data.id;
        const toId = d.target.data.id;
        if (hoveredNode) {
          if (connectedToHovered.has(fromId) && connectedToHovered.has(toId)) {
            return '#60A5FA';
          }
          return '#3a4a5e';
        }
        if (hoveredEdge && hoveredEdge.from === fromId && hoveredEdge.to === toId) {
          return '#60A5FA';
        }
        // Color edges by target node type
        return NODE_COLORS[d.target.data.nodeType] + '60';
      })
      .attr('stroke-width', d => {
        if (hoveredEdge && hoveredEdge.from === d.source.data.id && hoveredEdge.to === d.target.data.id) return 3;
        return 1.5;
      })
      .attr('stroke-dasharray', d => {
        // Animate dashes for router/filter conditional branches
        const parentType = d.source.data.nodeType;
        if (parentType === 'router' || parentType === 'filter') return '6 3';
        return 'none';
      })
      .style('cursor', 'pointer')
      .on('mouseenter', function (_event, d) {
        setHoveredEdge({ from: d.source.data.id, to: d.target.data.id });
      })
      .on('mouseleave', function () {
        setHoveredEdge(null);
      });

    // Draw nodes
    const nodeGroups = g.selectAll('g.tree-node')
      .data(nodes)
      .enter()
      .append('g')
      .attr('class', 'tree-node')
      .attr('transform', d => `translate(${d.y},${d.x})`)
      .style('cursor', 'pointer')
      .on('mouseenter', function (_event, d) {
        setHoveredNode(d.data.id);
      })
      .on('mouseleave', function () {
        setHoveredNode(null);
      })
      .on('click', function (_event, d) {
        // Find the original (non-cloned) node for full details
        if (tree) {
          const origNodes = flattenTree(tree);
          const orig = origNodes.find(n => n.id === d.data.id);
          setSelectedNode(orig || d.data);
        } else {
          setSelectedNode(d.data);
        }
      })
      .on('dblclick', function (_event, d) {
        // Toggle collapse
        const nodeId = d.data.id;
        setCollapsedNodes(prev => {
          const next = new Set(prev);
          if (next.has(nodeId)) {
            next.delete(nodeId);
          } else {
            next.add(nodeId);
          }
          return next;
        });
      });

    // Node shapes
    nodeGroups.append('path')
      .attr('d', d => {
        const nt = d.data.nodeType;
        const w = nt === 'aggregator' ? nodeW + 20 : nodeW;
        return renderNodeShape(nt, NODE_COLORS[nt], w, nodeH);
      })
      .attr('fill', d => {
        if (hoveredNode && !connectedToHovered.has(d.data.id)) {
          return THEME.surface + '40';
        }
        return NODE_COLORS[d.data.nodeType] + '20';
      })
      .attr('stroke', d => {
        if (selectedNode?.id === d.data.id) return '#60A5FA';
        if (hoveredNode === d.data.id) return NODE_COLORS[d.data.nodeType];
        if (hoveredNode && !connectedToHovered.has(d.data.id)) return THEME.border + '40';
        return NODE_COLORS[d.data.nodeType] + '80';
      })
      .attr('stroke-width', d => {
        if (selectedNode?.id === d.data.id) return 2;
        if (hoveredNode === d.data.id) return 2;
        return 1;
      });

    // Node label (name)
    nodeGroups.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', -4)
      .attr('fill', d => {
        if (hoveredNode && !connectedToHovered.has(d.data.id)) return THEME.dimText + '60';
        return THEME.text;
      })
      .attr('font-size', 10)
      .attr('font-weight', 600)
      .text(d => {
        const name = d.data.name;
        return name.length > 18 ? name.substring(0, 16) + '..' : name;
      });

    // Node type label
    nodeGroups.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', 10)
      .attr('fill', d => {
        if (hoveredNode && !connectedToHovered.has(d.data.id)) return THEME.dimText + '40';
        return NODE_COLORS[d.data.nodeType] + 'CC';
      })
      .attr('font-size', 8)
      .text(d => {
        const label = NODE_LABELS[d.data.nodeType];
        const fc = d.data.fieldCount;
        return fc > 0 ? `${label} (${fc}f)` : label;
      });

    // Collapse indicator for nodes with children
    nodeGroups.filter(d => {
      // Check if original node has children
      if (!tree) return false;
      const origNodes = flattenTree(tree);
      const orig = origNodes.find(n => n.id === d.data.id);
      return (orig?.children?.length || 0) > 0;
    })
      .append('circle')
      .attr('cx', nodeW / 2 + 4)
      .attr('cy', 0)
      .attr('r', 6)
      .attr('fill', d => collapsedNodes.has(d.data.id) ? '#F59E0B' : THEME.surface)
      .attr('stroke', THEME.dimText)
      .attr('stroke-width', 0.5);

    nodeGroups.filter(d => {
      if (!tree) return false;
      const origNodes = flattenTree(tree);
      const orig = origNodes.find(n => n.id === d.data.id);
      return (orig?.children?.length || 0) > 0;
    })
      .append('text')
      .attr('x', nodeW / 2 + 4)
      .attr('y', 0)
      .attr('text-anchor', 'middle')
      .attr('dy', 3)
      .attr('fill', THEME.text)
      .attr('font-size', 8)
      .attr('font-weight', 700)
      .text(d => collapsedNodes.has(d.data.id) ? '+' : '-');

    // Hover tooltip for edges
    if (hoveredEdge) {
      const key = `${hoveredEdge.from}->${hoveredEdge.to}`;
      const info = edgeFieldCounts[key];
      if (info) {
        // Find midpoint of the hovered edge
        const sourceNode = nodes.find(n => n.data.id === hoveredEdge.from);
        const targetNode = nodes.find(n => n.data.id === hoveredEdge.to);
        if (sourceNode && targetNode) {
          const mx = (sourceNode.y! + targetNode.y!) / 2;
          const my = (sourceNode.x! + targetNode.x!) / 2;
          const tipG = g.append('g').attr('class', 'edge-tooltip').attr('transform', `translate(${mx},${my - 20})`);
          tipG.append('rect')
            .attr('x', -50)
            .attr('y', -12)
            .attr('width', 100)
            .attr('height', 24)
            .attr('rx', 4)
            .attr('fill', THEME.surface)
            .attr('stroke', THEME.border)
            .attr('stroke-width', 0.5);
          tipG.append('text')
            .attr('text-anchor', 'middle')
            .attr('dy', 4)
            .attr('fill', THEME.text)
            .attr('font-size', 9)
            .text(`${info.count} field connections`);
        }
      }
    }

  }, [displayTree, tree, hoveredNode, hoveredEdge, selectedNode, connectedToHovered, collapsedNodes, edgeFieldCounts, allNodes]);

  // ── Zoom controls ──────────────────────────────────────────────────────
  const handleZoom = useCallback((direction: 'in' | 'out' | 'reset') => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = d3.select(svgRef.current);
    const zoom = zoomRef.current;
    if (direction === 'in') {
      svg.transition().duration(300).call(zoom.scaleBy, 1.4);
    } else if (direction === 'out') {
      svg.transition().duration(300).call(zoom.scaleBy, 0.7);
    } else {
      svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity);
    }
  }, []);

  // ── Tier color helper ──────────────────────────────────────────────────
  const tierColor = (tier: number) => {
    if (tier <= 1) return '#10B981';
    if (tier <= 3) return '#3B82F6';
    if (tier <= 5) return '#F97316';
    return '#EF4444';
  };

  const bucketColor = (bucket: string) => {
    switch (bucket) {
      case 'Simple': return '#10B981';
      case 'Medium': return '#3B82F6';
      case 'Complex': return '#F97316';
      case 'Very Complex': return '#EF4444';
      default: return THEME.muted;
    }
  };

  const session = flowData?.session as Record<string, unknown> | undefined;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: THEME.bg }}>
      {/* ── Left Panel: Session Picker ─────────────────────────────────── */}
      <div style={{ width: 240, borderRight: `1px solid ${THEME.border}`, overflow: 'auto', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px', borderBottom: `1px solid ${THEME.border}` }}>
          <input
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search sessions..."
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6,
              border: `1px solid ${THEME.border}`, background: THEME.bg, color: THEME.text,
              fontSize: 11, outline: 'none', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
            <select value={tierFilter} onChange={e => setTierFilter(e.target.value)}
              style={{ flex: 1, padding: '3px 4px', borderRadius: 4, border: `1px solid ${THEME.border}`, background: THEME.bg, color: THEME.muted, fontSize: 10 }}>
              <option value="all">All Tiers</option>
              <option value="1-1">Tier 1</option>
              <option value="1-3">Tier 1-3</option>
              <option value="4-10">Tier 4-10</option>
              <option value="11-99">Tier 11+</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: THEME.muted, cursor: 'pointer' }}>
              <input type="checkbox" checked={criticalOnly} onChange={e => setCriticalOnly(e.target.checked)}
                style={{ width: 12, height: 12 }} />
              Critical
            </label>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '4px 8px' }}>
          {filteredSessions.length < sessions.length && (
            <div style={{ padding: '4px 8px', fontSize: 9, color: THEME.dimText }}>
              {filteredSessions.length} of {sessions.length} sessions
            </div>
          )}
          {filteredSessions.map(s => {
            const cx = complexityScores[s.id];
            const isSelected = s.id === selectedSessionId;
            return (
              <div
                key={s.id}
                onClick={() => loadFlow(s.id)}
                style={{
                  padding: '8px 10px', borderRadius: 6, marginBottom: 4,
                  cursor: 'pointer',
                  background: isSelected ? THEME.highlight : 'transparent',
                  border: isSelected ? '1px solid rgba(59,130,246,0.4)' : '1px solid transparent',
                }}
              >
                <div style={{
                  fontSize: 11, fontWeight: 600,
                  color: isSelected ? '#60A5FA' : THEME.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.name}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 600,
                    background: tierColor(s.tier) + '20', color: tierColor(s.tier),
                  }}>
                    T{s.tier}
                  </span>
                  <span style={{ fontSize: 9, color: THEME.dimText }}>
                    {s.transforms} transforms
                  </span>
                  {cx && (
                    <span style={{
                      fontSize: 8, padding: '1px 5px', borderRadius: 3,
                      background: bucketColor(cx.bucket) + '20', color: bucketColor(cx.bucket),
                    }}>
                      {cx.bucket}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {filteredSessions.length === 0 && (
            <div style={{ padding: 12, textAlign: 'center', fontSize: 11, color: THEME.dimText }}>
              No sessions found
            </div>
          )}
        </div>
      </div>

      {/* ── Center Panel: SVG Decision Tree ────────────────────────────── */}
      <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {loading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: THEME.bg + 'CC', zIndex: 10, color: THEME.dimText, fontSize: 13,
          }}>
            Loading flow data...
          </div>
        )}

        {!loading && flowData && !tree && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 8,
          }}>
            <div style={{ fontSize: 13, color: THEME.dimText }}>
              No mapping detail available for this session.
            </div>
            <div style={{ fontSize: 11, color: THEME.dimText + '80' }}>
              Deep XML mapping data is required to build a decision tree.
            </div>
          </div>
        )}

        {!loading && loadError && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 8, color: '#EF4444', fontSize: 13,
          }}>
            <span>Failed to load flow data</span>
            <span style={{ color: THEME.dimText, fontSize: 11, maxWidth: 300, textAlign: 'center' }}>{loadError}</span>
          </div>
        )}
        {!loading && !loadError && !flowData && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: THEME.dimText, fontSize: 13,
          }}>
            Select a session to view its decision tree.
          </div>
        )}

        <svg
          ref={svgRef}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />

        {/* Zoom controls */}
        <div style={{
          position: 'absolute', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 4, zIndex: 5,
        }}>
          {[
            { label: '+', action: 'in' as const },
            { label: '-', action: 'out' as const },
            { label: 'R', action: 'reset' as const },
          ].map(btn => (
            <button
              key={btn.label}
              onClick={() => handleZoom(btn.action)}
              style={{
                width: 32, height: 32, borderRadius: 6, border: `1px solid ${THEME.border}`,
                background: THEME.surface, color: THEME.text, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, fontWeight: 700,
              }}
            >
              {btn.label}
            </button>
          ))}
        </div>

        {/* Legend */}
        {tree && (
          <div style={{
            position: 'absolute', top: 12, left: 12, background: THEME.surface + 'E0',
            borderRadius: 8, padding: '8px 12px', border: `1px solid ${THEME.border}`,
            fontSize: 9, zIndex: 5,
          }}>
            <div style={{ fontWeight: 700, color: THEME.text, marginBottom: 6, fontSize: 10 }}>Node Types</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {Object.entries(NODE_COLORS).map(([type, color]) => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                  <span style={{ color: THEME.muted }}>{NODE_LABELS[type as TreeNode['nodeType']]}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6, color: THEME.dimText }}>
              Click node for details. Double-click to collapse/expand.
            </div>
          </div>
        )}

        {/* Session title overlay */}
        {session && (
          <div style={{
            position: 'absolute', top: 12, right: 300, background: THEME.surface + 'E0',
            borderRadius: 8, padding: '6px 12px', border: `1px solid ${THEME.border}`,
            zIndex: 5,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#60A5FA' }}>
              {(session.full as string) || (session.name as string)}
            </div>
            <div style={{ fontSize: 9, color: THEME.muted, marginTop: 2 }}>
              Tier {session.tier as number} | {(session.transforms as number) || 0} transforms
              | {allNodes.length} tree nodes | {allEdges.length} edges
            </div>
          </div>
        )}
      </div>

      {/* ── Right Panel: Node Detail ───────────────────────────────────── */}
      <div style={{
        width: 280, borderLeft: `1px solid ${THEME.border}`, overflow: 'auto', flexShrink: 0,
        padding: 12, background: THEME.bg,
      }}>
        {!selectedNode && (
          <div style={{ padding: 20, textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: THEME.dimText, marginBottom: 8 }}>Node Details</div>
            <div style={{ fontSize: 11, color: THEME.dimText + '80' }}>
              Click a node in the tree to see its details here.
            </div>
          </div>
        )}

        {selectedNode && (
          <>
            {/* Node header */}
            <div style={{
              padding: '10px 12px', borderRadius: 8, marginBottom: 12,
              background: NODE_COLORS[selectedNode.nodeType] + '15',
              border: `1px solid ${NODE_COLORS[selectedNode.nodeType]}40`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{
                  fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 700,
                  background: NODE_COLORS[selectedNode.nodeType] + '30',
                  color: NODE_COLORS[selectedNode.nodeType],
                }}>
                  {NODE_LABELS[selectedNode.nodeType]}
                </span>
                <span style={{ fontSize: 9, color: THEME.dimText }}>
                  Order #{selectedNode.executionOrder}
                </span>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: THEME.text, wordBreak: 'break-all' }}>
                {selectedNode.name}
              </div>
              {selectedNode.transformationType && (
                <div style={{ fontSize: 10, color: THEME.muted, marginTop: 2 }}>
                  {selectedNode.transformationType}
                </div>
              )}
            </div>

            {/* Stats row */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12,
            }}>
              {[
                { label: 'Fields', value: selectedNode.fieldCount },
                { label: 'Expressions', value: selectedNode.expressionCount },
                { label: 'Children', value: selectedNode.children?.length ?? 0 },
                { label: 'Exec Order', value: selectedNode.executionOrder },
              ].map(stat => (
                <div key={stat.label} style={{
                  padding: '6px 8px', borderRadius: 6, background: THEME.surface,
                  border: `1px solid ${THEME.border}`,
                }}>
                  <div style={{ fontSize: 9, color: THEME.dimText }}>{stat.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: THEME.text }}>{stat.value}</div>
                </div>
              ))}
            </div>

            {/* Tables (for source/target groups) */}
            {selectedNode.tables && selectedNode.tables.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: THEME.muted, textTransform: 'uppercase', marginBottom: 6 }}>
                  Tables ({selectedNode.tables.length})
                </div>
                {selectedNode.tables.map((t, i) => (
                  <div key={i} style={{
                    padding: '4px 8px', borderRadius: 4, marginBottom: 2,
                    fontSize: 10, color: THEME.text, background: THEME.surface,
                    border: `1px solid ${THEME.border}`,
                    wordBreak: 'break-all',
                  }}>
                    {t}
                  </div>
                ))}
              </div>
            )}

            {/* Router conditions */}
            {selectedNode.conditions && selectedNode.conditions.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#F59E0B', textTransform: 'uppercase', marginBottom: 6 }}>
                  Router Groups ({selectedNode.conditions.length})
                </div>
                {selectedNode.conditions.map((cond, i) => (
                  <div key={i} style={{
                    padding: '6px 8px', borderRadius: 6, marginBottom: 4,
                    background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: '#F59E0B', marginBottom: 2 }}>
                      {cond.name}
                    </div>
                    {cond.expression && (
                      <div style={{
                        fontSize: 9, color: THEME.muted, fontFamily: 'monospace',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                      }}>
                        {cond.expression}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Filter condition */}
            {selectedNode.filterCondition && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#F97316', textTransform: 'uppercase', marginBottom: 6 }}>
                  Filter Condition
                </div>
                <div style={{
                  padding: '6px 8px', borderRadius: 6, fontSize: 9,
                  background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.2)',
                  color: THEME.muted, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>
                  {selectedNode.filterCondition}
                </div>
              </div>
            )}

            {/* Join condition */}
            {selectedNode.joinCondition && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#A855F7', textTransform: 'uppercase', marginBottom: 6 }}>
                  Join Condition
                </div>
                <div style={{
                  padding: '6px 8px', borderRadius: 6, fontSize: 9,
                  background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.2)',
                  color: THEME.muted, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>
                  {selectedNode.joinCondition}
                </div>
              </div>
            )}

            {/* Lookup table */}
            {selectedNode.lookupTable && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#06B6D4', textTransform: 'uppercase', marginBottom: 6 }}>
                  Lookup Table
                </div>
                <div style={{
                  padding: '6px 8px', borderRadius: 6, fontSize: 10,
                  background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)',
                  color: '#06B6D4', fontWeight: 600,
                }}>
                  {selectedNode.lookupTable}
                </div>
              </div>
            )}

            {/* Children list */}
            {(selectedNode.children?.length ?? 0) > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: THEME.muted, textTransform: 'uppercase', marginBottom: 6 }}>
                  Downstream ({selectedNode.children?.length ?? 0})
                </div>
                {(selectedNode.children ?? []).map((child, i) => (
                  <div
                    key={i}
                    onClick={() => setSelectedNode(child)}
                    style={{
                      padding: '4px 8px', borderRadius: 4, marginBottom: 2,
                      fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                      background: THEME.surface, border: `1px solid ${THEME.border}`,
                    }}
                  >
                    <span style={{
                      width: 6, height: 6, borderRadius: 1,
                      background: NODE_COLORS[child.nodeType], flexShrink: 0,
                    }} />
                    <span style={{ color: THEME.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {child.name}
                    </span>
                    <span style={{ fontSize: 8, color: THEME.dimText, marginLeft: 'auto', flexShrink: 0 }}>
                      {NODE_LABELS[child.nodeType]}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Field table */}
            {selectedNode.fields && selectedNode.fields.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: THEME.muted, textTransform: 'uppercase', marginBottom: 6 }}>
                  Fields ({selectedNode.fields.length})
                </div>
                <div style={{ maxHeight: 300, overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${THEME.border}` }}>
                        <th style={{ textAlign: 'left', padding: '3px 4px', color: THEME.dimText, fontWeight: 600 }}>Field</th>
                        <th style={{ textAlign: 'left', padding: '3px 4px', color: THEME.dimText, fontWeight: 600 }}>Type</th>
                        <th style={{ textAlign: 'left', padding: '3px 4px', color: THEME.dimText, fontWeight: 600 }}>Port</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedNode.fields.map((f, fi) => (
                        <tr key={fi} style={{ borderBottom: `1px solid ${THEME.surface}` }}>
                          <td style={{ padding: '2px 4px', color: THEME.text, fontWeight: 500 }}>
                            {f.name as string}
                          </td>
                          <td style={{ padding: '2px 4px', color: THEME.dimText }}>
                            {f.datatype as string}
                          </td>
                          <td style={{ padding: '2px 4px' }}>
                            <span style={{
                              padding: '0px 4px', borderRadius: 2, fontSize: 8,
                              background: (f.expression_type as string) === 'derived' ? 'rgba(96,165,250,0.15)' :
                                (f.expression_type as string) === 'aggregated' ? 'rgba(168,139,250,0.15)' :
                                'transparent',
                              color: (f.expression_type as string) === 'derived' ? '#60A5FA' :
                                (f.expression_type as string) === 'aggregated' ? '#A78BFA' :
                                THEME.dimText,
                            }}>
                              {f.porttype as string}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Expressions subset */}
                {selectedNode.expressionCount > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: '#60A5FA', marginBottom: 4 }}>
                      Expressions ({selectedNode.expressionCount})
                    </div>
                    <div style={{ maxHeight: 200, overflow: 'auto' }}>
                      {selectedNode.fields
                        .filter(f => f.expression && (f.expression as string).trim() !== '')
                        .slice(0, 20)
                        .map((f, i) => (
                          <div key={i} style={{
                            padding: '3px 6px', marginBottom: 2, borderRadius: 4,
                            background: THEME.surface, border: `1px solid ${THEME.border}`,
                          }}>
                            <div style={{ fontSize: 9, fontWeight: 600, color: THEME.text }}>{f.name as string}</div>
                            <div style={{
                              fontSize: 8, color: THEME.muted, fontFamily: 'monospace',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 1,
                            }}>
                              {f.expression as string}
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
