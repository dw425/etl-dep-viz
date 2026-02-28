/**
 * ExecOrderView.tsx -- Timeline with numbered steps, session cards,
 * conflict/chain badges.
 */

import React, { useMemo } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import {
  C,
  buildSessionData,
  buildExecutionOrder,
  deriveWriteConflicts,
  deriveReadAfterWrite,
} from './constants';

interface Props {
  data: TierMapResult;
}

const ExecOrderView: React.FC<Props> = ({ data }) => {
  const sessionData = useMemo(() => buildSessionData(data), [data]);
  const executionOrder = useMemo(() => buildExecutionOrder(data), [data]);
  const writeConflicts = useMemo(() => deriveWriteConflicts(sessionData), [sessionData]);
  const readAfterWrite = useMemo(() => deriveReadAfterWrite(sessionData), [sessionData]);

  return (
    <div style={{ overflowY: 'auto', height: '100%' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>
        Recommended Execution Order
      </div>
      <div style={{ fontSize: 10, color: C.textDim, marginBottom: 16 }}>
        Respects all read-after-write chains and write conflicts
      </div>

      {executionOrder.map((name, i) => {
        const s = sessionData[name];
        if (!s) return null;

        const hasConflict = s.targets.some(t => !!writeConflicts[t]);
        const hasChain = s.targets.some(t => !!readAfterWrite[t]);

        const circleColor = hasConflict
          ? C.conflict
          : hasChain
            ? C.chain
            : '#3b82f6';
        const circleBg = hasConflict
          ? 'rgba(239,68,68,0.15)'
          : hasChain
            ? 'rgba(168,85,247,0.15)'
            : 'rgba(59,130,246,0.15)';

        return (
          <div
            key={name}
            style={{
              display: 'flex',
              alignItems: 'stretch',
              marginBottom: 2,
            }}
          >
            {/* Timeline column */}
            <div
              style={{
                width: 48,
                display: 'flex',
                flexDirection: 'column' as const,
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: circleBg,
                  border: '2px solid ' + circleColor,
                  fontSize: 11,
                  fontWeight: 700,
                  color: circleColor,
                  fontFamily: 'monospace',
                }}
              >
                {i + 1}
              </div>
              {i < executionOrder.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    width: 2,
                    background: C.border,
                    minHeight: 24,
                  }}
                />
              )}
            </div>

            {/* Session card */}
            <div
              style={{
                flex: 1,
                background: C.surface,
                border: '1px solid ' + C.border,
                borderRadius: 8,
                padding: '10px 14px',
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: C.text,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {s.short}
                  </div>
                  <div style={{ fontSize: 9, color: C.textDim, marginTop: 2 }}>
                    writes {'\u2192'} {s.targets.join(', ') || '(none)'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {hasConflict && (
                    <span
                      style={{
                        fontSize: 8,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'rgba(239,68,68,0.1)',
                        color: C.conflict,
                        fontWeight: 700,
                      }}
                    >
                      CONFLICT
                    </span>
                  )}
                  {hasChain && (
                    <span
                      style={{
                        fontSize: 8,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'rgba(168,85,247,0.1)',
                        color: C.chain,
                        fontWeight: 700,
                      }}
                    >
                      CHAIN
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default ExecOrderView;
