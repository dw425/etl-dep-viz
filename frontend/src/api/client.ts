/**
 * API client for ETL Dependency Visualizer.
 * 5 tier-map functions + 3 persistence functions.
 */

import type { TierMapResult, ConstellationResult, AlgorithmKey } from '../types/tiermap';

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
