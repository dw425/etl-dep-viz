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

// ── Request deduplication with AbortController ───────────────────────────
// When a new request for the same endpoint arrives, the previous in-flight
// request is automatically aborted to prevent duplicate/stale responses.
const _inflightControllers = new Map<string, AbortController>();
const _MAX_CONCURRENT = 4;
let _activeRequests = 0;

/**
 * Fetch with automatic deduplication — aborts previous in-flight request
 * for the same dedup key. Use for GET-like requests where only the latest
 * response matters (e.g. tab switches, search-as-you-type).
 */
export async function dedupFetch(url: string, init?: RequestInit, dedupKey?: string): Promise<Response> {
  const key = dedupKey || url;

  // Abort previous request for this key
  const prev = _inflightControllers.get(key);
  if (prev) prev.abort();

  const controller = new AbortController();
  _inflightControllers.set(key, controller);

  try {
    _activeRequests++;
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    _activeRequests--;
    if (_inflightControllers.get(key) === controller) {
      _inflightControllers.delete(key);
    }
  }
}

// ── User ID management ────────────────────────────────────────────────────
// A UUID is generated on first visit and stored in localStorage so the user's
// upload history persists across sessions without requiring auth.

/** Returns the persistent user UUID from localStorage, creating one on first visit. */
export function getUserId(): string {
  let id = localStorage.getItem('edv-user-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('edv-user-id', id);
  }
  return id;
}

/** Builds the X-User-Id header object used by endpoints that track upload ownership. */
export function userHeaders(): Record<string, string> {
  return { 'X-User-Id': getUserId() };
}

// ── Upload & analyze ──────────────────────────────────────────────────────

/**
 * Parses uploaded ETL files and returns a tier-map result synchronously (non-streaming).
 * @param files - XML files (Informatica PowerCenter or NiFi flow definitions)
 * @param projectId - Optional project to associate the upload with
 * @returns Tier map with sessions, tables, connections, and an optional upload_id for persistence
 * @endpoint POST /api/tier-map/analyze
 */
