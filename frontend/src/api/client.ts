/**
 * API client for ETL Dependency Visualizer.
 *
 * All functions call the FastAPI backend at BASE = '/api' (proxied from :3000 → :8000 in dev).
 * Sections (in order):
 *   User ID management
 *   Upload & analyze (tier-map, constellation, SSE stream, recluster)
 *   Persistence (list/get/delete uploads, paginated sessions)
 *   Vector analysis (analyze, cache, stream, wave plan, complexity, what-if, incremental, sweep)
 *   Layer data (L1–L4 progressive disclosure)
 *   Active tags (CRUD, batch, color update)
 *   User profile & activity log
 *   Health & logs
 *   Flow Walker
 *   Lineage (graph, forward/backward trace, table lineage, column lineage, impact)
 *   Export downloads (Excel, DOT, Mermaid, Jira CSV, Databricks, Snapshot, Merge)
 *   AI Chat (index, query, search, status)
 *   Error reporting (reportError, installGlobalErrorHandler)
 *   Extended health check (getHealth, getErrorAggregation)
 */

import type { TierMapResult, ConstellationResult, AlgorithmKey } from '../types/tiermap';
import type { VectorResults, WavePlan, ComplexityResult, WhatIfResult, L1Data, ActiveTag } from '../types/vectors';

const BASE = '/api';

// ── User ID management ────────────────────────────────────────────────────
// A UUID is generated on first visit and stored in localStorage so the user's
// upload history persists across sessions without requiring auth.

// Returns the persistent user UUID, creating one if it doesn't exist yet
export function getUserId(): string {
  let id = localStorage.getItem('edv-user-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('edv-user-id', id);
  }
  return id;
}

// Convenience: builds the X-User-Id header used by endpoints that track ownership
export function userHeaders(): Record<string, string> {
  return { 'X-User-Id': getUserId() };
}

// ── Upload & analyze ──────────────────────────────────────────────────────

