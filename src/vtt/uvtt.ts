import fs from 'node:fs';
import { parseVector2, parseVector2Array, type Vec2 } from '../godot/variant.js';
import { closestOnPolyline, PX_PER_SQUARE, segments } from '../map/geometry.js';
import type { DDMap, Level } from '../map/types.js';

/** Universal VTT (.dd2vtt / .uvtt). All coordinates are in grid squares. */
export interface XY {
  x: number;
  y: number;
}
export interface UvttPortal {
  position: XY;
  bounds: [XY, XY];
  rotation: number;
  closed: boolean;
  freestanding: boolean;
}
export interface UvttLight {
  position: XY;
  range: number;
  intensity: number;
  color: string;
  shadows: boolean;
}
export interface Uvtt {
  format: number;
  resolution: { map_origin: XY; map_size: XY; pixels_per_grid: number };
  line_of_sight: XY[][];
  objects_line_of_sight?: XY[][];
  portals: UvttPortal[];
  environment?: { baked_lighting: boolean; ambient_light: string };
  lights: UvttLight[];
  image: string;
}

export function readUvtt(file: string): Uvtt {
  const d = JSON.parse(fs.readFileSync(file, 'utf8')) as Uvtt;
  if (!d?.resolution?.map_size || typeof d.resolution.pixels_per_grid !== 'number') throw new Error(`${file} is not a Universal VTT file (no resolution).`);
  d.line_of_sight ??= [];
  d.portals ??= [];
  d.lights ??= [];
  return d;
}

export function imageInfo(buf: Buffer): { type: 'png' | 'webp' | 'jpg'; width: number; height: number } {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { type: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { type: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // Walk JPEG markers to the first SOFn.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  throw new Error('Unsupported image (expected PNG, WEBP or JPEG).');
}

const sq = ([x, y]: Vec2): XY => ({ x: Number((x / PX_PER_SQUARE).toFixed(6)), y: Number((y / PX_PER_SQUARE).toFixed(6)) });

/**
 * Geometry of one level in Universal VTT terms. Walls are cut where doors sit (the door itself
 * becomes a portal), matching how Dungeondraft's own export separates walls from portals.
 */
export function levelGeometry(level: Level) {
  const line_of_sight: XY[][] = [];
  const portals: UvttPortal[] = [];

  for (const w of level.walls ?? []) {
    const pts = parseVector2Array(w.points);
    const segs = segments(pts, w.loop);
    // Door gaps per segment, in px along the segment.
    const gaps = new Map<number, [number, number][]>();
    for (const p of w.portals ?? []) {
      const pos = parseVector2(p.position);
      const hit = closestOnPolyline(pts, w.loop, pos);
      if (!hit) continue;
      const c = hit.t * hit.length;
      gaps.set(hit.segment, [...(gaps.get(hit.segment) ?? []), [c - p.radius, c + p.radius]]);
      const [dx, dy] = hit.direction;
      portals.push({
        position: sq(pos),
        bounds: [sq([pos[0] - dx * p.radius, pos[1] - dy * p.radius]), sq([pos[0] + dx * p.radius, pos[1] + dy * p.radius])],
        rotation: p.rotation,
        closed: p.closed,
        freestanding: false,
      });
    }
    // Emit polylines, breaking at gaps.
    let cur: Vec2[] = [];
    const flush = () => {
      if (cur.length >= 2) line_of_sight.push(cur.map(sq));
      cur = [];
    };
    segs.forEach(([a, b], i) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const at = (d: number): Vec2 => [a[0] + ((b[0] - a[0]) * d) / len, a[1] + ((b[1] - a[1]) * d) / len];
      const g = (gaps.get(i) ?? []).map(([s, e]) => [Math.max(0, s), Math.min(len, e)] as [number, number]).sort((x, y) => x[0] - y[0]);
      let pos = 0;
      if (!cur.length) cur.push(a);
      for (const [s, e] of g) {
        if (s > pos) cur.push(at(s));
        flush();
        pos = Math.max(pos, e);
        if (pos < len) cur.push(at(pos));
      }
      if (pos < len) cur.push(b);
    });
    flush();
  }

  for (const p of level.portals ?? []) {
    const pos = parseVector2(p.position);
    const [dx, dy] = parseVector2(p.direction);
    portals.push({
      position: sq(pos),
      bounds: [sq([pos[0] - dx * p.radius, pos[1] - dy * p.radius]), sq([pos[0] + dx * p.radius, pos[1] + dy * p.radius])],
      rotation: p.rotation,
      closed: p.closed,
      freestanding: true,
    });
  }

  const lights: UvttLight[] = (level.lights ?? []).map((l) => ({
    position: sq(parseVector2(l.position)),
    range: l.range,
    intensity: l.intensity,
    color: l.color,
    shadows: l.shadows,
  }));
  return { line_of_sight, portals, lights };
}

/** Build a .dd2vtt from map geometry plus an image exported from Dungeondraft. */
export function buildUvtt(map: DDMap, level: Level, image: Buffer): { uvtt: Uvtt; warnings: string[] } {
  const info = imageInfo(image);
  const w = Number(map.world.width);
  const h = Number(map.world.height);
  const ppgX = info.width / w;
  const ppgY = info.height / h;
  const warnings: string[] = [];
  if (Math.abs(ppgX - ppgY) > 0.5) throw new Error(`Image is ${info.width}x${info.height}px but the map is ${w}x${h} squares; the aspect ratios don't match. Export the full map from Dungeondraft.`);
  const ppg = Math.round(ppgX);
  if (Math.abs(ppgX - ppg) > 0.01) warnings.push(`Image width ${info.width}px is not a whole number of pixels per square (${ppgX.toFixed(2)}); using ${ppg}.`);
  const geo = levelGeometry(level);
  return {
    uvtt: {
      format: 0.2,
      resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: w, y: h }, pixels_per_grid: ppg },
      line_of_sight: geo.line_of_sight,
      portals: geo.portals,
      environment: { baked_lighting: level.environment?.baked_lighting ?? true, ambient_light: level.environment?.ambient_light ?? 'ffffffff' },
      lights: geo.lights,
      image: image.toString('base64'),
    },
    warnings,
  };
}
