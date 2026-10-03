import type { Vec2 } from '../godot/variant.js';

/** Dungeondraft stores positions in its own pixels: 256 per grid square. */
export const PX_PER_SQUARE = 256;

export const gridToPx = ([x, y]: Vec2): Vec2 => [x * PX_PER_SQUARE, y * PX_PER_SQUARE];
export const pxToGrid = ([x, y]: Vec2): Vec2 => [round(x / PX_PER_SQUARE), round(y / PX_PER_SQUARE)];

export const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

/** Axis-aligned rectangle in grid squares: x,y = top-left corner. */
export interface GridRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectContainsGrid(r: GridRect, [gx, gy]: Vec2, eps = 1e-6): boolean {
  return gx >= r.x - eps && gy >= r.y - eps && gx <= r.x + r.width + eps && gy <= r.y + r.height + eps;
}

export function rectContainsPx(r: GridRect, p: Vec2): boolean {
  return rectContainsGrid(r, [p[0] / PX_PER_SQUARE, p[1] / PX_PER_SQUARE]);
}

export interface SegmentHit {
  /** Index of the segment (closing segment of a loop = points.length - 1). */
  segment: number;
  /** Fraction along that segment, 0..1. */
  t: number;
  point: Vec2;
  distance: number;
  direction: Vec2;
  length: number;
}

/** Segments of a polyline; a loop includes the closing segment. */
export function segments(points: Vec2[], loop: boolean): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push([points[i], points[i + 1]]);
  if (loop && points.length > 2) out.push([points[points.length - 1], points[0]]);
  return out;
}

/** Closest point on a polyline. Used to attach doors to walls (Dungeondraft's wall_distance = segment + t). */
export function closestOnPolyline(points: Vec2[], loop: boolean, p: Vec2): SegmentHit | null {
  let best: SegmentHit | null = null;
  segments(points, loop).forEach(([a, b], i) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len);
    t = Math.min(1, Math.max(0, t));
    const q: Vec2 = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!best || d < best.distance - 1e-9) best = { segment: i, t, point: q, distance: d, direction: [dx / len, dy / len], length: len };
  });
  return best;
}

export function bbox(points: Vec2[]): { min: Vec2; max: Vec2 } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}
