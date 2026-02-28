/**
 * ConflictsView.tsx -- Two sections: Write-Write Conflicts (tables with >1
 * writer) and Read-After-Write Chains (tables where readers depend on
 * writers).
 */

import React, { useMemo } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import {
  C,
  buildSessionData,
  deriveWriteConflicts,
  deriveReadAfterWrite,
} from './constants';

interface Props {
  data: TierMapResult;
}

const ConflictsView: React.FC<Props> = ({ data }) => {
  const sessionData = useMemo(() => buildSessionData(data), [data]);
  const writeConflicts = useMemo(() => deriveWriteConflicts(sessionData), [sessionData]);
  const readAfterWrite = useMemo(() => deriveReadAfterWrite(sessionData), [sessionData]);

  const conflictEntries = useMemo(
    () => Object.entries(writeConflicts),
    [writeConflicts],
  );
  const rawEntries = useMemo(
    () => Object.entries(readAfterWrite),
    [readAfterWrite],
  );

  return (
    <div style={{ overflowY: 'auto', height: '100%' }}>
      {/* ── Write-Write Conflicts ──────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: C.conflict,
            marginBottom: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 16 }}>{'\u26A0'}</span>
          Write-Write Conflicts ({conflictEntries.length})
        </div>
        <div style={{ fontSize: 10, color: C.textDim, marginBottom: 12 }}>
          Multiple sessions writing to the same target &mdash; validation depends on execution
          order
        </div>

        {conflictEntries.length === 0 && (
          <div
            style={{
              fontSize: 11,
              color: C.textDim,
              padding: 16,
              background: C.surface,
              borderRadius: 8,
              border: '1px solid ' + C.border,
              textAlign: 'center' as const,
            }}
          >
            No write-write conflicts detected
          </div>
        )}

        {conflictEntries.map(([table, writers]) => (
          <div
            key={table}
            style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 8,
              padding: 14,
              marginBottom: 10,
            }}
          >
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 12,
                fontWeight: 700,
                color: C.write,
                marginBottom: 8,
              }}
            >
              {table}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
              {writers.map(s => (
                <span
                  key={s}
                  style={{
                    fontSize: 10,
                    padding: '4px 10px',
                    borderRadius: 5,
                    background: C.surface,
                    color: C.text,
                    border: '1px solid ' + C.border,
                  }}
                >
                  {sessionData[s]?.short || s}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ── Read-After-Write Chains ────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: C.chain,
            marginBottom: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 16 }}>{'\u26D3'}</span>
          Read-After-Write Chains ({rawEntries.length})
        </div>
        <div style={{ fontSize: 10, color: C.textDim, marginBottom: 12 }}>
          Reader MUST run after writer
        </div>

        {rawEntries.length === 0 && (
          <div
            style={{
              fontSize: 11,
              color: C.textDim,
              padding: 16,
              background: C.surface,
              borderRadius: 8,
              border: '1px solid ' + C.border,
              textAlign: 'center' as const,
            }}
          >
            No read-after-write chains detected
          </div>
        )}

        {rawEntries.map(([table, { writers, readers }]) => (
          <div
            key={table}
            style={{
              background: 'rgba(168,85,247,0.06)',
              border: '1px solid rgba(168,85,247,0.2)',
              borderRadius: 8,
              padding: 14,
              marginBottom: 10,
            }}
          >
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 12,
                fontWeight: 700,
                color: C.chain,
                marginBottom: 10,
              }}
            >
              {table}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap' as const,
              }}
            >
              {/* Writers */}
              <div>
                <div
                  style={{
                    fontSize: 8,
                    color: C.textDim,
                    textTransform: 'uppercase' as const,
                    marginBottom: 4,
                  }}
                >
                  Writers
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {writers.map(x => (
                    <span
                      key={x}
                      style={{
                        fontSize: 10,
                        padding: '3px 8px',
                        borderRadius: 4,
                        background: 'rgba(239,68,68,0.1)',
                        color: C.write,
                        fontFamily: 'monospace',
                      }}
                    >
                      {sessionData[x]?.short || x}
                    </span>
                  ))}
                </div>
              </div>

              {/* Arrow */}
              <div style={{ fontSize: 18, color: C.chain }}>{'\u2192'}</div>

              {/* Readers */}
              <div>
                <div
                  style={{
                    fontSize: 8,
                    color: C.textDim,
                    textTransform: 'uppercase' as const,
                    marginBottom: 4,
                  }}
                >
                  Readers
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {readers.map(x => (
                    <span
                      key={x}
                      style={{
                        fontSize: 10,
                        padding: '3px 8px',
                        borderRadius: 4,
                        background: 'rgba(34,197,94,0.1)',
                        color: C.read,
                        fontFamily: 'monospace',
                      }}
                    >
                      {sessionData[x]?.short || x}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ConflictsView;
