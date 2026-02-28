/**
 * L5 Mapping Pipeline — transform pipeline within a session.
 * Vertical flow: Source (green) → Transforms (blue chain) → Target (purple)
 * Lookups branch off to the side (orange).
 */

import React, { useMemo, useState } from 'react';
import { useNavigationContext } from '../navigation/NavigationProvider';

interface Instance {
  name: string;
  type: string;
  transformation_name: string;
  transformation_type: string;
}

interface Connector {
  from_instance: string;
  from_field: string;
  to_instance: string;
  to_field: string;
}

interface TransformField {
  transform: string;
  name: string;
  datatype: string;
  precision: string;
  expression: string;
  porttype: string;
}

interface MappingDetail {
  instances: Instance[];
  connectors: Connector[];
  fields: TransformField[];
}

const TYPE_COLORS: Record<string, { bg: string; border: string; text: string; label: string }> = {
  source:    { bg: 'bg-green-500/10',  border: 'border-green-500/30',  text: 'text-green-400',  label: 'SOURCE' },
  target:    { bg: 'bg-purple-500/10', border: 'border-purple-500/30', text: 'text-purple-400', label: 'TARGET' },
  lookup:    { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-400', label: 'LOOKUP' },
  transform: { bg: 'bg-blue-500/10',   border: 'border-blue-500/30',   text: 'text-blue-400',   label: 'TRANSFORM' },
  mapplet:   { bg: 'bg-cyan-500/10',   border: 'border-cyan-500/30',   text: 'text-cyan-400',   label: 'MAPPLET' },
};

function getNodeType(inst: Instance): string {
  const t = inst.type?.toLowerCase() || '';
  const tt = inst.transformation_type?.toLowerCase() || '';
  if (t === 'source') return 'source';
  if (t === 'target') return 'target';
  if (t === 'mapplet') return 'mapplet';
  if (tt.includes('lookup')) return 'lookup';
  return 'transform';
}

export default function L5_MappingPipeline() {
  const { currentParams, tierData, drillUp, drillDown } = useNavigationContext();
  const sessionId = currentParams.sessionId || '';
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const [showLineage, setShowLineage] = useState(false);

  // Find session and mapping detail
  const session = useMemo(() => {
    if (!tierData) return null;
    return tierData.sessions.find(s => s.id === sessionId) || null;
  }, [tierData, sessionId]);

  const detail: MappingDetail | null = useMemo(() => {
    if (!session) return null;
    return (session as any).mapping_detail || null;
  }, [session]);

  // Categorize instances
  const { sources, targets, lookups, transforms } = useMemo(() => {
    if (!detail) return { sources: [] as Instance[], targets: [] as Instance[], lookups: [] as Instance[], transforms: [] as Instance[] };
    const s: Instance[] = [];
    const t: Instance[] = [];
    const l: Instance[] = [];
    const x: Instance[] = [];
    for (const inst of detail.instances) {
      const type = getNodeType(inst);
      if (type === 'source') s.push(inst);
      else if (type === 'target') t.push(inst);
      else if (type === 'lookup') l.push(inst);
      else x.push(inst);
    }
    return { sources: s, targets: t, lookups: l, transforms: x };
  }, [detail]);

  // Get fields for an instance
  const getFields = (instName: string) =>
    detail?.fields.filter(f => f.transform === instName) || [];

  // Get connections to/from an instance
  const getConnections = (instName: string) => ({
    incoming: detail?.connectors.filter(c => c.to_instance === instName) || [],
    outgoing: detail?.connectors.filter(c => c.from_instance === instName) || [],
  });

  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={drillUp} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
            &larr; Back to Session
          </button>
          <h2 className="text-lg font-medium text-gray-200">Mapping Pipeline</h2>
          <span className="text-xs text-gray-500">{session?.full || session?.name || sessionId}</span>
          <div className="ml-auto">
            <button
              onClick={() => setShowLineage(!showLineage)}
              className={`text-xs px-3 py-1 rounded ${showLineage ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-700 text-gray-400'}`}
            >
              {showLineage ? 'Column Lineage ON' : 'Column Lineage'}
            </button>
          </div>
        </div>

        {!detail ? (
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 text-center">
            <div className="text-sm text-gray-400 mb-2">Session: {sessionId}</div>
            <div className="text-sm text-gray-500">
              {session ? (
                <>
                  <div className="mb-3">Mapping detail not available in parsed data.</div>
                  <div className="text-xs">Sources: {(session as any).sources?.join(', ') || 'None'}</div>
                  <div className="text-xs mt-1">Targets: {(session as any).targets?.join(', ') || 'None'}</div>
                  <div className="text-xs mt-1">Lookups: {(session as any).lookups?.join(', ') || 'None'}</div>
                </>
              ) : 'Session not found'}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Sources */}
            <PipelineSection label="SOURCES" items={sources} color={TYPE_COLORS.source}
              expandedNode={expandedNode} setExpandedNode={setExpandedNode}
              getFields={getFields} getConnections={getConnections} showLineage={showLineage} />

            <Arrow />

            {/* Transforms chain */}
            <PipelineSection label="TRANSFORMS" items={transforms} color={TYPE_COLORS.transform}
              expandedNode={expandedNode} setExpandedNode={setExpandedNode}
              getFields={getFields} getConnections={getConnections} showLineage={showLineage} />

            {/* Lookup branch */}
            {lookups.length > 0 && (
              <div className="ml-12 border-l-2 border-orange-500/30 pl-4">
                <PipelineSection label="LOOKUPS" items={lookups} color={TYPE_COLORS.lookup}
                  expandedNode={expandedNode} setExpandedNode={setExpandedNode}
                  getFields={getFields} getConnections={getConnections} showLineage={showLineage} />
              </div>
            )}

            <Arrow />

            {/* Targets */}
            <PipelineSection label="TARGETS" items={targets} color={TYPE_COLORS.target}
              expandedNode={expandedNode} setExpandedNode={setExpandedNode}
              getFields={getFields} getConnections={getConnections} showLineage={showLineage} />
          </div>
        )}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex justify-center">
      <svg width="2" height="24" className="text-gray-600">
        <line x1="1" y1="0" x2="1" y2="24" stroke="currentColor" strokeWidth="2" strokeDasharray="4,4" />
      </svg>
    </div>
  );
}

