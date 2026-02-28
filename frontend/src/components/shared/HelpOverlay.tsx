/**
 * HelpOverlay — Full help overlay with keyboard shortcuts, view descriptions, and docs.
 * Opens with '?' key.
 */

import { useEffect } from 'react';

interface Props {
  onClose: () => void;
  views: { id: string; label: string; icon: string; group?: string }[];
  theme: {
    bg: string; bgCard: string; border: string;
    text: string; textMuted: string;
    accent: string; accentBg: string; accentText: string;
  };
}

const SHORTCUTS = [
  { key: '?', desc: 'Toggle this help overlay' },
  { key: 'Esc', desc: 'Go back / close modal / drill up' },
  { key: '1-6', desc: 'Jump to core views (Tier, Galaxy, Constellation, Explorer, Conflicts, Order)' },
  { key: 'Alt+\u2190', desc: 'Navigate back in view history' },
  { key: 'Alt+\u2192', desc: 'Navigate forward in view history' },
  { key: 'F11', desc: 'Toggle fullscreen' },
];

const VIEW_GROUPS = [
  { name: 'Core Views', desc: 'Primary visualization and analysis views' },
  { name: 'Data Harmonization', desc: 'Table exploration, duplicate detection, chunking strategy' },
  { name: 'Vector Analysis', desc: 'Advanced data science vectors (requires vector analysis run)' },
  { name: 'Navigation', desc: '6-layer progressive drill-down and flow walking' },
];

export default function HelpOverlay({ onClose, views, theme: T }: Props) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 560, maxHeight: '80vh', background: T.bgCard, borderRadius: 16,
          border: `1px solid ${T.border}`, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: `1px solid ${T.border}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>ETL Dependency Visualizer</div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>Help & Keyboard Shortcuts</div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', color: T.textMuted,
              fontSize: 18, cursor: 'pointer', padding: '4px 8px',
            }}
          >x</button>
        </div>

        {/* Content */}
        <div style={{ overflow: 'auto', padding: 20 }}>
          {/* Keyboard shortcuts */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 12 }}>Keyboard Shortcuts</div>
            {SHORTCUTS.map(s => (
              <div key={s.key} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 0', borderBottom: `1px solid ${T.border}`,
              }}>
                <kbd style={{
                  padding: '3px 10px', borderRadius: 5, fontSize: 11,
                  background: T.accentBg, color: T.accentText, fontFamily: 'monospace',
                  fontWeight: 600, border: `1px solid ${T.border}`,
                }}>{s.key}</kbd>
                <span style={{ fontSize: 12, color: T.textMuted }}>{s.desc}</span>
              </div>
            ))}
          </div>

          {/* Views */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 12 }}>Available Views</div>
            {VIEW_GROUPS.map((g, gi) => (
              <div key={gi} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.accent, marginBottom: 6 }}>{g.name}</div>
                <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 8 }}>{g.desc}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {views.filter(v => {
                    const groupMap: Record<string, string> = {
                      core: 'Core Views', harmonize: 'Data Harmonization',
                      vector: 'Vector Analysis', nav: 'Navigation',
                    };
                    return groupMap[v.group || ''] === g.name;
                  }).map(v => (
                    <span key={v.id} style={{
                      padding: '3px 10px', borderRadius: 5, fontSize: 10,
                      background: T.accentBg, color: T.accentText,
                      border: `1px solid ${T.border}`,
                    }}>
                      {v.icon} {v.label}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Getting started */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 8 }}>Getting Started</div>
            <div style={{ fontSize: 11, color: T.textMuted, lineHeight: 1.8 }}>
              1. Upload your Informatica PowerCenter XML or NiFi flow XML files<br/>
              2. Explore session dependencies across 7 core views (Tier, Galaxy, Constellation, etc.)<br/>
              3. Run Vector Analysis for deep insights (complexity, waves, UMAP clustering)<br/>
              4. Use the Flow Walker to trace data lineage end-to-end<br/>
              5. Export results as HTML, CSV, or JSON
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
