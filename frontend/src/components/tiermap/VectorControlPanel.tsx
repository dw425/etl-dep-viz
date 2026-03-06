/**
 * VectorControlPanel — toggle panel for activating/deactivating vector overlays.
 * Controls resolution, algorithm comparison, and "Run All Vectors" button.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { analyzeVectorsStream } from '../../api/client';
import type { VectorStreamEvent } from '../../api/client';
import type { TierMapResult } from '../../types/tiermap';
import type { VectorResults } from '../../types/vectors';

interface Props {
  tierData: TierMapResult;
  vectorResults: VectorResults | null;
  onVectorResults: (results: VectorResults) => void;
  uploadId?: number | null;
  onToast?: (message: string, severity: 'error' | 'warning' | 'info' | 'success') => void;
}

const PHASE_LABELS: Record<number, { label: string; desc: string; vectors: string }> = {
  1: { label: 'Core', desc: 'V1 Community + V4 Waves + V11 Complexity', vectors: 'V1, V4, V11' },
  2: { label: 'Advanced', desc: '+ V2 Lineage + V3 UMAP + V9 Cascade + V10 Concentration', vectors: 'V1-V4, V9-V11' },
  3: { label: 'Full', desc: '+ V5 Affinity + V6 Spectral + V7 HDBSCAN + V8 Ensemble', vectors: 'V1-V11' },
};

/**
 * VectorControlPanel -- phase selector for running vector analysis (1/2/3).
 * Shows phase descriptions, a "Run" button with loading spinner, and a
 * loaded-vectors status list with per-vector timing readout.
 *
 * Phase 1 (Core): V1 Community + V4 Waves + V11 Complexity
 * Phase 2 (Advanced): + V2 Lineage + V3 UMAP + V9 Cascade + V10 Concentration
 * Phase 3 (Full): + V5 Affinity + V6 Spectral + V7 HDBSCAN + V8 Ensemble
 */