export async function analyzeTierMap(files: File[], projectId?: number): Promise<TierMapResult & { upload_id?: number }> {
  const form = new FormData();
  files.forEach(f => form.append('files', f));
  const params = projectId ? `?project_id=${projectId}` : '';
  const res = await fetch(`${BASE}/tier-map/analyze${params}`, { method: 'POST', body: form, headers: userHeaders() });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Parses files and clusters sessions in one call; returns tier data + constellation.
 * @param files - XML files to parse
 * @param algorithm - Clustering algorithm (default: 'louvain')
 * @param projectId - Optional project association
 * @returns Combined tier data and constellation clustering result
 * @endpoint POST /api/tier-map/constellation
 */
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

/** SSE progress event emitted during streaming constellation analysis. */
export interface StreamEvent {
  /** Current processing phase. */
  phase: 'extracting' | 'parsing' | 'clustering' | 'complete' | 'error' | 'timeout';
  /** Current file index (1-based) during multi-file upload. */
  current?: number;
  /** Total number of files being processed. */
  total?: number;
  /** Name of the file currently being processed. */
  filename?: string;
  /** Overall progress percentage (0-100). */
  percent?: number;
  /** Human-readable status or error message. */
  message?: string;
  /** Elapsed wall-clock time in milliseconds. */
  elapsed_ms?: number;
  /** Estimated time remaining in milliseconds. */
  eta_ms?: number;
  /** Number of sessions discovered so far. */
  sessions_found?: number;
  /** Size of the current file in MB. */
  file_size_mb?: number;
  /** Total upload size across all files in MB. */
  total_size_mb?: number;
  /** Final result payload, present only when phase is 'complete'. */
  result?: { upload_id?: number; tier_data: TierMapResult; constellation: ConstellationResult };
}

/**
 * SSE-streaming variant of analyzeConstellation. Emits progress events for each phase.
 * Preferred for production: yields granular step-by-step feedback.
 * @param files - XML files to parse
 * @param algorithm - Clustering algorithm (default: 'louvain')
 * @param onEvent - Callback invoked for each SSE event
 * @param projectId - Optional project association
 * @returns AbortController to cancel the in-flight request
 * @endpoint POST /api/tier-map/constellation-stream (SSE)
 */
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

// ── Server-side path parse (SSE) ─────────────────────────────────────────
// For large files uploaded to DBFS via CLI, trigger parse from a server path.

/**
 * Parse ETL files from a server-side path (DBFS or local) via SSE streaming.
 * Same event format as analyzeConstellationStream.
 * @param filePath - Server-side file path (e.g. "dbfs:/landing/export.zip")
 * @param algorithm - Clustering algorithm (default: 'louvain')
 * @param onEvent - Callback for SSE progress events
 * @param projectId - Optional project association
 * @returns AbortController to cancel the in-flight request
 * @endpoint POST /api/tier-map/analyze-path
 */
export function analyzeFromPath(
  filePath: string,
  algorithm: AlgorithmKey = 'louvain',
  onEvent: (event: StreamEvent) => void,
  projectId?: number,
): AbortController {
  const ctrl = new AbortController();

  const params = new URLSearchParams({ file_path: filePath, algorithm });
  if (projectId) params.set('project_id', String(projectId));
  fetch(`${BASE}/tier-map/analyze-path?${params}`, {
    method: 'POST',
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

      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

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

/**
 * Re-runs clustering on already-stored tier data using a different algorithm
 * without requiring the user to re-upload their files.
 * @param tierData - Previously parsed tier map result
 * @param algorithm - New clustering algorithm to apply
 * @returns Updated tier data + constellation result
 * @endpoint POST /api/tier-map/recluster
 */
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
/**
 * Returns all available clustering algorithms and their human-readable descriptions.
 * @returns Map of algorithm key to {name, desc} metadata
 * @endpoint GET /api/tier-map/algorithms
 */
export async function getAlgorithms(): Promise<Record<string, { name: string; desc: string }>> {
  const res = await fetch(`${BASE}/tier-map/algorithms`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  const data = await res.json();
  return data.algorithms;
}

// ── Persistence endpoints ─────────────────────────────────────────────────
// SQLite-backed upload history; allows restoring a previous analysis without re-parsing

/** Summary metadata for a persisted upload. Returned by list/get upload endpoints. */
export interface UploadSummary {
  /** Server-assigned upload ID. */
  id: number;
  /** Original filename(s) of the uploaded XML. */
  filename: string;
  /** Detected platform: 'informatica' or 'nifi'. */
  platform: string;
  /** Number of ETL sessions parsed. */
  session_count: number;
  /** Clustering algorithm used (null if no constellation run). */
  algorithm: string | null;
  /** Parse wall-clock time in milliseconds (null if not recorded). */
  parse_duration_ms: number | null;
  /** Associated project ID (null if standalone upload). */
  project_id: number | null;
  /** ISO timestamp of when the upload was created. */
  created_at: string | null;
}

/**
 * Lists recent uploads for the current user.
 * @param limit - Max number of uploads to return (default: 20)
 * @returns Array of upload summaries, newest first
 * @endpoint GET /api/tier-map/uploads
 */
export async function listUploads(limit = 20): Promise<UploadSummary[]> {
  const res = await fetch(`${BASE}/tier-map/uploads?limit=${limit}`, { headers: userHeaders() });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Retrieves a single upload with its full tier data, constellation, and vector results.
 * @param uploadId - Upload ID to retrieve
 * @returns Full upload payload including parsed data and analysis results
 * @endpoint GET /api/tier-map/uploads/{uploadId}
 */
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
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Deletes an upload and all associated data (cascade).
 * @param uploadId - Upload ID to delete
 * @endpoint DELETE /api/tier-map/uploads/{uploadId}
 */
export async function deleteUpload(uploadId: number): Promise<void> {
  const res = await fetch(`${BASE}/tier-map/uploads/${uploadId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
}

// ── Vector Analysis ──────────────────────────────────────────────────────
// 11 vector engines run in 3 phases: Core (phase=1) → Advanced (phase=2) → Ensemble (phase=3)
// upload_id is optional; when provided the backend can cache results by upload

/**
 * Runs vector analysis engines on parsed tier data. Engines run in 3 phases:
 * Phase 1 (Core): V1, V4, V11. Phase 2 (Advanced): V2, V3, V9, V10. Phase 3 (Ensemble): V5-V8.
 * @param tierData - Parsed tier map result
 * @param phase - Which phase to run (1, 2, or 3; default: 1)
 * @param uploadId - Optional upload ID for server-side caching
 * @returns Combined vector results from all engines run so far
 * @endpoint POST /api/vectors/analyze
 */
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

/**
 * Retrieves cached vector results for an upload. Returns null on 404 without throwing.
 * @param uploadId - Upload ID to look up cached results for
 * @returns Cached VectorResults or null if not yet computed
 * @endpoint GET /api/vectors/results/{uploadId}
 */
export async function getCachedVectors(uploadId: number): Promise<VectorResults | null> {
  const res = await fetch(`${BASE}/vectors/results/${uploadId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/** SSE progress event emitted during streaming vector analysis. */
export interface VectorStreamEvent {
  /** Current engine or phase name (e.g. "V1", "V4", "complete", "error"). */
  phase: string;
  /** Overall progress percentage (0-100). */
  percent?: number;
  /** Human-readable status or error message. */
  message?: string;
  /** Final combined results, present only when phase is 'complete'. */
  result?: VectorResults;
}

/**
 * SSE-streaming variant of analyzeVectors. Emits progress events for each engine.
 * @param tierData - Parsed tier map result
 * @param uploadId - Optional upload ID for caching
 * @param onEvent - Callback invoked for each SSE progress event
 * @returns AbortController to cancel the in-flight request
 * @endpoint POST /api/vectors/analyze-stream (SSE)
 */
export function analyzeVectorsStream(
  _tierData: TierMapResult,
  uploadId: number | undefined,
  onEvent: (event: VectorStreamEvent) => void,
): AbortController {
  const ctrl = new AbortController();
  if (!uploadId) {
    onEvent({ phase: 'error', message: 'upload_id required for vector analysis' });
    return ctrl;
  }

  // Start background job, then poll for progress
  fetch(`${BASE}/vectors/analyze-background?upload_id=${uploadId}`, {
    method: 'POST',
    headers: userHeaders(),
    signal: ctrl.signal,
  }).then(async res => {
    if (!res.ok) {
      onEvent({ phase: 'error', message: (await res.json()).detail || res.statusText });
      return;
    }
    // Poll for status (interval matches backend bg_job_poll_interval_ms default)
    const POLL_MS = 2000;
    const poll = setInterval(async () => {
      if (ctrl.signal.aborted) { clearInterval(poll); return; }
      try {
        const statusRes = await fetch(`${BASE}/vectors/analyze-status?upload_id=${uploadId}`, { headers: userHeaders() });
        if (!statusRes.ok) {
          if (statusRes.status === 404) { clearInterval(poll); onEvent({ phase: 'error', message: 'Analysis job not found' }); }
          return;
        }
        const status = await statusRes.json();
        onEvent({ phase: status.phase || 'running', percent: status.percent, message: `${status.phase} (${status.percent}%)` });
        if (status.state === 'complete') {
          clearInterval(poll);
          const resultRes = await fetch(`${BASE}/vectors/analyze-result?upload_id=${uploadId}`, { headers: userHeaders() });
          if (!resultRes.ok) { onEvent({ phase: 'error', message: 'Failed to fetch results' }); return; }
          const result = await resultRes.json();
          onEvent({ phase: 'complete', percent: 100, result });
        } else if (status.state === 'error') {
          clearInterval(poll);
          onEvent({ phase: 'error', message: status.error || 'Analysis failed' });
        }
      } catch (err) {
        // Network error during poll — keep trying
      }
    }, POLL_MS);
  }).catch(err => {
    if (err.name !== 'AbortError') onEvent({ phase: 'error', message: err.message });
  });
  return ctrl;
}

/**
 * Standalone V4 wave plan endpoint (bypasses full vector pipeline).
 * @param tierData - Parsed tier map result
 * @returns Migration wave plan with SCC analysis
 * @endpoint POST /api/vectors/wave-plan
 */
export async function getWavePlan(tierData: TierMapResult): Promise<WavePlan> {
  const res = await fetch(`${BASE}/vectors/wave-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Standalone V11 complexity scoring endpoint (bypasses full vector pipeline).
 * @param tierData - Parsed tier map result
 * @returns Complexity scores with bucket distribution and hour estimates
 * @endpoint POST /api/vectors/complexity
 */
export async function getComplexity(tierData: TierMapResult): Promise<ComplexityResult> {
  const res = await fetch(`${BASE}/vectors/complexity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Simulates the downstream impact of a failure at sessionId. Returns blast radius,
 * affected sessions, and hop-by-hop amplitude decay.
 * @param tierData - Parsed tier map result
 * @param sessionId - Session to simulate failure for
 * @returns What-if simulation result with blast radius and hop breakdown
 * @endpoint POST /api/vectors/what-if/{sessionId}
 */
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

/**
 * Fetches L1 Enterprise layer data: supernode graph + environment summary.
 * @param tierData - Parsed tier map result
 * @returns L1 data with supernode graph, environment summary, and embedded vector results
 * @endpoint POST /api/layers/L1
 */
export async function getL1Data(tierData: TierMapResult): Promise<L1Data> {
  const res = await fetch(`${BASE}/layers/L1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Fetches L2 Domain Cluster data: sessions, sub-clusters, and connections within a group.
 * @param tierData - Parsed tier map result
 * @param groupId - Community/group ID to drill into (e.g. "community_0")
 * @returns L2 data with sessions, sub_clusters, connections, and complexity_scores
 * @endpoint POST /api/layers/L2/{groupId}
 */
export async function getL2Data(tierData: TierMapResult, groupId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/layers/L2/${groupId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Fetches L3 Workflow Neighborhood data: sessions scoped to a sub-cluster or workflow.
 * @param tierData - Parsed tier map result
 * @param groupId - Parent community/group ID
 * @param scopeType - Scope type (e.g. "sub_cluster", "workflow")
 * @param scopeId - Scope identifier within the group
 * @returns L3 data with sessions, connections, cascade_data, and scc_groups
 * @endpoint POST /api/layers/L3/{groupId}/{scopeType}/{scopeId}
 */
export async function getL3Data(tierData: TierMapResult, groupId: string, scopeType: string, scopeId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/layers/L3/${groupId}/${scopeType}/${scopeId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Fetches L4 Session Blueprint data: session detail with complexity and criticality.
 * @param tierData - Parsed tier map result
 * @param sessionId - Session ID to retrieve blueprint for
 * @returns L4 data with session, complexity, criticality, upstream/downstream connections
 * @endpoint POST /api/layers/L4/{sessionId}
 */
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

/**
 * Creates a new active tag on a session, table, or transform.
 * @param data - Tag creation payload (object_id, object_type, tag_type, label, color, note)
 * @returns The created ActiveTag with server-generated tag_id
 * @endpoint POST /api/active-tags
 */
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

/**
 * Retrieves all tags for a specific object.
 * @param objectId - ID of the session, table, or transform
 * @returns Array of ActiveTag instances for this object
 * @endpoint GET /api/active-tags/{objectId}
 */
export async function getActiveTags(objectId: string): Promise<ActiveTag[]> {
  const res = await fetch(`${BASE}/active-tags/${objectId}`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Deletes a single active tag by ID.
 * @param tagId - Server-generated tag ID to delete
 * @endpoint DELETE /api/active-tags/{tagId}
 */
export async function deleteActiveTag(tagId: string): Promise<void> {
  const res = await fetch(`${BASE}/active-tags/${tagId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
}

/**
 * Lists all active tags, optionally filtered by object_type or tag_type.
 * @param params - Optional filters: object_type ('session'|'table'|'transform'), tag_type ('risk'|'status'|etc.)
 * @returns Array of matching ActiveTag instances
 * @endpoint GET /api/active-tags
 */
export async function listAllActiveTags(params?: { object_type?: string; tag_type?: string }): Promise<ActiveTag[]> {
  const qs = new URLSearchParams();
  if (params?.object_type) qs.set('object_type', params.object_type);
  if (params?.tag_type) qs.set('tag_type', params.tag_type);
  const q = qs.toString();
  const res = await fetch(`${BASE}/active-tags${q ? '?' + q : ''}`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── User Profile & Activity ──────────────────────────────────────────────
// User records are keyed by the localStorage UUID; activity events are fire-and-forget.

/**
 * Creates or updates the current user's profile.
 * @param displayName - Optional display name for the user
 * @returns User record with upload_count and total_sessions
 * @endpoint POST /api/users
 */
export async function upsertUser(displayName?: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: getUserId(), display_name: displayName || '' }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Retrieves the current user's profile. Returns a default record on 404.
 * @returns User record with display_name, upload_count, total_sessions
 * @endpoint GET /api/users/{userId}
 */
export async function getUser(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/users/${getUserId()}`);
  if (res.status === 404) return { user_id: getUserId(), display_name: '', upload_count: 0, total_sessions: 0 };
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Lists uploads belonging to the current user.
 * @param limit - Max uploads to return (default: 50)
 * @returns Array of UploadSummary for the current user
 * @endpoint GET /api/users/{userId}/uploads
 */
export async function getUserUploads(limit = 50): Promise<UploadSummary[]> {
  const res = await fetch(`${BASE}/users/${getUserId()}/uploads?limit=${limit}`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Retrieves the current user's activity log.
 * @param limit - Max events to return (default: 50)
 * @returns Array of activity event records
 * @endpoint GET /api/users/{userId}/activity
 */
export async function getUserActivity(limit = 50): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${BASE}/users/${getUserId()}/activity?limit=${limit}`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Logs a user activity event. Fire-and-forget; failures are silently swallowed.
 * @param action - Action name (e.g. "upload", "view_change", "export")
 * @param targetFilename - Optional filename the action applies to
 * @param details - Optional structured metadata
 * @endpoint POST /api/users/{userId}/activity
 */
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

/** A single log entry from the backend's in-memory ring buffer. */
export interface LogEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  /** Severity level: DEBUG, INFO, WARNING, ERROR, CRITICAL. */
  level: string;
  /** Python logger name (e.g. "app.routers.tier_map"). */
  logger: string;
  /** Human-readable log message. */
  message: string;
  /** Structured metadata attached to the log entry. */
  extra: Record<string, unknown>;
}

/**
 * Retrieves recent log entries from the backend's in-memory ring buffer.
 * @param limit - Max entries to return (default: 50)
 * @param level - Optional minimum severity filter (e.g. "ERROR")
 * @returns Array of LogEntry records, newest first
 * @endpoint GET /api/health/logs
 */
export async function getHealthLogs(limit = 50, level?: string): Promise<LogEntry[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (level) params.set('level', level);
  const res = await fetch(`${BASE}/health/logs?${params}`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Flow Walker ───────────────────────────────────────────────────────────
// Returns upstream/downstream chains, mapping detail (instances + connectors + fields),
// tables touched, complexity score, wave info, and SCC membership for a session.

/**
 * Fetches Flow Walker data for a session: upstream/downstream chains, mapping detail,
 * tables touched, complexity score, wave info, and SCC membership.
 * When uploadId is available, sends it as a query param to avoid transmitting
 * the full tier_data body (which can be 15MB+ for large datasets).
 * @param tierData - Parsed tier map result (ignored when uploadId is provided)
 * @param sessionId - Session to retrieve flow data for
 * @param uploadId - Optional upload ID; when set, backend fetches tier data from DB
 * @returns Flow data including upstream_chain, downstream_chain, mapping_detail, etc.
 * @endpoint POST /api/layers/flow/{sessionId}
 */
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
    body: uploadId
      ? JSON.stringify({ tier_data: null, vector_results: null })
      : JSON.stringify({ tier_data: tierData, vector_results: null }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Lineage API ───────────────────────────────────────────────────────────
// Graph-level and hop-limited forward/backward tracing; also per-table and per-column.

/**
 * Builds the full lineage graph for all sessions and tables.
 * Returns nodes (sessions + tables) and directed edges.
 * @param tierData - Parsed tier map result
 * @returns Lineage graph with nodes, edges, and summary statistics
 * @endpoint POST /api/lineage/graph
 */
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

/**
 * Traces downstream (forward) lineage from a node up to maxHops edges.
 * @param tierData - Parsed tier map result
 * @param nodeId - Starting node (session or table ID)
 * @param maxHops - Maximum edge traversal depth (default: 20)
 * @returns Subgraph of reachable nodes and edges within maxHops
 * @endpoint POST /api/lineage/trace/forward/{nodeId}
 */
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

/**
 * Traces upstream (backward) lineage from a node up to maxHops edges.
 * @param tierData - Parsed tier map result
 * @param nodeId - Starting node (session or table ID)
 * @param maxHops - Maximum edge traversal depth (default: 20)
 * @returns Subgraph of ancestor nodes and edges within maxHops
 * @endpoint POST /api/lineage/trace/backward/{nodeId}
 */
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

/**
 * Returns lineage data scoped to a single table: upstream writers and downstream readers.
 * @param tierData - Parsed tier map result
 * @param tableName - Table name to trace lineage for (URL-encoded automatically)
 * @returns Table-centric lineage with writer_sessions, reader_sessions, and connection types
 * @endpoint POST /api/lineage/table/{tableName}
 */
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

/**
 * Returns field-level (column) lineage for a session, derived from deep
 * Informatica connector parsing. Shows source_field -> transform -> target_field paths.
 * @param tierData - Parsed tier map result
 * @param sessionId - Session to extract column lineage for
 * @returns Column lineage graph with field-level edges and transform nodes
 * @endpoint POST /api/lineage/columns/{sessionId}
 */
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

/**
 * Returns all downstream sessions and tables affected if sessionId were to change.
 * Similar to whatIfSimulation but focuses on structural impact rather than failure cascading.
 * @param tierData - Parsed tier map result
 * @param sessionId - Session to analyze impact for
 * @param maxHops - Maximum downstream hop depth (default: 10)
 * @returns Impact result with affected_sessions, affected_tables, hop_breakdown
 * @endpoint POST /api/lineage/impact/{sessionId}
 */
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

/**
 * Runs all vector engines at multiple resolution levels and returns a comparison matrix.
 * Useful for determining the optimal analysis granularity.
 * @param tierData - Parsed tier map result
 * @returns Sweep matrix with per-resolution vector engine results
 * @endpoint POST /api/vectors/sweep-resolution
 */
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

/**
 * Runs only the specified vector engines (by id) instead of the full 11-engine pipeline.
 * Useful for re-running a single engine after parameter changes.
 * @param tierData - Parsed tier map result
 * @param vectors - Array of engine IDs to run (e.g. ["V1", "V4"])
 * @param uploadId - Optional upload ID for server-side caching
 * @returns Partial VectorResults containing only the requested engine outputs
 * @endpoint POST /api/vectors/analyze-incremental
 */
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

/**
 * Updates only the color of an existing active tag without touching other properties.
 * @param tagId - Server-generated tag ID
 * @param color - New hex color value (e.g. "#EF4444")
 * @endpoint PATCH /api/active-tags/{tagId}
 */
export async function updateTagColor(
  tagId: string,
  color: string,
): Promise<void> {
  const res = await fetch(`${BASE}/active-tags/${tagId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
}

// ── Batch Tag Operations ──────────────────────────────────────────────────
// Applies the same tag to multiple object IDs in parallel via Promise.all

/**
 * Applies the same tag to multiple objects in parallel via Promise.all.
 * Each object gets its own ActiveTag record.
 * @param objectIds - Array of object IDs to tag
 * @param tag - Tag template (object_type, tag_type, label, optional color/note)
 */
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

/**
 * Exports tier data as a multi-sheet Excel workbook (.xlsx).
 * @param tierData - Parsed tier map result
 * @param uploadId - Optional upload ID for including vector data in the export
 * @returns Binary Blob of the Excel file
 * @endpoint POST /api/exports/excel
 */
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
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.blob();
}

/**
 * Exports the lineage graph in Graphviz DOT format for external rendering.
 * @param tierData - Parsed tier map result
 * @returns DOT language string
 * @endpoint POST /api/exports/lineage/dot
 */
export async function exportLineageDot(tierData: TierMapResult): Promise<string> {
  const res = await fetch(`${BASE}/exports/lineage/dot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.text();
}

/**
 * Exports the lineage graph in Mermaid diagram format for embedding in docs.
 * @param tierData - Parsed tier map result
 * @returns Mermaid syntax string
 * @endpoint POST /api/exports/lineage/mermaid
 */
export async function exportLineageMermaid(tierData: TierMapResult): Promise<string> {
  const res = await fetch(`${BASE}/exports/lineage/mermaid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.text();
}

/**
 * Exports sessions as Jira-importable CSV with summary, description, priority, and labels.
 * @param tierData - Parsed tier map result
 * @param uploadId - Optional upload ID for including vector data
 * @returns CSV text string
 * @endpoint POST /api/exports/jira/csv
 */
export async function exportJiraCsv(tierData: TierMapResult, uploadId?: number): Promise<string> {
  const params = new URLSearchParams();
  if (uploadId) params.set('upload_id', String(uploadId));
  const res = await fetch(`${BASE}/exports/jira/csv?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.text();
}

/**
 * Exports session migration plan as Databricks notebook-compatible Python/SQL.
 * @param tierData - Parsed tier map result
 * @returns Databricks notebook content as text
 * @endpoint POST /api/exports/databricks
 */
export async function exportDatabricks(tierData: TierMapResult): Promise<string> {
  const res = await fetch(`${BASE}/exports/databricks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.text();
}

/**
 * Exports a full analysis snapshot as a binary archive (JSON + metadata).
 * Can be re-imported later to restore the complete analysis state.
 * @param tierData - Parsed tier map result
 * @param uploadId - Optional upload ID for including vector data
 * @returns Binary Blob of the snapshot archive
 * @endpoint POST /api/exports/snapshot
 */
export async function exportSnapshot(tierData: TierMapResult, uploadId?: number): Promise<Blob> {
  const params = new URLSearchParams();
  if (uploadId) params.set('upload_id', String(uploadId));
  const res = await fetch(`${BASE}/exports/snapshot?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.blob();
}

/**
 * Merges multiple uploads into a single combined tier data set.
 * Sessions and tables are deduplicated; connections are unioned.
 * @param uploadIds - Array of upload IDs to merge
 * @returns Merged tier data result with combined sessions, tables, and connections
 * @endpoint POST /api/exports/merge
 */
export async function mergeUploads(uploadIds: number[]): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/exports/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userHeaders() },
    body: JSON.stringify(uploadIds),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Compare Uploads API ───────────────────────────────────────────────────

export interface CompareResult {
  upload_a_info: { id: number; filename: string; platform: string; session_count: number; created_at: string | null };
  upload_b_info: { id: number; filename: string; platform: string; session_count: number; created_at: string | null };
  matched: Array<{
    full_name: string;
    upload_a: SessionDetail;
    upload_b: SessionDetail;
    changes: Record<string, { old: unknown; new: unknown } | { added: string[]; removed: string[] }>;
    has_changes: boolean;
  }>;
  added: SessionDetail[];
  removed: SessionDetail[];
  table_diff: {
    added: Array<Record<string, unknown>>;
    removed: Array<Record<string, unknown>>;
    modified: Array<{ name: string; upload_a: Record<string, unknown>; upload_b: Record<string, unknown>; changes: Record<string, { old: unknown; new: unknown }> }>;
  };
  stats: {
    total_a: number; total_b: number;
    matched_count: number; changed_count: number; unchanged_count: number;
    added_count: number; removed_count: number;
    tables_added: number; tables_removed: number; tables_modified: number;
    connections_added: number; connections_removed: number;
  };
}

export interface SessionDetail {
  session_id: string; name: string; full_name: string;
  tier: number; step: number; workflow: string;
  folder_path: string; mapping_name: string;
  transforms: number; ext_reads: number; lookup_count: number; critical: boolean;
  sources: string[]; targets: string[]; lookups: string[];
  total_loc: number; total_functions_used: number; distinct_functions_used: number;
  has_embedded_sql: boolean; has_embedded_java: boolean; has_stored_procedure: boolean;
  core_intent: string | null;
  expression_count: number; field_mapping_count: number;
}

export async function compareUploads(uploadA: number, uploadB: number): Promise<CompareResult> {
  const res = await dedupFetch(`${BASE}/compare?upload_a=${uploadA}&upload_b=${uploadB}`, {
    headers: userHeaders(),
  }, 'compare');
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── AI Chat API ───────────────────────────────────────────────────────────
// Requires the upload to be indexed first (chatIndexUpload); then supports
// conversational Q&A (chatQuery) and semantic search (chatSearch) over the ETL graph.

/**
 * Builds the AI vector index for an upload. Must be called before chatQuery or chatSearch.
 * Indexes sessions, tables, chains, and community groups into ChromaDB.
 * @param uploadId - Upload ID to index
 * @returns Index result with documents_indexed count and per-type breakdown
 * @endpoint POST /api/chat/index/{uploadId}
 */
export async function chatIndexUpload(uploadId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/chat/index/${uploadId}`, {
    method: 'POST',
    headers: userHeaders(),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Sends a natural-language question to the AI assistant. Uses RAG (retrieval-augmented
 * generation) over the indexed upload to answer questions about sessions, tables, lineage, etc.
 * @param uploadId - Upload ID (must be indexed first via chatIndexUpload)
 * @param question - User's question text
 * @param conversationHistory - Previous messages for multi-turn context (last 10 recommended)
 * @returns AI response with answer, intent classification, referenced_sessions/tables, and suggested_questions
 * @endpoint POST /api/chat/{uploadId}
 */
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

/**
 * Performs semantic vector search over the indexed upload documents.
 * Lower-level than chatQuery; returns raw document matches without LLM synthesis.
 * @param uploadId - Upload ID (must be indexed)
 * @param query - Search query text
 * @param docType - Optional document type filter ("session", "table", "chain", "group")
 * @param nResults - Number of results to return (default: 10)
 * @returns Search results with matched documents, distances, and metadata
 * @endpoint POST /api/chat/{uploadId}/search
 */
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

/**
 * Checks whether an upload has been indexed for AI chat.
 * @param uploadId - Upload ID to check
 * @returns Status object with indexed flag and document_count
 * @endpoint GET /api/chat/{uploadId}/status
 */
export async function chatIndexStatus(uploadId: number): Promise<{ indexed: boolean; document_count: number }> {
  const res = await fetch(`${BASE}/chat/${uploadId}/status`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Re-indexes an upload with the latest vector analysis data (complexity, waves, communities).
 * Call after running vector analysis to enrich AI responses with vector insights.
 * @param uploadId - Upload ID to re-index
 * @returns Re-index result with updated documents_indexed count
 * @endpoint POST /api/chat/reindex/{uploadId}
 */
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

/**
 * Reports a client-side error to the backend for centralized logging.
 * Fire-and-forget; failures are silently swallowed so this never causes secondary errors.
 * @param error - Error details (type, message, stack, url, code, severity)
 * @endpoint POST /api/health/report-error
 */
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

// Module-level guard ensures the handler is only installed once,
// even if installGlobalErrorHandler() is called from multiple components.
let _errorHandlerInstalled = false;

/**
 * Installs global window-level error handlers that forward uncaught errors
 * and unhandled promise rejections to reportError(). Should be called once
 * at app startup (e.g. in main.tsx).
 */
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

/** Runtime health status returned by the backend health check endpoint. */
export interface HealthStatus {
  /** Overall status: "ok" or "degraded". */
  status: string;
  /** Database connectivity status. */
  db?: string;
  /** Free disk space in MB. */
  disk_free_mb?: number;
  /** Process resident memory in MB. */
  memory_mb?: number;
  /** Python version string. */
  python?: string;
  /** FastAPI version string. */
  fastapi?: string;
  /** lxml library version. */
  lxml?: string;
  /** NetworkX library version. */
  networkx?: string;
  /** Current number of entries in the in-memory log ring buffer. */
  log_buffer_size?: number;
  /** Total error count since server start. */
  error_count?: number;
}

/**
 * Returns runtime health status: database, disk, memory, library versions, error counts.
 * @returns HealthStatus object
 * @endpoint GET /api/health
 */
export async function getHealth(): Promise<HealthStatus> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Returns grouped error summaries from the in-memory ring buffer.
 * Errors are aggregated by message pattern with occurrence counts.
 * @param params - Optional filters: limit, source ("frontend"|"backend"), severity
 * @returns Aggregated error groups with counts and last_seen timestamps
 * @endpoint GET /api/health/errors
 */
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
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Paginated Sessions ────────────────────────────────────────────────────
// Server-side pagination for uploads with thousands of sessions; supports
// offset/limit, tier filter, and full-text search query parameters.

/**
 * Retrieves sessions with server-side pagination, tier filtering, and full-text search.
 * Preferred for uploads with thousands of sessions to avoid loading them all at once.
 * @param uploadId - Upload ID to paginate sessions for
 * @param params - Pagination and filter options: offset, limit, tier, search
 * @returns Paginated result with sessions array, total count, offset, and limit
 * @endpoint GET /api/tier-map/uploads/{uploadId}/sessions
 */
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

/**
 * Internal helper: fetches server-side filtered data for a named view.
 * All per-view endpoints share the pattern GET /api/views/{view}?upload_id=X.
 * @param view - View name (e.g. "explorer", "conflicts", "waves")
 * @param uploadId - Upload ID for the data source
 * @param params - Additional query parameters specific to the view
 * @returns View-specific data payload
 */
async function fetchView(view: string, uploadId: number, params?: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ upload_id: String(uploadId), ...params });
  const url = `${BASE}/views/${view}?${qs}`;
  const res = await dedupFetch(url, undefined, `view:${view}:${uploadId}`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/** Fetches Explorer view data with pagination, tier filter, search, and sort options. */
export function getViewExplorer(uploadId: number, opts?: { offset?: number; limit?: number; tier?: number; search?: string; sort?: string }) {
  const params: Record<string, string> = {};
  if (opts?.offset != null) params.offset = String(opts.offset);
  if (opts?.limit != null) params.limit = String(opts.limit);
  if (opts?.tier != null) params.tier = String(opts.tier);
  if (opts?.search) params.search = opts.search;
  if (opts?.sort) params.sort = opts.sort;
  return fetchView('explorer', uploadId, params);
}

/** Fetches write-conflict matrix data. */
export const getViewConflicts = (uploadId: number) => fetchView('conflicts', uploadId);
/** Fetches execution order (topological sort) with pagination. */
export const getViewExecOrder = (uploadId: number, opts?: { offset?: number; limit?: number }) =>
  fetchView('exec-order', uploadId, { offset: String(opts?.offset ?? 0), limit: String(opts?.limit ?? 200) });
/** Fetches session-to-session dependency matrix with pagination. */
export const getViewMatrix = (uploadId: number, opts?: { page?: number; page_size?: number }) =>
  fetchView('matrix', uploadId, { page: String(opts?.page ?? 0), page_size: String(opts?.page_size ?? 50) });
/** Fetches table explorer data sorted by total references. */
export const getViewTables = (uploadId: number, opts?: { sort?: string; limit?: number }) =>
  fetchView('tables', uploadId, { sort: opts?.sort ?? 'total_refs', limit: String(opts?.limit ?? 100) });
/** Fetches duplicate/near-duplicate pipeline pairs. */
export const getViewDuplicates = (uploadId: number) => fetchView('duplicates', uploadId);
/** Fetches constellation clustering data from the DB. */
export const getViewConstellation = (uploadId: number) => fetchView('constellation', uploadId);
/** Fetches V11 complexity scores and bucket distribution. */
export const getViewComplexity = (uploadId: number) => fetchView('complexity', uploadId);
/** Fetches V4 wave plan with SCC analysis. */
export const getViewWaves = (uploadId: number) => fetchView('waves', uploadId);
/** Fetches UMAP 2D embedding coordinates at the given scale. */
export const getViewUmap = (uploadId: number, scale?: string) =>
  fetchView('umap', uploadId, { scale: scale ?? 'balanced' });
/** Fetches wave simulator initial state data. */
export const getViewSimulator = (uploadId: number) => fetchView('simulator', uploadId);
/** Fetches V10 concentration/independence analysis. */
export const getViewConcentration = (uploadId: number) => fetchView('concentration', uploadId);
/** Fetches consensus radar (multi-vector agreement) data. */
export const getViewConsensus = (uploadId: number) => fetchView('consensus', uploadId);

// ── Projects ─────────────────────────────────────────────────────────────

/** Summary metadata for a project. Projects group related uploads together. */
export interface ProjectSummary {
  /** Server-assigned project ID. */
  id: number;
  /** Human-readable project name. */
  name: string;
  /** Optional project description. */
  description: string | null;
  /** User ID of the project owner. */
  user_id: string | null;
  /** ISO timestamp of when the project was created. */
  created_at: string | null;
  /** ISO timestamp of last modification. */
  updated_at: string | null;
  /** Number of uploads associated with this project. */
  upload_count: number;
}

/**
 * Lists all projects, optionally filtered by user.
 * @param userId - Optional user ID filter
 * @returns Array of ProjectSummary records
 * @endpoint GET /api/projects
 */
export async function listProjects(userId?: string): Promise<ProjectSummary[]> {
  const params = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
  const res = await fetch(`${BASE}/projects${params}`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Creates a new project for the current user.
 * @param name - Project name
 * @param description - Optional project description
 * @returns The created ProjectSummary
 * @endpoint POST /api/projects
 */
export async function createProject(name: string, description?: string): Promise<ProjectSummary> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, user_id: getUserId() }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Retrieves a project with its list of associated uploads.
 * @param projectId - Project ID to fetch
 * @returns ProjectSummary extended with an uploads array
 * @endpoint GET /api/projects/{projectId}
 */
export async function getProject(projectId: number): Promise<ProjectSummary & { uploads: Array<{ id: number; filename: string; platform: string; session_count: number; created_at: string | null }> }> {
  const res = await fetch(`${BASE}/projects/${projectId}`);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Updates an existing project's name and/or description.
 * @param projectId - Project ID to update
 * @param data - Fields to update (name, description)
 * @returns Updated ProjectSummary
 * @endpoint PUT /api/projects/{projectId}
 */
export async function updateProject(projectId: number, data: { name?: string; description?: string }): Promise<ProjectSummary> {
  const res = await fetch(`${BASE}/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

/**
 * Deletes a project and all associated uploads (cascade delete).
 * @param projectId - Project ID to delete
 * @endpoint DELETE /api/projects/{projectId}
 */
export async function deleteProject(projectId: number): Promise<void> {
  const res = await fetch(`${BASE}/projects/${projectId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
}


// ── Algorithm Lab ────────────────────────────────────────────────────────────

export interface LabAlgorithmInfo {
  name: string;
  desc: string;
  speed: 'fast' | 'medium' | 'slow';
  deterministic: boolean;
  category: string;
  requires?: string;
  params?: Record<string, { type: 'int' | 'float'; default: number; min: number; max: number }>;
}

export interface LabRunResult {
  constellation: ConstellationResult;
  quality_metrics: {
    modularity: number;
    silhouette: number;
    n_clusters: number;
    entropy: number;
    duration_ms: number;
  };
  run_meta: {
    algorithm: string;
    params: Record<string, number>;
    seed: number | null;
    timestamp: string;
  };
}

export async function getLabAlgorithms(): Promise<Record<string, LabAlgorithmInfo>> {
  const res = await fetch(`${BASE}/tier-map/lab/algorithms`);
  if (!res.ok) throw new Error(`getLabAlgorithms failed: ${res.status}`);
  const data = await res.json();
  return data.algorithms;
}

export async function runLabAlgorithm(
  tierData: Record<string, unknown>,
  algorithm: string,
  params?: Record<string, number>,
  seed?: number | null,
): Promise<LabRunResult> {
  const qs = new URLSearchParams({ algorithm, params: JSON.stringify(params || {}) });
  if (seed != null) qs.set('seed', String(seed));
  const res = await fetch(`${BASE}/tier-map/lab/run?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || `runLabAlgorithm failed: ${res.status}`);
  return res.json();
}

// ── Code Analysis, Embedded Code, Function Usage ─────────────────────────

export async function getCodeAnalysis(uploadId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/views/code_analysis?upload_id=${uploadId}`);
  if (!res.ok) throw new Error(`Code analysis failed: ${res.status}`);
  return res.json();
}

export async function getEmbeddedCode(uploadId: number, sessionName?: string): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ upload_id: String(uploadId) });
  if (sessionName) params.set('session_name', sessionName);
  const res = await fetch(`${BASE}/views/embedded_code?${params}`);
  if (!res.ok) throw new Error(`Embedded code failed: ${res.status}`);
  return res.json();
}

export async function getFunctionUsage(uploadId: number, sessionName?: string): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ upload_id: String(uploadId) });
  if (sessionName) params.set('session_name', sessionName);
  const res = await fetch(`${BASE}/views/function_usage?${params}`);
  if (!res.ok) throw new Error(`Function usage failed: ${res.status}`);
  return res.json();
}

// ── Vector Config & Selective Analysis ───────────────────────────────────

export async function getVectorConfig(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/vectors/config`);
  if (!res.ok) throw new Error(`Vector config failed: ${res.status}`);
  return res.json();
}

export async function analyzeVectorsSelective(uploadId: number, vectors: string[]): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/vectors/analyze-selective`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_id: uploadId, vectors }),
  });
  if (!res.ok) throw new Error(`Selective analysis failed: ${res.status}`);
  return res.json();
}

// ── Chat Background Index ────────────────────────────────────────────────

export async function chatIndexBackground(uploadId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/chat/index/${uploadId}/background`, { method: 'POST' });
  if (!res.ok) throw new Error(`Background index failed: ${res.status}`);
  return res.json();
}

// ── Anomalies, Effort Estimate, Transpile ────────────────────────────────

export async function getAnomalies(uploadId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/views/anomalies?upload_id=${uploadId}`);
  if (!res.ok) throw new Error(`Anomalies failed: ${res.status}`);
  return res.json();
}

export async function getEffortEstimate(uploadId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/views/effort_estimate?upload_id=${uploadId}`);
  if (!res.ok) throw new Error(`Effort estimate failed: ${res.status}`);
  return res.json();
}

export async function transpileExpression(expression: string, sourceDialect: string, targetDialect: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/views/transpile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expression, source_dialect: sourceDialect, target_dialect: targetDialect }),
  });
  if (!res.ok) throw new Error(`Transpile failed: ${res.status}`);
  return res.json();
}
