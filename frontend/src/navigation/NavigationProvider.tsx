/**
 * NavigationProvider — React context for 6-layer progressive disclosure.
 * Wraps the useNavigation hook and provides it to all children.
 */

import React, { createContext, useContext, type ReactNode } from 'react';
import { useNavigation, type NavigationState } from './useNavigation';
import type { TierMapResult } from '../types/tiermap';
import type { VectorResults, DrillFilter } from '../types/vectors';

/** Full context shape provided to all children via useNavigationContext(). */
interface NavigationContextType extends NavigationState {
  drillDown: (layer: number, params?: Record<string, string>) => void;
  drillUp: () => void;
  drillHome: () => void;
  jumpTo: (layer: number, params?: Record<string, string>) => void;
  setFilter: (filter: DrillFilter) => void;
  breadcrumbs: { layer: number; params: Record<string, string>; label: string }[];
  tierData: TierMapResult | null;
  vectorResults: VectorResults | null;
  setTierData: (data: TierMapResult) => void;
  setVectorResults: (data: VectorResults) => void;
}

const NavigationContext = createContext<NavigationContextType | null>(null);

interface ProviderProps {
  children: ReactNode;
  initialTierData?: TierMapResult | null;
  initialVectorResults?: VectorResults | null;
  onVectorResults?: (data: VectorResults) => void;
}

/**
 * Top-level provider that composes the useNavigation hook with tier data and vector results state.
 * Syncs from parent props when initial values change, and propagates vector result updates
 * upward via onVectorResults callback.
 */
export function NavigationProvider({ children, initialTierData, initialVectorResults, onVectorResults }: ProviderProps) {
  const nav = useNavigation();
  const [tierData, setTierData] = React.useState<TierMapResult | null>(initialTierData ?? null);
  const [vectorResults, setVectorResultsInternal] = React.useState<VectorResults | null>(initialVectorResults ?? null);

  // Sync from parent when initial values change
  React.useEffect(() => { if (initialTierData) setTierData(initialTierData); }, [initialTierData]);
  React.useEffect(() => { if (initialVectorResults) setVectorResultsInternal(initialVectorResults); }, [initialVectorResults]);

  const setVectorResults = React.useCallback((data: VectorResults) => {
    setVectorResultsInternal(data);
    onVectorResults?.(data);
  }, [onVectorResults]);

  const value: NavigationContextType = {
    ...nav,
    tierData,
    vectorResults,
    setTierData,
    setVectorResults,
  };

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

/**
 * Hook to consume the NavigationContext. Must be called within a NavigationProvider.
 * @throws Error if called outside of NavigationProvider
 */
export function useNavigationContext() {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigationContext must be used within NavigationProvider');
  return ctx;
}