export default function VectorControlPanel({ tierData, vectorResults, onVectorResults, uploadId, onToast }: Props) {
  const [phase, setPhase] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [phaseTimings, setPhaseTimings] = useState<Record<string, number> | null>(null);
  const [errorDetail, setErrorDetail] = useState<{ message: string; failed_phase: string; phase_timings: Record<string, number> } | null>(null);

  const handleRun = useCallback(() => {
    setLoading(true);
    setErrorDetail(null);
    setPhaseTimings(null);
    setProgress(`Running Phase ${phase} analysis...`);
    analyzeVectorsStream(tierData, uploadId ?? undefined, (event: VectorStreamEvent) => {
      if (event.phase_timings) setPhaseTimings(event.phase_timings);
      if (event.phase === 'complete' && event.result) {
        onVectorResults(event.result);
        const vecCount = Object.keys(event.result).filter(k => k.startsWith('v')).length;
        const totalTime = event.phase_timings?.total;
        const msg = `Phase ${phase} complete: ${vecCount} vectors` + (totalTime ? ` in ${totalTime}s` : '');
        setProgress(msg);
        onToast?.(msg, 'success');
        setLoading(false);
      } else if (event.phase === 'error') {
        if (event.error_detail) setErrorDetail(event.error_detail);
        const detail = event.error_detail;
        const errMsg = detail
          ? `Failed in ${detail.failed_phase}: ${detail.message}`
          : `Vector analysis error: ${event.message}`;
        setProgress(errMsg);
        onToast?.(errMsg, 'error');
        setLoading(false);
      } else {
        // Show phase timing in progress text
        const timingStr = event.phase_timings
          ? Object.entries(event.phase_timings).map(([k, v]) => `${k}: ${v}s`).join(', ')
          : '';
        setProgress((event.message || `Running ${event.phase}...`) + (timingStr ? ` [${timingStr}]` : ''));
      }
    });
  }, [tierData, phase, onVectorResults, uploadId, onToast]);

  const availableVectors = useMemo(
    () => vectorResults ? Object.keys(vectorResults).filter(k => k.startsWith('v')) : [],
    [vectorResults],
  );

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">Vector Analysis</h3>
        {vectorResults && (
          <span className="text-xs text-green-400">
            {availableVectors.length} vectors loaded
          </span>
        )}
      </div>

      {/* Phase Selector */}
      <div className="space-y-2">
        {([1, 2, 3] as const).map(p => (
          <button
            key={p}
            onClick={() => setPhase(p)}
            className={`w-full text-left px-3 py-2 rounded border transition-colors ${
              phase === p
                ? 'border-blue-500/50 bg-blue-500/10'
                : 'border-gray-700 hover:border-gray-600'
            }`}
          >
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${phase === p ? 'bg-blue-400' : 'bg-gray-600'}`} />
              <span className="text-xs font-medium text-gray-300">
                Phase {p}: {PHASE_LABELS[p].label}
              </span>
            </div>
            <div className="text-[10px] text-gray-500 mt-0.5 ml-4">
              {PHASE_LABELS[p].desc}
            </div>
          </button>
        ))}
      </div>

      {/* Run Button */}
      <button
        onClick={handleRun}
        disabled={loading}
        className={`w-full py-2 rounded text-sm font-medium transition-colors ${
          loading
            ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-700 text-white'
        }`}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Running...
          </span>
        ) : (
          `Run Phase ${phase} Analysis`
        )}
      </button>

      {progress && (
        <div className="text-xs text-gray-500 text-center">{progress}</div>
      )}

      {/* Error detail */}
      {errorDetail && (
        <div className="text-xs bg-red-900/20 border border-red-800/30 rounded p-2 space-y-1">
          <div className="text-red-400 font-medium">Failed in: {errorDetail.failed_phase}</div>
          <div className="text-red-300/80 break-words">{errorDetail.message}</div>
          {Object.keys(errorDetail.phase_timings).length > 0 && (
            <div className="text-gray-500">
              Completed: {Object.entries(errorDetail.phase_timings)
                .filter(([k]) => k !== 'total')
                .map(([k, v]) => `${k}: ${v}s`).join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Live phase timings during analysis */}
      {loading && phaseTimings && Object.keys(phaseTimings).length > 0 && (
        <div className="space-y-0.5">
          {Object.entries(phaseTimings).map(([k, v]) => (
            <div key={k} className="flex justify-between text-[10px]">
              <span className="text-gray-500">{k}</span>
              <span className="text-green-400/70">{v}s</span>
            </div>
          ))}
        </div>
      )}

      {/* Loaded Vectors Status */}
      {vectorResults && (
        <div className="space-y-1 pt-2 border-t border-gray-700">
          <div className="text-xs text-gray-500 mb-1">Loaded Vectors</div>
          {[
            { key: 'v1_communities', label: 'V1 Community', icon: '●' },
            { key: 'v2_hierarchical_lineage', label: 'V2 Lineage', icon: '◆' },
            { key: 'v3_dimensionality_reduction', label: 'V3 UMAP', icon: '◎' },
            { key: 'v4_wave_plan', label: 'V4 Waves', icon: '≋' },
            { key: 'v5_affinity_propagation', label: 'V5 Affinity', icon: '◉' },
            { key: 'v6_spectral_clustering', label: 'V6 Spectral', icon: '✦' },
            { key: 'v7_hdbscan_density', label: 'V7 HDBSCAN', icon: '⊙' },
            { key: 'v8_ensemble_consensus', label: 'V8 Ensemble', icon: '◈' },
            { key: 'v9_wave_function', label: 'V9 Cascade', icon: '∿' },
            { key: 'v10_concentration', label: 'V10 Gravity', icon: '⊕' },
            { key: 'v11_complexity', label: 'V11 Complexity', icon: '▣' },
          ].map(v => {
            const loaded = v.key in vectorResults && vectorResults[v.key as keyof VectorResults] != null;
            return (
              <div key={v.key} className="flex items-center gap-2 text-xs">
                <span className={loaded ? 'text-green-400' : 'text-gray-600'}>{v.icon}</span>
                <span className={loaded ? 'text-gray-300' : 'text-gray-600'}>{v.label}</span>
                {loaded && vectorResults.timings?.[v.key.replace('v', 'v').replace('_', '_')] && (
                  <span className="ml-auto text-gray-600">
                    {vectorResults.timings[Object.keys(vectorResults.timings).find(k => k.includes(v.key.split('_')[0].replace('v', 'v'))) ?? ''] ?? ''}s
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Timings */}
      {vectorResults?.timings && (
        <div className="pt-2 border-t border-gray-700">
          <div className="text-xs text-gray-500 mb-1">Timings</div>
          {Object.entries(vectorResults.timings).map(([k, v]) => (
            <div key={k} className="flex justify-between text-[10px]">
              <span className="text-gray-500">{k.replace(/_/g, ' ')}</span>
              <span className="text-gray-400">{v}s</span>
            </div>
          ))}
          {vectorResults.total_time && (
            <div className="flex justify-between text-xs font-medium mt-1 pt-1 border-t border-gray-700/50">
              <span className="text-gray-400">Total</span>
              <span className="text-gray-300">{vectorResults.total_time}s</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
