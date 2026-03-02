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

/**
 * Object detail dispatcher: routes to the appropriate sub-view based on objectType.
 * Sub-views: TableDetail (6A), TransformDetail (6B), ExpressionDetail (6C).
 */
export default function L6_ObjectDetail() {
  const { currentParams, tierData, drillUp } = useNavigationContext();
  const objectType = currentParams.objectType || 'table';
  const objectId = currentParams.objectId || '';

  if (objectType === 'table') {
    return <TableDetail objectId={objectId} />;
  }
  if (objectType === 'transform') {
    return <TransformDetail objectId={objectId} />;
  }
  if (objectType === 'expression') {
    return <ExpressionDetail objectId={objectId} />;
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
        </div>
      </div>
    </div>
  );
}

/** L6A: Table detail showing type, tier, readers, writers, and lookup users. */
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

/** L6B: Transform detail showing input/output ports and field expressions. */
function TransformDetail({ objectId }: { objectId: string }) {
  const { tierData, drillUp, drillDown } = useNavigationContext();

  // Find any session mapping_detail containing this transform
  const detail = useMemo(() => {
    if (!tierData) return null;
    for (const s of tierData.sessions) {
      const md = (s as any).mapping_detail;
      if (!md) continue;
      const inst = md.instances?.find((i: any) => i.name === objectId || i.transformation_name === objectId);
      if (inst) {
        const fields = md.fields?.filter((f: any) => f.transform === objectId || f.transform === inst.transformation_name) || [];
        const incoming = md.connectors?.filter((c: any) => c.to_instance === objectId) || [];
        const outgoing = md.connectors?.filter((c: any) => c.from_instance === objectId) || [];
        return { instance: inst, fields, incoming, outgoing, sessionId: s.id };
      }
    }
    return null;
  }, [tierData, objectId]);

  return (
    <div className="p-6">
      <div className="max-w-3xl mx-auto">
        <button onClick={drillUp} className="text-xs text-gray-500 hover:text-gray-300 mb-4 transition-colors">
          &larr; Back
        </button>
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-5 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-3 h-3 rounded-full bg-blue-500" />
            <h2 className="text-lg font-medium text-gray-200">{objectId}</h2>
            {detail?.instance && (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">
                {detail.instance.transformation_type}
              </span>
            )}
          </div>

          {detail ? (
            <div className="space-y-4">
              {/* Input Ports */}
              <div>
                <h3 className="text-sm font-medium text-gray-300 mb-2">Input Ports ({detail.incoming.length})</h3>
                {detail.incoming.map((c: any, i: number) => (
                  <div key={i} className="text-xs text-gray-400 flex gap-2 py-1">
                    <span className="text-green-400">{c.from_instance}</span>
                    <span className="text-gray-600">.</span>
                    <span>{c.from_field}</span>
                    <span className="text-gray-600">→</span>
                    <span className="text-blue-400">{c.to_field}</span>
                  </div>
                ))}
              </div>

              {/* Output Ports */}
              <div>
                <h3 className="text-sm font-medium text-gray-300 mb-2">Output Ports ({detail.outgoing.length})</h3>
                {detail.outgoing.map((c: any, i: number) => (
                  <div key={i} className="text-xs text-gray-400 flex gap-2 py-1">
                    <span className="text-blue-400">{c.from_field}</span>
                    <span className="text-gray-600">→</span>
                    <span className="text-purple-400">{c.to_instance}</span>
                    <span className="text-gray-600">.</span>
                    <span>{c.to_field}</span>
                  </div>
                ))}
              </div>

              {/* Fields with expressions */}
              {detail.fields.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-300 mb-2">Fields ({detail.fields.length})</h3>
                  <div className="space-y-1">
                    {detail.fields.map((f: any, i: number) => (
                      <div key={i} className="flex items-start gap-3 text-xs py-1 border-b border-gray-700/50">
                        <span className="text-gray-300 font-medium w-32 truncate">{f.name}</span>
                        <span className="text-gray-500 w-20">{f.datatype}{f.precision ? `(${f.precision})` : ''}</span>
                        <span className="text-gray-500 w-16">{f.porttype}</span>
                        {f.expression && (
                          <button
                            onClick={() => drillDown(6, { objectType: 'expression', objectId: `${objectId}::${f.name}` })}
                            className="text-yellow-500 hover:text-yellow-400 truncate flex-1"
                          >
                            {f.expression}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500">Transform detail not found in parsed data.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** L6C: Expression detail showing the Informatica expression text with data type info. */
function ExpressionDetail({ objectId }: { objectId: string }) {
  const { tierData, drillUp } = useNavigationContext();

  // objectId format: "TRANSFORM_NAME::FIELD_NAME"
  const [transformName, fieldName] = objectId.split('::');

  const detail = useMemo(() => {
    if (!tierData) return null;
    for (const s of tierData.sessions) {
      const md = (s as any).mapping_detail;
      if (!md) continue;
      const field = md.fields?.find(
        (f: any) => (f.transform === transformName) && (f.name === fieldName)
      );
      if (field) {
        // Find all fields from this transform that contribute
        const allFields = md.fields?.filter((f: any) => f.transform === transformName) || [];
        return { field, allFields, sessionId: s.id };
      }
    }
    return null;
  }, [tierData, transformName, fieldName]);

  return (
    <div className="p-6">
      <div className="max-w-3xl mx-auto">
        <button onClick={drillUp} className="text-xs text-gray-500 hover:text-gray-300 mb-4 transition-colors">
          &larr; Back
        </button>
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-5 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <h2 className="text-lg font-medium text-gray-200">{fieldName}</h2>
            <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
              Expression
            </span>
          </div>
          <div className="text-xs text-gray-500 mb-4">Transform: {transformName}</div>

          {detail?.field ? (
            <div className="space-y-4">
              {/* Expression code */}
              <div>
                <h3 className="text-sm font-medium text-gray-300 mb-2">Expression</h3>
                <div className="bg-gray-900 rounded p-3 font-mono text-sm text-yellow-300 whitespace-pre-wrap border border-gray-700">
                  {detail.field.expression || 'No expression (passthrough)'}
                </div>
              </div>

              {/* Data type */}
              <div className="flex gap-6">
                <div>
                  <div className="text-xs text-gray-500">Data Type</div>
                  <div className="text-sm text-gray-300">{detail.field.datatype}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Precision</div>
                  <div className="text-sm text-gray-300">{detail.field.precision || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Port Type</div>
                  <div className="text-sm text-gray-300">{detail.field.porttype || '-'}</div>
                </div>
              </div>

              {/* Related fields in same transform */}
              {detail.allFields.length > 1 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-300 mb-2">
                    Other Fields in {transformName} ({detail.allFields.length - 1})
                  </h3>
                  <div className="space-y-1 max-h-40 overflow-auto">
                    {detail.allFields.filter((f: any) => f.name !== fieldName).map((f: any, i: number) => (
                      <div key={i} className="text-xs text-gray-400 flex gap-2">
                        <span className="w-32 truncate">{f.name}</span>
                        <span className="text-gray-600">{f.datatype}</span>
                        {f.expression && <span className="text-yellow-500/60 truncate">{f.expression}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500">Expression detail not found.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Centered metric card used in the table detail header grid. */
function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <div className="text-xl font-bold text-gray-200">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
