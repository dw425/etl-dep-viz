/**
 * Navigation hook for 6-layer progressive disclosure.
 * Manages a stack of layer contexts with drill-down/up/home operations.
 */

import { useCallback, useState } from 'react';
import type { LayerContext, DrillFilter } from '../types/vectors';

export interface NavigationState {
  stack: LayerContext[];
  currentLayer: number;
  currentParams: Record<string, string>;
  filter: DrillFilter;
}

export function useNavigation() {
  const [state, setState] = useState<NavigationState>({
    stack: [{ layer: 1, params: {} }],
    currentLayer: 1,
    currentParams: {},
    filter: {},
  });

  const drillDown = useCallback((layer: number, params: Record<string, string> = {}) => {
    setState(prev => {
      const newEntry: LayerContext = { layer, params, scrollPosition: window.scrollY };
      return {
        ...prev,
        stack: [...prev.stack, newEntry],
        currentLayer: layer,
        currentParams: params,
      };
    });
  }, []);

  const drillUp = useCallback(() => {
    setState(prev => {
      if (prev.stack.length <= 1) return prev;
      const newStack = prev.stack.slice(0, -1);
      const top = newStack[newStack.length - 1];
      return {
        ...prev,
        stack: newStack,
        currentLayer: top.layer,
        currentParams: top.params,
      };
    });
  }, []);

  const drillHome = useCallback(() => {
    setState(prev => ({
      ...prev,
      stack: [{ layer: 1, params: {} }],
      currentLayer: 1,
      currentParams: {},
    }));
  }, []);

  const jumpTo = useCallback((layer: number, params: Record<string, string> = {}) => {
    setState(prev => {
      // Truncate stack to the target layer depth
      const truncIdx = prev.stack.findIndex(s => s.layer >= layer);
      const base = truncIdx >= 0 ? prev.stack.slice(0, truncIdx) : prev.stack;
      return {
        ...prev,
        stack: [...base, { layer, params }],
        currentLayer: layer,
        currentParams: params,
      };
    });
  }, []);

  const setFilter = useCallback((filter: DrillFilter) => {
    setState(prev => ({ ...prev, filter }));
  }, []);

  const breadcrumbs = state.stack.map(ctx => ({
    layer: ctx.layer,
    params: ctx.params,
    label: _layerLabel(ctx),
  }));

  return {
    ...state,
    drillDown,
    drillUp,
    drillHome,
    jumpTo,
    setFilter,
    breadcrumbs,
  };
}

function _layerLabel(ctx: LayerContext): string {
  switch (ctx.layer) {
    case 1: return 'Enterprise';
    case 2: return ctx.params.groupLabel || `Group ${ctx.params.groupId || ''}`;
    case 3: return ctx.params.scopeLabel || ctx.params.scopeId || 'Workflow';
    case 4: return ctx.params.sessionName || ctx.params.sessionId || 'Session';
    case 5: return ctx.params.mappingId || 'Mapping';
    case 6: return ctx.params.objectId || 'Detail';
    default: return `L${ctx.layer}`;
  }
}
