/**
 * L5 Mapping Pipeline — transform pipeline within a session.
 * Vertical flow diagram with port details and column lineage mode.
 */

import React from 'react';
import { useNavigationContext } from '../navigation/NavigationProvider';

export default function L5_MappingPipeline() {
  const { currentParams, drillDown, drillUp } = useNavigationContext();

  const sessionId = currentParams.sessionId || '';
  const mappingId = currentParams.mappingId || '';

  return (
    <div className="p-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => drillUp()}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            &larr; Back to Session
          </button>
          <h2 className="text-lg font-medium text-gray-200">
            Mapping Pipeline
          </h2>
        </div>

        <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
          <div className="text-center">
            <div className="text-sm text-gray-400 mb-2">Session: {sessionId}</div>
            <div className="text-sm text-gray-400 mb-4">Mapping: {mappingId || 'Default'}</div>

            <div className="space-y-4">
              {/* Source */}
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                <div className="text-xs text-green-400 font-medium mb-1">SOURCE</div>
                <div className="text-sm text-gray-300">Detailed mapping pipeline requires extended XML parsing data</div>
              </div>

              <div className="flex justify-center">
                <svg width="2" height="30" className="text-gray-600">
                  <line x1="1" y1="0" x2="1" y2="30" stroke="currentColor" strokeWidth="2" strokeDasharray="4,4" />
                </svg>
              </div>

              {/* Transform */}
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                <div className="text-xs text-blue-400 font-medium mb-1">TRANSFORMS</div>
                <div className="text-sm text-gray-300">Transform pipeline details available at L5 with extended parsing</div>
              </div>

              <div className="flex justify-center">
                <svg width="2" height="30" className="text-gray-600">
                  <line x1="1" y1="0" x2="1" y2="30" stroke="currentColor" strokeWidth="2" strokeDasharray="4,4" />
                </svg>
              </div>

              {/* Target */}
              <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4">
                <div className="text-xs text-purple-400 font-medium mb-1">TARGET</div>
                <div className="text-sm text-gray-300">Target details available with extended parsing</div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 text-xs text-gray-500 text-center">
          Full mapping pipeline visualization requires extended XML parsing data beyond basic tier analysis
        </div>
      </div>
    </div>
  );
}
