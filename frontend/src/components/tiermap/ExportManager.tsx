/**
 * ExportManager — per-layer export for wave plans, complexity reports, and data.
 * Supports JSON, CSV, and summary exports.
 */

import React, { useCallback, useState } from 'react';
import type { VectorResults, WavePlan, ComplexityResult } from '../../types/vectors';
import type { TierMapResult } from '../../types/tiermap';

interface Props {
  tierData: TierMapResult;
  vectorResults: VectorResults | null;
}

type ExportFormat = 'json' | 'csv';

/**
 * ExportManager -- per-layer export panel for tier data, wave plans, complexity
 * reports, environment summaries, and full vector results. Supports JSON and
 * CSV formats. Each export row shows a label, description, and format buttons.
 * Downloads are triggered via programmatic Blob URL creation.
 */
export default function ExportManager({ tierData, vectorResults }: Props) {
  const [exporting, setExporting] = useState<string | null>(null);

  const download = useCallback((filename: string, content: string, mime = 'application/json') => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const exportWavePlan = useCallback((format: ExportFormat) => {
    const plan = vectorResults?.v4_wave_plan;
    if (!plan) return;
    setExporting('wave');

    if (format === 'json') {
      download('wave_plan.json', JSON.stringify(plan, null, 2));
    } else {
      const rows = ['Wave,Session Count,Hours Low,Hours High,Prerequisites,Sessions'];
      for (const w of plan.waves) {
        rows.push([
          w.wave_number,
          w.session_count,
          Math.round(w.estimated_hours_low),
          Math.round(w.estimated_hours_high),
          w.prerequisite_waves.join(';'),
          `"${w.session_ids.join(';')}"`,
        ].join(','));
      }
      download('wave_plan.csv', rows.join('\n'), 'text/csv');
    }
    setTimeout(() => setExporting(null), 500);
  }, [vectorResults, download]);

  const exportComplexity = useCallback((format: ExportFormat) => {
    const cx = vectorResults?.v11_complexity;
    if (!cx) return;
    setExporting('complexity');

    if (format === 'json') {
      download('complexity_analysis.json', JSON.stringify(cx, null, 2));
    } else {
      const rows = ['Session ID,Name,Score,Bucket,Hours Low,Hours High,Top Drivers'];
      for (const s of cx.scores) {
        rows.push([
          s.session_id,
          `"${s.name}"`,
          Math.round(s.overall_score),
          s.bucket,
          s.hours_estimate_low,
          s.hours_estimate_high,
          `"${s.top_drivers.join(';')}"`,
        ].join(','));
      }
      download('complexity_analysis.csv', rows.join('\n'), 'text/csv');
    }
    setTimeout(() => setExporting(null), 500);
  }, [vectorResults, download]);

  const exportTierData = useCallback(() => {
    setExporting('tier');
    download('tier_data.json', JSON.stringify(tierData, null, 2));
    setTimeout(() => setExporting(null), 500);
  }, [tierData, download]);

  const exportAllVectors = useCallback(() => {
    if (!vectorResults) return;
    setExporting('vectors');
    download('vector_results.json', JSON.stringify(vectorResults, null, 2));
    setTimeout(() => setExporting(null), 500);
  }, [vectorResults, download]);

  const exportEnvironmentSummary = useCallback(() => {
    const v11 = vectorResults?.v11_complexity;
    const v4 = vectorResults?.v4_wave_plan;
    const v1 = vectorResults?.v1_communities;
    const v10 = vectorResults?.v10_concentration;

    const summary = {
      generated_at: new Date().toISOString(),
      total_sessions: tierData.sessions.length,
      total_tables: tierData.tables.length,
      max_tier: tierData.stats.max_tier,
      write_conflicts: tierData.stats.write_conflicts,
      complexity: v11 ? {
        distribution: v11.bucket_distribution,
        mean_score: v11.aggregate_stats.mean_score,
        total_hours: `${Math.round(v11.total_hours_low)}-${Math.round(v11.total_hours_high)}`,
      } : null,
      waves: v4 ? {
        total_waves: v4.waves.length,
        critical_path: v4.critical_path_length,
        cyclic_sessions: v4.cyclic_session_count,
      } : null,
      communities: v1 ? {
        macro_count: Object.keys(v1.macro_communities).length,
        modularity: v1.modularity,
      } : null,
      independent_sessions: v10?.independent_sessions.length ?? 0,
    };

    setExporting('summary');
    download('environment_summary.json', JSON.stringify(summary, null, 2));
    setTimeout(() => setExporting(null), 500);
  }, [tierData, vectorResults, download]);

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 space-y-3">
      <h3 className="text-sm font-medium text-gray-300">Export</h3>

      <ExportRow
        label="Tier Data"
        description="Sessions, tables, connections"
        onExport={() => exportTierData()}
        format="json"
        loading={exporting === 'tier'}
      />

      <ExportRow
        label="Wave Plan"
        description="Migration waves with hours estimates"
        onExport={() => exportWavePlan('csv')}
        onExportAlt={() => exportWavePlan('json')}
        format="csv"
        altFormat="json"
        loading={exporting === 'wave'}
        disabled={!vectorResults?.v4_wave_plan}
      />

      <ExportRow
        label="Complexity"
        description="Per-session complexity scores"
        onExport={() => exportComplexity('csv')}
        onExportAlt={() => exportComplexity('json')}
        format="csv"
        altFormat="json"
        loading={exporting === 'complexity'}
        disabled={!vectorResults?.v11_complexity}
      />

      <ExportRow
        label="Environment Summary"
        description="High-level overview"
        onExport={exportEnvironmentSummary}
        format="json"
        loading={exporting === 'summary'}
      />

      <ExportRow
        label="All Vectors"
        description="Full V1–V11 analysis results"
        onExport={exportAllVectors}
        format="json"
        loading={exporting === 'vectors'}
        disabled={!vectorResults}
      />
    </div>
  );
}

/** Single export row with label, description, primary format button, and optional alt format button. */
function ExportRow({
  label,
  description,
  onExport,
  onExportAlt,
  format,
  altFormat,
  loading,
  disabled,
}: {
  label: string;
  description: string;
  onExport: () => void;
  onExportAlt?: () => void;
  format: string;
  altFormat?: string;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <div className="flex-1">
        <div className="text-xs text-gray-300">{label}</div>
        <div className="text-[10px] text-gray-500">{description}</div>
      </div>
      <button
        onClick={onExport}
        disabled={disabled || loading}
        className="px-2.5 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300 transition-colors disabled:cursor-not-allowed"
      >
        {loading ? '...' : format.toUpperCase()}
      </button>
      {onExportAlt && altFormat && (
        <button
          onClick={onExportAlt}
          disabled={disabled || loading}
          className="px-2.5 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300 transition-colors disabled:cursor-not-allowed"
        >
          {altFormat.toUpperCase()}
        </button>
      )}
    </div>
  );
}
