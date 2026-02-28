/**
 * LayerContainer — switches child view based on currentLayer.
 * Manages transition animations between layers.
 */

import React, { Suspense, lazy, useCallback } from 'react';
import { useNavigationContext } from './NavigationProvider';

const L1 = lazy(() => import('../layers/L1_EnterpriseConstellation'));
const L2 = lazy(() => import('../layers/L2_DomainCluster'));
const L3 = lazy(() => import('../layers/L3_WorkflowNeighborhood'));
const L4 = lazy(() => import('../layers/L4_SessionBlueprint'));
const L5 = lazy(() => import('../layers/L5_MappingPipeline'));
const L6 = lazy(() => import('../layers/L6_ObjectDetail'));

const Loading = () => (
  <div className="flex items-center justify-center h-64 text-gray-500">
    <div className="flex flex-col items-center gap-3">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      <span className="text-sm">Loading layer...</span>
    </div>
  </div>
);

export default function LayerContainer() {
  const { currentLayer } = useNavigationContext();

  const renderLayer = useCallback(() => {
    switch (currentLayer) {
      case 1: return <L1 />;
      case 2: return <L2 />;
      case 3: return <L3 />;
      case 4: return <L4 />;
      case 5: return <L5 />;
      case 6: return <L6 />;
      default: return <L1 />;
    }
  }, [currentLayer]);

  return (
    <div
      className="transition-opacity duration-200 ease-in-out"
      key={currentLayer}
    >
      <Suspense fallback={<Loading />}>
        {renderLayer()}
      </Suspense>
    </div>
  );
}
