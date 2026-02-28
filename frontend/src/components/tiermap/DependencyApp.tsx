/**
 * DependencyApp — Master layout with 7-view tab bar, file upload, and persistence.
 *
 * Views: Tier Diagram | Galaxy Map | Constellation | Explorer | Conflicts | Exec Order | Matrix
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  TierMapResult,
  ConstellationResult,
  ConstellationChunk,
  AlgorithmKey,
} from '../../types/tiermap';
import {
  analyzeConstellationStream,
  recluster,
  listUploads,
  getUpload,
  type StreamEvent,
  type UploadSummary,
} from '../../api/client';
import ExplorerView from './ExplorerView';
import ConflictsView from './ConflictsView';
import ExecOrderView from './ExecOrderView';
import TierDiagram from './TierDiagram';
import MatrixView from './MatrixView';
import ConstellationCanvas from './ConstellationCanvas';
import ChunkSelector from './ChunkSelector';
import ChunkSummary from './ChunkSummary';
import GalaxyMapCanvas from './GalaxyMapCanvas';
import { buildTierMapHTML } from './exportTierMapHTML';

type ViewId = 'tier' | 'galaxy' | 'constellation' | 'explorer' | 'conflicts' | 'order' | 'matrix';

const VIEWS: { id: ViewId; label: string; icon: string }[] = [
  { id: 'tier', label: 'Tier Diagram', icon: '\u25A4' },
  { id: 'galaxy', label: 'Galaxy Map', icon: '\u25C9' },
  { id: 'constellation', label: 'Constellation', icon: '\u2726' },
  { id: 'explorer', label: 'Explorer', icon: '\u25CE' },
  { id: 'conflicts', label: 'Conflicts', icon: '\u26A0' },
  { id: 'order', label: 'Exec Order', icon: '\u2193' },
  { id: 'matrix', label: 'Matrix', icon: '\u229E' },
];

export function DependencyApp() {
  // ── State ──────────────────────────────────────────────────────────
  const [view, setView] = useState<ViewId>('tier');
  const [tierData, setTierData] = useState<TierMapResult | null>(null);
  const [constellation, setConstellation] = useState<ConstellationResult | null>(null);
  const [algorithm, setAlgorithm] = useState<AlgorithmKey>('louvain');
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<number | null>(null);
  const [recentUploads, setRecentUploads] = useState<UploadSummary[]>([]);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Derived ────────────────────────────────────────────────────────
  const selectedChunk = constellation?.chunks.find(c => c.id === selectedChunkId) ?? null;

  // ── Load recent uploads on mount ───────────────────────────────────
  useEffect(() => {
    listUploads(10).then(setRecentUploads).catch(() => {});
  }, []);

  // ── Upload handler ─────────────────────────────────────────────────
  const handleUpload = useCallback((files: File[]) => {
    if (!files.length) return;
    setError(null);
    setUploading(true);
    setProgress(0);
    setProgressPhase('Preparing...');

    analyzeConstellationStream(files, algorithm, (event: StreamEvent) => {
      setProgress(event.percent ?? 0);
      if (event.phase === 'extracting') setProgressPhase(`Extracted ${event.current} files`);
      else if (event.phase === 'parsing') setProgressPhase(`Parsing ${event.filename || ''} (${event.current}/${event.total})`);
      else if (event.phase === 'clustering') setProgressPhase('Clustering...');
      else if (event.phase === 'complete' && event.result) {
        setTierData(event.result.tier_data);
        setConstellation(event.result.constellation);
        setUploadId(event.result.upload_id ?? null);
        setUploading(false);
        const count = event.result.tier_data.sessions.length;
        if (count >= 500) setView('constellation');
        else setView('tier');
        listUploads(10).then(setRecentUploads).catch(() => {});
      } else if (event.phase === 'error') {
        setError(event.message || 'Upload failed');
        setUploading(false);
      }
    });
  }, [algorithm]);

  // ── Recluster handler ──────────────────────────────────────────────
  const handleRecluster = useCallback(async (algo: AlgorithmKey) => {
    if (!tierData) return;
    setAlgorithm(algo);
    try {
      const result = await recluster(tierData, algo);
      setConstellation(result.constellation);
      setSelectedChunkId(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [tierData]);

  // ── Load from persistence ──────────────────────────────────────────
  const handleLoadUpload = useCallback(async (id: number) => {
    try {
      const data = await getUpload(id);
      setTierData(data.tier_data);
      setConstellation(data.constellation ?? null);
      setUploadId(data.upload_id);
      setAlgorithm((data.algorithm as AlgorithmKey) || 'louvain');
      setView('tier');
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  // ── Export HTML ────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    if (!tierData) return;
    const html = buildTierMapHTML(tierData);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tier_map_export.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [tierData]);

  // ── Drag & drop ────────────────────────────────────────────────────
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.name.toLowerCase().endsWith('.xml') || f.name.toLowerCase().endsWith('.zip'),
    );
    if (files.length) handleUpload(files);
  }, [handleUpload]);

  // ── Scoped data for constellation chunk ────────────────────────────
  const scopedTierData = (() => {
    if (!selectedChunk || !tierData) return tierData;
    const ids = new Set(selectedChunk.session_ids);
    const sessions = tierData.sessions.filter(s => ids.has(s.id));
    const sessionIds = new Set(sessions.map(s => s.id));
    const connections = tierData.connections.filter(c => sessionIds.has(c.from) || sessionIds.has(c.to));
    const tableIds = new Set<string>();
    connections.forEach(c => {
      if (!sessionIds.has(c.from)) tableIds.add(c.from);
      if (!sessionIds.has(c.to)) tableIds.add(c.to);
    });
    const tables = tierData.tables.filter(t => tableIds.has(t.id));
    return { ...tierData, sessions, tables, connections };
  })();

  const stats = tierData?.stats;

  // ── No data yet: show upload screen ────────────────────────────────
  if (!tierData) {
    return (
      <div
        style={{
          width: '100%', height: '100vh', background: '#080C14', display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24,
        }}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div style={{ fontSize: 28, fontWeight: 800, color: '#e2e8f0', letterSpacing: '-0.02em' }}>
          ETL Dependency Visualizer
        </div>
        <div style={{ fontSize: 13, color: '#64748b', maxWidth: 500, textAlign: 'center' }}>
          Upload Informatica PowerCenter XML or Apache NiFi flow XML files to visualize session dependencies,
          write conflicts, and execution ordering across 7 interactive views.
        </div>

        {/* Upload zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          style={{
            width: 480, padding: '48px 32px', borderRadius: 16,
            border: `2px dashed ${dragOver ? '#3b82f6' : '#1e293b'}`,
            background: dragOver ? 'rgba(59,130,246,0.08)' : 'rgba(17,24,39,0.6)',
            cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s',
          }}
        >
          {uploading ? (
            <div>
              <div style={{ fontSize: 13, color: '#e2e8f0', marginBottom: 12 }}>{progressPhase}</div>
              <div style={{ width: '100%', height: 6, borderRadius: 3, background: '#1e293b', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 3, background: '#3b82f6', width: `${progress}%`, transition: 'width 0.3s' }} />
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>{Math.round(progress)}%</div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 36, marginBottom: 12 }}>+</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', marginBottom: 8 }}>
                Drop XML or ZIP files here
              </div>
              <div style={{ fontSize: 11, color: '#64748b' }}>
                Supports Informatica PowerCenter XML and NiFi flow XML
              </div>
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".xml,.zip"
          multiple
          style={{ display: 'none' }}
          onChange={e => {
            const files = Array.from(e.target.files || []);
            if (files.length) handleUpload(files);
            e.target.value = '';
          }}
        />

        {error && (
          <div style={{ color: '#ef4444', fontSize: 12, maxWidth: 480, textAlign: 'center' }}>
            {error}
          </div>
        )}

        {/* Recent uploads */}
        {recentUploads.length > 0 && (
          <div style={{ maxWidth: 480, width: '100%' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
              Recent Uploads
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {recentUploads.map(u => (
                <div
                  key={u.id}
                  onClick={() => handleLoadUpload(u.id)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 14px', borderRadius: 8, background: '#111827',
                    border: '1px solid #1e293b', cursor: 'pointer', transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = '#3b82f6')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = '#1e293b')}
                >
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{u.filename}</div>
                    <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                      {u.platform} · {u.session_count} sessions
                      {u.created_at && ` · ${new Date(u.created_at).toLocaleDateString()}`}
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: '#3b82f6', fontWeight: 600 }}>Load</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Main app layout with data ──────────────────────────────────────
  return (
    <div style={{ width: '100%', height: '100vh', background: '#080C14', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{
        padding: '8px 20px', borderBottom: '1px solid #1e293b', display: 'flex',
        alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        background: 'rgba(15,23,42,0.9)', backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{ fontSize: 14, fontWeight: 800, color: '#e2e8f0', cursor: 'pointer', letterSpacing: '-0.02em' }}
            onClick={() => { setTierData(null); setConstellation(null); setUploadId(null); setSelectedChunkId(null); }}
          >
            ETL Dep Viz
          </span>
          <div style={{ display: 'flex', gap: 2 }}>
            {VIEWS.map(v => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                style={{
                  padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontSize: 11, fontWeight: 600,
                  background: view === v.id ? 'rgba(59,130,246,0.2)' : 'transparent',
                  color: view === v.id ? '#60a5fa' : '#64748b',
                  transition: 'all 0.15s',
                }}
              >
                {v.icon} {v.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleExport}
            style={{
              padding: '4px 10px', borderRadius: 5, border: '1px solid #1e293b',
              background: 'transparent', color: '#64748b', fontSize: 10, cursor: 'pointer',
            }}
          >
            Export HTML
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '4px 10px', borderRadius: 5, border: '1px solid #3b82f6',
              background: 'rgba(59,130,246,0.1)', color: '#60a5fa', fontSize: 10, cursor: 'pointer',
            }}
          >
            New Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,.zip"
            multiple
            style={{ display: 'none' }}
            onChange={e => {
              const files = Array.from(e.target.files || []);
              if (files.length) handleUpload(files);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* Stats bar */}
      {stats && (
        <div style={{
          padding: '5px 20px', borderBottom: '1px solid #1e293b', display: 'flex',
          gap: 20, fontSize: 10, color: '#64748b', flexShrink: 0,
        }}>
          <span><strong style={{ color: '#e2e8f0' }}>{stats.session_count}</strong> Sessions</span>
          <span><strong style={{ color: '#10B981' }}>{stats.source_tables}</strong> Sources</span>
          {stats.write_conflicts > 0 && <span style={{ color: '#ef4444' }}><strong>{stats.write_conflicts}</strong> Conflicts</span>}
          {stats.dep_chains > 0 && <span style={{ color: '#F97316' }}><strong>{stats.dep_chains}</strong> Chains</span>}
          {stats.staleness_risks > 0 && <span style={{ color: '#F59E0B' }}><strong>{stats.staleness_risks}</strong> Stale Lookups</span>}
          <span style={{ color: '#94A3B8' }}><strong style={{ color: '#e2e8f0' }}>{stats.max_tier}</strong> Tier Depth</span>
        </div>
      )}

      {/* Chunk summary bar (constellation only) */}
      {view === 'constellation' && selectedChunk && constellation && (
        <ChunkSummary
          chunk={selectedChunk}
          totalSessions={tierData.sessions.length}
          crossChunkEdges={constellation.cross_chunk_edges}
        />
      )}

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {/* Constellation sidebar */}
        {view === 'constellation' && constellation && (
          <ChunkSelector
            chunks={constellation.chunks}
            activeChunkId={selectedChunkId}
            onSelect={(chunkId: string) => setSelectedChunkId(prev => prev === chunkId ? null : chunkId)}
            onBack={() => setSelectedChunkId(null)}
            algorithm={algorithm}
            tableRanking={constellation.table_reference_ranking}
          />
        )}

        {/* View content */}
        <div style={{ flex: 1, overflow: 'hidden', padding: (view === 'tier' || view === 'matrix' || view === 'galaxy' || view === 'constellation') ? 0 : 20 }}>
          {view === 'tier' && scopedTierData && <TierDiagram data={scopedTierData} />}
          {view === 'galaxy' && scopedTierData && (
            <GalaxyMapCanvas
              data={scopedTierData}
              onClose={() => setView('tier')}
            />
          )}
          {view === 'constellation' && tierData && constellation && (
            <ConstellationCanvas
              points={constellation.points}
              chunks={constellation.chunks}
              crossChunkEdges={constellation.cross_chunk_edges}
              onChunkSelect={(chunkId: string) => setSelectedChunkId(prev => prev === chunkId ? null : chunkId)}
              algorithm={algorithm}
              onAlgorithmChange={handleRecluster}
            />
          )}
          {view === 'explorer' && scopedTierData && <ExplorerView data={scopedTierData} />}
          {view === 'conflicts' && scopedTierData && <ConflictsView data={scopedTierData} />}
          {view === 'order' && scopedTierData && <ExecOrderView data={scopedTierData} />}
          {view === 'matrix' && scopedTierData && <MatrixView data={scopedTierData} />}
        </div>
      </div>

      {error && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20, padding: '10px 16px',
          background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: 8, color: '#ef4444', fontSize: 12, maxWidth: 400,
          cursor: 'pointer',
        }}
        onClick={() => setError(null)}
        >
          {error}
        </div>
      )}
    </div>
  );
}
