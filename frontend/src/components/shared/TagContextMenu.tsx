/**
 * TagContextMenu — right-click or button-triggered menu for adding tags to objects.
 * Built-in tag types + custom tag creation.
 */

import React, { useCallback, useState } from 'react';
import { createActiveTag } from '../../api/client';

const BUILT_IN_TAGS = [
  { label: 'PII Risk', color: '#EF4444', tag_type: 'risk' },
  { label: 'Review Needed', color: '#F59E0B', tag_type: 'review' },
  { label: 'Migration Ready', color: '#10B981', tag_type: 'status' },
  { label: 'Converted', color: '#3B82F6', tag_type: 'status' },
  { label: 'Deprecated', color: '#6B7280', tag_type: 'status' },
  { label: 'Question', color: '#A855F7', tag_type: 'question' },
  { label: 'Blocked', color: '#EF4444', tag_type: 'blocker' },
] as const;

interface Props {
  objectId: string;
  objectType: 'session' | 'table' | 'transform';
  position: { x: number; y: number };
  onClose: () => void;
  onTagCreated?: () => void;
}

export default function TagContextMenu({ objectId, objectType, position, onClose, onTagCreated }: Props) {
  const [customMode, setCustomMode] = useState(false);
  const [customLabel, setCustomLabel] = useState('');
  const [customColor, setCustomColor] = useState('#3B82F6');
  const [loading, setLoading] = useState(false);

  const handleAddTag = useCallback(async (label: string, color: string, tagType: string) => {
    setLoading(true);
    try {
      await createActiveTag({
        object_id: objectId,
        object_type: objectType,
        tag_type: tagType,
        label,
        color,
      });
      onTagCreated?.();
      onClose();
    } catch {
      // silently fail — tag creation is best-effort
    } finally {
      setLoading(false);
    }
  }, [objectId, objectType, onClose, onTagCreated]);

  const handleCustomSubmit = useCallback(() => {
    if (!customLabel.trim()) return;
    handleAddTag(customLabel.trim(), customColor, 'custom');
  }, [customLabel, customColor, handleAddTag]);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Menu */}
      <div
        className="fixed z-50 bg-gray-800 rounded-lg border border-gray-700 shadow-xl py-1 min-w-[180px]"
        style={{ left: position.x, top: position.y }}
      >
        <div className="px-3 py-1.5 text-[10px] text-gray-500 border-b border-gray-700">
          Tag {objectType}: {objectId}
        </div>

        {!customMode ? (
          <>
            {BUILT_IN_TAGS.map(tag => (
              <button
                key={tag.label}
                onClick={() => handleAddTag(tag.label, tag.color, tag.tag_type)}
                disabled={loading}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.label}
              </button>
            ))}
            <div className="border-t border-gray-700 mt-1 pt-1">
              <button
                onClick={() => setCustomMode(true)}
                className="w-full px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 transition-colors text-left"
              >
                + Custom tag...
              </button>
            </div>
          </>
        ) : (
          <div className="px-3 py-2 space-y-2">
            <input
              type="text"
              value={customLabel}
              onChange={e => setCustomLabel(e.target.value)}
              placeholder="Tag label"
              className="w-full px-2 py-1 text-xs bg-gray-700 border border-gray-600 rounded text-gray-300 placeholder-gray-500"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handleCustomSubmit()}
            />
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={customColor}
                onChange={e => setCustomColor(e.target.value)}
                className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"
              />
              <button
                onClick={handleCustomSubmit}
                disabled={loading || !customLabel.trim()}
                className="flex-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white transition-colors disabled:opacity-50"
              >
                Add
              </button>
              <button
                onClick={() => setCustomMode(false)}
                className="px-2 py-1 text-xs text-gray-400 hover:text-gray-300 transition-colors"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
