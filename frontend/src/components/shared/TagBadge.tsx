/**
 * TagBadge — small colored pill badge for active tags on sessions/tables/transforms.
 */

import React from 'react';
import type { ActiveTag } from '../../types/vectors';

interface Props {
  tag: ActiveTag;
  onRemove?: (tagId: string) => void;
}

/**
 * Renders a small colored pill badge for an active tag.
 * Shows the tag label and an optional "x" remove button.
 * @param tag - The ActiveTag to display
 * @param onRemove - Optional callback to delete the tag (shows remove button when provided)
 */
export default function TagBadge({ tag, onRemove }: Props) {
  const bgColor = tag.color ? `${tag.color}20` : '#3B82F620';
  const textColor = tag.color ?? '#3B82F6';

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
      style={{ backgroundColor: bgColor, color: textColor }}
    >
      {tag.label}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(tag.tag_id);
          }}
          className="hover:opacity-70 transition-opacity ml-0.5"
        >
          ×
        </button>
      )}
    </span>
  );
}
