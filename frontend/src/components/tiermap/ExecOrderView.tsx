/**
 * ExecOrderView -- Recommended execution order timeline.
 *
 * Displays sessions as a vertical timeline with numbered step circles and
 * connecting lines. Each card shows write targets and badges for CONFLICT
 * (write-write on the same table) and CHAIN (read-after-write dependency).
 *
 * Layout:
 *   Left column  — numbered circle + vertical connector line
 *   Right column — session card with name, targets, conflict/chain badges
 *   Right edge   — TierFilterSidebar (compact)
 *
 * Performance:
 *   - Virtual scrolling kicks in at 200+ sessions to keep DOM node count low.
 *   - ResizeObserver tracks container height so the visible window stays accurate.
 *   - Fixed ITEM_HEIGHT (64px) is assumed for position calculations.
 *
 * @param data - Full tier map result; filtered via TierFilterSidebar before rendering.
 */

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import {
  C,
  buildSessionData,
  buildExecutionOrder,
  deriveWriteConflicts,
  deriveReadAfterWrite,
} from './constants';
import TierFilterSidebar, { type TierFilters, getDefaultTierFilters, applyTierFilters } from '../shared/TierFilterSidebar';

interface Props {
  data: TierMapResult;
}

const ExecOrderView: React.FC<Props> = ({ data }) => {
  const [tierFilters, setTierFilters] = useState<TierFilters>(getDefaultTierFilters);
  const filteredData = useMemo(() => applyTierFilters(data, tierFilters), [data, tierFilters]);
  const sessionData = useMemo(() => buildSessionData(filteredData), [filteredData]);
  const executionOrder = useMemo(() => buildExecutionOrder(filteredData), [filteredData]);
  const writeConflicts = useMemo(() => deriveWriteConflicts(sessionData), [sessionData]);
  const readAfterWrite = useMemo(() => deriveReadAfterWrite(sessionData), [sessionData]);

  // Virtual scrolling for large lists
  const ITEM_HEIGHT = 64;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setContainerHeight(e.contentRect.height);
    });
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop);
  }, []);

  const useVirtual = executionOrder.length > 200;
  const startIdx = useVirtual ? Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 3) : 0;
  const endIdx = useVirtual ? Math.min(executionOrder.length, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + 3) : executionOrder.length;
  const visibleItems = executionOrder.slice(startIdx, endIdx);

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
    <div ref={scrollRef} onScroll={handleScroll} style={{ overflowY: 'auto', flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>
        Recommended Execution Order
      </div>
      <div style={{ fontSize: 10, color: C.textDim, marginBottom: 16 }}>
        Respects all read-after-write chains and write conflicts ({executionOrder.length} sessions)
      </div>

      {useVirtual && <div style={{ height: startIdx * ITEM_HEIGHT }} />}
      {visibleItems.map((name, vi) => {
        const i = startIdx + vi;
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
      {useVirtual && <div style={{ height: (executionOrder.length - endIdx) * ITEM_HEIGHT }} />}
    </div>
    <TierFilterSidebar data={data} filters={tierFilters} onChange={setTierFilters} compact />
    </div>
  );
};

export default ExecOrderView;
