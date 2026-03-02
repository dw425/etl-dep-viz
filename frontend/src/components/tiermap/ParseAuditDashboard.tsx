/**
 * Parse Audit Dashboard — shows per-file parse results, error summary,
 * and timing breakdown from the parse coordinator audit trail.
 */

import React from 'react';

interface FileResult {
  filename: string;
  status: string;
  session_count: number;
  error: string;
  elapsed_ms: number;
  file_size: number;
}

interface ParseAudit {
  total_files: number;
  parsed_ok: number;
  parse_errors: number;
  duplicates_skipped: number;
  total_sessions: number;
  elapsed_ms: number;
  file_results: FileResult[];
}

interface ParseAuditDashboardProps {
  audit: ParseAudit | null;
}

const STATUS_COLORS: Record<string, string> = {
  ok: '#10B981',
  error: '#EF4444',
  skipped_duplicate: '#F59E0B',
};

const STATUS_LABELS: Record<string, string> = {
  ok: 'Parsed',
  error: 'Error',
  skipped_duplicate: 'Duplicate',
};

/**
 * ParseAuditDashboard -- displays per-file parse results from the parse
 * coordinator audit trail. Shows summary cards (total files, parsed OK,
 * errors, duplicates, sessions), a timing waterfall bar per file, and
 * an error detail section for failed files.
 */
export default function ParseAuditDashboard({ audit }: ParseAuditDashboardProps) {
  if (!audit) {
    return (
      <div style={{ padding: 24, color: '#94a3b8', textAlign: 'center' }}>
        No parse audit data available. Upload files to see parse results.
      </div>
    );
  }

  const maxElapsed = Math.max(...audit.file_results.map(f => f.elapsed_ms), 1);

  return (
    <div style={{ padding: 16, color: '#e2e8f0', fontFamily: '"JetBrains Mono", monospace' }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>Parse Audit</h3>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 20 }}>
        <SummaryCard label="Total Files" value={audit.total_files} color="#3B82F6" />
        <SummaryCard label="Parsed OK" value={audit.parsed_ok} color="#10B981" />
        <SummaryCard label="Errors" value={audit.parse_errors} color="#EF4444" />
        <SummaryCard label="Duplicates" value={audit.duplicates_skipped} color="#F59E0B" />
        <SummaryCard label="Sessions" value={audit.total_sessions} color="#A855F7" />
      </div>

      {/* Timing */}
      <div style={{ marginBottom: 16, fontSize: 12, color: '#94a3b8' }}>
        Total parse time: {(audit.elapsed_ms / 1000).toFixed(1)}s
      </div>

      {/* Per-file results */}
      <div style={{ border: '1px solid #334155', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 80px 60px 100px 1fr',
          padding: '8px 12px', background: '#1e293b', fontSize: 11, color: '#64748b',
          fontWeight: 600, borderBottom: '1px solid #334155',
        }}>
          <span>File</span>
          <span>Status</span>
          <span>Sessions</span>
          <span>Time</span>
          <span>Timeline</span>
        </div>

        {audit.file_results.map((f, i) => (
          <div
            key={i}
            style={{
              display: 'grid', gridTemplateColumns: '2fr 80px 60px 100px 1fr',
              padding: '6px 12px', borderBottom: '1px solid #1e293b',
              fontSize: 12, alignItems: 'center',
            }}
          >
            <span style={{
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {f.filename}
            </span>
            <span style={{ color: STATUS_COLORS[f.status] || '#94a3b8' }}>
              {STATUS_LABELS[f.status] || f.status}
            </span>
            <span style={{ color: '#94a3b8' }}>{f.session_count || '-'}</span>
            <span style={{ color: '#94a3b8' }}>
              {f.elapsed_ms > 0 ? `${f.elapsed_ms}ms` : '-'}
            </span>
            <div style={{ position: 'relative', height: 6, background: '#1e293b', borderRadius: 3 }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: 3,
                width: `${(f.elapsed_ms / maxElapsed) * 100}%`,
                background: STATUS_COLORS[f.status] || '#64748b',
                opacity: 0.7,
              }} />
            </div>
          </div>
        ))}
      </div>

      {/* Error details */}
      {audit.file_results.filter(f => f.status === 'error' && f.error).length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#EF4444' }}>Errors</h4>
          {audit.file_results
            .filter(f => f.status === 'error' && f.error)
            .map((f, i) => (
              <div key={i} style={{
                padding: '8px 12px', marginBottom: 4,
                background: 'rgba(239,68,68,0.1)', borderRadius: 6,
                border: '1px solid rgba(239,68,68,0.2)',
                fontSize: 11, color: '#fca5a5',
              }}>
                <strong>{f.filename}:</strong> {f.error}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** Colored summary card with large number and label. */
function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      padding: '12px 16px', background: '#1e293b', borderRadius: 8,
      border: `1px solid ${color}33`,
    }}>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{label}</div>
    </div>
  );
}
