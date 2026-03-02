/**
 * Algorithm Picker — select and compare clustering algorithms with side-by-side view.
 *
 * Shows available algorithms, their descriptions, and allows
 * running analysis with different algorithms for comparison.
 */

import React, { useState, useCallback } from 'react';
import type { AlgorithmKey } from '../../types/tiermap';

interface AlgorithmPickerProps {
  currentAlgorithm: AlgorithmKey;
  onAlgorithmChange: (algo: AlgorithmKey) => void;
  onCompare?: (algoA: AlgorithmKey, algoB: AlgorithmKey) => void;
  reclustering?: boolean;
}

const ALGORITHMS: { key: AlgorithmKey; name: string; icon: string; desc: string; speed: string }[] = [
  { key: 'louvain', name: 'Louvain', icon: '◎', desc: 'Modularity-based community detection', speed: 'fast' },
  { key: 'tier', name: 'Tier Groups', icon: '≡', desc: 'Group sessions by execution tier', speed: 'instant' },
  { key: 'components', name: 'Connected Components', icon: '◇', desc: 'Natural graph islands', speed: 'instant' },
  { key: 'label_prop', name: 'Label Propagation', icon: '↹', desc: 'Fast iterative label spreading', speed: 'fast' },
  { key: 'greedy_mod', name: 'Greedy Modularity', icon: '▣', desc: 'Agglomerative merge — fewer, larger clusters', speed: 'medium' },
  { key: 'process_group', name: 'Process Group', icon: '⊞', desc: 'Group by workflow/process group', speed: 'instant' },
  { key: 'table_gravity', name: 'Table Gravity', icon: '⊙', desc: 'Cluster around most referenced tables', speed: 'medium' },
];

const SPEED_COLORS: Record<string, string> = {
  instant: '#10B981',
  fast: '#3B82F6',
  medium: '#F59E0B',
};

/**
 * AlgorithmPicker -- clustering algorithm selection grid with optional
 * side-by-side comparison mode. Each algorithm card shows name, description,
 * icon, and speed indicator (instant/fast/medium).
 */
export default function AlgorithmPicker({
  currentAlgorithm,
  onAlgorithmChange,
  onCompare,
  reclustering = false,
}: AlgorithmPickerProps) {
  const [compareMode, setCompareMode] = useState(false);
  const [compareAlgo, setCompareAlgo] = useState<AlgorithmKey | null>(null);

  const handleSelect = useCallback((algo: AlgorithmKey) => {
    if (compareMode && compareAlgo) {
      onCompare?.(compareAlgo, algo);
      setCompareMode(false);
      setCompareAlgo(null);
    } else if (compareMode) {
      setCompareAlgo(algo);
    } else {
      onAlgorithmChange(algo);
    }
  }, [compareMode, compareAlgo, onAlgorithmChange, onCompare]);

  return (
    <div style={{
      padding: 16, color: '#e2e8f0',
      fontFamily: '"JetBrains Mono", monospace',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Clustering Algorithm</h4>
        {onCompare && (
          <button
            onClick={() => { setCompareMode(!compareMode); setCompareAlgo(null); }}
            style={{
              padding: '4px 10px', fontSize: 11, cursor: 'pointer',
              background: compareMode ? '#3B82F6' : 'transparent',
              border: `1px solid ${compareMode ? '#3B82F6' : '#475569'}`,
              borderRadius: 4, color: '#e2e8f0',
            }}
          >
            {compareMode ? 'Cancel Compare' : 'Compare'}
          </button>
        )}
      </div>

      {compareMode && (
        <div style={{
          padding: '6px 10px', marginBottom: 8, background: 'rgba(59,130,246,0.1)',
          borderRadius: 6, fontSize: 11, color: '#93c5fd',
        }}>
          {compareAlgo
            ? `Select second algorithm to compare with ${ALGORITHMS.find(a => a.key === compareAlgo)?.name}`
            : 'Select first algorithm to compare'}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {ALGORITHMS.map(algo => {
          const isActive = algo.key === currentAlgorithm;
          const isCompareSelected = algo.key === compareAlgo;

          return (
            <button
              key={algo.key}
              onClick={() => handleSelect(algo.key)}
              disabled={reclustering}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px', cursor: reclustering ? 'wait' : 'pointer',
                background: isActive ? 'rgba(59,130,246,0.15)' :
                  isCompareSelected ? 'rgba(168,85,247,0.15)' : 'transparent',
                border: `1px solid ${isActive ? '#3B82F6' :
                  isCompareSelected ? '#A855F7' : '#1e293b'}`,
                borderRadius: 8, color: '#e2e8f0', textAlign: 'left',
                opacity: reclustering ? 0.5 : 1,
              }}
            >
              <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>{algo.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{algo.name}</div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{algo.desc}</div>
              </div>
              <span style={{
                fontSize: 9, padding: '2px 6px', borderRadius: 3,
                background: `${SPEED_COLORS[algo.speed]}22`,
                color: SPEED_COLORS[algo.speed],
              }}>
                {algo.speed}
              </span>
              {isActive && (
                <span style={{ fontSize: 10, color: '#3B82F6' }}>active</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
