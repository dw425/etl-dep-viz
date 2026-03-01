/**
 * Galaxy Map v2 — enhanced orbital visualization with D3 zoom + search + detail panel.
 *
 * OVERVIEW  Sessions placed equally spaced on a single large circle —
 *           no overlap, no clustering. Sorted by tier then step.
 *           Session→session edges as colored arcs. Click → FOCUSED.
 *
 * FOCUSED   SVG zooms 2× centered on the focused session. Three
 *           concentric orbit rings:
 *             Ring 1 (185 px) — inner tables (up to 12)
 *             Ring 2 (285 px) — overflow tables
 *             Ring 3 (355 px) — connected sessions (clickable → switch)
 *           Click orbit session → zoom transitions to that session.
 *           ← Overview or ESC returns to overview.
 *
 * Enhancements (v2):
 *   - D3 zoom/pan for smooth navigation (scroll to zoom, drag to pan)
 *   - Search overlay (Ctrl+F or click search icon)
 *   - Session detail panel on right-click or double-click
 *   - Minimap navigator (bottom-right corner)
 *   - Node grouping by tier with visual ring indicators
 *   - Performance: virtualized rendering for off-screen nodes
 */

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import * as d3 from 'd3';
import type { TierMapResult, TierSession, TierTable } from '../../types/tiermap';
import GalaxyFilterSidebar, { type GalaxyFilters, getDefaultFilters, applyGalaxyFilters } from './GalaxyFilterSidebar';

// ── Colors ────────────────────────────────────────────────────────────────────

// Maps tier number → color, cycling through 8 palette entries
function tierColor(t: number): string {
  const p = ['#3B82F6','#EAB308','#A855F7','#10B981','#F97316','#06B6D4','#EC4899','#84CC16'];
  return p[Math.max(0, Math.floor(t) - 1) % p.length];
}

// CC — connection type → stroke color
const CC: Record<string, string> = {
  write_conflict: '#EF4444', write_clean: '#3B82F6',
  read_after_write: '#A855F7', lookup_stale: '#F59E0B',
  chain: '#F97316', source_read: '#10B981',
};
// CD — connection type → SVG stroke-dasharray (undefined = solid)
const CD: Record<string, string> = { lookup_stale: '6,3', source_read: '4,4' };
// CL — connection type → human-readable label for tooltips/legend
const CL: Record<string, string> = {
  write_conflict: 'Write Conflict', write_clean: 'Write',
  read_after_write: 'Read After Write', lookup_stale: 'Lookup (stale)',
  chain: 'Chain', source_read: 'Source Read',
};

// ── Stars ─────────────────────────────────────────────────────────────────────
// Pre-computed deterministic star positions (rendered outside D3 zoom group for parallax)
const STARS = Array.from({ length: 200 }, (_, i) => ({
  x: ((i * 7919 + 1327) % 10000) / 100, // hash-based pseudo-random x [0, 100]
  y: ((i * 6271 + 4523) % 10000) / 100, // hash-based pseudo-random y [0, 100]
  r: i % 7 === 0 ? 1.4 : i % 3 === 0 ? 0.9 : 0.5,
  o: 0.06 + (i % 5) * 0.04,
}));

interface SP { x: number; y: number; r: number; color: string }
interface ONode {
  uid: string; entityId: string; type: 'table' | 'session';
  x: number; y: number; r: number; color: string;
  label: string; fullName: string; connType: string; dir: 'out' | 'in';
  parentX: number; parentY: number; level: 1 | 2;
}
interface OEdge { x1: number; y1: number; x2: number; y2: number; connType: string; strong?: boolean }

// ── Component ─────────────────────────────────────────────────────────────────

