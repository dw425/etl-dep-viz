/**
 * Spatial Index — reusable quadtree-based spatial indexing for large node sets.
 *
 * Extracted from ConstellationCanvas for reuse across Galaxy, Tier, and
 * Constellation views. Provides O(log N) nearest-neighbor and viewport
 * culling queries.
 */

import * as d3 from 'd3';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SpatialNode {
  x: number;
  y: number;
  id: string;
  radius?: number;
}

export interface ViewportBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// ── SpatialIndex class ───────────────────────────────────────────────────────

export class SpatialIndex<T extends SpatialNode> {
  private quadtree: d3.Quadtree<T>;
  private nodes: T[];

  constructor(nodes: T[]) {
    this.nodes = nodes;
    this.quadtree = d3.quadtree<T>()
      .x(d => d.x)
      .y(d => d.y)
      .addAll(nodes);
  }

  /**
   * Find the nearest node to (x, y) within maxDistance.
   * Returns null if no node is within range.
   */
  findNearest(x: number, y: number, maxDistance: number = Infinity): T | null {
    return this.quadtree.find(x, y, maxDistance) ?? null;
  }

  /**
   * Find all nodes within a rectangular viewport (viewport culling).
   * Returns only nodes whose centers fall within the bounds.
   */
  queryViewport(bounds: ViewportBounds): T[] {
    const results: T[] = [];
    this.quadtree.visit((node, x0, y0, x1, y1) => {
      // If this quadrant doesn't overlap the viewport, skip it
      if (x0 > bounds.x1 || x1 < bounds.x0 || y0 > bounds.y1 || y1 < bounds.y0) {
        return true; // skip children
      }
      // Check leaf nodes
      if (!node.length) {
        let d = node as d3.QuadtreeLeaf<T>;
        do {
          const p = d.data;
          if (p.x >= bounds.x0 && p.x <= bounds.x1 && p.y >= bounds.y0 && p.y <= bounds.y1) {
            results.push(p);
          }
        } while ((d = d.next!));
      }
      return false;
    });
    return results;
  }

  /**
   * Find all nodes within a circle centered at (cx, cy) with given radius.
   */
  queryRadius(cx: number, cy: number, radius: number): T[] {
    const results: T[] = [];
    const r2 = radius * radius;
    this.quadtree.visit((node, x0, y0, x1, y1) => {
      // Closest point on quad to circle center
      const dx = Math.max(x0 - cx, 0, cx - x1);
      const dy = Math.max(y0 - cy, 0, cy - y1);
      if (dx * dx + dy * dy > r2) return true; // skip children
      if (!node.length) {
        let d = node as d3.QuadtreeLeaf<T>;
        do {
          const p = d.data;
          const dist2 = (p.x - cx) ** 2 + (p.y - cy) ** 2;
          if (dist2 <= r2) results.push(p);
        } while ((d = d.next!));
      }
      return false;
    });
    return results;
  }

  /**
   * Get viewport bounds from a D3 zoom transform and canvas dimensions.
   * Converts screen-space viewport to data-space bounds.
   */
  static viewportFromTransform(
    transform: d3.ZoomTransform,
    width: number,
    height: number,
    padding: number = 50,
  ): ViewportBounds {
    const inv = transform.invert([0, 0]);
    const inv2 = transform.invert([width, height]);
    return {
      x0: inv[0] - padding,
      y0: inv[1] - padding,
      x1: inv2[0] + padding,
      y1: inv2[1] + padding,
    };
  }

  /** Get all nodes (for non-culled rendering). */
  all(): T[] {
    return this.nodes;
  }

  /** Get node count. */
  get size(): number {
    return this.nodes.length;
  }

  /** Rebuild the index with new nodes. */
  rebuild(nodes: T[]): void {
    this.nodes = nodes;
    this.quadtree = d3.quadtree<T>()
      .x(d => d.x)
      .y(d => d.y)
      .addAll(nodes);
  }
}

// ── Viewport culling helper ──────────────────────────────────────────────────

/**
 * Determine if a node is visible in the current viewport.
 * Accounts for node radius so partially visible nodes still render.
 */
export function isNodeVisible(
  node: SpatialNode,
  bounds: ViewportBounds,
): boolean {
  const r = node.radius ?? 0;
  return (
    node.x + r >= bounds.x0 &&
    node.x - r <= bounds.x1 &&
    node.y + r >= bounds.y0 &&
    node.y - r <= bounds.y1
  );
}

/**
 * Determine Level of Detail for a node based on zoom scale.
 * Returns 'dot' | 'circle' | 'full' for progressive detail rendering.
 */
export function getLOD(
  zoomScale: number,
  nodeCount: number,
): 'dot' | 'circle' | 'full' {
  if (nodeCount > 2000 && zoomScale < 0.5) return 'dot';
  if (nodeCount > 500 && zoomScale < 1.0) return 'circle';
  return 'full';
}
