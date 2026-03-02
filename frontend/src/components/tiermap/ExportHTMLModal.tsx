/**
 * ExportHTMLModal — View selector modal shown before HTML export.
 * Users pick which views to include in the self-contained HTML report.
 */

import { useState, useCallback } from 'react';

interface ExportView {
  id: string;
  label: string;
  requires?: 'constellation' | 'complexity';
}

const EXPORT_VIEWS: ExportView[] = [
  { id: 'constellation', label: 'Constellation', requires: 'constellation' },
  { id: 'tier', label: 'Tier Diagram' },
  { id: 'explorer', label: 'Explorer' },
  { id: 'conflicts', label: 'Conflicts & Chains' },
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'order', label: 'Flow (Exec Order)' },
  { id: 'tables', label: 'Decision Tree (Tables)' },
  { id: 'complexity', label: 'Complexity', requires: 'complexity' },
];

interface Props {
  onExport: (selectedViews: Set<string>) => void;
  onClose: () => void;
  hasConstellation: boolean;
  hasComplexity: boolean;
  theme: {
    bg: string; bgCard: string; border: string; borderActive: string;
    text: string; textMuted: string; textDim: string;
    accent: string; accentBg: string; accentText: string;
  };
}

/**
 * ExportHTMLModal -- modal dialog for selecting which views to include in a
 * self-contained HTML report export. Shows a 2-column checkbox grid of available
 * views (some gated by data availability), with Select All / Deselect All toggle
 * and a count-aware Export button. Views requiring constellation or complexity
 * data are disabled (greyed out with "no data" label) when that data is absent.
 */
export default function ExportHTMLModal({ onExport, onClose, hasConstellation, hasComplexity, theme: T }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const v of EXPORT_VIEWS) {
      if (v.requires === 'constellation' && !hasConstellation) continue;
      if (v.requires === 'complexity' && !hasComplexity) continue;
      initial.add(v.id);
    }
    return initial;
  });

  const isDisabled = useCallback((v: ExportView) => {
    if (v.requires === 'constellation' && !hasConstellation) return true;
    if (v.requires === 'complexity' && !hasComplexity) return true;
    return false;
  }, [hasConstellation, hasComplexity]);

  const enabledCount = EXPORT_VIEWS.filter(v => !isDisabled(v)).length;
  const allSelected = selected.size === enabledCount;

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      const all = new Set<string>();
      for (const v of EXPORT_VIEWS) {
        if (!isDisabled(v)) all.add(v.id);
      }
      setSelected(all);
    }
  }, [allSelected, isDisabled]);

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleExport = useCallback(() => {
    if (selected.size > 0) onExport(selected);
  }, [selected, onExport]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 420, background: T.bgCard, borderRadius: 12,
          border: `1px solid ${T.border}`, padding: 24,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Export HTML Report</span>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', color: T.textMuted,
              cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4,
            }}
          >
            &times;
          </button>
        </div>

        {/* Select All / Deselect All */}
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={toggleAll}
            style={{
              background: 'transparent', border: 'none', color: T.accentText,
              cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: 0,
            }}
          >
            {allSelected ? 'Deselect All' : 'Select All'}
          </button>
        </div>

        {/* Checkbox grid — 2 columns */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 24 }}>
          {EXPORT_VIEWS.map(v => {
            const disabled = isDisabled(v);
            const checked = selected.has(v.id);
            return (
              <label
                key={v.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 6,
                  border: `1px solid ${checked && !disabled ? T.borderActive : T.border}`,
                  background: checked && !disabled ? T.accentBg : 'transparent',
                  opacity: disabled ? 0.35 : 1,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontSize: 12, color: disabled ? T.textMuted : T.text,
                  transition: 'all 0.15s',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => !disabled && toggle(v.id)}
                  style={{ accentColor: T.accent, cursor: disabled ? 'not-allowed' : 'pointer' }}
                />
                {v.label}
                {disabled && <span style={{ fontSize: 9, color: T.textDim }}>(no data)</span>}
              </label>
            );
          })}
        </div>

        {/* Export button */}
        <button
          onClick={handleExport}
          disabled={selected.size === 0}
          style={{
            width: '100%', padding: '10px 0', borderRadius: 8,
            border: 'none', cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
            background: selected.size > 0 ? T.accent : T.border,
            color: selected.size > 0 ? '#fff' : T.textMuted,
            fontSize: 13, fontWeight: 700,
            transition: 'all 0.15s',
          }}
        >
          Export {selected.size} {selected.size === 1 ? 'View' : 'Views'}
        </button>
      </div>
    </div>
  );
}