// Parses files and returns a tier-map result synchronously (non-streaming)
export async function analyzeTierMap(files: File[], projectId?: number): Promise<TierMapResult & { upload_id?: number }> {
  const form = new FormData();
  files.forEach(f => form.append('files', f));
  const params = projectId ? `?project_id=${projectId}` : '';
  const res = await fetch(`${BASE}/tier-map/analyze${params}`, { method: 'POST', body: form, headers: userHeaders() });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// Parses files and clusters sessions in one call; returns tier data + constellation
export async function analyzeConstellation(
  files: File[],
  algorithm: AlgorithmKey = 'louvain',
  projectId?: number,
): Promise<{ upload_id?: number; tier_data: TierMapResult; constellation: ConstellationResult }> {
  const form = new FormData();
  files.forEach(f => form.append('files', f));
  const params = new URLSearchParams({ algorithm });
  if (projectId) params.set('project_id', String(projectId));
  const res = await fetch(`${BASE}/tier-map/constellation?${params}`, {
    method: 'POST',
    body: form,
    headers: userHeaders(),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── SSE streaming upload ──────────────────────────────────────────────────
// Preferred for production: yields progress events so the UI shows granular
// step-by-step feedback (extracting → parsing → clustering → complete).
// Returns an AbortController so the caller can cancel the in-flight request.

export interface StreamEvent {
  phase: 'extracting' | 'parsing' | 'clustering' | 'complete' | 'error' | 'timeout';
  current?: number;
  total?: number;
  filename?: string;
  percent?: number;
  message?: string;
  elapsed_ms?: number;
  eta_ms?: number;
  sessions_found?: number;
  file_size_mb?: number;
  total_size_mb?: number;
  result?: { upload_id?: number; tier_data: TierMapResult; constellation: ConstellationResult };
}

export function analyzeConstellationStream(
  files: File[],
  algorithm: AlgorithmKey = 'louvain',
  onEvent: (event: StreamEvent) => void,
  projectId?: number,
): AbortController {
  const ctrl = new AbortController();
  const form = new FormData();
  files.forEach(f => form.append('files', f));

  const params = new URLSearchParams({ algorithm });
  if (projectId) params.set('project_id', String(projectId));
  fetch(`${BASE}/tier-map/constellation-stream?${params}`, {
    method: 'POST',
    body: form,
    signal: ctrl.signal,
    headers: userHeaders(),
  }).then(async res => {
    if (!res.ok) {
      onEvent({ phase: 'error', message: (await res.json()).detail || res.statusText });
      return;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE wire format: "data: {json}\n\n" — split on double-newline, strip "data:" prefix
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || ''; // keep incomplete chunk for next iteration

      for (const line of lines) {
        const trimmed = line.replace(/^data:\s*/, '').trim();
        if (!trimmed) continue;
        try {
          const event: StreamEvent = JSON.parse(trimmed);
          onEvent(event);
          if (event.phase === 'complete' || event.phase === 'error') return;
        } catch { /* skip malformed frames */ }
      }
    }
  }).catch(err => {
    if (err.name !== 'AbortError') {
      onEvent({ phase: 'error', message: err.message });
    }
  });

  return ctrl;
}

// ── Recluster (no re-upload) ──────────────────────────────────────────────
// Re-runs clustering on already-stored tier data using a different algorithm
// without requiring the user to re-upload their files.

export async function recluster(
  tierData: TierMapResult,
  algorithm: AlgorithmKey,
): Promise<{ tier_data: TierMapResult; constellation: ConstellationResult }> {
  const res = await fetch(`${BASE}/tier-map/recluster?algorithm=${algorithm}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Algorithm list ────────────────────────────────────────────────────────
// Returns all available clustering algorithms and their human-readable descriptions
export async function getAlgorithms(): Promise<Record<string, { name: string; desc: string }>> {
  const res = await fetch(`${BASE}/tier-map/algorithms`);
  if (!res.ok) throw new Error(res.statusText);
  const data = await res.json();
  return data.algorithms;
}

// ── Persistence endpoints ─────────────────────────────────────────────────
// SQLite-backed upload history; allows restoring a previous analysis without re-parsing

export interface UploadSummary {
  id: number;
  filename: string;
  platform: string;
  session_count: number;
  algorithm: string | null;
  parse_duration_ms: number | null;
  project_id: number | null;
  created_at: string | null;
}

export async function listUploads(limit = 20): Promise<UploadSummary[]> {
  const res = await fetch(`${BASE}/tier-map/uploads?limit=${limit}`, { headers: userHeaders() });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function getUpload(uploadId: number): Promise<{
  upload_id: number;
  tier_data: TierMapResult;
  constellation?: ConstellationResult;
  vector_results?: VectorResults;
  filename: string;
  platform: string;
  session_count: number;
  algorithm: string | null;
  created_at: string | null;
}> {
  const res = await fetch(`${BASE}/tier-map/uploads/${uploadId}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function deleteUpload(uploadId: number): Promise<void> {
  const res = await fetch(`${BASE}/tier-map/uploads/${uploadId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(res.statusText);
}

// ── Vector Analysis ──────────────────────────────────────────────────────
// 11 vector engines run in 3 phases: Core (phase=1) → Advanced (phase=2) → Ensemble (phase=3)
// upload_id is optional; when provided the backend can cache results by upload

export async function analyzeVectors(
  tierData: TierMapResult,
  phase: 1 | 2 | 3 = 1,
  uploadId?: number,
): Promise<VectorResults> {
  const params = new URLSearchParams({ phase: String(phase) });
  if (uploadId) params.set('upload_id', String(uploadId));
  const res = await fetch(`${BASE}/vectors/analyze?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// Returns null on 404 (no cached results yet) without throwing
export async function getCachedVectors(uploadId: number): Promise<VectorResults | null> {
  const res = await fetch(`${BASE}/vectors/results/${uploadId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export interface VectorStreamEvent {
  phase: string;
  percent?: number;
  message?: string;
  result?: VectorResults;
}

// SSE-streaming variant of analyzeVectors — emits progress events for each engine
export function analyzeVectorsStream(
  tierData: TierMapResult,
  uploadId: number | undefined,
  onEvent: (event: VectorStreamEvent) => void,
): AbortController {
  const ctrl = new AbortController();
  const params = new URLSearchParams();
  if (uploadId) params.set('upload_id', String(uploadId));

  fetch(`${BASE}/vectors/analyze-stream?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
    signal: ctrl.signal,
  }).then(async res => {
    if (!res.ok) {
      onEvent({ phase: 'error', message: (await res.json()).detail || res.statusText });
      return;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.replace(/^data:\s*/, '').trim();
        if (!trimmed) continue;
        try {
          onEvent(JSON.parse(trimmed));
        } catch { /* skip malformed */ }
      }
    }
  }).catch(err => {
    if (err.name !== 'AbortError') onEvent({ phase: 'error', message: err.message });
  });
  return ctrl;
}

// Standalone wave plan endpoint (bypasses full vector pipeline)
export async function getWavePlan(tierData: TierMapResult): Promise<WavePlan> {
  const res = await fetch(`${BASE}/vectors/wave-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function getComplexity(tierData: TierMapResult): Promise<ComplexityResult> {
  const res = await fetch(`${BASE}/vectors/complexity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// Simulates the impact of removing/changing sessionId on downstream ripple chains
export async function whatIfSimulation(tierData: TierMapResult, sessionId: string): Promise<WhatIfResult> {
  const res = await fetch(`${BASE}/vectors/what-if/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Layer Data ────────────────────────────────────────────────────────────
// 6-layer progressive disclosure: L1 (enterprise) → L6 (object detail).
// Only L1–L4 have dedicated endpoints; L5/L6 are derived client-side.

export async function getL1Data(tierData: TierMapResult): Promise<L1Data> {
  const res = await fetch(`${BASE}/layers/L1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// L2: drills into a single cluster/group from the L1 overview
export async function getL2Data(tierData: TierMapResult, groupId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/layers/L2/${groupId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function getL3Data(tierData: TierMapResult, groupId: string, scopeType: string, scopeId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/layers/L3/${groupId}/${scopeType}/${scopeId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function getL4Data(tierData: TierMapResult, sessionId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/layers/L4/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Active Tags ───────────────────────────────────────────────────────────
// User-defined labels attached to sessions, tables, or clusters.
// Stored in the active_tags SQLite table; retrieved per-object or listed globally.

export async function createActiveTag(data: {
  object_id: string;
  object_type: string;
  tag_type: string;
  label: string;
  color?: string;
  note?: string;
}): Promise<ActiveTag> {
  const res = await fetch(`${BASE}/active-tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function getActiveTags(objectId: string): Promise<ActiveTag[]> {
  const res = await fetch(`${BASE}/active-tags/${objectId}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function deleteActiveTag(tagId: string): Promise<void> {
  const res = await fetch(`${BASE}/active-tags/${tagId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(res.statusText);
}

export async function listAllActiveTags(params?: { object_type?: string; tag_type?: string }): Promise<ActiveTag[]> {
  const qs = new URLSearchParams();
  if (params?.object_type) qs.set('object_type', params.object_type);
  if (params?.tag_type) qs.set('tag_type', params.tag_type);
  const q = qs.toString();
  const res = await fetch(`${BASE}/active-tags${q ? '?' + q : ''}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

// ── User Profile & Activity ──────────────────────────────────────────────
// User records are keyed by the localStorage UUID; activity events are fire-and-forget.

export async function upsertUser(displayName?: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: getUserId(), display_name: displayName || '' }),
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function getUser(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/users/${getUserId()}`);
  if (res.status === 404) return { user_id: getUserId(), display_name: '', upload_count: 0, total_sessions: 0 };
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function getUserUploads(limit = 50): Promise<UploadSummary[]> {
  const res = await fetch(`${BASE}/users/${getUserId()}/uploads?limit=${limit}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function getUserActivity(limit = 50): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${BASE}/users/${getUserId()}/activity?limit=${limit}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

// Fire-and-forget activity event; failures are silently swallowed
export async function logActivity(
  action: string,
  targetFilename?: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await fetch(`${BASE}/users/${getUserId()}/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, target_filename: targetFilename, details }),
  }).catch(() => {}); // intentionally fire-and-forget
}

// ── Health / Logs ─────────────────────────────────────────────────────────
// Reads from the in-memory ring buffer log handler (last N entries by level)

export interface LogEntry {
  timestamp: string;
  level: string;
  logger: string;
  message: string;
  extra: Record<string, unknown>;
}

export async function getHealthLogs(limit = 50, level?: string): Promise<LogEntry[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (level) params.set('level', level);
  const res = await fetch(`${BASE}/health/logs?${params}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

// ── Flow Walker ───────────────────────────────────────────────────────────
// Returns upstream/downstream chains, mapping detail (instances + connectors + fields),
// tables touched, complexity score, wave info, and SCC membership for a session.

export async function getFlowData(
  tierData: TierMapResult,
  sessionId: string,
  uploadId?: number | null,
): Promise<Record<string, unknown>> {
  // When upload_id is available, use query param instead of sending the full tier_data body
  // This avoids transmitting 15MB+ JSON for large datasets
  const params = uploadId ? `?upload_id=${uploadId}` : '';
  const res = await fetch(`${BASE}/layers/flow/${sessionId}${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: uploadId ? '{}' : JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Lineage API ───────────────────────────────────────────────────────────
// Graph-level and hop-limited forward/backward tracing; also per-table and per-column.

export async function getLineageGraph(
  tierData: TierMapResult,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/lineage/graph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// Traces downstream from nodeId up to maxHops edges
export async function traceLineageForward(
  tierData: TierMapResult,
  nodeId: string,
  maxHops: number = 20,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/lineage/trace/forward/${nodeId}?max_hops=${maxHops}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// Traces upstream from nodeId up to maxHops edges
export async function traceLineageBackward(
  tierData: TierMapResult,
  nodeId: string,
  maxHops: number = 20,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/lineage/trace/backward/${nodeId}?max_hops=${maxHops}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function getTableLineage(
  tierData: TierMapResult,
  tableName: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/lineage/table/${encodeURIComponent(tableName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Column Lineage ────────────────────────────────────────────────────────
// Field-level lineage derived from the deep Informatica connector parse

export async function getColumnLineage(
  tierData: TierMapResult,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/lineage/columns/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Impact Analysis ───────────────────────────────────────────────────────
// Returns all downstream sessions/tables affected if sessionId were to change

export async function getImpactAnalysis(
  tierData: TierMapResult,
  sessionId: string,
  maxHops: number = 10,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/lineage/impact/${sessionId}?max_hops=${maxHops}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Vector Sweep ──────────────────────────────────────────────────────────
// Runs all vector engines at multiple resolution levels and returns a comparison matrix

export async function sweepResolution(
  tierData: TierMapResult,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/vectors/sweep-resolution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Incremental Vector Analysis ───────────────────────────────────────────
// Runs only the specified vector engines (by id, e.g. ["V1","V4"]) instead of all 11

export async function analyzeVectorsIncremental(
  tierData: TierMapResult,
  vectors: string[],
  uploadId?: number,
): Promise<VectorResults> {
  const params = new URLSearchParams();
  vectors.forEach(v => params.append('vectors', v));
  if (uploadId) params.set('upload_id', String(uploadId));
  const res = await fetch(`${BASE}/vectors/analyze-incremental?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Tag Color Presets ─────────────────────────────────────────────────────
// PATCHes only the color field of an existing tag without touching other properties

export async function updateTagColor(
  tagId: string,
  color: string,
): Promise<void> {
  const res = await fetch(`${BASE}/active-tags/${tagId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color }),
  });
  if (!res.ok) throw new Error(res.statusText);
}

// ── Batch Tag Operations ──────────────────────────────────────────────────
// Applies the same tag to multiple object IDs in parallel via Promise.all

export async function batchCreateTags(
  objectIds: string[],
  tag: { object_type: string; tag_type: string; label: string; color?: string; note?: string },
): Promise<void> {
  await Promise.all(objectIds.map(id =>
    createActiveTag({ ...tag, object_id: id })
  ));
}

// ── Export Downloads ──────────────────────────────────────────────────────
// All export functions return either a Blob (binary) or string (text) for the caller to save

export async function exportExcel(
  tierData: TierMapResult,
  uploadId?: number,
): Promise<Blob> {
  const params = new URLSearchParams();
  if (uploadId) params.set('upload_id', String(uploadId));
  const res = await fetch(`${BASE}/exports/excel?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.blob();
}

export async function exportLineageDot(tierData: TierMapResult): Promise<string> {
  const res = await fetch(`${BASE}/exports/lineage/dot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.text();
}

export async function exportLineageMermaid(tierData: TierMapResult): Promise<string> {
  const res = await fetch(`${BASE}/exports/lineage/mermaid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.text();
}

export async function exportJiraCsv(tierData: TierMapResult, uploadId?: number): Promise<string> {
  const params = new URLSearchParams();
  if (uploadId) params.set('upload_id', String(uploadId));
  const res = await fetch(`${BASE}/exports/jira/csv?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.text();
}

export async function exportDatabricks(tierData: TierMapResult): Promise<string> {
  const res = await fetch(`${BASE}/exports/databricks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.text();
}

export async function exportSnapshot(tierData: TierMapResult, uploadId?: number): Promise<Blob> {
  const params = new URLSearchParams();
  if (uploadId) params.set('upload_id', String(uploadId));
  const res = await fetch(`${BASE}/exports/snapshot?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.blob();
}

export async function mergeUploads(uploadIds: number[]): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/exports/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(uploadIds),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── AI Chat API ───────────────────────────────────────────────────────────
// Requires the upload to be indexed first (chatIndexUpload); then supports
// conversational Q&A (chatQuery) and semantic search (chatSearch) over the ETL graph.

export async function chatIndexUpload(uploadId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/chat/index/${uploadId}`, {
    method: 'POST',
    headers: userHeaders(),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function chatQuery(
  uploadId: number,
  question: string,
  conversationHistory: { role: string; content: string }[] = [],
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/chat/${uploadId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify({ question, conversation_history: conversationHistory }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function chatSearch(
  uploadId: number,
  query: string,
  docType?: string,
  nResults: number = 10,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/chat/${uploadId}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify({ query, doc_type: docType, n_results: nResults }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function chatIndexStatus(uploadId: number): Promise<{ indexed: boolean; document_count: number }> {
  const res = await fetch(`${BASE}/chat/${uploadId}/status`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function chatReindex(uploadId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/chat/reindex/${uploadId}`, {
    method: 'POST',
    headers: userHeaders(),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Frontend Error Reporting ──────────────────────────────────────────────
// reportError sends client-side errors to the backend for centralized logging.
// installGlobalErrorHandler should be called once at app startup.

export async function reportError(error: {
  type?: string;
  message: string;
  stack?: string;
  url?: string;
  code?: string;
  severity?: 'warning' | 'error' | 'critical';
}): Promise<void> {
  try {
    await fetch(`${BASE}/health/report-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...error,
        user_id: getUserId(),
        url: error.url || window.location.href,
      }),
    });
  } catch {
    // fire-and-forget — don't throw on reporting failure
  }
}

// Global error handler — captures unhandled errors and promise rejections
let _errorHandlerInstalled = false;

export function installGlobalErrorHandler(): void {
  if (_errorHandlerInstalled) return;
  _errorHandlerInstalled = true;

  window.addEventListener('error', (event) => {
    reportError({
      type: 'uncaught_error',
      message: event.message || 'Unknown error',
      stack: event.error?.stack,
      url: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportError({
      type: 'unhandled_rejection',
      message: reason?.message || String(reason) || 'Unhandled promise rejection',
      stack: reason?.stack,
    });
  });
}

// ── Extended Health Check ─────────────────────────────────────────────────
// getHealth returns runtime stats (db, disk, memory, lib versions, error counts)
// getErrorAggregation returns grouped error summaries from the ring buffer

export interface HealthStatus {
  status: string;
  db?: string;
  disk_free_mb?: number;
  memory_mb?: number;
  python?: string;
  fastapi?: string;
  lxml?: string;
  networkx?: string;
  log_buffer_size?: number;
  error_count?: number;
}

export async function getHealth(): Promise<HealthStatus> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function getErrorAggregation(params?: {
  limit?: number;
  source?: string;
  severity?: string;
}): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.source) qs.set('source', params.source);
  if (params?.severity) qs.set('severity', params.severity);
  const res = await fetch(`${BASE}/health/errors?${qs}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

// ── Paginated Sessions ────────────────────────────────────────────────────
// Server-side pagination for uploads with thousands of sessions; supports
// offset/limit, tier filter, and full-text search query parameters.

export async function getPaginatedSessions(
  uploadId: number,
  params: { offset?: number; limit?: number; tier?: number; search?: string } = {},
): Promise<{ sessions: any[]; total: number; offset: number; limit: number }> {
  const qs = new URLSearchParams();
  if (params.offset != null) qs.set('offset', String(params.offset));
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.tier != null) qs.set('tier', String(params.tier));
  if (params.search) qs.set('search', params.search);
  const res = await fetch(`${BASE}/tier-map/uploads/${uploadId}/sessions?${qs}`, {
    headers: userHeaders(),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Per-View API Endpoints ────────────────────────────────────────────────
// Each view can optionally call its dedicated endpoint for server-side filtered data.

async function fetchView(view: string, uploadId: number, params?: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ upload_id: String(uploadId), ...params });
  const res = await fetch(`${BASE}/views/${view}?${qs}`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export function getViewExplorer(uploadId: number, opts?: { offset?: number; limit?: number; tier?: number; search?: string; sort?: string }) {
  const params: Record<string, string> = {};
  if (opts?.offset != null) params.offset = String(opts.offset);
  if (opts?.limit != null) params.limit = String(opts.limit);
  if (opts?.tier != null) params.tier = String(opts.tier);
  if (opts?.search) params.search = opts.search;
  if (opts?.sort) params.sort = opts.sort;
  return fetchView('explorer', uploadId, params);
}

export const getViewConflicts = (uploadId: number) => fetchView('conflicts', uploadId);
export const getViewExecOrder = (uploadId: number, opts?: { offset?: number; limit?: number }) =>
  fetchView('exec-order', uploadId, { offset: String(opts?.offset ?? 0), limit: String(opts?.limit ?? 200) });
export const getViewMatrix = (uploadId: number, opts?: { page?: number; page_size?: number }) =>
  fetchView('matrix', uploadId, { page: String(opts?.page ?? 0), page_size: String(opts?.page_size ?? 50) });
export const getViewTables = (uploadId: number, opts?: { sort?: string; limit?: number }) =>
  fetchView('tables', uploadId, { sort: opts?.sort ?? 'total_refs', limit: String(opts?.limit ?? 100) });
export const getViewDuplicates = (uploadId: number) => fetchView('duplicates', uploadId);
export const getViewConstellation = (uploadId: number) => fetchView('constellation', uploadId);
export const getViewComplexity = (uploadId: number) => fetchView('complexity', uploadId);
export const getViewWaves = (uploadId: number) => fetchView('waves', uploadId);
export const getViewUmap = (uploadId: number, scale?: string) =>
  fetchView('umap', uploadId, { scale: scale ?? 'balanced' });
export const getViewSimulator = (uploadId: number) => fetchView('simulator', uploadId);
export const getViewConcentration = (uploadId: number) => fetchView('concentration', uploadId);
export const getViewConsensus = (uploadId: number) => fetchView('consensus', uploadId);

// ── Projects ─────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: number;
  name: string;
  description: string | null;
  user_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  upload_count: number;
}

export async function listProjects(userId?: string): Promise<ProjectSummary[]> {
  const params = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
  const res = await fetch(`${BASE}/projects${params}`);
  if (!res.ok) throw new Error(`listProjects failed: ${res.status}`);
  return res.json();
}

export async function createProject(name: string, description?: string): Promise<ProjectSummary> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, user_id: getUserId() }),
  });
  if (!res.ok) throw new Error(`createProject failed: ${res.status}`);
  return res.json();
}

export async function getProject(projectId: number): Promise<ProjectSummary & { uploads: Array<{ id: number; filename: string; platform: string; session_count: number; created_at: string | null }> }> {
  const res = await fetch(`${BASE}/projects/${projectId}`);
  if (!res.ok) throw new Error(`getProject failed: ${res.status}`);
  return res.json();
}

export async function updateProject(projectId: number, data: { name?: string; description?: string }): Promise<ProjectSummary> {
  const res = await fetch(`${BASE}/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`updateProject failed: ${res.status}`);
  return res.json();
}

export async function deleteProject(projectId: number): Promise<void> {
  const res = await fetch(`${BASE}/projects/${projectId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteProject failed: ${res.status}`);
}
