/**
 * API client for ETL Dependency Visualizer.
 * Tier-map functions + persistence + vector analysis + layers + tags.
 */

import type { TierMapResult, ConstellationResult, AlgorithmKey } from '../types/tiermap';
import type { VectorResults, WavePlan, ComplexityResult, WhatIfResult, L1Data, ActiveTag } from '../types/vectors';

const BASE = '/api';

// ── Upload + analyze ──────────────────────────────────────────────────────

export async function analyzeTierMap(files: File[]): Promise<TierMapResult & { upload_id?: number }> {
  const form = new FormData();
  files.forEach(f => form.append('files', f));
  const res = await fetch(`${BASE}/tier-map/analyze`, { method: 'POST', body: form });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function analyzeConstellation(
  files: File[],
  algorithm: AlgorithmKey = 'louvain',
): Promise<{ upload_id?: number; tier_data: TierMapResult; constellation: ConstellationResult }> {
  const form = new FormData();
  files.forEach(f => form.append('files', f));
  const res = await fetch(`${BASE}/tier-map/constellation?algorithm=${algorithm}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── SSE streaming upload ──────────────────────────────────────────────────

export interface StreamEvent {
  phase: 'extracting' | 'parsing' | 'clustering' | 'complete' | 'error';
  current?: number;
  total?: number;
  filename?: string;
  percent?: number;
  message?: string;
  result?: { upload_id?: number; tier_data: TierMapResult; constellation: ConstellationResult };
}

export function analyzeConstellationStream(
  files: File[],
  algorithm: AlgorithmKey = 'louvain',
  onEvent: (event: StreamEvent) => void,
): AbortController {
  const ctrl = new AbortController();
  const form = new FormData();
  files.forEach(f => form.append('files', f));

  fetch(`${BASE}/tier-map/constellation-stream?algorithm=${algorithm}`, {
    method: 'POST',
    body: form,
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
          const event: StreamEvent = JSON.parse(trimmed);
          onEvent(event);
          if (event.phase === 'complete' || event.phase === 'error') return;
        } catch { /* skip malformed */ }
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

export async function recluster(
  tierData: TierMapResult,
  algorithm: AlgorithmKey,
): Promise<{ tier_data: TierMapResult; constellation: ConstellationResult }> {
  const res = await fetch(`${BASE}/tier-map/recluster?algorithm=${algorithm}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Algorithm list ────────────────────────────────────────────────────────

export async function getAlgorithms(): Promise<Record<string, { name: string; desc: string }>> {
  const res = await fetch(`${BASE}/tier-map/algorithms`);
  if (!res.ok) throw new Error(res.statusText);
  const data = await res.json();
  return data.algorithms;
}

// ── Persistence endpoints ─────────────────────────────────────────────────

export interface UploadSummary {
  id: number;
  filename: string;
  platform: string;
  session_count: number;
  algorithm: string | null;
  created_at: string | null;
}

export async function listUploads(limit = 20): Promise<UploadSummary[]> {
  const res = await fetch(`${BASE}/tier-map/uploads?limit=${limit}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function getUpload(uploadId: number): Promise<{
  upload_id: number;
  tier_data: TierMapResult;
  constellation?: ConstellationResult;
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

export async function analyzeVectors(
  tierData: TierMapResult,
  phase: 1 | 2 | 3 = 1,
  uploadId?: number,
): Promise<VectorResults> {
  const params = new URLSearchParams({ phase: String(phase) });
  if (uploadId) params.set('upload_id', String(uploadId));
  const res = await fetch(`${BASE}/vectors/analyze?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

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

export async function whatIfSimulation(tierData: TierMapResult, sessionId: string): Promise<WhatIfResult> {
  const res = await fetch(`${BASE}/vectors/what-if/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

// ── Layer Data ───────────────────────────────────────────────────────────

export async function getL1Data(tierData: TierMapResult): Promise<L1Data> {
  const res = await fetch(`${BASE}/layers/L1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tierData),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

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

// ── Active Tags ──────────────────────────────────────────────────────────

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