function PipelineSection({
  label, items, color, expandedNode, setExpandedNode, getFields, getConnections, showLineage,
}: {
  label: string;
  items: Instance[];
  color: { bg: string; border: string; text: string; label: string };
  expandedNode: string | null;
  setExpandedNode: (v: string | null) => void;
  getFields: (name: string) => TransformField[];
  getConnections: (name: string) => { incoming: Connector[]; outgoing: Connector[] };
  showLineage: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className={`text-xs font-medium ${color.text} mb-2`}>{label} ({items.length})</div>
      <div className="space-y-2">
        {items.map(inst => {
          const expanded = expandedNode === inst.name;
          const fields = getFields(inst.transformation_name || inst.name);
          const conns = getConnections(inst.name);
          return (
            <div key={inst.name} className={`${color.bg} border ${color.border} rounded-lg overflow-hidden`}>
              <button
                onClick={() => setExpandedNode(expanded ? null : inst.name)}
                className="w-full flex items-center justify-between p-3 text-left"
              >
                <div>
                  <span className="text-sm text-gray-200 font-medium">{inst.name}</span>
                  {inst.transformation_type && (
                    <span className="ml-2 text-xs text-gray-500">({inst.transformation_type})</span>
                  )}
                </div>
                <span className="text-xs text-gray-500">
                  {fields.length > 0 && `${fields.length} fields`}
                  {expanded ? ' ▲' : ' ▼'}
                </span>
              </button>
              {expanded && (
                <div className="border-t border-gray-700 p-3 space-y-2">
                  {/* Port/field detail */}
                  {fields.length > 0 && (
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Fields:</div>
                      <div className="grid grid-cols-4 gap-1 text-xs">
                        <div className="text-gray-600 font-medium">Name</div>
                        <div className="text-gray-600 font-medium">Type</div>
                        <div className="text-gray-600 font-medium">Port</div>
                        <div className="text-gray-600 font-medium">Expression</div>
                        {fields.slice(0, 20).map((f, i) => (
                          <React.Fragment key={i}>
                            <div className="text-gray-300 truncate">{f.name}</div>
                            <div className="text-gray-500">{f.datatype}{f.precision ? `(${f.precision})` : ''}</div>
                            <div className="text-gray-500">{f.porttype}</div>
                            <div className="text-gray-500 truncate">{f.expression || '-'}</div>
                          </React.Fragment>
                        ))}
                      </div>
                      {fields.length > 20 && <div className="text-xs text-gray-600 mt-1">+{fields.length - 20} more</div>}
                    </div>
                  )}
                  {/* Column lineage */}
                  {showLineage && (conns.incoming.length > 0 || conns.outgoing.length > 0) && (
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Lineage:</div>
                      {conns.incoming.map((c, i) => (
                        <div key={i} className="text-xs text-gray-400">
                          ← {c.from_instance}.{c.from_field} → {c.to_field}
                        </div>
                      ))}
                      {conns.outgoing.map((c, i) => (
                        <div key={i} className="text-xs text-gray-400">
                          → {c.to_instance}.{c.to_field} ← {c.from_field}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
