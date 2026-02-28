/**
 * L6 Object Detail — table, transform, or expression detail view.
 * 3 sub-views: Table Detail (6A), Transform Detail (6B), Expression Detail (6C).
 */

import React, { useMemo } from 'react';
import { useNavigationContext } from '../navigation/NavigationProvider';
import type { TierTable, TierConn } from '../types/tiermap';

const TABLE_TYPE_COLORS: Record<string, string> = {
  conflict: '#EF4444',
  chain: '#F97316',
  independent: '#22C55E',
  source: '#10B981',
};

export default function L6_ObjectDetail() {
  const { currentParams, tierData, drillUp } = useNavigationContext();
  const objectType = currentParams.objectType || 'table';
  const objectId = currentParams.objectId || '';

  if (objectType === 'table') {
    return <TableDetail objectId={objectId} />;
  }

  return (
    <div className="p-6">
      <div className="max-w-3xl mx-auto">
        <button onClick={drillUp} className="text-xs text-gray-500 hover:text-gray-300 mb-4 transition-colors">
          &larr; Back
        </button>
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
          <h3 className="text-sm font-medium text-gray-300 mb-2">{objectType} Detail</h3>
          <p className="text-xs text-gray-500">Object: {objectId}</p>
          <p className="text-xs text-gray-500 mt-2">
            Detailed {objectType} view requires extended parsing data
          </p>
        </div>
      </div>
    </div>
  );
}

function TableDetail({ objectId }: { objectId: string }) {
  const { tierData, drillUp, drillDown } = useNavigationContext();

  const table = useMemo(() => {
    if (!tierData) return null;
    return tierData.tables.find(t => t.id === objectId || t.name === objectId) || null;
  }, [tierData, objectId]);

  const connections = useMemo(() => {
    if (!tierData || !table) return { readers: [] as TierConn[], writers: [] as TierConn[], lookups: [] as TierConn[] };
    const readers = tierData.connections.filter(c => c.from === table.id && c.type === 'source_read');
    const writers = tierData.connections.filter(c => c.to === table.id);
    const lookups = tierData.connections.filter(c => c.from === table.id && c.type === 'lookup_stale');
    return { readers, writers, lookups };
  }, [tierData, table]);

  if (!table) {
    return (
      <div className="p-6 text-gray-500">
        <button onClick={drillUp} className="text-xs hover:text-gray-300 mb-4">&larr; Back</button>
        <div>Table not found: {objectId}</div>
      </div>
    );
  }

  const typeColor = TABLE_TYPE_COLORS[table.type] || '#6B7280';

  return (
    <div className="p-6">
      <div className="max-w-3xl mx-auto">
        <button onClick={drillUp} className="text-xs text-gray-500 hover:text-gray-300 mb-4 transition-colors">
          &larr; Back
        </button>

        {/* Table Header */}
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-5 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: typeColor }} />
            <h2 className="text-lg font-medium text-gray-200">{table.name}</h2>
            <span
              className="text-xs px-2 py-0.5 rounded"
              style={{ backgroundColor: `${typeColor}20`, color: typeColor }}
            >
              {table.type}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-4">
            <MetricCard label="Tier" value={table.tier} />
            <MetricCard label="Readers" value={table.readers} />
            <MetricCard label="Conflict Writers" value={table.conflictWriters} />
            <MetricCard label="Lookup Users" value={table.lookupUsers} />
          </div>
        </div>

        {/* Writer Sessions */}
        {connections.writers.length > 0 && (
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-4">
            <h3 className="text-sm font-medium text-gray-300 mb-3">
              Writer Sessions ({connections.writers.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {connections.writers.map((c, i) => (
                <button
                  key={i}
                  onClick={() => drillDown(4, { sessionId: c.from, sessionName: c.from })}
                  className="px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300 transition-colors"
                >
                  {c.from}
                  <span className="ml-1 text-gray-500">({c.type})</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Reader Sessions */}
        {connections.readers.length > 0 && (
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-4">
            <h3 className="text-sm font-medium text-gray-300 mb-3">
              Reader Sessions ({connections.readers.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {connections.readers.map((c, i) => (
                <button
                  key={i}
                  onClick={() => drillDown(4, { sessionId: c.to, sessionName: c.to })}
                  className="px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300 transition-colors"
                >
                  {c.to}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Lookup Users */}
        {connections.lookups.length > 0 && (
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
            <h3 className="text-sm font-medium text-gray-300 mb-3">
              Lookup Users ({connections.lookups.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {connections.lookups.map((c, i) => (
                <button
                  key={i}
                  onClick={() => drillDown(4, { sessionId: c.to, sessionName: c.to })}
                  className="px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300 transition-colors"
                >
                  {c.to}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <div className="text-xl font-bold text-gray-200">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