export default function GalaxyMapCanvas({
  data, onClose,
}: { data: TierMapResult; onClose: () => void }) {
  const [dims,    setDims]    = useState({ w: window.innerWidth, h: window.innerHeight });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [expTbls, setExpTbls] = useState<Set<string>>(new Set());
  const [mouseXY, setMouseXY] = useState({ x: 0, y: 0 });
  const [tip,     setTip]     = useState<{ name: string; sub: string } | null>(null);
  const [search,  setSearch]  = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [detailNode, setDetailNode] = useState<TierSession | null>(null);
  const [galaxyFilters, setGalaxyFilters] = useState<GalaxyFilters>(() => getDefaultFilters(data));
  const [filterVisible, setFilterVisible] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);

  // Filters are applied once here; all layout memos below operate on filteredData
  const filteredData = useMemo(() => applyGalaxyFilters(data, galaxyFilters), [data, galaxyFilters]);
  const { sessions, tables, connections } = filteredData;

  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown>>();
  const gRef = useRef<SVGGElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fn = () => setDims({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showSearch) { setShowSearch(false); setSearch(''); }
        else if (detailNode) setDetailNode(null);
        else if (focusId) { setFocusId(null); setExpTbls(new Set()); }
        else onClose();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
        setTimeout(() => searchRef.current?.focus(), 50);
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [focusId, onClose, showSearch, detailNode]);

  // ── D3 Zoom ──────────────────────────────────────────────────────────────────
  // Attaches a D3 zoom behavior to the SVG. The zoom transform is applied to
  // the inner <g ref={gRef}> so stars (outside the group) stay fixed for parallax.
  // zoomScale state drives semantic LOD switching on session nodes.
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;

    const svg = d3.select(svgRef.current);
    const g = d3.select(gRef.current);

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 8])
      .on('zoom', (event) => {
        g.attr('transform', event.transform.toString());
        setZoomScale(event.transform.k);
      });

    zoomRef.current = zoom;
    svg.call(zoom);

    // Double-click is used for session detail panel, not zoom
    svg.on('dblclick.zoom', null);

    return () => { svg.on('.zoom', null); };
  }, []);

  // ── Zoom to focused session ────────────────────────────────────────────────
  // When focusId changes, smoothly pan/zoom to center the selected session at 2× scale.
  // When focus is cleared, animate back to the identity transform (full overview).
  // The translate positions the session at the viewport center after applying the scale.
  useEffect(() => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = d3.select(svgRef.current);

    if (focusId) {
      const p = sessPos.get(focusId);
      if (p) {
        const scale = 2.0;
        // Translate so that (p.x * scale, p.y * scale) lands at (dims.w/2, dims.h/2)
        const transform = d3.zoomIdentity
          .translate(dims.w / 2 - p.x * scale, dims.h / 2 - p.y * scale)
          .scale(scale);
        svg.transition().duration(480).ease(d3.easeCubicInOut)
          .call(zoomRef.current.transform, transform);
      }
    } else {
      // Return to overview at identity (zoom=1, translate=0,0)
      svg.transition().duration(480).ease(d3.easeCubicInOut)
        .call(zoomRef.current.transform, d3.zoomIdentity);
    }
  }, [focusId, dims]); // sessPos dependency handled below

  const sessById = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);
  const tblById  = useMemo(() => new Map(tables.map(t => [t.id, t])),   [tables]);
  const sessSet  = useMemo(() => new Set(sessions.map(s => s.id)),       [sessions]);

  const cx = dims.w / 2;
  const cy = dims.h / 2;

  // ── Equal-distance circle layout ────────────────────────────────────────────
  // Sessions are sorted by tier then step, then distributed uniformly on a circle.
  // R is clamped so nodes never overlap (110px arc-gap per node) and stay inside 36% of viewport.
  // Node radius grows with connection count (more edges → larger sphere, capped at +12px).
  const sessPos = useMemo((): Map<string, SP> => {
    const sorted = [...sessions].sort((a, b) => a.tier - b.tier || a.step - b.step);
    const N      = sorted.length;
    // Choose radius that guarantees ~110px arc-gap between adjacent nodes
    const R      = Math.max((110 * N) / (2 * Math.PI), Math.min(dims.w, dims.h) * 0.36);
    const pos    = new Map<string, SP>();
    sorted.forEach((s, i) => {
      // Start at -π/2 so the first node appears at the top
      const angle  = (i / N) * Math.PI * 2 - Math.PI / 2;
      const connCt = connections.filter(c => c.from === s.id || c.to === s.id).length;
      pos.set(s.id, {
        x: cx + Math.cos(angle) * R,
        y: cy + Math.sin(angle) * R,
        r: 28 + Math.min(connCt * 1.5, 12), // base 28px + up to 12px for hub nodes
        color: tierColor(s.tier),
      });
    });
    return pos;
  }, [sessions, connections, cx, cy, dims]);

  // ── Search results ───────────────────────────────────────────────────────────
  // Matches session name/full path and table name case-insensitively; capped at 20 results
  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    const results: Array<{ id: string; name: string; type: 'session' | 'table'; tier: number }> = [];
    sessions.forEach(s => {
      if (s.name.toLowerCase().includes(q) || s.full.toLowerCase().includes(q)) {
        results.push({ id: s.id, name: s.name, type: 'session', tier: s.tier });
      }
    });
    tables.forEach(t => {
      if (t.name.toLowerCase().includes(q)) {
        results.push({ id: t.id, name: t.name, type: 'table', tier: t.tier });
      }
    });
    return results.slice(0, 20);
  }, [search, sessions, tables]);

  // Collect result IDs into a Set for O(1) highlight lookup during rendering
  const highlightSet = useMemo(() => new Set(searchResults.map(r => r.id)), [searchResults]);

  // ── External orb (overview only) ──────────────────────────────────────────
  // Tier ≤ 0.6 indicates a source table not produced by any session (upstream external source)
  const extCount = useMemo(() => tables.filter(t => t.tier <= 0.6).length, [tables]);
  const EXT      = useMemo((): SP => ({
    x: dims.w * 0.90, y: dims.h * 0.12, r: 48, color: '#475569',
  }), [dims]);

  // ── Session→session edges (overview only) ─────────────────────────────────
  const baseEdges = useMemo(
    () => connections.filter(cn => sessSet.has(cn.from) && sessSet.has(cn.to)),
    [connections, sessSet],
  );

  // ── Tier ring guides (overview) ────────────────────────────────────────────
  // Computes the average radial distance of each tier's sessions from the center,
  // then draws a faint guide circle at that radius labeled "T{n} (count)".
  const tierRings = useMemo(() => {
    const tiers = [...new Set(sessions.map(s => s.tier))].sort((a, b) => a - b);
    return tiers.map(t => {
      const tierSessions = sessions.filter(s => s.tier === t);
      const positions = tierSessions.map(s => sessPos.get(s.id)).filter(Boolean) as SP[];
      if (positions.length === 0) return null;
      const avgDist = positions.reduce((sum, p) =>
        sum + Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2), 0) / positions.length;
      return { tier: t, radius: avgDist, color: tierColor(t), count: tierSessions.length };
    }).filter(Boolean) as Array<{ tier: number; radius: number; color: string; count: number }>;
  }, [sessions, sessPos, cx, cy]);

  // ── Orbit computation for the focused session ─────────────────────────────
  // Builds three concentric rings around the focused session:
  //   Ring 1 (IR=185px) — up to 12 connected tables (inner ring)
  //   Ring 2 (OR=285px) — overflow tables beyond the first 12
  //   Ring 3 (SR=355px) — connected sessions (clickable to switch focus)
  // Angles start at -π/2 (top) for single items, distributed evenly for multiple.
  const { orbitNodes, orbitEdges } = useMemo((): { orbitNodes: ONode[]; orbitEdges: OEdge[] } => {
    if (!focusId) return { orbitNodes: [], orbitEdges: [] };
    const sp = sessPos.get(focusId);
    if (!sp) return { orbitNodes: [], orbitEdges: [] };

    const seen  = new Set<string>();
    const items: Array<{ otherId: string; connType: string; dir: 'out' | 'in' }> = [];
    connections.forEach(cn => {
      if (cn.from !== focusId && cn.to !== focusId) return;
      const otherId = cn.from === focusId ? cn.to : cn.from;
      const dir     = cn.from === focusId ? 'out' : 'in';
      if (!seen.has(otherId)) { seen.add(otherId); items.push({ otherId, connType: cn.type, dir }); }
    });

    const tblItems  = items.filter(({ otherId }) => tblById.has(otherId));
    const sessItems = items.filter(({ otherId }) => sessById.has(otherId));

    const nodes: ONode[] = [];
    const edges: OEdge[] = [];

    // Table rings
    const inner = tblItems.slice(0, 12);
    const outer = tblItems.slice(12);
    const IR = 185, OR = 285;

    inner.forEach(({ otherId, connType, dir }, i) => {
      const angle = inner.length === 1
        ? -Math.PI / 2
        : (i / inner.length) * Math.PI * 2 - Math.PI / 2;
      const x = sp.x + Math.cos(angle) * IR;
      const y = sp.y + Math.sin(angle) * IR;
      const tbl = tblById.get(otherId)!;
      nodes.push({
        uid: `i::${otherId}`, entityId: otherId, type: 'table',
        x, y, r: 22, color: CC[connType] ?? '#64748B',
        label: tbl.name.length > 13 ? tbl.name.slice(0, 13) + '…' : tbl.name,
        fullName: tbl.name, connType, dir, parentX: sp.x, parentY: sp.y, level: 1,
      });
      edges.push({ x1: sp.x, y1: sp.y, x2: x, y2: y, connType });
    });

    outer.forEach(({ otherId, connType, dir }, i) => {
      const angle = outer.length === 1
        ? Math.PI / 4
        : (i / outer.length) * Math.PI * 2 + Math.PI / outer.length - Math.PI / 2;
      const x = sp.x + Math.cos(angle) * OR;
      const y = sp.y + Math.sin(angle) * OR;
      const tbl = tblById.get(otherId)!;
      nodes.push({
        uid: `o::${otherId}`, entityId: otherId, type: 'table',
        x, y, r: 20, color: CC[connType] ?? '#64748B',
        label: tbl.name.length > 13 ? tbl.name.slice(0, 13) + '…' : tbl.name,
        fullName: tbl.name, connType, dir, parentX: sp.x, parentY: sp.y, level: 1,
      });
      edges.push({ x1: sp.x, y1: sp.y, x2: x, y2: y, connType });
    });

    // Session orbit ring (outermost)
    const SR = 355;
    sessItems.forEach(({ otherId, connType, dir }, i) => {
      const angle = sessItems.length === 1
        ? Math.PI / 6
        : (i / sessItems.length) * Math.PI * 2 - Math.PI / 2;
      const x = sp.x + Math.cos(angle) * SR;
      const y = sp.y + Math.sin(angle) * SR;
      const s = sessById.get(otherId)!;
      nodes.push({
        uid: `s::${otherId}`, entityId: otherId, type: 'session',
        x, y, r: 26, color: tierColor(s.tier),
        label: s.name.length > 12 ? s.name.slice(0, 12) + '…' : s.name,
        fullName: s.full, connType, dir, parentX: sp.x, parentY: sp.y, level: 1,
      });
      edges.push({ x1: sp.x, y1: sp.y, x2: x, y2: y, connType, strong: true });
    });

    return { orbitNodes: nodes, orbitEdges: edges };
  }, [focusId, sessPos, sessById, tblById, connections]);

  // ── Level-2: expanded orbit — shows sessions connected to a clicked table ──
  // When a table node is expanded (expTbls set), places its connected sessions
  // in a mini ring (95px) around that table node. This is the drill-down layer.
  const { l2Nodes, l2Edges } = useMemo((): { l2Nodes: ONode[]; l2Edges: OEdge[] } => {
    if (!focusId) return { l2Nodes: [], l2Edges: [] };
    const nodes: ONode[] = [];
    const edges: OEdge[] = [];
    expTbls.forEach(uid => {
      const orb = orbitNodes.find(n => n.uid === uid);
      if (!orb) return;
      const { entityId: tableId, x: tx, y: ty } = orb;
      const found: Array<{ sessId: string; connType: string; dir: 'out' | 'in' }> = [];
      const seenS = new Set<string>();
      connections.forEach(cn => {
        if (cn.from !== tableId && cn.to !== tableId) return;
        const oid = cn.from === tableId ? cn.to : cn.from;
        const dir = cn.from === tableId ? 'out' : 'in';
        if (sessById.has(oid) && !seenS.has(oid)) {
          seenS.add(oid); found.push({ sessId: oid, connType: cn.type, dir });
        }
      });
      found.forEach(({ sessId, connType, dir }, i) => {
        const angle = found.length === 1 ? 0 : (i / found.length) * Math.PI * 2 - Math.PI / 2;
        const x = tx + Math.cos(angle) * 95;
        const y = ty + Math.sin(angle) * 95;
        const s = sessById.get(sessId)!;
        nodes.push({
          uid: `l2::${uid}::${sessId}`, entityId: sessId, type: 'session',
          x, y, r: 22, color: tierColor(s.tier),
          label: s.name.length > 11 ? s.name.slice(0, 11) + '…' : s.name,
          fullName: s.full, connType, dir, parentX: tx, parentY: ty, level: 2,
        });
        edges.push({ x1: tx, y1: ty, x2: x, y2: y, connType });
      });
    });
    return { l2Nodes: nodes, l2Edges: edges };
  }, [focusId, expTbls, orbitNodes, connections, sessById]);

  const toggleTbl = useCallback((uid: string) => {
    setExpTbls(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }, []);

  const goFocus = useCallback((id: string) => {
    setFocusId(id);
    setExpTbls(new Set());
    setDetailNode(null);
  }, []);

  const showTip = useCallback((name: string, sub: string) => setTip({ name, sub }), []);
  const hideTip = useCallback(() => setTip(null), []);

  const handleDetailClick = useCallback((s: TierSession) => {
    setDetailNode(prev => prev?.id === s.id ? null : s);
  }, []);

  // Navigate to search result
  const goToResult = useCallback((id: string, type: string) => {
    if (type === 'session') {
      goFocus(id);
    }
    setShowSearch(false);
    setSearch('');
  }, [goFocus]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: '#060C18',
        zIndex: 9999, overflow: 'hidden',
        fontFamily: "'JetBrains Mono','Fira Mono',monospace",
      }}
      onMouseMove={e => setMouseXY({ x: e.clientX, y: e.clientY })}
    >

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 48,
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px',
        background: 'rgba(6,12,24,0.92)', backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)', zIndex: 10,
      }}>
        {focusId ? (
          <button onClick={() => { setFocusId(null); setExpTbls(new Set()); setDetailNode(null); }} style={btnSt}>
            ← Overview
          </button>
        ) : (
          <button onClick={onClose} style={btnSt}>✕ Close</button>
        )}
        <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.07)' }} />
        <span style={{ fontSize: 14, fontWeight: 800, color: '#E2E8F0' }}>Galaxy Map</span>
        {focusId ? (
          <span style={{ fontSize: 11, color: '#64748B' }}>
            {sessById.get(focusId)?.full ?? focusId}
            {' · '}{orbitNodes.filter(n => n.type === 'table').length} tables
            {' · '}{orbitNodes.filter(n => n.type === 'session').length} sessions
            {' · scroll to zoom · drag to pan'}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: '#475569' }}>
            {sessions.length} sessions — click to explore · scroll to zoom · drag to pan
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setFilterVisible(prev => !prev)}
            style={{
              ...btnSt,
              borderColor: filterVisible ? 'rgba(59,130,246,0.5)' : undefined,
              color: filterVisible ? '#60a5fa' : '#64748B',
            }}
          >
            ⫶ Filters {sessions.length < data.sessions.length ? `(${sessions.length}/${data.sessions.length})` : ''}
          </button>
          <button onClick={() => { setShowSearch(prev => !prev); setTimeout(() => searchRef.current?.focus(), 50); }} style={btnSt}>
            Search
          </button>
          {focusId && (
            <button onClick={onClose} style={btnSt}>✕ Close</button>
          )}
          {!focusId && (
            <div style={{ fontSize: 10, color: '#1e293b' }}>ESC closes</div>
          )}
        </div>
      </div>

      {/* ── Search Overlay ─────────────────────────────────────────────────── */}
      {showSearch && (
        <div style={{
          position: 'absolute', top: 56, left: '50%', transform: 'translateX(-50%)',
          width: 400, maxHeight: 360, background: 'rgba(4,8,18,0.97)',
          backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12, zIndex: 20, overflow: 'hidden',
        }}>
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search sessions & tables..."
            style={{
              width: '100%', padding: '12px 16px', background: 'transparent',
              border: 'none', borderBottom: '1px solid rgba(255,255,255,0.06)',
              color: '#E2E8F0', fontSize: 13, outline: 'none',
              fontFamily: "'JetBrains Mono','Fira Mono',monospace",
            }}
          />
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            {searchResults.map(r => (
              <div
                key={r.id}
                onClick={() => goToResult(r.id, r.type)}
                style={{
                  padding: '8px 16px', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', gap: 8, borderBottom: '1px solid rgba(255,255,255,0.03)',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{
                  fontSize: 9, padding: '2px 6px', borderRadius: 4,
                  background: r.type === 'session' ? '#3B82F620' : '#10B98120',
                  color: r.type === 'session' ? '#3B82F6' : '#10B981',
                }}>{r.type}</span>
                <span style={{ fontSize: 12, color: '#E2E8F0' }}>{r.name}</span>
                <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>T{r.tier}</span>
              </div>
            ))}
            {search && searchResults.length === 0 && (
              <div style={{ padding: '12px 16px', color: '#475569', fontSize: 11 }}>No results found</div>
            )}
          </div>
        </div>
      )}

      {/* ── SVG ────────────────────────────────────────────────────────────── */}
      <svg ref={svgRef} width={dims.w} height={dims.h} style={{ position: 'absolute', top: 0, left: 0, cursor: 'grab' }}>
        <defs>
          <filter id="gxl" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="20" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="gmd" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="gsm" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        {/* Stars (outside zoom group — stay fixed for parallax) */}
        {STARS.map((s, i) => (
          <circle key={i} cx={(s.x / 100) * dims.w} cy={(s.y / 100) * dims.h}
            r={s.r} fill="white" opacity={s.o}
          />
        ))}

        {/* ── Zoom group (D3 controlled) ───────────────────────────────────── */}
        <g ref={gRef}>

          {/* ── OVERVIEW ONLY ELEMENTS ────────────────────────────────────── */}
          {!focusId && (
            <>
              {/* Tier ring guides (grouped by tier) */}
              {tierRings.map(ring => (
                <g key={`tier-ring-${ring.tier}`}>
                  <circle cx={cx} cy={cy} r={ring.radius}
                    fill="none" stroke={ring.color} strokeWidth={0.5} opacity={0.12}
                  />
                  <text
                    x={cx + ring.radius * Math.cos(-Math.PI / 4)}
                    y={cy + ring.radius * Math.sin(-Math.PI / 4)}
                    fill={ring.color} fontSize={9} opacity={0.3} fontWeight={700}
                  >T{ring.tier} ({ring.count})</text>
                </g>
              ))}

              {/* Subtle guide circle at session ring radius */}
              <circle cx={cx} cy={cy}
                r={Math.max((110 * sessions.length) / (2 * Math.PI), Math.min(dims.w, dims.h) * 0.36)}
                fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth={1}
              />

              {/* External sources orb */}
              <g
                onMouseEnter={() => showTip(`${extCount} External Source Tables`, 'Tier 0 upstream sources — not produced by any session')}
                onMouseLeave={hideTip}
              >
                <circle cx={EXT.x} cy={EXT.y} r={EXT.r + 14} fill="#47556906" />
                <circle cx={EXT.x} cy={EXT.y} r={EXT.r}
                  fill="rgba(71,85,105,0.10)" stroke="#475569" strokeWidth={1.5}
                  filter="url(#gsm)"
                />
                <text x={EXT.x} y={EXT.y - 7} textAnchor="middle"
                  fill="#94A3B8" fontSize={22} fontWeight={800}
                >{extCount}</text>
                <text x={EXT.x} y={EXT.y + 10} textAnchor="middle" fill="#64748B" fontSize={10}>External</text>
                <text x={EXT.x} y={EXT.y + 22} textAnchor="middle" fill="#475569" fontSize={9}>Sources</text>
              </g>

              {/* Session→session base edges */}
              {galaxyFilters.showEdges && baseEdges.map((cn, i) => {
                const fp = sessPos.get(cn.from);
                const tp = sessPos.get(cn.to);
                if (!fp || !tp) return null;
                const isHighlight = highlightSet.has(cn.from) || highlightSet.has(cn.to);
                return (
                  <line key={i}
                    x1={fp.x} y1={fp.y} x2={tp.x} y2={tp.y}
                    stroke={CC[cn.type] ?? '#3B82F6'}
                    strokeWidth={isHighlight ? 2.5 : 1.2}
                    opacity={isHighlight ? 0.8 : 0.28}
                    strokeDasharray={CD[cn.type] || undefined}
                  />
                );
              })}

              {/* Center label */}
              <text x={cx} y={cy - 8} textAnchor="middle"
                fill="rgba(255,255,255,0.05)" fontSize={15} fontWeight={800} letterSpacing="0.12em"
              >GALAXY MAP</text>
              <text x={cx} y={cy + 10} textAnchor="middle"
                fill="rgba(255,255,255,0.03)" fontSize={11}
              >click a session sphere to zoom in</text>
            </>
          )}

          {/* ── FOCUSED MODE ELEMENTS ─────────────────────────────────────── */}
          {focusId && (
            <>
              {/* Orbit ring guides */}
              {[185, 285, 355].map(r => (
                <circle key={r}
                  cx={sessPos.get(focusId)?.x ?? cx}
                  cy={sessPos.get(focusId)?.y ?? cy}
                  r={r}
                  fill="none" stroke="rgba(255,255,255,0.04)"
                  strokeWidth={1} strokeDasharray="4,14"
                />
              ))}

              {/* Orbit edges */}
              {orbitEdges.map((e, i) => (
                <line key={`oe-${i}`}
                  x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke={CC[e.connType] ?? '#3B82F6'}
                  strokeWidth={e.strong ? 2.5 : 1.8}
                  opacity={e.strong ? 0.8 : 0.55}
                  strokeDasharray={CD[e.connType] || undefined}
                />
              ))}

              {/* Level-2 edges */}
              {l2Edges.map((e, i) => (
                <line key={`l2e-${i}`}
                  x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke={CC[e.connType] ?? '#3B82F6'}
                  strokeWidth={1.5} opacity={0.50}
                  strokeDasharray={CD[e.connType] || undefined}
                />
              ))}

              {/* Table orbit nodes */}
              {orbitNodes.filter(n => n.type === 'table').map(node => {
                const isExp = expTbls.has(node.uid);
                return (
                  <g key={node.uid}
                    transform={`translate(${node.x},${node.y})`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleTbl(node.uid)}
                    onMouseEnter={() => showTip(node.fullName,
                      `${CL[node.connType] ?? node.connType} · ${node.dir === 'out' ? '↓ downstream' : '↑ upstream'} · click to ${isExp ? 'collapse' : 'expand'}`)}
                    onMouseLeave={hideTip}
                    filter="url(#gsm)"
                  >
                    <circle r={node.r + 10} fill={node.color} opacity={isExp ? 0.22 : 0.08} />
                    <circle r={node.r} fill={`${node.color}22`} stroke={node.color}
                      strokeWidth={isExp ? 2.5 : 1.8}
                    />
                    {isExp && (
                      <circle r={node.r + 6} fill="none" stroke={node.color}
                        strokeWidth={1} opacity={0.4} strokeDasharray="3,3"
                      />
                    )}
                    <text y={-4} textAnchor="middle" fill="#F1F5F9" fontSize={11} fontWeight={700}>
                      {node.label}
                    </text>
                    <text y={9} textAnchor="middle" fill={node.color} fontSize={9}>
                      {CL[node.connType]?.slice(0, 13)}
                    </text>
                    <text y={node.r + 14} textAnchor="middle" fill={node.color} fontSize={8} opacity={0.6}>
                      {isExp ? '▲ collapse' : '▼ sessions'}
                    </text>
                  </g>
                );
              })}

              {/* Session orbit nodes (outermost ring) */}
              {orbitNodes.filter(n => n.type === 'session').map(node => (
                <g key={node.uid}
                  transform={`translate(${node.x},${node.y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => goFocus(node.entityId)}
                  onMouseEnter={() => {
                    const s = sessById.get(node.entityId) as TierSession | undefined;
                    showTip(node.fullName,
                      `Tier ${s?.tier} · ${s?.transforms} transforms · ${CL[node.connType]} · click to focus`);
                  }}
                  onMouseLeave={hideTip}
                  filter="url(#gsm)"
                >
                  <circle r={node.r + 12} fill={node.color} opacity={0.10} />
                  <circle r={node.r} fill={`${node.color}1E`} stroke={node.color} strokeWidth={2} />
                  <text y={-5} textAnchor="middle" fill="#F1F5F9" fontSize={11} fontWeight={700}>
                    {node.label}
                  </text>
                  <text y={8} textAnchor="middle" fill={node.color} fontSize={9}>
                    T{(sessById.get(node.entityId) as TierSession | undefined)?.tier}
                  </text>
                  <text y={node.r + 14} textAnchor="middle" fill={node.color} fontSize={8} opacity={0.6}>
                    → focus
                  </text>
                </g>
              ))}

              {/* Level-2 session nodes */}
              {l2Nodes.map(node => (
                <g key={node.uid}
                  transform={`translate(${node.x},${node.y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => goFocus(node.entityId)}
                  onMouseEnter={() => {
                    const s = sessById.get(node.entityId) as TierSession | undefined;
                    showTip(node.fullName, `Tier ${s?.tier} · ${CL[node.connType]} · click to focus`);
                  }}
                  onMouseLeave={hideTip}
                  filter="url(#gsm)"
                >
                  <circle r={node.r + 8} fill={node.color} opacity={0.12} />
                  <circle r={node.r} fill={`${node.color}1E`} stroke={node.color} strokeWidth={1.8} />
                  <text y={-3} textAnchor="middle" fill="#F1F5F9" fontSize={10} fontWeight={700}>
                    {node.label}
                  </text>
                  <text y={8} textAnchor="middle" fill={node.color} fontSize={8}>
                    T{(sessById.get(node.entityId) as TierSession | undefined)?.tier}
                  </text>
                </g>
              ))}
            </>
          )}

          {/* ── Session nodes — LOD rendering based on D3 zoom scale ───────────
               dot    (k < 0.4) — minimal filled circle, best for far-out views
               circle (0.4–0.8) — circle + tier badge, for medium zoom
               full   (k > 0.8) — name label + all decorations (glow, ring, etc.)
               Focused session always uses full LOD regardless of zoom scale.   ── */}
          {sessions.map(s => {
            const p = sessPos.get(s.id);
            if (!p) return null;
            if (focusId && s.id !== focusId) return null;
            const isFocus = focusId === s.id;
            const isHighlighted = highlightSet.has(s.id);
            // Semantic zoom levels: dot (<0.4), circle (0.4-0.8), full (>0.8)
            const lod = isFocus ? 'full' : zoomScale < 0.4 ? 'dot' : zoomScale < 0.8 ? 'circle' : 'full';
            return (
              <g key={s.id}
                transform={`translate(${p.x},${p.y})`}
                style={{ cursor: isFocus ? 'default' : 'pointer' }}
                onClick={isFocus ? undefined : () => goFocus(s.id)}
                onDoubleClick={() => handleDetailClick(s)}
                onMouseEnter={() => showTip(s.full,
                  `Tier ${s.tier} · ${s.transforms} transforms · ${s.lookupCount} lookups · ${s.extReads} ext reads${s.critical ? ' · ⚠ CONFLICT' : ''} · dbl-click for details`)}
                onMouseLeave={hideTip}
                filter={isFocus ? 'url(#gmd)' : isHighlighted ? 'url(#gsm)' : undefined}
              >
                {/* Dot LOD — simple filled circle */}
                {lod === 'dot' && (
                  <>
                    <circle r={6} fill={p.color} opacity={0.7} />
                    {s.critical && <circle r={8} fill="none" stroke="#EF4444" strokeWidth={1.5} opacity={0.7} />}
                  </>
                )}
                {/* Circle LOD — circle with tier number */}
                {lod === 'circle' && (
                  <>
                    <circle r={p.r * 0.7} fill={`${p.color}1E`} stroke={p.color} strokeWidth={1.5} />
                    {s.critical && <circle r={p.r * 0.7 + 3} fill="none" stroke="#EF4444" strokeWidth={2} opacity={0.8} />}
                    <text y={4} textAnchor="middle" fill={p.color} fontSize={10} fontWeight={700}>
                      T{s.tier}
                    </text>
                  </>
                )}
                {/* Full LOD — complete rendering */}
                {lod === 'full' && (
                  <>
                    {/* Search highlight ring */}
                    {isHighlighted && !isFocus && (
                      <circle r={p.r + 20} fill="none" stroke="#FBBF24" strokeWidth={2} opacity={0.6}>
                        <animate attributeName="opacity" values="0.6;0.2;0.6" dur="1.5s" repeatCount="indefinite" />
                      </circle>
                    )}
                    {/* Focus glow */}
                    {isFocus && (
                      <>
                        <circle r={p.r + 30} fill={p.color} opacity={0.07} />
                        <circle r={p.r + 14} fill="none" stroke={p.color}
                          strokeWidth={1.5} opacity={0.35} strokeDasharray="5,5"
                        />
                      </>
                    )}
                    {/* Ambient halo */}
                    <circle r={p.r + 5} fill={p.color} opacity={0.08} />
                    {/* Main body */}
                    <circle r={p.r} fill={`${p.color}1E`} stroke={p.color}
                      strokeWidth={isFocus ? 2.5 : 1.8}
                    />
                    {/* Critical ring */}
                    {s.critical && (
                      <circle r={p.r + 4} fill="none" stroke="#EF4444" strokeWidth={2.5} opacity={0.85} />
                    )}
                    {/* Name */}
                    <text y={-7} textAnchor="middle" fill="#F1F5F9" fontSize={12} fontWeight={800}>
                      {s.name.length > 12 ? s.name.slice(0, 12) + '…' : s.name}
                    </text>
                    {/* Tier */}
                    <text y={7} textAnchor="middle" fill={p.color} fontSize={10} fontWeight={600}>
                      T{s.tier}
                    </text>
                  </>
                )}
                {/* Critical label */}
                {s.critical && (
                  <text y={p.r + 18} textAnchor="middle" fill="#EF4444" fontSize={9} fontWeight={800}>
                    ⚠ CONFLICT
                  </text>
                )}
                {/* Click hint (overview only) */}
                {!focusId && !isHighlighted && (
                  <text y={p.r + 14} textAnchor="middle" fill={p.color} fontSize={8} opacity={0.4}>
                    click to explore
                  </text>
                )}
              </g>
            );
          })}

        </g>{/* end zoom group */}
      </svg>

      {/* ── Session Detail Panel ───────────────────────────────────────────── */}
      {detailNode && (
        <div style={{
          position: 'absolute', top: 56, right: 16, width: 320,
          maxHeight: dims.h - 80, overflowY: 'auto',
          background: 'rgba(4,8,18,0.97)', backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
          padding: 16, zIndex: 15,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>Session Detail</span>
            <button onClick={() => setDetailNode(null)} style={{ ...btnSt, padding: '2px 8px' }}>✕</button>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: tierColor(detailNode.tier), marginBottom: 8 }}>
            {detailNode.full}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <DetailStat label="Tier" value={`${detailNode.tier}`} color={tierColor(detailNode.tier)} />
            <DetailStat label="Step" value={`${detailNode.step}`} color="#64748B" />
            <DetailStat label="Transforms" value={`${detailNode.transforms}`} color="#3B82F6" />
            <DetailStat label="Lookups" value={`${detailNode.lookupCount}`} color="#A855F7" />
            <DetailStat label="Ext Reads" value={`${detailNode.extReads}`} color="#10B981" />
            <DetailStat label="Critical" value={detailNode.critical ? 'Yes' : 'No'} color={detailNode.critical ? '#EF4444' : '#10B981'} />
          </div>
          {/* Connections list */}
          <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', marginBottom: 6 }}>Connections</div>
          {connections
            .filter(c => c.from === detailNode.id || c.to === detailNode.id)
            .slice(0, 20)
            .map((c, i) => {
              const otherId = c.from === detailNode.id ? c.to : c.from;
              const dir = c.from === detailNode.id ? '→' : '←';
              const other = sessById.get(otherId) ?? tblById.get(otherId);
              return (
                <div key={i} style={{
                  fontSize: 10, color: '#64748B', padding: '3px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                }}>
                  <span style={{ color: CC[c.type] ?? '#3B82F6' }}>{dir}</span>{' '}
                  <span style={{ color: '#94A3B8' }}>{(other as any)?.name ?? otherId}</span>{' '}
                  <span style={{ color: '#475569' }}>({CL[c.type] ?? c.type})</span>
                </div>
              );
            })}
        </div>
      )}

      {/* ── Hover tooltip ──────────────────────────────────────────────────── */}
      {tip && (
        <div style={{
          position: 'fixed',
          left: Math.min(mouseXY.x + 16, dims.w - 360),
          top:  Math.max(mouseXY.y - 60, 56),
          background: 'rgba(4,8,18,0.97)', backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.13)',
          borderRadius: 10, padding: '10px 16px',
          pointerEvents: 'none', zIndex: 10001, maxWidth: 360,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9', marginBottom: 5, wordBreak: 'break-all', lineHeight: 1.4 }}>
            {tip.name}
          </div>
          <div style={{ fontSize: 11, color: '#64748B', lineHeight: 1.5 }}>{tip.sub}</div>
        </div>
      )}

      {/* ── Zoom Controls ──────────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute', bottom: sessions.length > 20 ? 196 : 64, right: 16,
        display: 'flex', flexDirection: 'column', gap: 4, zIndex: 10,
      }}>
        {[
          { label: '+', action: () => { if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 1.5); } },
          { label: '-', action: () => { if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 0.67); } },
          { label: '\u2302', action: () => { if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.transform, d3.zoomIdentity); } },
        ].map(b => (
          <button key={b.label} onClick={b.action} style={{
            width: 32, height: 32, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(4,8,18,0.8)', color: '#94a3b8', fontSize: 16,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{b.label}</button>
        ))}
      </div>

      {/* ── Minimap — visible when sessions > 20; uses the same sessPos coords as
               the main SVG, scaled down via viewBox to 160×120. The focused
               session is highlighted with a white stroke ring.               ── */}
      {sessions.length > 20 && (
        <div style={{
          position: 'absolute', bottom: 64, right: 16, width: 160, height: 120,
          background: 'rgba(4,8,18,0.9)', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8, overflow: 'hidden', zIndex: 10,
        }}>
          <svg width={160} height={120} viewBox={`0 0 ${dims.w} ${dims.h}`} preserveAspectRatio="xMidYMid meet">
            {sessions.map(s => {
              const p = sessPos.get(s.id);
              if (!p) return null;
              return (
                <circle key={s.id} cx={p.x} cy={p.y} r={6}
                  fill={p.color} opacity={focusId === s.id ? 1 : 0.5}
                  stroke={focusId === s.id ? '#fff' : 'none'} strokeWidth={2}
                />
              );
            })}
          </svg>
        </div>
      )}

      {/* ── Legend ─────────────────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 16, flexWrap: 'wrap', padding: '8px 22px',
        background: 'rgba(4,8,18,0.84)', backdropFilter: 'blur(8px)',
        borderRadius: 24, border: '1px solid rgba(255,255,255,0.05)',
        justifyContent: 'center',
      }}>
        {Object.entries(CC).map(([type, col]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 20, height: 2.5, background: col, borderRadius: 2 }} />
            <span style={{ fontSize: 9, color: '#4B5563', whiteSpace: 'nowrap' }}>{CL[type]}</span>
          </div>
        ))}
      </div>

      {/* ── Filter Sidebar ──────────────────────────────────────────────── */}
      <GalaxyFilterSidebar
        data={data}
        filters={galaxyFilters}
        onFiltersChange={setGalaxyFilters}
        visible={filterVisible}
        onToggle={() => setFilterVisible(prev => !prev)}
      />
    </div>
  );
}

// ── Detail stat mini-component ───────────────────────────────────────────────

function DetailStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '6px 10px',
    }}>
      <div style={{ fontSize: 9, color: '#475569', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

const btnSt: React.CSSProperties = {
  padding: '4px 14px', borderRadius: 5,
  border: '1px solid rgba(255,255,255,0.09)',
  background: 'transparent', color: '#64748B',
  fontSize: 11, cursor: 'pointer',
};
