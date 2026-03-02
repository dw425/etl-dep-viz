# Infrastructure View (L1A) — Upgrade Tracking

## Status: Complete

## Changes Made

### 1. Fix Edges + Data Lineage Arrows
- **Bug fixed:** `edgeMap` was declared but never populated — edges always empty
- Edges now derived from session source/target flows
- Connection-profile mode: maps via `connections_used` to systems
- Fallback mode: maps tables via `inferSystem()`
- Directed edges with arrowheads (triangle at target end)
- Bidirectional edges (A->B and B->A) merged with arrowheads at both ends
- Colors: directed = `#475569`, bidirectional = `#F59E0B`

### 2. Connection Sub-Nodes
- All Oracle connections aggregate into one "oracle" node (not `oracle_CONNNAME`)
- Individual connections stored as `sub_nodes[]` on each SystemNode
- Session counts tracked per sub-node
- Left sidebar expands to show connection names (capped at 8 + "+N more")

### 3. Parse Connection Strings
- `parseConnectionString()` extracts host/port/database from stored connection strings
- Handles JDBC Oracle, generic JDBC, simple host:port/db, host:port-only patterns
- Parsed info displayed in Connections tab of detail panel

### 4. Drill-Through Detail Panel
- Replaced basic right panel with 4-tab panel: Overview | Sessions | Tables | Connections
- **Overview:** Stats grid + connected systems with directional arrows
- **Sessions:** Sessions touching system, clickable to navigate to FlowWalker
- **Tables:** Schema-grouped tables when raw names available, flat list fallback
- **Connections:** Sub-nodes with parsed connection strings, dbtype badges
- `onNavigateView` prop for drill-through navigation

### 5. Schema-Level Grouping
- **Backend:** Preserved raw table names (`raw_sources`, `raw_targets`, `raw_lookups`) before normalization
- **Frontend:** Parse `OWNER.TABLE` patterns, group by schema in Tables tab
- Collapsible schema headers with table lists

### 6. Component Extraction
```
frontend/src/layers/
  L1A_InfrastructureTopology.tsx    — Orchestrator (state, data transform, layout)
  infra/
    InfraCanvas.tsx                 — Canvas rendering + hit-testing + arrows
    InfraDetailPanel.tsx            — Right panel with tabs
    infraUtils.ts                   — parseConnectionString, inferSystem, mapDbType*, groupBySchema
```

## Files Modified

| File | Changes |
|------|---------|
| `frontend/src/layers/L1A_InfrastructureTopology.tsx` | Rewritten: orchestrator with fixed edges, sub-nodes, delegated rendering |
| `frontend/src/layers/infra/InfraCanvas.tsx` | New: canvas rendering with directional arrows |
| `frontend/src/layers/infra/InfraDetailPanel.tsx` | New: tabbed detail panel (Overview/Sessions/Tables/Connections) |
| `frontend/src/layers/infra/infraUtils.ts` | New: utility functions, types, constants |
| `frontend/src/components/tiermap/DependencyApp.tsx` | Pass `onNavigateView` prop to L1A |
| `backend/app/engines/infa_engine.py` | Preserve raw table names before normalization |
