/**
 * SemanticToggle — toolbar toggle between Technical and Business terminology.
 * Affects all labels L1–L6 when active.
 */

import React from 'react';

interface Props {
  mode: 'technical' | 'business';
  onToggle: (mode: 'technical' | 'business') => void;
}

/**
 * Pill-shaped toggle switch between "Technical" and "Business" terminology modes.
 * Blue highlight for technical, green for business.
 * @param mode - Currently active mode
 * @param onToggle - Callback when the user switches modes
 */
export default function SemanticToggle({ mode, onToggle }: Props) {
  return (
    <div className="flex items-center gap-1 bg-gray-800 rounded-lg border border-gray-700 p-0.5">
      <button
        onClick={() => onToggle('technical')}
        className={`px-3 py-1 text-xs rounded transition-colors ${
          mode === 'technical'
            ? 'bg-blue-500/20 text-blue-400 font-medium'
            : 'text-gray-500 hover:text-gray-300'
        }`}
      >
        Technical
      </button>
      <button
        onClick={() => onToggle('business')}
        className={`px-3 py-1 text-xs rounded transition-colors ${
          mode === 'business'
            ? 'bg-green-500/20 text-green-400 font-medium'
            : 'text-gray-500 hover:text-gray-300'
        }`}
      >
        Business
      </button>
    </div>
  );
}
