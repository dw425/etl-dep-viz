/**
 * DependencyApp — Master layout with 15-view tab bar, file upload, persistence,
 * vector analysis, 6-layer navigation, drill-through, and export.
 */

import { lazy, Suspense, useState, useCallback, useEffect, useRef } from 'react';
import type {
  TierMapResult,
  ConstellationResult,
  ConstellationChunk,
  AlgorithmKey,
} from '../../types/tiermap';
import type { VectorResults, DrillFilter } from '../../types/vectors';
import {
  analyzeConstellationStream,
  recluster,
  listUploads,
  getUpload,
  getHealthLogs,
  logActivity,
  upsertUser,
  type StreamEvent,
  type UploadSummary,
  type LogEntry,
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
import VectorControlPanel from './VectorControlPanel';
import DrillThroughPanel from './DrillThroughPanel';
import ExportManager from './ExportManager';
import { NavigationProvider } from '../../navigation/NavigationProvider';
import ErrorBoundary from '../shared/ErrorBoundary';

// Lazy-load vector views
const ComplexityOverlay = lazy(() => import('./ComplexityOverlay'));
const WavePlanView = lazy(() => import('./WavePlanView'));
const UMAPView = lazy(() => import('./UMAPView'));
const WaveSimulator = lazy(() => import('./WaveSimulator'));
const ConcentrationView = lazy(() => import('./ConcentrationView'));
const ConsensusRadar = lazy(() => import('./ConsensusRadar'));
const LayerContainer = lazy(() => import('../../navigation/LayerContainer'));
const L1AInfra = lazy(() => import('../../layers/L1A_InfrastructureTopology'));
const TableExplorer = lazy(() => import('./TableExplorer'));
const DuplicatePipelines = lazy(() => import('./DuplicatePipelines'));
const ChunkingStrategy = lazy(() => import('./ChunkingStrategy'));
const UserProfileView = lazy(() => import('./UserProfileView'));
const FlowWalkerView = lazy(() => import('./FlowWalker'));
const LineageBuilder = lazy(() => import('./LineageBuilder'));
const ImpactAnalysisView = lazy(() => import('./ImpactAnalysis'));
const HelpOverlay = lazy(() => import('../shared/HelpOverlay'));
const AIChat = lazy(() => import('../chat/AIChat'));

type ViewId = 'tier' | 'galaxy' | 'constellation' | 'explorer' | 'conflicts' | 'order' | 'matrix'
  | 'tables' | 'duplicates' | 'chunking'
  | 'complexity' | 'waves' | 'umap' | 'simulator' | 'concentration' | 'consensus'
  | 'layers' | 'infra' | 'profile' | 'flowwalker' | 'lineage' | 'impact' | 'chat';

const VIEWS: { id: ViewId; label: string; icon: string; group?: 'core' | 'vector' | 'nav' | 'harmonize' }[] = [
  { id: 'tier', label: 'Tier Diagram', icon: '\u25A4', group: 'core' },
  { id: 'galaxy', label: 'Galaxy Map', icon: '\u25C9', group: 'core' },
  { id: 'constellation', label: 'Constellation', icon: '\u2726', group: 'core' },
  { id: 'explorer', label: 'Explorer', icon: '\u25CE', group: 'core' },
  { id: 'conflicts', label: 'Conflicts', icon: '\u26A0', group: 'core' },
  { id: 'order', label: 'Exec Order', icon: '\u2193', group: 'core' },
  { id: 'matrix', label: 'Matrix', icon: '\u229E', group: 'core' },
  { id: 'tables', label: 'Tables', icon: '\u2637', group: 'harmonize' },
  { id: 'duplicates', label: 'Duplicates', icon: '\u2261', group: 'harmonize' },
  { id: 'chunking', label: 'Chunking', icon: '\u2699', group: 'harmonize' },
  { id: 'complexity', label: 'Complexity', icon: '\u25A3', group: 'vector' },
  { id: 'waves', label: 'Waves', icon: '\u224B', group: 'vector' },
  { id: 'umap', label: 'UMAP', icon: '\u25CE', group: 'vector' },
  { id: 'simulator', label: 'Simulator', icon: '\u223F', group: 'vector' },
  { id: 'concentration', label: 'Gravity', icon: '\u2295', group: 'vector' },
  { id: 'consensus', label: 'Consensus', icon: '\u25C8', group: 'vector' },
  { id: 'layers', label: 'Layers', icon: '\u25CF', group: 'nav' },
  { id: 'infra', label: 'Infra', icon: '\u229E', group: 'nav' },
  { id: 'flowwalker', label: 'Flow', icon: '\u21C4', group: 'nav' },
  { id: 'lineage', label: 'Lineage', icon: '\u2192', group: 'nav' },
  { id: 'impact', label: 'Impact', icon: '\u26A1', group: 'nav' },
  { id: 'chat', label: 'AI Chat', icon: '\uD83D\uDCAC', group: 'nav' },
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

  // Vector analysis state
  const [vectorResults, setVectorResults] = useState<VectorResults | null>(null);
  const [drillFilter, setDrillFilter] = useState<DrillFilter>({});
  const [rightPanel, setRightPanel] = useState<'vectors' | 'drill' | 'export' | null>(null);

  // Theme state — default light, persist to localStorage
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    (localStorage.getItem('edv-theme') as 'dark' | 'light') || 'light'
  );
  const isDark = theme === 'dark';
  useEffect(() => { localStorage.setItem('edv-theme', theme); }, [theme]);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState('');
  const [error, setError] = useState<{ message: string; phase?: string; type?: string; timestamp?: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Parse timer state
  const [parseStartTime, setParseStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [staleDetected, setStaleDetected] = useState(false);
  const [showLogModal, setShowLogModal] = useState(false);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const lastEventTime = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);

  // Parse timer interval
  useEffect(() => {
    if (!parseStartTime) return;
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - parseStartTime) / 1000);
      setElapsedSeconds(elapsed);
      // Stale detection: no progress event for 60s
      if (lastEventTime.current && Date.now() - lastEventTime.current > 60000) {
        setStaleDetected(true);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [parseStartTime]);

  // Init user on mount
  useEffect(() => { upsertUser().catch(() => {}); }, []);

  // View history (back/forward)
  const viewHistory = useRef<ViewId[]>(['tier']);
  const viewHistoryIdx = useRef(0);
  const navigateView = useCallback((newView: ViewId) => {
    viewHistory.current = viewHistory.current.slice(0, viewHistoryIdx.current + 1);
    viewHistory.current.push(newView);
    viewHistoryIdx.current = viewHistory.current.length - 1;
    setView(newView);
  }, []);
  const goBack = useCallback(() => {
    if (viewHistoryIdx.current > 0) {
      viewHistoryIdx.current--;
      setView(viewHistory.current[viewHistoryIdx.current]);
    }
  }, []);
  const goForward = useCallback(() => {
    if (viewHistoryIdx.current < viewHistory.current.length - 1) {
      viewHistoryIdx.current++;
      setView(viewHistory.current[viewHistoryIdx.current]);
    }
  }, []);

  // Keyboard shortcuts
  const [showHelp, setShowHelp] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === '?') { setShowHelp(h => !h); return; }
      if (e.key === 'Escape') {
        if (showHelp) { setShowHelp(false); return; }
        if (showLogModal) { setShowLogModal(false); return; }
        // Drill up
        goBack();
        return;
      }
      if (e.key === '/') { e.preventDefault(); return; }

      // Alt+Left/Right for view history
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); return; }

      // Number keys 1-6 for layer jump (when in layers view)
      if (e.key >= '1' && e.key <= '6' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const layerViews: ViewId[] = ['tier', 'galaxy', 'constellation', 'explorer', 'conflicts', 'order'];
        const idx = parseInt(e.key) - 1;
        if (idx < layerViews.length) navigateView(layerViews[idx]);
        return;
      }

      // F11 for fullscreen
      if (e.key === 'F11') {
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showHelp, showLogModal, goBack, goForward, navigateView]);

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
    setParseStartTime(Date.now());
    setElapsedSeconds(0);
    setStaleDetected(false);
    lastEventTime.current = Date.now();

    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const sizeStr = totalSize > 1024 * 1024
      ? `${(totalSize / (1024 * 1024)).toFixed(1)}MB`
      : `${(totalSize / 1024).toFixed(0)}KB`;
    setProgressPhase(`Uploading ${sizeStr} (${files.length} file${files.length > 1 ? 's' : ''})...`);

    const ctrl = analyzeConstellationStream(files, algorithm, (event: StreamEvent) => {
      lastEventTime.current = Date.now();
      setStaleDetected(false);
      setProgress(event.percent ?? 0);
      if (event.phase === 'extracting') setProgressPhase(`Extracted ${event.current} files`);
      else if (event.phase === 'parsing') setProgressPhase(`Parsing ${event.filename || ''} (${event.current}/${event.total})`);
      else if (event.phase === 'clustering') setProgressPhase('Clustering...');
      else if (event.phase === 'complete' && event.result) {
        setTierData(event.result.tier_data);
        setConstellation(event.result.constellation);
        setUploadId(event.result.upload_id ?? null);
        setUploading(false);
        setParseStartTime(null);
        setView('chunking');
        listUploads(10).then(setRecentUploads).catch(() => {});
        const fname = files.map(f => f.name).join(', ');
        logActivity('upload', fname, {
          session_count: event.result.tier_data?.stats?.session_count,
          elapsed_ms: event.elapsed_ms,
        });
      } else if (event.phase === 'error' || event.phase === 'timeout') {
        setError({
          message: event.message || 'Upload failed',
          phase: event.phase,
          type: event.phase === 'timeout' ? 'TimeoutError' : 'ParseError',
          timestamp: new Date().toISOString(),
        });
        setUploading(false);
        setParseStartTime(null);
      }
    });
    abortRef.current = ctrl;
  }, [algorithm]);

  // ── Cancel upload ─────────────────────────────────────────────────
  const handleCancelUpload = useCallback(() => {
    abortRef.current?.abort();
    setUploading(false);
    setParseStartTime(null);
    setProgress(0);
    setProgressPhase('');
  }, []);

  // ── Recluster handler ──────────────────────────────────────────────
  const handleRecluster = useCallback(async (algo: AlgorithmKey) => {
    if (!tierData) return;
    setAlgorithm(algo);
    try {
      const result = await recluster(tierData, algo);
      setConstellation(result.constellation);
      setSelectedChunkId(null);
      logActivity('recluster', undefined, { algorithm: algo });
    } catch (e: any) {
      setError({ message: e.message, phase: 'recluster', timestamp: new Date().toISOString() });
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
      logActivity('load', data.filename, { upload_id: id, session_count: data.session_count });
    } catch (e: any) {
      setError({ message: e.message, phase: 'load', timestamp: new Date().toISOString() });
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
    logActivity('export', 'tier_map_export.html', { session_count: tierData.stats?.session_count });
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

  // ── Theme colors ─────────────────────────────────────────────────────
  const T = isDark ? {
    bg: '#080C14', bgCard: '#111827', bgBar: 'rgba(15,23,42,0.9)', bgPanel: 'rgba(15,23,42,0.95)',
    border: '#1e293b', borderActive: '#3b82f6',
    text: '#e2e8f0', textMuted: '#64748b', textDim: '#334155',
    accent: '#3b82f6', accentBg: 'rgba(59,130,246,0.2)', accentText: '#60a5fa',
    dropBg: 'rgba(17,24,39,0.6)', dropBgActive: 'rgba(59,130,246,0.08)',
  } : {
    bg: '#F8FAFC', bgCard: '#FFFFFF', bgBar: 'rgba(248,250,252,0.95)', bgPanel: 'rgba(255,255,255,0.97)',
    border: '#E2E8F0', borderActive: '#2563EB',
    text: '#0F172A', textMuted: '#475569', textDim: '#CBD5E1',
    accent: '#2563EB', accentBg: 'rgba(37,99,235,0.1)', accentText: '#2563EB',
    dropBg: '#FFFFFF', dropBgActive: 'rgba(37,99,235,0.05)',
  };

  // ── Onboarding state ────────────────────────────────────────────────
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('edv-onboarding-complete'));
  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    localStorage.setItem('edv-onboarding-complete', '1');
  }, []);

  // ── No data yet: show dashboard/upload screen ─────────────────────
  if (!tierData) {
    return (
      <div
        style={{
          width: '100%', height: '100vh', background: T.bg, display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24,
        }}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {/* Onboarding tour */}
        {showOnboarding && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              maxWidth: 480, background: T.bgCard, borderRadius: 16, border: `1px solid ${T.border}`,
              padding: 32, textAlign: 'center',
            }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: T.text, marginBottom: 16 }}>
                Welcome to ETL Dep Viz
              </div>
              <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 2, marginBottom: 24, textAlign: 'left' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
                  <span style={{ fontSize: 18, color: T.accent }}>1.</span>
                  <span><strong style={{ color: T.text }}>Upload</strong> your Informatica PowerCenter XML exports or NiFi flow definitions</span>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
                  <span style={{ fontSize: 18, color: T.accent }}>2.</span>
                  <span><strong style={{ color: T.text }}>Explore</strong> tiers, write conflicts, and dependencies across 20+ views</span>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 18, color: T.accent }}>3.</span>
                  <span><strong style={{ color: T.text }}>Analyze</strong> with vector analysis for complexity scoring, wave planning, and UMAP clustering</span>
                </div>
              </div>
              <button onClick={dismissOnboarding} style={{
                padding: '10px 32px', borderRadius: 8, border: 'none',
                background: T.accent, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>
                Get Started
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: T.text, letterSpacing: '-0.02em' }}>
            ETL Dependency Visualizer
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
              style={{
                padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.border}`,
                background: 'transparent', color: T.textMuted, fontSize: 11, cursor: 'pointer',
              }}
            >
              {isDark ? 'Light' : 'Dark'}
            </button>
            <button
              onClick={() => setShowHelp(true)}
              style={{
                padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.border}`,
                background: 'transparent', color: T.textMuted, fontSize: 11, cursor: 'pointer',
              }}
            >
              ? Help
            </button>
          </div>
        </div>
        <div style={{ fontSize: 13, color: T.textMuted, maxWidth: 500, textAlign: 'center' }}>
          Upload Informatica PowerCenter XML or Apache NiFi flow XML files to visualize session dependencies,
          write conflicts, and execution ordering across 20+ interactive views.
        </div>

        {/* Upload zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          style={{
            width: 480, padding: '48px 32px', borderRadius: 16,
            border: `2px dashed ${dragOver ? T.accent : T.border}`,
            background: dragOver ? T.dropBgActive : T.dropBg,
            cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s',
          }}
        >
          {uploading ? (
            <div>
              {/* Spinning animation */}
              <div style={{
                width: 40, height: 40, margin: '0 auto 12px',
                border: `3px solid ${T.border}`, borderTopColor: T.accent,
                borderRadius: '50%',
                animation: 'edv-spin 1s linear infinite',
              }} />
              <style>{`@keyframes edv-spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ fontSize: 13, color: T.text, marginBottom: 4 }}>{progressPhase}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: T.accent, marginBottom: 8, fontVariantNumeric: 'tabular-nums' }}>
                {String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:{String(elapsedSeconds % 60).padStart(2, '0')}
              </div>
              <div style={{ width: '100%', height: 6, borderRadius: 3, background: T.border, overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 3, background: T.accent, width: `${progress}%`, transition: 'width 0.3s' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <div style={{ fontSize: 11, color: T.textMuted }}>{Math.round(progress)}%</div>
                <button onClick={(e) => { e.stopPropagation(); handleCancelUpload(); }}
                  style={{ fontSize: 11, color: '#ef4444', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                  Cancel
                </button>
              </div>
              {staleDetected && (
                <div style={{ fontSize: 11, color: '#F59E0B', marginTop: 8, padding: '6px 10px', background: 'rgba(245,158,11,0.1)', borderRadius: 6 }}>
                  No progress for 60s — the server may be processing a large file
                </div>
              )}
            </div>
          ) : (
            <div>
              <div style={{
                width: 48, height: 48, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 12, background: T.accentBg,
              }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={T.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="12" y1="18" x2="12" y2="12"/>
                  <line x1="9" y1="15" x2="15" y2="15"/>
                </svg>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 8 }}>
                Drop XML or ZIP files here
              </div>
              <div style={{ fontSize: 11, color: T.textMuted }}>
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
            <div>{error.message}</div>
            {error.phase && <div style={{ fontSize: 10, color: T.textMuted, marginTop: 4 }}>Phase: {error.phase}</div>}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 8 }}>
              <button onClick={() => setError(null)}
                style={{ fontSize: 11, color: T.textMuted, background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>
                Dismiss
              </button>
              <button onClick={() => { fileInputRef.current?.click(); }}
                style={{ fontSize: 11, color: T.accent, background: 'transparent', border: `1px solid ${T.accent}`, borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>
                Retry
              </button>
              <button onClick={() => { getHealthLogs(50).then(setLogEntries).catch(() => {}); setShowLogModal(true); }}
                style={{ fontSize: 11, color: '#F59E0B', background: 'transparent', border: `1px solid #F59E0B`, borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>
                View Logs
              </button>
            </div>
          </div>
        )}

        {/* Recent uploads */}
        {recentUploads.length > 0 && (
          <div style={{ maxWidth: 480, width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                Recent Uploads
              </div>
              <button
                onClick={() => { /* Will set view to profile after loading data */ }}
                style={{ fontSize: 10, color: T.accent, background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                View All
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {recentUploads.map(u => (
                <div
                  key={u.id}
                  onClick={() => handleLoadUpload(u.id)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 14px', borderRadius: 8, background: T.bgCard,
                    border: `1px solid ${T.border}`, cursor: 'pointer', transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = T.accent)}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = T.border)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.filename}</div>
                    <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span>{u.platform}</span>
                      <span style={{ fontWeight: 600, color: T.text }}>{u.session_count}</span> sessions
                      {u.parse_duration_ms && <span>{(u.parse_duration_ms / 1000).toFixed(1)}s</span>}
                      {u.created_at && <span>{new Date(u.created_at).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  <div style={{
                    fontSize: 10, color: T.accentText, fontWeight: 600,
                    padding: '4px 12px', borderRadius: 5, background: T.accentBg,
                  }}>Load</div>
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
    <div style={{ width: '100%', height: '100vh', background: T.bg, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{
        padding: '8px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex',
        alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        background: T.bgBar, backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{ fontSize: 14, fontWeight: 800, color: T.text, cursor: 'pointer', letterSpacing: '-0.02em' }}
            onClick={() => { setTierData(null); setConstellation(null); setUploadId(null); setSelectedChunkId(null); }}
          >
            ETL Dep Viz
          </span>
          <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {VIEWS.map(v => {
              const isVector = v.group === 'vector';
              const vectorDisabled = isVector && !vectorResults;
              const specificDisabled = isVector && (
                (v.id === 'complexity' && !vectorResults?.v11_complexity) ||
                (v.id === 'waves' && !vectorResults?.v4_wave_plan) ||
                (v.id === 'umap' && !vectorResults?.v3_dimensionality_reduction) ||
                (v.id === 'simulator' && !vectorResults?.v9_wave_function) ||
                (v.id === 'concentration' && !vectorResults?.v10_concentration) ||
                (v.id === 'consensus' && !vectorResults?.v8_ensemble_consensus)
              );
              const disabled = vectorDisabled || specificDisabled;
              return (
                <button
                  key={v.id}
                  onClick={() => !disabled && navigateView(v.id)}
                  style={{
                    padding: '5px 10px', borderRadius: 6, border: 'none',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontSize: 11, fontWeight: 600,
                    background: view === v.id ? T.accentBg : 'transparent',
                    color: view === v.id ? T.accentText : disabled ? T.textDim : T.textMuted,
                    opacity: disabled ? 0.4 : 1,
                    transition: 'all 0.15s',
                  }}
                >
                  {v.icon} {v.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setRightPanel(rightPanel === 'vectors' ? null : 'vectors')}
            style={{
              padding: '4px 10px', borderRadius: 5,
              border: `1px solid ${rightPanel === 'vectors' ? T.accent : T.border}`,
              background: rightPanel === 'vectors' ? T.accentBg : 'transparent',
              color: rightPanel === 'vectors' ? T.accentText : T.textMuted, fontSize: 10, cursor: 'pointer',
            }}
          >
            {vectorResults ? '✓ Vectors' : 'Vectors'}
          </button>
          <button
            onClick={() => setRightPanel(rightPanel === 'drill' ? null : 'drill')}
            disabled={!vectorResults}
            style={{
              padding: '4px 10px', borderRadius: 5,
              border: `1px solid ${rightPanel === 'drill' ? T.accent : T.border}`,
              background: rightPanel === 'drill' ? T.accentBg : 'transparent',
              color: rightPanel === 'drill' ? T.accentText : T.textMuted, fontSize: 10, cursor: 'pointer',
              opacity: vectorResults ? 1 : 0.4,
            }}
          >
            Drill
          </button>
          <button
            onClick={() => setRightPanel(rightPanel === 'export' ? null : 'export')}
            style={{
              padding: '4px 10px', borderRadius: 5,
              border: `1px solid ${rightPanel === 'export' ? T.accent : T.border}`,
              background: rightPanel === 'export' ? T.accentBg : 'transparent',
              color: rightPanel === 'export' ? T.accentText : T.textMuted, fontSize: 10, cursor: 'pointer',
            }}
          >
            Export
          </button>
          <div style={{ width: 1, height: 16, background: T.border }} />
          <button
            onClick={handleExport}
            style={{
              padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.border}`,
              background: 'transparent', color: T.textMuted, fontSize: 10, cursor: 'pointer',
            }}
          >
            HTML
          </button>
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            style={{
              padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.border}`,
              background: 'transparent', color: T.textMuted, fontSize: 10, cursor: 'pointer',
            }}
          >
            {isDark ? 'Light' : 'Dark'}
          </button>
          <button
            onClick={() => setView('profile' as ViewId)}
            style={{
              padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.border}`,
              background: view === 'profile' ? T.accentBg : 'transparent',
              color: view === 'profile' ? T.accentText : T.textMuted, fontSize: 10, cursor: 'pointer',
            }}
          >
            Profile
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.accent}`,
              background: T.accentBg, color: T.accentText, fontSize: 10, cursor: 'pointer',
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
          padding: '5px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex',
          gap: 20, fontSize: 10, color: T.textMuted, flexShrink: 0,
        }}>
          <span><strong style={{ color: T.text }}>{stats.session_count}</strong> Sessions</span>
          <span><strong style={{ color: '#10B981' }}>{stats.source_tables}</strong> Sources</span>
          {stats.write_conflicts > 0 && <span style={{ color: '#ef4444' }}><strong>{stats.write_conflicts}</strong> Conflicts</span>}
          {stats.dep_chains > 0 && <span style={{ color: '#F97316' }}><strong>{stats.dep_chains}</strong> Chains</span>}
          {stats.staleness_risks > 0 && <span style={{ color: '#F59E0B' }}><strong>{stats.staleness_risks}</strong> Stale Lookups</span>}
          <span><strong style={{ color: T.text }}>{stats.max_tier}</strong> Tier Depth</span>
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
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: '#64748b' }}>Loading view...</div>}>
            <div style={{ flex: 1, overflow: 'hidden', padding: (['tier', 'matrix', 'galaxy', 'constellation', 'tables', 'duplicates'].includes(view)) ? 0 : 20 }}>
              {/* Core views */}
              {view === 'tier' && scopedTierData && <TierDiagram data={scopedTierData} />}
              {view === 'galaxy' && scopedTierData && (
                <GalaxyMapCanvas data={scopedTierData} onClose={() => setView('tier')} />
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

              {/* Data harmonization views */}
              {view === 'tables' && scopedTierData && (
                <ErrorBoundary>
                  <div style={{ overflow: 'hidden', height: '100%' }}>
                    <TableExplorer data={scopedTierData} />
                  </div>
                </ErrorBoundary>
              )}
              {view === 'duplicates' && scopedTierData && (
                <ErrorBoundary>
                  <div style={{ overflow: 'hidden', height: '100%' }}>
                    <DuplicatePipelines data={scopedTierData} />
                  </div>
                </ErrorBoundary>
              )}
              {view === 'chunking' && tierData && (
                <ErrorBoundary>
                  <ChunkingStrategy
                    tierData={tierData}
                    constellation={constellation}
                    vectorResults={vectorResults}
                    onRecluster={handleRecluster}
                    onProceed={(v) => setView(v as ViewId)}
                  />
                </ErrorBoundary>
              )}

              {/* Vector views */}
              {view === 'complexity' && vectorResults?.v11_complexity && (
                <ErrorBoundary>
                  <div style={{ overflow: 'auto', height: '100%' }}>
                    <ComplexityOverlay complexity={vectorResults.v11_complexity} />
                  </div>
                </ErrorBoundary>
              )}
              {view === 'waves' && vectorResults?.v4_wave_plan && (
                <ErrorBoundary>
                  <div style={{ overflow: 'auto', height: '100%' }}>
                    <WavePlanView wavePlan={vectorResults.v4_wave_plan} />
                  </div>
                </ErrorBoundary>
              )}
              {view === 'umap' && vectorResults && (
                <ErrorBoundary>
                  <div style={{ overflow: 'auto', height: '100%' }}>
                    <UMAPView vectorResults={vectorResults} />
                  </div>
                </ErrorBoundary>
              )}
              {view === 'simulator' && vectorResults?.v9_wave_function && tierData && (
                <ErrorBoundary>
                  <div style={{ overflow: 'auto', height: '100%' }}>
                    <WaveSimulator waveFunction={vectorResults.v9_wave_function} tierData={tierData} />
                  </div>
                </ErrorBoundary>
              )}
              {view === 'concentration' && vectorResults?.v10_concentration && (
                <ErrorBoundary>
                  <div style={{ overflow: 'auto', height: '100%' }}>
                    <ConcentrationView concentration={vectorResults.v10_concentration} />
                  </div>
                </ErrorBoundary>
              )}
              {view === 'consensus' && vectorResults?.v8_ensemble_consensus && (
                <ErrorBoundary>
                  <div style={{ overflow: 'auto', height: '100%' }}>
                    <ConsensusRadar ensemble={vectorResults.v8_ensemble_consensus} />
                  </div>
                </ErrorBoundary>
              )}

              {/* Layer navigation */}
              {view === 'layers' && tierData && (
                <ErrorBoundary>
                  <NavigationProvider initialTierData={tierData} initialVectorResults={vectorResults} onVectorResults={setVectorResults}>
                    <div style={{ overflow: 'auto', height: '100%' }}>
                      <LayerContainer />
                    </div>
                  </NavigationProvider>
                </ErrorBoundary>
              )}
              {view === 'infra' && tierData && (
                <ErrorBoundary>
                  <div style={{ overflow: 'auto', height: '100%' }}>
                    <L1AInfra tierData={tierData} vectorResults={vectorResults} />
                  </div>
                </ErrorBoundary>
              )}

              {/* Flow Walker */}
              {view === 'flowwalker' && tierData && (
                <ErrorBoundary>
                  <div style={{ overflow: 'hidden', height: '100%' }}>
                    <FlowWalkerView tierData={tierData} vectorResults={vectorResults} />
                  </div>
                </ErrorBoundary>
              )}

              {/* Lineage Builder (Items 53-54) */}
              {view === 'lineage' && tierData && (
                <ErrorBoundary>
                  <div style={{ overflow: 'hidden', height: '100%' }}>
                    <LineageBuilder tierData={tierData} />
                  </div>
                </ErrorBoundary>
              )}

              {/* Impact Analysis (Item 55) */}
              {view === 'impact' && tierData && (
                <ErrorBoundary>
                  <div style={{ overflow: 'hidden', height: '100%' }}>
                    <ImpactAnalysisView tierData={tierData} />
                  </div>
                </ErrorBoundary>
              )}

              {/* AI Chat */}
              {view === 'chat' && (
                <ErrorBoundary>
                  <div style={{ overflow: 'hidden', height: '100%' }}>
                    <AIChat uploadId={uploadId} tierData={tierData} />
                  </div>
                </ErrorBoundary>
              )}

              {/* User Profile */}
              {view === 'profile' && (
                <ErrorBoundary>
                  <div style={{ overflow: 'auto', height: '100%' }}>
                    <UserProfileView onLoadUpload={handleLoadUpload} />
                  </div>
                </ErrorBoundary>
              )}
            </div>
          </Suspense>
        </div>

        {/* Right sidebar panel */}
        {rightPanel && tierData && (
          <div style={{ width: 280, borderLeft: `1px solid ${T.border}`, overflow: 'auto', padding: 12, flexShrink: 0, background: T.bgPanel }}>
            {rightPanel === 'vectors' && (
              <VectorControlPanel tierData={tierData} vectorResults={vectorResults} onVectorResults={setVectorResults} />
            )}
            {rightPanel === 'drill' && vectorResults && (
              <DrillThroughPanel vectorResults={vectorResults} filter={drillFilter} onFilterChange={setDrillFilter} uploadId={uploadId} />
            )}
            {rightPanel === 'export' && (
              <ExportManager tierData={tierData} vectorResults={vectorResults} />
            )}
          </div>
        )}
      </div>

      {error && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20, padding: '10px 16px',
          background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: 8, color: '#ef4444', fontSize: 12, maxWidth: 400,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div>
              {error.phase && <span style={{ fontSize: 10, opacity: 0.7 }}>[{error.phase}] </span>}
              {error.message}
            </div>
            <button onClick={() => setError(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>x</button>
          </div>
          <button onClick={() => { getHealthLogs(50).then(setLogEntries).catch(() => {}); setShowLogModal(true); }}
            style={{ fontSize: 10, color: '#F59E0B', background: 'transparent', border: 'none', cursor: 'pointer', marginTop: 4, padding: 0, textDecoration: 'underline' }}>
            View Logs
          </button>
        </div>
      )}

      {/* Help overlay */}
      {showHelp && (
        <Suspense fallback={null}>
          <HelpOverlay onClose={() => setShowHelp(false)} views={VIEWS} theme={T} />
        </Suspense>
      )}

      {/* Log viewer modal */}
      {showLogModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }} onClick={() => setShowLogModal(false)}>
          <div style={{
            width: 640, maxHeight: '70vh', background: T.bgCard, borderRadius: 12,
            border: `1px solid ${T.border}`, overflow: 'hidden',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Server Logs</span>
              <button onClick={() => setShowLogModal(false)} style={{ background: 'transparent', border: 'none', color: T.textMuted, cursor: 'pointer', fontSize: 16 }}>x</button>
            </div>
            <div style={{ overflow: 'auto', maxHeight: '60vh', padding: 8, fontFamily: 'monospace', fontSize: 11 }}>
              {logEntries.length === 0 && <div style={{ color: T.textMuted, padding: 16, textAlign: 'center' }}>No log entries</div>}
              {logEntries.map((entry, i) => (
                <div key={i} style={{ padding: '4px 8px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 8 }}>
                  <span style={{
                    color: entry.level === 'ERROR' ? '#ef4444' : entry.level === 'WARNING' ? '#F59E0B' : entry.level === 'INFO' ? '#10B981' : T.textMuted,
                    fontWeight: 600, minWidth: 50,
                  }}>{entry.level}</span>
                  <span style={{ color: T.textMuted, minWidth: 70 }}>{entry.timestamp.split('T')[1]?.slice(0, 8)}</span>
                  <span style={{ color: T.text, wordBreak: 'break-all' }}>{entry.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
