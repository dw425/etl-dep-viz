/**
 * DependencyApp — Master layout with 15-view tab bar, file upload, persistence,
 * vector analysis, 6-layer navigation, drill-through, and export.
 *
 * Layout:
 *   Top bar    — tab navigation, right-panel toggles, upload/export actions
 *   Stats bar  — session/table/conflict counts from parsed data
 *   Main area  — active view (left) + optional right sidebar panel
 *   Overlays   — help modal, log viewer modal, onboarding tour
 */

import { lazy, Suspense, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type {
  TierMapResult,
  ConstellationResult,
  ConstellationChunk,
  AlgorithmKey,
} from '../../types/tiermap';
import type { VectorResults, DrillFilter } from '../../types/vectors';
import {
  analyzeConstellationStream,
  analyzeVectors,
  recluster,
  listUploads,
  getUpload,
  getCachedVectors,
  getHealthLogs,
  logActivity,
  upsertUser,
  listProjects,
  createProject,
  getProject,
  deleteProject,
  type StreamEvent,
  type UploadSummary,
  type LogEntry,
  type ProjectSummary,
} from '../../api/client';
import { useUrlState, type UrlState } from '../../navigation/useUrlState';
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

// ── Lazy imports (code-split heavy views to keep initial bundle small) ────────
const ComplexityOverlay = lazy(() => import('./ComplexityOverlay'));
const WavePlanView = lazy(() => import('./WavePlanView'));
const HeatMapView = lazy(() => import('./HeatMapView'));
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
const AdminConsole = lazy(() => import('./AdminConsole'));

// ── View registry ─────────────────────────────────────────────────────────────
// ViewId is the union of all valid tab identifiers. Adding a new tab requires:
//   1. Adding its id to ViewId  2. Adding it to VIEWS  3. Rendering it below.
type ViewId = 'tier' | 'galaxy' | 'constellation' | 'explorer' | 'conflicts' | 'order' | 'matrix'
  | 'tables' | 'duplicates' | 'chunking'
  | 'complexity' | 'waves' | 'heatmap' | 'umap' | 'simulator' | 'concentration' | 'consensus'
  | 'layers' | 'infra' | 'profile' | 'flowwalker' | 'lineage' | 'impact' | 'chat' | 'admin';

// Group determines tab section: core, harmonize, vector, nav
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
  { id: 'heatmap', label: 'Heat Map', icon: '\u2593', group: 'vector' },
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

function VectorFallback({ label, phase = 1, onRun, onRunDirect }: { label: string; phase?: number; onRun: () => void; onRunDirect?: () => void }) {
  const [running, setRunning] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16 }}>
      <div style={{ fontSize: 36, opacity: 0.3 }}>&#x25A3;</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#64748b' }}>{label} — No Data Yet</div>
      <div style={{ fontSize: 11, color: '#475569', maxWidth: 320, textAlign: 'center' }}>
        {running
          ? `Running Phase ${phase} analysis...`
          : phase === 1
            ? 'Run Phase 1 vector analysis to enable this view.'
            : `Run Phase ${phase} vector analysis to enable this view.`}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {onRunDirect && !running && (
          <button
            onClick={() => { setRunning(true); onRunDirect(); }}
            style={{
              padding: '8px 20px', borderRadius: 6, border: '1px solid #10B981',
              background: '#10B981', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Run Now
          </button>
        )}
        {running && (
          <div style={{ padding: '8px 20px', fontSize: 12, color: '#A855F7' }}>Analyzing...</div>
        )}
        <button
          onClick={onRun}
          style={{
            padding: '8px 20px', borderRadius: 6, border: '1px solid #A855F7',
            background: 'transparent', color: '#A855F7', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {phase === 1 ? 'Go to Chunking' : 'Open Vectors Panel'}
        </button>
      </div>
    </div>
  );
}

export function DependencyApp() {
  // ── Project state ──────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(() => {
    const saved = localStorage.getItem('edv-project-id');
    return saved ? Number(saved) : null;
  });
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  // ── Core data state ────────────────────────────────────────────────────────
  const [view, setView] = useState<ViewId>('tier');
  const [tierData, setTierData] = useState<TierMapResult | null>(null);
  const [constellation, setConstellation] = useState<ConstellationResult | null>(null);
  const [algorithm, setAlgorithm] = useState<AlgorithmKey>('louvain');
  const [selectedChunkIds, setSelectedChunkIds] = useState<Set<string>>(new Set());
  // Session search highlight state
  const [highlightedSessionIds, setHighlightedSessionIds] = useState<Set<string>>(new Set());
  // uploadId is passed to the vector/export endpoints to avoid re-sending large tier data
  const [uploadId, setUploadId] = useState<number | null>(null);
  const [recentUploads, setRecentUploads] = useState<UploadSummary[]>([]);

  // ── Vector analysis state ──────────────────────────────────────────────────
  const [vectorResults, setVectorResults] = useState<VectorResults | null>(null);
  const [drillFilter, setDrillFilter] = useState<DrillFilter>({});
  // rightPanel: which sidebar panel is open (null = collapsed)
  const [rightPanel, setRightPanel] = useState<'vectors' | 'drill' | 'export' | null>(null);

  // ── Theme state — default light, persist to localStorage ──────────────────
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    (localStorage.getItem('edv-theme') as 'dark' | 'light') || 'light'
  );
  const isDark = theme === 'dark';
  useEffect(() => { localStorage.setItem('edv-theme', theme); }, [theme]);

  // ── Upload / streaming state ───────────────────────────────────────────────
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState('');
  const [error, setError] = useState<{ message: string; phase?: string; type?: string; timestamp?: string } | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; severity: 'error' | 'warning' | 'info' | 'success' }>>([]);
  const toastIdRef = useRef(0);
  const addToast = useCallback((message: string, severity: 'error' | 'warning' | 'info' | 'success' = 'error') => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev.slice(-4), { id, message, severity }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 10000);
  }, []);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Parse timer / stale detection ─────────────────────────────────────────
  // parseStartTime drives the elapsed mm:ss counter in the upload UI
  const [parseStartTime, setParseStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // staleDetected becomes true when no SSE progress event arrives for 120s
  const [staleDetected, setStaleDetected] = useState(false);
  const [showLogPanel, setShowLogPanel] = useState(false);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  // 5-minute cooldown: after user closes the log panel, suppress auto-reopen until cooldown expires
  const logDismissedAt = useRef<number>(0);
  // lastEventTime is a ref (not state) so updates don't cause re-renders
  const lastEventTime = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);

  // Tick the elapsed counter every second while an upload is running
  useEffect(() => {
    if (!parseStartTime) return;
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - parseStartTime) / 1000);
      setElapsedSeconds(elapsed);
      // Stale detection: no progress event for 120s → auto-show server logs
      // but only if user hasn't dismissed the panel within the last 5 minutes
      if (lastEventTime.current && Date.now() - lastEventTime.current > 120000) {
        if (!staleDetected) {
          setStaleDetected(true);
          const cooldownExpired = Date.now() - logDismissedAt.current > 5 * 60 * 1000;
          if (cooldownExpired) {
            getHealthLogs(100).then(setLogEntries).catch(() => {});
            setShowLogPanel(true);
          }
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [parseStartTime]);

  // Auto-refresh logs every 10s while log panel is open and upload is active
  useEffect(() => {
    if (!showLogPanel || !uploading) return;
    const interval = setInterval(() => {
      getHealthLogs(100).then(setLogEntries).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [showLogPanel, uploading]);

  // Register/refresh the user profile record on first render
  useEffect(() => { upsertUser().catch(() => {}); }, []);

  // ── View history (browser-style back/forward) ──────────────────────────────
  // Stored in refs so history mutations don't trigger re-renders
  const viewHistory = useRef<ViewId[]>(['tier']);
  const viewHistoryIdx = useRef(0);
  // Truncates forward history on each navigation (like a browser)
  const navigateView = useCallback((newView: ViewId) => {
    viewHistory.current = viewHistory.current.slice(0, viewHistoryIdx.current + 1);
    viewHistory.current.push(newView);
    viewHistoryIdx.current = viewHistory.current.length - 1;
    setView(newView);
    localStorage.setItem('edv-last-view', newView);
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

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  // ?         — toggle help overlay
  // Esc       — close overlay / drill up via goBack
  // Alt+←/→   — view history navigation
  // 1-6       — jump to core views (tier/galaxy/constellation/explorer/conflicts/order)
  // F11       — toggle browser fullscreen
  const [showHelp, setShowHelp] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === '?') { setShowHelp(h => !h); return; }
      if (e.key === 'Escape') {
        if (showHelp) { setShowHelp(false); return; }
        if (showLogPanel) { setShowLogPanel(false); return; }
        // Drill up through view history
        goBack();
        return;
      }
      if (e.key === '/') { e.preventDefault(); return; }

      // Alt+Left/Right for view history
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); return; }

      // Number keys 1-6 jump directly to core views
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
  }, [showHelp, showLogPanel, goBack, goForward, navigateView]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const selectedChunks = constellation?.chunks.filter(c => selectedChunkIds.has(c.id)) ?? [];
  const hasChunkSelection = selectedChunks.length > 0;

  // ── Multi-select handlers ─────────────────────────────────────────────────
  const handleChunkToggle = useCallback((chunkId: string) => {
    setSelectedChunkIds(prev => {
      const next = new Set(prev);
      if (next.has(chunkId)) next.delete(chunkId);
      else next.add(chunkId);
      return next;
    });
  }, []);
  const handleSelectAll = useCallback(() => {
    if (!constellation) return;
    setSelectedChunkIds(new Set(constellation.chunks.map(c => c.id)));
  }, [constellation]);
  const handleDeselectAll = useCallback(() => {
    setSelectedChunkIds(new Set());
  }, []);

  // ── Session search: session → tables map ──────────────────────────────────
  const sessionTableMap = useMemo(() => {
    if (!tierData) return new Map<string, Set<string>>();
    const map = new Map<string, Set<string>>();
    const tableIdToName = new Map(tierData.tables.map((t: any) => [t.id, t.name]));
    for (const conn of tierData.connections) {
      const fromIsSession = conn.from.startsWith('S');
      const toIsSession = conn.to.startsWith('S');
      if (fromIsSession) {
        const tName = tableIdToName.get(conn.to);
        if (tName) {
          if (!map.has(conn.from)) map.set(conn.from, new Set());
          map.get(conn.from)!.add(tName);
        }
      }
      if (toIsSession) {
        const tName = tableIdToName.get(conn.from);
        if (tName) {
          if (!map.has(conn.to)) map.set(conn.to, new Set());
          map.get(conn.to)!.add(tName);
        }
      }
    }
    return map;
  }, [tierData]);

  const handleHighlightSession = useCallback((sessionId: string) => {
    setHighlightedSessionIds(new Set([sessionId]));
  }, []);

  const handleFindLinked = useCallback((sessionId: string) => {
    const tables = sessionTableMap.get(sessionId);
    if (!tables || tables.size === 0) return;
    const linked = new Set<string>([sessionId]);
    for (const [sid, sTables] of sessionTableMap) {
      if (sid === sessionId) continue;
      for (const t of sTables) {
        if (tables.has(t)) { linked.add(sid); break; }
      }
    }
    setHighlightedSessionIds(linked);
  }, [sessionTableMap]);

  // Load projects list on mount
  useEffect(() => {
    listProjects().then(setProjects).catch(() => {});
  }, []);

  // Persist active project to localStorage
  useEffect(() => {
    if (activeProjectId) localStorage.setItem('edv-project-id', String(activeProjectId));
    else localStorage.removeItem('edv-project-id');
  }, [activeProjectId]);

  // Populate the Recent Uploads list shown on the dashboard before any data is loaded
  useEffect(() => {
    listUploads(10).then(setRecentUploads).catch(() => {});
  }, []);

  // ── Upload handler ─────────────────────────────────────────────────────────
  // Initiates an SSE stream upload; handles progress, completion, error, and timeout phases
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

    // Format total file size for display in the progress label
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const sizeStr = totalSize > 1024 * 1024
      ? `${(totalSize / (1024 * 1024)).toFixed(1)}MB`
      : `${(totalSize / 1024).toFixed(0)}KB`;
    setProgressPhase(`Uploading ${sizeStr} (${files.length} file${files.length > 1 ? 's' : ''})...`);

    // Open SSE stream; each event updates the progress UI
    const ctrl = analyzeConstellationStream(files, algorithm, (event: StreamEvent) => {
      lastEventTime.current = Date.now();
      setStaleDetected(false);
      setProgress(event.percent ?? 0);
      if (event.phase === 'extracting') {
        const sizePart = event.total_size_mb ? ` (${event.total_size_mb}MB total)` : '';
        setProgressPhase(`Extracted ${event.current} files${sizePart}`);
      } else if (event.phase === 'parsing') {
        const fsize = event.file_size_mb ? ` (${event.file_size_mb}MB)` : '';
        const sessions = event.sessions_found ? ` — ${event.sessions_found.toLocaleString()} sessions found` : '';
        const eta = event.eta_ms && event.eta_ms > 5000 ? ` — ETA ${Math.ceil(event.eta_ms / 1000)}s` : '';
        setProgressPhase(`Parsing ${event.filename || ''}${fsize} (${event.current}/${event.total})${sessions}${eta}`);
      }
      else if (event.phase === 'clustering') setProgressPhase('Clustering...');
      else if (event.phase === 'complete' && event.result) {
        setTierData(event.result.tier_data);
        setConstellation(event.result.constellation);
        const newUploadId = event.result.upload_id ?? null;
        setUploadId(newUploadId);
        if (newUploadId) localStorage.setItem('edv-last-upload', String(newUploadId));
        setUploading(false);
        setParseStartTime(null);
        setView('chunking');
        localStorage.setItem('edv-last-view', 'chunking');
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
    }, activeProjectId ?? undefined);
    abortRef.current = ctrl;
  }, [algorithm, activeProjectId]);

  // ── Cancel upload — aborts the in-flight fetch via AbortController ───────
  const handleCancelUpload = useCallback(() => {
    abortRef.current?.abort();
    setUploading(false);
    setParseStartTime(null);
    setProgress(0);
    setProgressPhase('');
  }, []);

  // ── Recluster — re-runs clustering on already-parsed tierData, no re-upload ─
  const handleRecluster = useCallback(async (algo: AlgorithmKey) => {
    if (!tierData) return;
    setAlgorithm(algo);
    setSelectedChunkIds(new Set());
    if (algo === 'gradient_scale') {
      // Pure frontend mode — no backend call needed
      return;
    }
    try {
      const result = await recluster(tierData, algo);
      setConstellation(result.constellation);
      logActivity('recluster', undefined, { algorithm: algo });
    } catch (e: any) {
      setError({ message: e.message, phase: 'recluster', timestamp: new Date().toISOString() });
    }
  }, [tierData]);

  // ── Load from persistence — restores tier/constellation/vector data from SQLite ────
  const handleLoadUpload = useCallback(async (id: number, restoreView?: string) => {
    try {
      const data = await getUpload(id);
      setTierData(data.tier_data);
      setConstellation(data.constellation ?? null);
      setUploadId(data.upload_id);
      setAlgorithm((data.algorithm as AlgorithmKey) || 'louvain');
      // Restore vector results if returned from backend
      if (data.vector_results) {
        setVectorResults(data.vector_results);
      }
      // Persist to localStorage for cross-refresh recovery
      localStorage.setItem('edv-last-upload', String(data.upload_id));
      // Navigate to requested view, or last saved view, or default to 'tier'
      const targetView = restoreView || localStorage.getItem('edv-last-view') || 'tier';
      const validViews = VIEWS.map(v => v.id);
      setView(validViews.includes(targetView as ViewId) ? (targetView as ViewId) : 'tier');
      setError(null);
      logActivity('load', data.filename, { upload_id: id, session_count: data.session_count });
    } catch (e: any) {
      setError({ message: e.message, phase: 'load', timestamp: new Date().toISOString() });
    }
  }, []);

  // ── URL state sync + auto-restore ────────────────────────────────────────
  const { initialState: urlState, updateUrl } = useUrlState(
    useCallback((state: UrlState) => {
      // Handle browser back/forward for deep-linked views
      if (state.view) {
        const validViews = VIEWS.map(v => v.id);
        if (validViews.includes(state.view as ViewId)) setView(state.view as ViewId);
      }
    }, []),
  );

  // Sync current state to URL whenever view or uploadId changes
  useEffect(() => {
    const chunkParam = selectedChunkIds.size > 0 ? Array.from(selectedChunkIds).join(',') : undefined;
    updateUrl({
      view: view,
      upload: uploadId ? String(uploadId) : undefined,
      chunk: chunkParam,
    });
  }, [view, uploadId, selectedChunkIds, updateUrl]);

  // Auto-restore: ONLY from URL params (deep links), never from localStorage alone.
  // Users should always see the dashboard/project screen on fresh load.
  const autoRestoreRef = useRef(false);
  useEffect(() => {
    if (autoRestoreRef.current) return;
    autoRestoreRef.current = true;
    const urlUpload = urlState.upload;
    if (urlUpload) {
      handleLoadUpload(Number(urlUpload), urlState.view);
    }
  }, [handleLoadUpload, urlState]);

  // ── Export HTML — generates a self-contained static report and triggers download ─
  const handleExport = useCallback(() => {
    if (!tierData) return;
    const html = buildTierMapHTML(tierData, constellation ?? undefined);
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
  }, [tierData, constellation]);

  // ── Drag & drop — filters to only .xml and .zip files before upload ──────
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.name.toLowerCase().endsWith('.xml') || f.name.toLowerCase().endsWith('.zip'),
    );
    if (files.length) handleUpload(files);
  }, [handleUpload]);

  // ── Drill filter: compute matching session IDs ─────────────────────────────
  const drillMatchingIds = useMemo(() => {
    if (!vectorResults || Object.keys(drillFilter).length === 0) return null;
    let ids: Set<string> | null = null;
    const intersect = (a: Set<string>, b: Set<string>) => {
      const r = new Set<string>(); for (const x of a) if (b.has(x)) r.add(x); return r;
    };
    if (drillFilter.complexity_bucket) {
      const matching = new Set<string>();
      for (const score of (vectorResults.v11_complexity?.scores ?? [])) {
        if ((score as any).bucket === drillFilter.complexity_bucket) matching.add((score as any).session_id);
      }
      ids = matching;
    }
    if (drillFilter.wave_number?.length) {
      const waveSet = new Set(drillFilter.wave_number);
      const matching = new Set<string>();
      for (const wave of (vectorResults.v4_wave_plan?.waves ?? [])) {
        if (waveSet.has((wave as any).wave_number)) {
          for (const sid of (wave as any).session_ids) matching.add(sid);
        }
      }
      ids = ids ? intersect(ids, matching) : matching;
    }
    if (drillFilter.criticality_tier_min != null) {
      const matching = new Set<string>();
      for (const sc of ((vectorResults as any).v9_wave_function?.sessions ?? [])) {
        if ((sc.criticality_tier ?? 0) >= drillFilter.criticality_tier_min!) matching.add(sc.session_id);
      }
      ids = ids ? intersect(ids, matching) : matching;
    }
    if (drillFilter.community_macro != null) {
      const matching = new Set<string>();
      const macros = (vectorResults as any).v1_communities?.macro_communities ?? {};
      const sids = macros[String(drillFilter.community_macro)] ?? [];
      for (const sid of sids) matching.add(sid);
      ids = ids ? intersect(ids, matching) : matching;
    }
    if (drillFilter.is_independent) {
      const matching = new Set<string>();
      for (const s of ((vectorResults as any).v10_concentration?.independent_sessions ?? [])) {
        matching.add(s.session_id);
      }
      ids = ids ? intersect(ids, matching) : matching;
    }
    return ids ?? new Set<string>();
  }, [vectorResults, drillFilter]);

  // ── Scoped data for constellation chunk + drill filter ─────────────────────
  // When clusters are selected, filter to those clusters' sessions.
  // When drill filter is active, further filter to matching sessions.
  const scopedTierData = (() => {
    let data = tierData;
    if (!data) return data;

    // 1. Chunk filter
    if (hasChunkSelection) {
      const ids = new Set<string>();
      for (const chunk of selectedChunks) for (const sid of chunk.session_ids) ids.add(sid);
      const sessions = data.sessions.filter(s => ids.has(s.id));
      const sessionIds = new Set(sessions.map(s => s.id));
      const connections = data.connections.filter(c => sessionIds.has(c.from) || sessionIds.has(c.to));
      const tableIds = new Set<string>();
      connections.forEach(c => {
        if (!sessionIds.has(c.from)) tableIds.add(c.from);
        if (!sessionIds.has(c.to)) tableIds.add(c.to);
      });
      const tables = data.tables.filter(t => tableIds.has(t.id));
      data = { ...data, sessions, tables, connections };
    }

    // 2. Drill filter
    if (drillMatchingIds && data) {
      const sessions = data.sessions.filter(s => drillMatchingIds.has(s.id));
      const sessionIds = new Set(sessions.map(s => s.id));
      const connections = data.connections.filter(c => sessionIds.has(c.from) || sessionIds.has(c.to));
      const tableIds = new Set<string>();
      connections.forEach(c => {
        if (!sessionIds.has(c.from)) tableIds.add(c.from);
        if (!sessionIds.has(c.to)) tableIds.add(c.to);
      });
      const tables = data.tables.filter(t => tableIds.has(t.id));
      data = { ...data, sessions, tables, connections };
    }

    return data;
  })();

  const stats = tierData?.stats;

  // ── Theme token map — all JSX uses T.* so switching themes is a one-liner ──
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

  // ── Onboarding — shown once until dismissed, then suppressed via localStorage
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('edv-onboarding-complete'));
  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    localStorage.setItem('edv-onboarding-complete', '1');
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  // Single return with fragment: dashboard OR main layout, then shared overlays.
  // This eliminates the early-return pattern that previously prevented modals
  // from rendering on the dashboard screen.
  return (
    <>
    {!tierData ? (
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

        {/* Project selector */}
        <div style={{ maxWidth: 480, width: '100%', margin: '8px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Project
            </div>
            <button
              onClick={() => setShowNewProject(!showNewProject)}
              style={{ fontSize: 10, color: T.accent, background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              + New Project
            </button>
          </div>
          {showNewProject && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                value={newProjectName}
                onChange={e => setNewProjectName(e.target.value)}
                placeholder="Project name..."
                onKeyDown={e => {
                  if (e.key === 'Enter' && newProjectName.trim()) {
                    createProject(newProjectName.trim()).then(p => {
                      setProjects(prev => [p, ...prev]);
                      setActiveProjectId(p.id);
                      setNewProjectName('');
                      setShowNewProject(false);
                    }).catch(() => {});
                  }
                }}
                style={{
                  flex: 1, padding: '6px 10px', borderRadius: 6,
                  border: `1px solid ${T.border}`, background: T.bgCard,
                  color: T.text, fontSize: 12, outline: 'none',
                }}
              />
              <button
                onClick={() => {
                  if (!newProjectName.trim()) return;
                  createProject(newProjectName.trim()).then(p => {
                    setProjects(prev => [p, ...prev]);
                    setActiveProjectId(p.id);
                    setNewProjectName('');
                    setShowNewProject(false);
                  }).catch(() => {});
                }}
                style={{
                  padding: '6px 14px', borderRadius: 6, border: 'none',
                  background: T.accent, color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Create
              </button>
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {projects.map(p => (
              <button
                key={p.id}
                onClick={() => {
                  setActiveProjectId(p.id);
                  // Load project's uploads
                  getProject(p.id).then(proj => {
                    if (proj.uploads?.length) {
                      setRecentUploads(proj.uploads.map(u => ({
                        id: u.id, filename: u.filename, platform: u.platform,
                        session_count: u.session_count, created_at: u.created_at || '',
                        algorithm: null, parse_duration_ms: null, project_id: p.id,
                      })));
                    }
                  }).catch(() => {});
                }}
                style={{
                  padding: '6px 14px', borderRadius: 8,
                  border: `1px solid ${activeProjectId === p.id ? T.accent : T.border}`,
                  background: activeProjectId === p.id ? T.accentBg : T.bgCard,
                  color: activeProjectId === p.id ? T.accent : T.text,
                  fontSize: 12, fontWeight: activeProjectId === p.id ? 700 : 400,
                  cursor: 'pointer', transition: 'all 0.15s',
                }}
              >
                {p.name}
                <span style={{ fontSize: 10, color: T.textMuted, marginLeft: 6 }}>
                  {p.upload_count} upload{p.upload_count !== 1 ? 's' : ''}
                </span>
              </button>
            ))}
            {projects.length === 0 && !showNewProject && (
              <div style={{ fontSize: 11, color: T.textMuted }}>
                No projects yet. Create one to organize your uploads.
              </div>
            )}
          </div>
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
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <button onClick={async (e) => { e.stopPropagation(); setLogLoading(true); setShowLogPanel(true); try { setLogEntries(await getHealthLogs(100)); } catch { /* */ } finally { setLogLoading(false); } }}
                    style={{ fontSize: 11, color: '#F59E0B', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                    View Logs
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleCancelUpload(); }}
                    style={{ fontSize: 11, color: '#ef4444', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                    Cancel
                  </button>
                </div>
              </div>
              {staleDetected && (
                <div style={{ fontSize: 11, color: '#F59E0B', marginTop: 8, padding: '6px 10px', background: 'rgba(245,158,11,0.1)', borderRadius: 6 }}>
                  No progress for 120s — server logs opened automatically. Check for errors above.
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
              <button onClick={async () => { setLogLoading(true); setShowLogPanel(true); try { setLogEntries(await getHealthLogs(50)); } catch { /* no-op */ } finally { setLogLoading(false); } }}
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
    ) : (
    <div style={{ width: '100%', height: '100vh', background: T.bg, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{
        padding: '8px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex',
        alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        background: T.bgBar, backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Logo — clicking resets to dashboard (tierData = null) */}
          <span
            style={{ fontSize: 14, fontWeight: 800, color: T.text, cursor: 'pointer', letterSpacing: '-0.02em' }}
            onClick={() => { setTierData(null); setConstellation(null); setUploadId(null); setSelectedChunkIds(new Set()); }}
          >
            ETL Dep Viz
          </span>
          {/* ── Tab bar — vector tabs disabled until vector analysis has run ── */}
          <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {VIEWS.map(v => {
              const isVector = v.group === 'vector';
              const hasVectorData = isVector && vectorResults;
              return (
                <button
                  key={v.id}
                  onClick={() => navigateView(v.id)}
                  style={{
                    padding: '5px 10px', borderRadius: 6, border: 'none',
                    cursor: 'pointer',
                    fontSize: 11, fontWeight: 600,
                    background: view === v.id ? T.accentBg : 'transparent',
                    color: view === v.id ? T.accentText : (isVector && !hasVectorData) ? T.textDim : T.textMuted,
                    opacity: (isVector && !hasVectorData) ? 0.6 : 1,
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
            onClick={async () => { setLogLoading(true); setShowLogPanel(true); try { setLogEntries(await getHealthLogs(100)); } catch { /* no-op */ } finally { setLogLoading(false); } }}
            style={{
              padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.border}`,
              background: 'transparent', color: '#F59E0B', fontSize: 10, cursor: 'pointer',
            }}
          >
            Logs
          </button>
          <button
            onClick={() => setShowHelp(true)}
            style={{
              padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.border}`,
              background: 'transparent', color: T.textMuted, fontSize: 10, cursor: 'pointer',
            }}
          >
            ? Help
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
            onClick={() => setView('admin' as ViewId)}
            style={{
              padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.border}`,
              background: view === 'admin' ? T.accentBg : 'transparent',
              color: view === 'admin' ? T.accentText : T.textMuted, fontSize: 10, cursor: 'pointer',
            }}
          >
            Admin
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
          {/* Platform cards from connection_profiles */}
          {(() => {
            const profiles = (tierData as any)?.connection_profiles as Array<{ name: string; dbtype: string }> | undefined;
            if (!profiles || profiles.length === 0) return null;
            const platforms = new Map<string, number>();
            profiles.forEach(p => {
              const t = p.dbtype || 'Unknown';
              platforms.set(t, (platforms.get(t) || 0) + 1);
            });
            const PLATFORM_COLORS: Record<string, string> = {
              'Oracle': '#EF4444', 'SQL Server': '#3B82F6', 'Teradata': '#F97316',
              'DB2': '#10B981', 'Sybase': '#A855F7', 'Informix': '#06B6D4',
              'ODBC': '#64748b', 'Unknown': '#475569',
            };
            return [...platforms.entries()].map(([dbtype, count]) => (
              <span key={dbtype} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: 3,
                  background: PLATFORM_COLORS[dbtype] || '#64748b',
                  display: 'inline-block',
                }} />
                <strong style={{ color: PLATFORM_COLORS[dbtype] || '#64748b' }}>{count}</strong> {dbtype}
              </span>
            ));
          })()}
        </div>
      )}

      {/* Chunk summary bar (constellation only) */}
      {view === 'constellation' && hasChunkSelection && constellation && (
        <ChunkSummary
          chunks={selectedChunks}
          totalSessions={tierData.sessions.length}
          crossChunkEdges={constellation.cross_chunk_edges}
        />
      )}

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {/* Constellation sidebar */}
        {view === 'constellation' && constellation && algorithm !== 'gradient_scale' && (
          <ChunkSelector
            chunks={constellation.chunks}
            activeChunkIds={selectedChunkIds}
            onToggle={handleChunkToggle}
            onSelectAll={handleSelectAll}
            onDeselectAll={handleDeselectAll}
            onBack={handleDeselectAll}
            algorithm={algorithm}
            tableRanking={constellation.table_reference_ranking}
            points={constellation.points}
            tierData={tierData}
            highlightedSessionIds={highlightedSessionIds}
            onHighlightSession={handleHighlightSession}
            onFindLinked={handleFindLinked}
            onClearHighlight={() => setHighlightedSessionIds(new Set())}
          />
        )}

        {/* ── View content — each view is conditionally rendered; lazy views are
                  wrapped in Suspense. Edge-to-edge views use padding=0. ── */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: '#64748b' }}>Loading view...</div>}>
            <div style={{ flex: 1, overflow: 'hidden', padding: (['tier', 'matrix', 'galaxy', 'constellation', 'tables', 'duplicates'].includes(view)) ? 0 : 20 }}>
              {/* ── Core views ── */}
              {view === 'tier' && scopedTierData && (
                <ErrorBoundary><TierDiagram data={scopedTierData} chunks={constellation?.chunks} /></ErrorBoundary>
              )}
              {view === 'galaxy' && scopedTierData && (
                <ErrorBoundary>
                  <GalaxyMapCanvas data={scopedTierData} onClose={() => setView('tier')} />
                </ErrorBoundary>
              )}
              {view === 'constellation' && tierData && constellation && (
                <ErrorBoundary>
                  <ConstellationCanvas
                    points={constellation.points}
                    chunks={constellation.chunks}
                    crossChunkEdges={constellation.cross_chunk_edges}
                    selectedChunkIds={selectedChunkIds}
                    onChunkSelect={handleChunkToggle}
                    algorithm={algorithm}
                    onAlgorithmChange={handleRecluster}
                    highlightedSessionIds={highlightedSessionIds}
                  />
                </ErrorBoundary>
              )}
              {view === 'explorer' && scopedTierData && (
                <ErrorBoundary><ExplorerView data={scopedTierData} /></ErrorBoundary>
              )}
              {view === 'conflicts' && scopedTierData && (
                <ErrorBoundary><ConflictsView data={scopedTierData} /></ErrorBoundary>
              )}
              {view === 'order' && scopedTierData && (
                <ErrorBoundary><ExecOrderView data={scopedTierData} /></ErrorBoundary>
              )}
              {view === 'matrix' && scopedTierData && (
                <ErrorBoundary><MatrixView data={scopedTierData} /></ErrorBoundary>
              )}

              {/* ── Data harmonization views ── */}
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
                    uploadId={uploadId}
                    onRecluster={handleRecluster}
                    onProceed={(v) => setView(v as ViewId)}
                    onVectorResults={setVectorResults}
                  />
                </ErrorBoundary>
              )}

              {/* ── Vector analysis views — show fallback when data missing ── */}
              {view === 'complexity' && (
                vectorResults?.v11_complexity ? (
                  <ErrorBoundary><div style={{ overflow: 'auto', height: '100%' }}><ComplexityOverlay complexity={vectorResults.v11_complexity} /></div></ErrorBoundary>
                ) : <VectorFallback label="Complexity" onRun={() => navigateView('chunking')} onRunDirect={tierData ? () => analyzeVectors(tierData, 1, uploadId ?? undefined).then(r => { setVectorResults(prev => ({ ...prev, ...r })); addToast(`Vector analysis complete: ${Object.keys(r).filter(k => k.startsWith('v')).length} vectors`, 'success'); }).catch(e => addToast(e.message)) : undefined} />
              )}
              {view === 'waves' && (
                vectorResults?.v4_wave_plan ? (
                  <ErrorBoundary><div style={{ overflow: 'auto', height: '100%' }}><WavePlanView wavePlan={vectorResults.v4_wave_plan} /></div></ErrorBoundary>
                ) : <VectorFallback label="Wave Plan" onRun={() => navigateView('chunking')} onRunDirect={tierData ? () => analyzeVectors(tierData, 1, uploadId ?? undefined).then(r => { setVectorResults(prev => ({ ...prev, ...r })); addToast(`Vector analysis complete: ${Object.keys(r).filter(k => k.startsWith('v')).length} vectors`, 'success'); }).catch(e => addToast(e.message)) : undefined} />
              )}
              {view === 'heatmap' && (
                vectorResults?.v11_complexity ? (
                  <ErrorBoundary><div style={{ overflow: 'auto', height: '100%' }}><HeatMapView complexity={vectorResults.v11_complexity} /></div></ErrorBoundary>
                ) : <VectorFallback label="Heat Map" onRun={() => navigateView('chunking')} onRunDirect={tierData ? () => analyzeVectors(tierData, 1, uploadId ?? undefined).then(r => { setVectorResults(prev => ({ ...prev, ...r })); addToast(`Vector analysis complete: ${Object.keys(r).filter(k => k.startsWith('v')).length} vectors`, 'success'); }).catch(e => addToast(e.message)) : undefined} />
              )}
              {view === 'umap' && (
                vectorResults?.v3_dimensionality_reduction ? (
                  <ErrorBoundary><div style={{ overflow: 'auto', height: '100%' }}><UMAPView vectorResults={vectorResults} /></div></ErrorBoundary>
                ) : <VectorFallback label="UMAP" phase={2} onRun={() => setRightPanel('vectors')} onRunDirect={tierData ? () => analyzeVectors(tierData, 2, uploadId ?? undefined).then(r => { setVectorResults(prev => ({ ...prev, ...r })); addToast(`Vector analysis complete: ${Object.keys(r).filter(k => k.startsWith('v')).length} vectors`, 'success'); }).catch(e => addToast(e.message)) : undefined} />
              )}
              {view === 'simulator' && (
                vectorResults?.v9_wave_function && tierData ? (
                  <ErrorBoundary><div style={{ overflow: 'auto', height: '100%' }}><WaveSimulator waveFunction={vectorResults.v9_wave_function} tierData={tierData} /></div></ErrorBoundary>
                ) : <VectorFallback label="Simulator" phase={2} onRun={() => setRightPanel('vectors')} onRunDirect={tierData ? () => analyzeVectors(tierData, 2, uploadId ?? undefined).then(r => { setVectorResults(prev => ({ ...prev, ...r })); addToast(`Vector analysis complete: ${Object.keys(r).filter(k => k.startsWith('v')).length} vectors`, 'success'); }).catch(e => addToast(e.message)) : undefined} />
              )}
              {view === 'concentration' && (
                vectorResults?.v10_concentration ? (
                  <ErrorBoundary><div style={{ overflow: 'auto', height: '100%' }}><ConcentrationView concentration={vectorResults.v10_concentration} /></div></ErrorBoundary>
                ) : <VectorFallback label="Gravity" phase={2} onRun={() => setRightPanel('vectors')} onRunDirect={tierData ? () => analyzeVectors(tierData, 2, uploadId ?? undefined).then(r => { setVectorResults(prev => ({ ...prev, ...r })); addToast(`Vector analysis complete: ${Object.keys(r).filter(k => k.startsWith('v')).length} vectors`, 'success'); }).catch(e => addToast(e.message)) : undefined} />
              )}
              {view === 'consensus' && (
                vectorResults?.v8_ensemble_consensus ? (
                  <ErrorBoundary><div style={{ overflow: 'auto', height: '100%' }}><ConsensusRadar ensemble={vectorResults.v8_ensemble_consensus} /></div></ErrorBoundary>
                ) : <VectorFallback label="Consensus" phase={3} onRun={() => setRightPanel('vectors')} onRunDirect={tierData ? () => analyzeVectors(tierData, 3, uploadId ?? undefined).then(r => { setVectorResults(prev => ({ ...prev, ...r })); addToast(`Vector analysis complete: ${Object.keys(r).filter(k => k.startsWith('v')).length} vectors`, 'success'); }).catch(e => addToast(e.message)) : undefined} />
              )}

              {/* ── Layer / navigation views ── */}
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
                    <AIChat uploadId={uploadId} tierData={tierData} onToast={addToast} />
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

              {/* Admin Console */}
              {view === 'admin' && (
                <ErrorBoundary>
                  <AdminConsole onToast={addToast} onLoadUpload={handleLoadUpload} />
                </ErrorBoundary>
              )}
            </div>
          </Suspense>
        </div>

        {/* ── Right sidebar panel — toggled by the Vectors/Drill/Export header buttons ── */}
        {rightPanel && tierData && (
          <div style={{ width: 280, borderLeft: `1px solid ${T.border}`, overflow: 'auto', padding: 12, flexShrink: 0, background: T.bgPanel }}>
            {rightPanel === 'vectors' && (
              // Vector control: run phases 1-3 and view results summary
              <VectorControlPanel tierData={tierData} vectorResults={vectorResults} onVectorResults={setVectorResults} uploadId={uploadId} onToast={addToast} />
            )}
            {rightPanel === 'drill' && vectorResults && (
              // Drill panel: filter any view by vector score ranges
              <DrillThroughPanel vectorResults={vectorResults} filter={drillFilter} onFilterChange={setDrillFilter} matchingCount={drillMatchingIds ? drillMatchingIds.size : undefined} uploadId={uploadId} />
            )}
            {rightPanel === 'export' && (
              // Export manager: Excel, DOT, Mermaid, Jira CSV, Snapshot, etc.
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
          <button onClick={async () => { setLogLoading(true); setShowLogPanel(true); try { setLogEntries(await getHealthLogs(50)); } catch { /* no-op */ } finally { setLogLoading(false); } }}
            style={{ fontSize: 10, color: '#F59E0B', background: 'transparent', border: 'none', cursor: 'pointer', marginTop: 4, padding: 0, textDecoration: 'underline' }}>
            View Logs
          </button>
        </div>
      )}

      {/* Toast queue */}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', bottom: error ? 80 : 20, right: 20, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 9998 }}>
          {toasts.map(t => {
            const bg = t.severity === 'success' ? 'rgba(34,197,94,0.15)' : t.severity === 'warning' ? 'rgba(245,158,11,0.15)' : t.severity === 'info' ? 'rgba(59,130,246,0.15)' : 'rgba(239,68,68,0.15)';
            const border = t.severity === 'success' ? 'rgba(34,197,94,0.3)' : t.severity === 'warning' ? 'rgba(245,158,11,0.3)' : t.severity === 'info' ? 'rgba(59,130,246,0.3)' : 'rgba(239,68,68,0.3)';
            const color = t.severity === 'success' ? '#22c55e' : t.severity === 'warning' ? '#f59e0b' : t.severity === 'info' ? '#3b82f6' : '#ef4444';
            return (
              <div key={t.id} style={{ padding: '8px 14px', background: bg, border: `1px solid ${border}`, borderRadius: 6, color, fontSize: 11, maxWidth: 360, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span>{t.message}</span>
                <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))} style={{ background: 'transparent', border: 'none', color, cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>x</button>
              </div>
            );
          })}
        </div>
      )}

    </div>
    )}

    {/* ── Shared overlays (rendered once, visible in both dashboard and data views) ── */}

    {/* Help overlay */}
    {showHelp && (
      <Suspense fallback={null}>
        <HelpOverlay onClose={() => setShowHelp(false)} views={VIEWS} theme={T} />
      </Suspense>
    )}

    {/* Log viewer — right-side slide-out panel (no backdrop, sits alongside content) */}
    {showLogPanel && (
      <div style={{
        position: 'fixed', top: 0, right: 0, width: 420, height: '100vh',
        background: T.bgCard, borderLeft: `1px solid ${T.border}`,
        boxShadow: '-4px 0 24px rgba(0,0,0,0.15)', zIndex: 9999,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Server Logs ({logEntries.length})</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={async () => { setLogLoading(true); try { setLogEntries(await getHealthLogs(100)); } catch { /* no-op */ } finally { setLogLoading(false); } }}
              style={{ background: 'transparent', border: `1px solid ${T.border}`, color: T.textMuted, cursor: 'pointer', fontSize: 11, borderRadius: 4, padding: '2px 8px' }}>
              Refresh
            </button>
            <button onClick={() => { logDismissedAt.current = Date.now(); setShowLogPanel(false); }}
              style={{ background: 'transparent', border: 'none', color: T.textMuted, cursor: 'pointer', fontSize: 16 }}>x</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 8, fontFamily: 'monospace', fontSize: 11 }}>
          {logLoading && <div style={{ color: T.textMuted, padding: 16, textAlign: 'center' }}>Loading logs...</div>}
          {!logLoading && logEntries.length === 0 && <div style={{ color: T.textMuted, padding: 16, textAlign: 'center' }}>No log entries</div>}
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
    )}
    </>
  );
}
