/**
 * Breadcrumb — sticky trail showing navigation path through 6 layers.
 * Every segment is clickable to navigate back to that layer.
 */

import React from 'react';
import { useNavigationContext } from './NavigationProvider';

export default function Breadcrumb() {
  const { breadcrumbs, jumpTo } = useNavigationContext();

  if (breadcrumbs.length <= 1) return null;

  return (
    <div className="sticky top-0 z-20 flex items-center gap-1 px-4 py-2 text-sm bg-gray-900/90 backdrop-blur border-b border-gray-700/50">
      {breadcrumbs.map((crumb, i) => {
        const isLast = i === breadcrumbs.length - 1;
        return (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-gray-500 mx-1">&rsaquo;</span>}
            <button
              onClick={() => !isLast && jumpTo(crumb.layer, crumb.params)}
              className={`px-2 py-0.5 rounded transition-colors ${
                isLast
                  ? 'text-blue-400 font-medium cursor-default'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800 cursor-pointer'
              }`}
              disabled={isLast}
            >
              <span className="text-xs text-gray-500 mr-1">L{crumb.layer}</span>
              {crumb.label.length > 30 ? `${crumb.label.slice(0, 27)}...` : crumb.label}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
