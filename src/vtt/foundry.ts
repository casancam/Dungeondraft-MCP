import { argbToCss } from '../godot/variant.js';
import { imageInfo, type Uvtt, type XY } from './uvtt.js';

/**
 * Universal VTT -> Foundry VTT v13 Scene document data, shaped like the payload foundry-vtt-mcp
 * passes to Scene.create() (packages/mcp-server/src/backend.ts), plus embedded walls and lights.
 */

// CONST.WALL_SENSE_TYPES.NORMAL / WALL_MOVEMENT_TYPES.NORMAL, CONST.WALL_DOOR_TYPES, CONST.WALL_DOOR_STATES
const NORMAL = 20;
const DOOR = { NONE: 0, DOOR: 1 };
const DOOR_STATE = { CLOSED: 0, OPEN: 1 };

export interface FoundryWall {
  c: [number, number, number, number];
  move: number;
  sight: number;
  light: number;
  sound: number;
  door: number;
  ds: number;
  dir: number;
}

export interface FoundryLight {
  x: number;
  y: number;
  rotation: number;
  walls: boolean;
  vision: boolean;
  config: { dim: number; bright: number; color: string | null; alpha: number; luminosity: number; angle: number };
}

export interface FoundrySceneOptions {
  name: string;
  /** Value for background.src, e.g. "maps/amonkhet/tomb.webp" as uploaded to The Forge / Data. */
  imageSrc: string;
  gridDistance?: number;
  gridUnits?: string;
  /** Scene padding fraction (Foundry default 0.25). Walls/lights are offset to match. */
  padding?: number;
  includeLights?: boolean;
  /** Treat objects_line_of_sight (light-blocking objects) as walls. */
  includeObjectWalls?: boolean;
}

/** Foundry offsets the map by padding rounded up to whole grid cells. */
export function paddingOffset(width: number, height: number, grid: number, padding: number) {
  return { x: Math.ceil((width * padding) / grid) * grid, y: Math.ceil((height * padding) / grid) * grid };
}

export function uvttToFoundryScene(uvtt: Uvtt, opts: FoundrySceneOptions) {
  const ppg = uvtt.resolution.pixels_per_grid;
  const origin = uvtt.resolution.map_origin ?? { x: 0, y: 0 };
  let width = Math.round(uvtt.resolution.map_size.x * ppg);
  let height = Math.round(uvtt.resolution.map_size.y * ppg);
  const warnings: string[] = [];
  try {
    const img = imageInfo(Buffer.from(uvtt.image.slice(0, 4096), 'base64'));
    if (img.width !== width || img.height !== height) {
      warnings.push(`Embedded image is ${img.width}x${img.height}px, expected ${width}x${height}; using the image size.`);
      width = img.width;
      height = img.height;
    }
  } catch {
    warnings.push('Could not read the embedded image header; scene size taken from map_size x pixels_per_grid.');
  }
  const padding = opts.padding ?? 0;
  const off = paddingOffset(width, height, ppg, padding);
  const px = (p: XY): [number, number] => [Math.round((p.x - origin.x) * ppg + off.x), Math.round((p.y - origin.y) * ppg + off.y)];

  const walls: FoundryWall[] = [];
  const pushWall = (a: XY, b: XY, door = DOOR.NONE, ds = DOOR_STATE.CLOSED) => {
    const [x1, y1] = px(a);
    const [x2, y2] = px(b);
    if (x1 === x2 && y1 === y2) return;
    walls.push({ c: [x1, y1, x2, y2], move: NORMAL, sight: NORMAL, light: NORMAL, sound: NORMAL, door, ds, dir: 0 });
  };
  const polylines = [...uvtt.line_of_sight, ...(opts.includeObjectWalls ? (uvtt.objects_line_of_sight ?? []) : [])];
  for (const line of polylines) for (let i = 0; i + 1 < line.length; i++) pushWall(line[i], line[i + 1]);
  let doors = 0;
  for (const p of uvtt.portals) {
    if (!p.bounds || p.bounds.length < 2) continue;
    pushWall(p.bounds[0], p.bounds[1], DOOR.DOOR, p.closed ? DOOR_STATE.CLOSED : DOOR_STATE.OPEN);
    doors++;
  }

  const distance = opts.gridDistance ?? 5;
  const lights: FoundryLight[] = (opts.includeLights ?? true)
    ? uvtt.lights.map((l) => {
        const [x, y] = px(l.position);
        const { hex } = argbToCss(l.color ?? 'ffffffff');
        // Range is in squares; Foundry radii are in grid distance units. Bright = half of dim.
        const dim = Number((l.range * distance).toFixed(2));
        return {
          x,
          y,
          rotation: 0,
          walls: true,
          vision: false,
          config: { dim, bright: Number((dim / 2).toFixed(2)), color: hex, alpha: Math.min(1, 0.5 * (l.intensity ?? 1)), luminosity: 0.5, angle: 360 },
        };
      })
    : [];

  const baked = uvtt.environment?.baked_lighting ?? true;
  const scene = {
    name: opts.name,
    background: { src: opts.imageSrc },
    width,
    height,
    padding,
    initial: { x: Math.round(width / 2 + off.x), y: Math.round(height / 2 + off.y), scale: 1 },
    backgroundColor: '#999999',
    grid: { type: 1, size: ppg, color: '#000000', alpha: 0.2, distance, units: opts.gridUnits ?? 'ft' },
    tokenVision: true,
    fog: { exploration: true },
    environment: { darknessLevel: 0, globalLight: { enabled: false } },
    navigation: true,
    active: false,
    ownership: { default: 2 },
    walls,
    lights,
    flags: { 'dungeondraft-mcp': { source: 'uvtt', uvttFormat: uvtt.format, bakedLighting: baked } },
  };
  if (baked && lights.length) warnings.push('The map image already has Dungeondraft lighting baked in; the Foundry lights add vision/illumination on top. Use include_lights=false if that looks doubled.');
  return { scene, stats: { walls: walls.length - doors, doors, lights: lights.length, width, height, gridSize: ppg }, warnings };
}
