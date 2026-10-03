import {
  formatByteArray,
  formatVector2,
  formatVector2Array,
  parseByteArray,
  parseVector2,
  parseVector2Array,
  toArgb,
  type Vec2,
} from '../godot/variant.js';
import { closestOnPolyline, gridToPx, PX_PER_SQUARE, rectContainsPx, round, type GridRect } from './geometry.js';
import type { MapEditor, ElementType } from './editor.js';
import type { Level, Light, MapObject, PathElement, Pattern, Portal, Wall } from './types.js';

const DEG = Math.PI / 180;
const rad = (deg: number) => Number((deg * DEG).toFixed(6));
const scaleVec = (s: number | Vec2 | undefined): Vec2 => (s === undefined ? [1, 1] : typeof s === 'number' ? [s, s] : s);

export const DEFAULTS = {
  layer: 100, // "User Layer 1": every element in every sample map uses it
  wallTexture: 'res://textures/walls/stone.png',
  doorTexture: 'res://textures/portals/door_00.png',
  lightTexture: 'res://textures/lights/point.png',
  lightColor: 'ffeccd8b', // used by every light in the samples
};

// ---------- objects ----------

export interface ObjectInput {
  asset: string;
  /** Grid coordinates of the object's centre. */
  at: Vec2;
  rotation?: number; // degrees clockwise
  scale?: number | Vec2;
  mirror?: boolean;
  layer?: number;
  shadow?: boolean;
  block_light?: boolean;
  custom_color?: string;
}

export function addObjects(ed: MapEditor, levelRef: string | number | undefined, items: ObjectInput[]) {
  const [key, level] = ed.level(levelRef);
  const added: { node_id: string; asset: string; at: Vec2 }[] = [];
  for (const it of items) {
    ed.useAsset(it.asset, 'objects');
    const o: MapObject = {
      position: formatVector2(gridToPx(it.at)),
      rotation: rad(it.rotation ?? 0),
      scale: formatVector2(scaleVec(it.scale)),
      mirror: it.mirror ?? false,
      texture: it.asset,
      layer: it.layer ?? DEFAULTS.layer,
      shadow: it.shadow ?? true,
      ...(ed.format >= 3 ? { block_light: it.block_light ?? false } : {}),
      ...(it.custom_color ? { custom_color: toArgb(it.custom_color) } : {}),
      node_id: '',
    };
    o.node_id = ed.allocId();
    level.objects.push(o);
    added.push({ node_id: o.node_id, asset: it.asset, at: it.at });
  }
  ed.touch(key, 'objects');
  ed.delta(key, 'objects', added.length);
  return { level: key, added };
}

// ---------- walls & doors ----------

export interface DoorInput {
  /** Grid point on (or within 0.25 squares of) the wall where the door's centre goes. */
  at: Vec2;
  /** Door width in squares (default 1). */
  width?: number;
  asset?: string;
  open?: boolean;
}

export interface WallInput {
  points: Vec2[];
  loop?: boolean;
  asset?: string;
  color?: string;
  shadow?: boolean;
  doors?: DoorInput[];
}

export function makePortal(ed: MapEditor, wall: { points: Vec2[]; loop: boolean; node_id: string }, d: DoorInput): Portal {
  ed.useAsset(d.asset ?? DEFAULTS.doorTexture, 'portals');
  const px = wall.points.map(gridToPx);
  const hit = closestOnPolyline(px, wall.loop, gridToPx(d.at));
  if (!hit) throw new Error('Wall has no usable segments for a door.');
  if (hit.distance > PX_PER_SQUARE / 4) {
    throw new Error(`Door at (${d.at}) is ${round(hit.distance / PX_PER_SQUARE, 2)} squares from the wall; it must be on the wall (within 0.25 squares).`);
  }
  const radius = ((d.width ?? 1) * PX_PER_SQUARE) / 2;
  const along = hit.t * hit.length;
  if (along < radius - 1e-6 || hit.length - along < radius - 1e-6) {
    ed.warnings.push(`Door at (${d.at}) extends past the end of its wall segment.`);
  }
  const [dx, dy] = hit.direction;
  const p: Portal = {
    position: formatVector2(hit.point),
    rotation: Number(Math.atan2(dy, dx).toFixed(6)),
    scale: 'Vector2( 1, 1 )',
    direction: formatVector2([Number(dx.toFixed(6)), Number(dy.toFixed(6))]),
    texture: d.asset ?? DEFAULTS.doorTexture,
    radius,
    // Verified against real maps: wall_id is a decimal int in format 2, a hex string in format 3.
    wall_id: ed.format >= 3 ? wall.node_id : parseInt(wall.node_id, 16),
    // Verified: segment index + fraction along that segment.
    wall_distance: Number((hit.segment + hit.t).toFixed(6)),
    closed: !(d.open ?? false),
    node_id: '',
  };
  p.node_id = ed.allocId();
  return p;
}

export function addWalls(ed: MapEditor, levelRef: string | number | undefined, items: WallInput[]) {
  const [key, level] = ed.level(levelRef);
  const added: { node_id: string; points: number; doors: string[] }[] = [];
  let doorCount = 0;
  for (const it of items) {
    if (it.points.length < 2) throw new Error('A wall needs at least 2 points.');
    const loop = it.loop ?? false;
    if (loop && it.points.length < 3) throw new Error('A looped wall needs at least 3 points.');
    const texture = it.asset ?? DEFAULTS.wallTexture;
    ed.useAsset(texture, 'walls');
    const w: Wall = {
      points: formatVector2Array(it.points.map(gridToPx)),
      texture,
      color: toArgb(it.color ?? 'ffffffff'),
      loop,
      type: 0,
      joint: 1,
      normalize_uv: true,
      shadow: it.shadow ?? true,
      node_id: ed.allocId(),
      portals: [],
    };
    for (const d of it.doors ?? []) w.portals.push(makePortal(ed, { points: it.points, loop, node_id: w.node_id }, d));
    level.walls.push(w);
    doorCount += w.portals.length;
    added.push({ node_id: w.node_id, points: it.points.length, doors: w.portals.map((p) => p.node_id) });
  }
  ed.touch(key, 'walls');
  ed.delta(key, 'walls', added.length);
  ed.delta(key, 'doors', doorCount);
  return { level: key, added };
}

/** Add doors to an existing wall, found by node id. */
export function addDoors(ed: MapEditor, levelRef: string | number | undefined, wallId: string, doors: DoorInput[]) {
  const [key, level] = ed.level(levelRef);
  const wall = level.walls.find((w) => w.node_id === wallId.toLowerCase());
  if (!wall) throw new Error(`No wall with node_id "${wallId}" on level ${key}. Use inspect-map with list "walls".`);
  const points = parseVector2Array(wall.points).map(([x, y]) => [x / PX_PER_SQUARE, y / PX_PER_SQUARE] as Vec2);
  const ids = doors.map((d) => {
    const p = makePortal(ed, { points, loop: wall.loop, node_id: wall.node_id }, d);
    wall.portals.push(p);
    return p.node_id;
  });
  ed.touch(key, 'walls');
  ed.delta(key, 'doors', ids.length);
  return { level: key, wall: wall.node_id, added: ids };
}

// ---------- lights ----------

export interface LightInput {
  at: Vec2;
  /** Radius in squares (Dungeondraft and Universal VTT both use squares). */
  range?: number;
  intensity?: number;
  color?: string;
  shadows?: boolean;
  asset?: string;
}

export function addLights(ed: MapEditor, levelRef: string | number | undefined, items: LightInput[]) {
  const [key, level] = ed.level(levelRef);
  const added: string[] = [];
  for (const it of items) {
    const texture = it.asset ?? DEFAULTS.lightTexture;
    ed.useAsset(texture, 'lights');
    const l: Light = {
      position: formatVector2(gridToPx(it.at)),
      range: it.range ?? 5,
      intensity: it.intensity ?? 1,
      color: toArgb(it.color ?? DEFAULTS.lightColor),
      texture,
      shadows: it.shadows ?? true,
      node_id: ed.allocId(),
    };
    level.lights.push(l);
    added.push(l.node_id);
  }
  ed.touch(key, 'lights');
  ed.delta(key, 'lights', added.length);
  return { level: key, added };
}

// ---------- paths ----------

export interface PathInput {
  asset: string;
  points: Vec2[];
  /** Width in squares (default 1). */
  width?: number;
  smooth?: boolean;
  loop?: boolean;
  layer?: number;
  fade_in?: boolean;
  fade_out?: boolean;
  grow?: boolean;
  shrink?: boolean;
  block_light?: boolean;
}

export function addPaths(ed: MapEditor, levelRef: string | number | undefined, items: PathInput[]) {
  const [key, level] = ed.level(levelRef);
  const added: string[] = [];
  for (const it of items) {
    if (it.points.length < 2) throw new Error('A path needs at least 2 points.');
    ed.useAsset(it.asset, 'paths');
    const px = it.points.map(gridToPx);
    const origin = px[0];
    const p: PathElement = {
      position: formatVector2(origin),
      rotation: 0,
      scale: 'Vector2( 1, 1 )',
      // Stored relative to `position`.
      edit_points: formatVector2Array(px.map(([x, y]) => [x - origin[0], y - origin[1]])),
      smoothness: it.smooth === false ? 0 : 1,
      texture: it.asset,
      width: (it.width ?? 1) * PX_PER_SQUARE,
      layer: it.layer ?? DEFAULTS.layer,
      fade_in: it.fade_in ?? false,
      fade_out: it.fade_out ?? false,
      grow: it.grow ?? false,
      shrink: it.shrink ?? false,
      ...(ed.format >= 3 ? { block_light: it.block_light ?? false } : {}),
      loop: it.loop ?? false,
      node_id: ed.allocId(),
    };
    level.paths.push(p);
    added.push(p.node_id);
  }
  ed.touch(key, 'paths');
  ed.delta(key, 'paths', added.length);
  return { level: key, added };
}

// ---------- floors (patterns) ----------

export interface FloorInput {
  /** Floor texture: built-in res://textures/tilesets/simple/... or a pack's textures/patterns/... */
  asset: string;
  /** Rectangle in grid squares, or... */
  area?: GridRect;
  /** ...a polygon of grid points (at least 3). */
  points?: Vec2[];
  color?: string;
  outline?: boolean;
  layer?: number;
}

const rectPoints = (r: GridRect): Vec2[] => [
  [r.x, r.y],
  [r.x + r.width, r.y],
  [r.x + r.width, r.y + r.height],
  [r.x, r.y + r.height],
];

/** Floor patterns use simple tilesets (built-in) or pattern textures (packs); smart tilesets belong to the tile tool. */
function useFloorAsset(ed: MapEditor, asset: string) {
  ed.useAsset(asset, ['tilesets', 'patterns']);
  if (/\/textures\/tilesets\//.test(asset) && !/\/tilesets\/simple\//.test(asset)) {
    throw new Error(`"${asset}" is a smart tileset (tile tool), not a floor pattern. Use a res://textures/tilesets/simple/... texture.`);
  }
}

export function addFloors(ed: MapEditor, levelRef: string | number | undefined, items: FloorInput[]) {
  const [key, level] = ed.level(levelRef);
  const added: string[] = [];
  for (const it of items) {
    const pts = it.points ?? (it.area ? rectPoints(it.area) : null);
    if (!pts || pts.length < 3) throw new Error('A floor needs an area or at least 3 points.');
    useFloorAsset(ed, it.asset);
    const p: Pattern = {
      position: 'Vector2( 0, 0 )',
      ...(ed.format >= 3 ? { shape_rotation: 0, scale: 'Vector2( 1, 1 )' } : {}),
      points: formatVector2Array(pts.map(gridToPx)),
      layer: it.layer ?? DEFAULTS.layer,
      color: toArgb(it.color ?? 'ffffffff'),
      outline: it.outline ?? false,
      texture: it.asset,
      rotation: 0,
      node_id: ed.allocId(),
    };
    level.patterns.push(p);
    added.push(p.node_id);
  }
  ed.touch(key, 'patterns');
  ed.delta(key, 'patterns', added.length);
  return { level: key, added };
}

export interface RoomInput {
  area?: GridRect;
  points?: Vec2[];
  wall_asset?: string;
  wall_color?: string;
  /** Omit for walls only. */
  floor_asset?: string;
  floor_color?: string;
  doors?: DoorInput[];
}

/** Walls around a rectangle/polygon plus a matching floor, like Dungeondraft's room tool. */
export function buildRooms(ed: MapEditor, levelRef: string | number | undefined, rooms: RoomInput[]) {
  const out = rooms.map((r) => {
    const pts = r.points ?? (r.area ? rectPoints(r.area) : null);
    if (!pts || pts.length < 3) throw new Error('A room needs an area or at least 3 points.');
    const floor = r.floor_asset ? addFloors(ed, levelRef, [{ asset: r.floor_asset, points: pts, color: r.floor_color }]).added[0] : null;
    const wall = addWalls(ed, levelRef, [{ points: pts, loop: true, asset: r.wall_asset, color: r.wall_color, doors: r.doors }]).added[0];
    return { wall: wall.node_id, doors: wall.doors, floor };
  });
  return { level: ed.level(levelRef)[0], rooms: out };
}

// ---------- environment ----------

export const AMBIENT_PRESETS: Record<string, string> = {
  day: 'ffffffff',
  overcast: 'ffc8ccd2',
  dusk: 'ffb88f74',
  night: 'ff3c4664',
  dark: 'ff141820',
};

export function setEnvironment(ed: MapEditor, levelRef: string | number | undefined, input: { ambient_light?: string; preset?: string; baked_lighting?: boolean }) {
  const [key, level] = ed.level(levelRef);
  if (input.preset && input.ambient_light) throw new Error('Give either preset or ambient_light, not both.');
  const env = level.environment;
  const before = { ...env };
  if (input.preset) {
    const c = AMBIENT_PRESETS[input.preset];
    if (!c) throw new Error(`Unknown preset "${input.preset}". Use one of: ${Object.keys(AMBIENT_PRESETS).join(', ')}`);
    env.ambient_light = c;
  }
  if (input.ambient_light) env.ambient_light = toArgb(input.ambient_light);
  if (input.baked_lighting !== undefined) env.baked_lighting = input.baked_lighting;
  ed.touch(key, 'environment');
  return { level: key, before, after: { ...env } };
}

// ---------- terrain ----------

/** One brush stroke: exactly one of area / circle / line. */
export interface TerrainStroke {
  slot: number;
  area?: GridRect;
  circle?: { center: Vec2; radius: number };
  /** A stroke along a polyline, `width` squares wide (roads, trails, riverbanks). */
  line?: { points: Vec2[]; width: number };
  /** Soft edge: weight fades from 1 to 0 over this many squares outside the shape (default 0 = hard). */
  feather?: number;
  /** 0..1, how far existing terrain is blended towards the slot (default 1). */
  strength?: number;
}

export interface TerrainInput {
  enabled?: boolean;
  /** Slot number (1-8) -> terrain texture. Slots 5-8 turn on Dungeondraft's "expand slots". */
  slots?: Record<string, string>;
  /** Paint the whole level with one slot. Applied before `paint`. */
  fill?: number;
  paint?: TerrainStroke[];
  smooth_blending?: boolean;
}

/** Terrain splat: RGBA bytes, 4x4 texels per square, row-major; channel = weight of slot 1..4 (splat2: 5..8). */
export const SPLAT_PER_SQUARE = 4;

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance (squares) from a point to the stroke's shape; <= 0 means inside. */
function strokeDistance(s: TerrainStroke, p: Vec2): number {
  if (s.area) {
    const a = s.area;
    const dx = Math.max(a.x - p[0], 0, p[0] - (a.x + a.width));
    const dy = Math.max(a.y - p[1], 0, p[1] - (a.y + a.height));
    return Math.hypot(dx, dy);
  }
  if (s.circle) return Math.hypot(p[0] - s.circle.center[0], p[1] - s.circle.center[1]) - s.circle.radius;
  const { points, width } = s.line!;
  let d = Infinity;
  for (let i = 0; i + 1 < points.length; i++) d = Math.min(d, segmentDistance(p, points[i], points[i + 1]));
  return d - width / 2;
}

function strokeBounds(s: TerrainStroke): GridRect {
  const f = s.feather ?? 0;
  if (s.area) return { x: s.area.x - f, y: s.area.y - f, width: s.area.width + 2 * f, height: s.area.height + 2 * f };
  if (s.circle) {
    const r = s.circle.radius + f;
    return { x: s.circle.center[0] - r, y: s.circle.center[1] - r, width: 2 * r, height: 2 * r };
  }
  const { points, width } = s.line!;
  const pad = width / 2 + f;
  const xs = points.map((q) => q[0]);
  const ys = points.map((q) => q[1]);
  return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, width: Math.max(...xs) - Math.min(...xs) + 2 * pad, height: Math.max(...ys) - Math.min(...ys) + 2 * pad };
}

function describeStroke(s: TerrainStroke): string {
  if (s.area) return `${s.area.width}x${s.area.height} area at (${s.area.x},${s.area.y})`;
  if (s.circle) return `circle r=${s.circle.radius} at (${s.circle.center})`;
  return `${s.line!.width}-wide line through ${s.line!.points.length} points`;
}

/**
 * Blend texels towards a one-hot weight for `slot`. Weight per texel = strength inside the shape,
 * smoothly falling to 0 across `feather`. A hard full-strength stroke writes exact one-hot values.
 */
export function paintStroke(splat: Uint8Array, splat2: Uint8Array | null, w: number, h: number, s: TerrainStroke): number {
  const shapes = [s.area, s.circle, s.line].filter(Boolean).length;
  if (shapes !== 1) throw new Error('Each terrain stroke needs exactly one of area, circle or line.');
  if (!Number.isInteger(s.slot) || s.slot < 1 || s.slot > 8) throw new Error(`Terrain slot must be 1-8, got ${s.slot}.`);
  if (s.slot > 4 && !splat2) throw new Error('Slots 5-8 need splat2.');
  if (s.line && s.line.points.length < 2) throw new Error('A terrain line needs at least 2 points.');
  const feather = Math.max(0, s.feather ?? 0);
  const strength = Math.max(0, Math.min(1, s.strength ?? 1));
  const b = strokeBounds(s);
  const x0 = Math.max(0, Math.floor(b.x * SPLAT_PER_SQUARE));
  const y0 = Math.max(0, Math.floor(b.y * SPLAT_PER_SQUARE));
  const x1 = Math.min(w, Math.ceil((b.x + b.width) * SPLAT_PER_SQUARE));
  const y1 = Math.min(h, Math.ceil((b.y + b.height) * SPLAT_PER_SQUARE));
  const channels = splat2 ? 8 : 4;
  let texels = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // Texel centre in grid squares.
      const d = strokeDistance(s, [(x + 0.5) / SPLAT_PER_SQUARE, (y + 0.5) / SPLAT_PER_SQUARE]);
      let k: number;
      if (d <= 1e-9) k = 1;
      else if (feather > 0 && d < feather) {
        const u = 1 - d / feather;
        k = u * u * (3 - 2 * u); // smoothstep
      } else continue;
      k *= strength;
      if (k <= 0) continue;
      const i = (y * w + x) * 4;
      const get = (c: number) => (c < 4 ? splat : splat2!)[i + (c % 4)];
      const set = (c: number, v: number) => ((c < 4 ? splat : splat2!)[i + (c % 4)] = v);
      if (k >= 1) {
        for (let c = 0; c < channels; c++) set(c, c === s.slot - 1 ? 255 : 0);
      } else {
        // Blend in floats, then round with largest remainders so the texel's total weight is preserved.
        const vals: number[] = [];
        for (let c = 0; c < channels; c++) {
          const cur = get(c);
          vals.push(cur + ((c === s.slot - 1 ? 255 : 0) - cur) * k);
        }
        const floors = vals.map(Math.floor);
        let left = Math.round(vals.reduce((a, v) => a + v, 0)) - floors.reduce((a, v) => a + v, 0);
        const order = vals.map((v, c) => [v - floors[c], c] as const).sort((a, b) => b[0] - a[0]);
        for (const [, c] of order) {
          if (left <= 0) break;
          floors[c]++;
          left--;
        }
        floors.forEach((v, c) => set(c, Math.min(255, v)));
      }
      texels++;
    }
  }
  return texels;
}

export function setTerrain(ed: MapEditor, levelRef: string | number | undefined, input: TerrainInput) {
  const [key, level] = ed.level(levelRef);
  const t = level.terrain;
  if (!t) throw new Error(`Level ${key} has no terrain section.`);
  const changes: string[] = [];

  for (const [slotStr, tex] of Object.entries(input.slots ?? {})) {
    const slot = Number(slotStr);
    if (!Number.isInteger(slot) || slot < 1 || slot > 8) throw new Error(`Terrain slot must be 1-8, got ${slotStr}.`);
    ed.useAsset(tex, 'terrain');
    t[`texture_${slot}`] = tex;
    changes.push(`slot ${slot} = ${tex}`);
  }

  const usesHighSlots = [input.fill, ...(input.paint ?? []).map((p) => p.slot), ...Object.keys(input.slots ?? {}).map(Number)].some((s) => (s ?? 0) > 4);
  const w = Number(ed.map.world.width) * SPLAT_PER_SQUARE;
  const h = Number(ed.map.world.height) * SPLAT_PER_SQUARE;

  if (usesHighSlots && !t.expand_slots) {
    t.expand_slots = true;
    changes.push('expand_slots on (slots 5-8)');
  }
  if (input.smooth_blending !== undefined) t.smooth_blending = input.smooth_blending;

  if (input.fill !== undefined || input.paint?.length) {
    const splat = parseByteArray(t.splat);
    if (splat.length !== w * h * 4) throw new Error(`Unexpected terrain splat size ${splat.length} (expected ${w * h * 4} for ${w / 4}x${h / 4} squares); refusing to paint.`);
    let splat2 = t.splat2 !== undefined ? parseByteArray(t.splat2) : null;
    if (usesHighSlots && !splat2) {
      splat2 = new Uint8Array(w * h * 4);
      // Dungeondraft writes splat2 right after splat; insertion order gives that.
    }
    if (splat2 && splat2.length !== w * h * 4) throw new Error(`Unexpected splat2 size ${splat2.length}; refusing to paint.`);

    const mapRect: GridRect = { x: 0, y: 0, width: w / 4, height: h / 4 };
    const strokes: TerrainStroke[] = [...(input.fill !== undefined ? [{ area: mapRect, slot: input.fill }] : []), ...(input.paint ?? [])];
    for (const s of strokes) {
      const n = paintStroke(splat, splat2, w, h, s);
      const label = describeStroke(s);
      if (!n) ed.warnings.push(`${label} is outside the map; nothing painted.`);
      changes.push(s.area === mapRect ? `filled level with slot ${s.slot}` : `painted ${label} with slot ${s.slot}${s.feather ? `, feather ${s.feather}` : ''}${s.strength !== undefined && s.strength < 1 ? `, strength ${s.strength}` : ''}`);
      // Floor patterns draw over terrain: say so, or painted terrain silently "disappears".
      const covering = floorsOverlapping(level, strokeBounds(s));
      if (covering.length) {
        ed.warnings.push(
          `Floor patterns cover ${s.area === mapRect ? 'parts of the level' : label} and are drawn on top of terrain, so the terrain there is hidden: ${covering.join(', ')}. Remove them (remove-elements types ["patterns"]) if the terrain should show.`,
        );
      }
    }
    t.splat = formatByteArray(splat);
    if (splat2) t.splat2 = formatByteArray(splat2);
    if (input.enabled === undefined && !t.enabled) {
      t.enabled = true;
      changes.push('terrain enabled');
    }
  }
  if (input.enabled !== undefined) {
    t.enabled = input.enabled;
    changes.push(`terrain ${input.enabled ? 'enabled' : 'disabled'}`);
  }
  ed.touch(key, 'terrain');
  return { level: key, changes, slots: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].filter((s) => t[`texture_${s}`] !== undefined).map((s) => [s, t[`texture_${s}`]])) };
}

/** Patterns whose bounding box overlaps a grid rect (cheap and slightly generous). */
function floorsOverlapping(level: Level, r: GridRect): string[] {
  const out: string[] = [];
  for (const p of level.patterns ?? []) {
    const pts = polyPx('patterns', p).map(([x, y]) => [x / PX_PER_SQUARE, y / PX_PER_SQUARE]);
    if (!pts.length) continue;
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const overlaps = Math.min(...xs) < r.x + r.width && Math.max(...xs) > r.x && Math.min(...ys) < r.y + r.height && Math.max(...ys) > r.y;
    if (overlaps) out.push(`${p.node_id} (${short(p.texture)})`);
  }
  return out;
}

// ---------- listing & removal ----------

export interface ElementSummary {
  type: ElementType;
  node_id: string;
  asset: string;
  /** Grid coordinates: position, or first point for walls/paths/patterns. */
  at: Vec2;
  points?: number;
  extra?: string;
}

const gridOf = (pos: string): Vec2 => {
  const [x, y] = parseVector2(pos);
  return [round(x / PX_PER_SQUARE, 3), round(y / PX_PER_SQUARE, 3)];
};
const short = (tex: string) => tex.replace(/^res:\/\/(packs\/([^/]+)\/)?textures\//, (_m, _p, id) => (id ? `[${id}] ` : ''));

function polyPx(type: ElementType, el: { points?: string; edit_points?: string; position?: string }): Vec2[] {
  if (type === 'paths') {
    const [ox, oy] = parseVector2(el.position!);
    return parseVector2Array(el.edit_points!).map(([x, y]) => [x + ox, y + oy]);
  }
  if (type === 'patterns') {
    const [ox, oy] = el.position ? parseVector2(el.position) : [0, 0];
    return parseVector2Array(el.points!).map(([x, y]) => [x + ox, y + oy]);
  }
  return parseVector2Array(el.points!);
}

/** Every element of the requested types, with grid coordinates. */
export function listElements(level: Level, types: ElementType[], area?: GridRect): ElementSummary[] {
  const out: ElementSummary[] = [];
  const inArea = (pts: Vec2[]) => !area || pts.every((p) => rectContainsPx(area, p));
  for (const type of types) {
    if (type === 'objects' || type === 'lights' || type === 'texts') {
      for (const el of (level[type] ?? []) as { position: string; texture?: string; text?: string; node_id: string; range?: number }[]) {
        if (!inArea([parseVector2(el.position)])) continue;
        out.push({
          type,
          node_id: el.node_id,
          asset: type === 'texts' ? '' : short(el.texture ?? ''),
          at: gridOf(el.position),
          ...(type === 'lights' ? { extra: `range ${el.range}` } : type === 'texts' ? { extra: (el.text ?? '').slice(0, 60) } : {}),
        });
      }
    } else if (type === 'doors') {
      const doors = [...(level.walls ?? []).flatMap((w) => (w.portals ?? []).map((p) => ({ p, wall: w.node_id }))), ...(level.portals ?? []).map((p) => ({ p, wall: '' }))];
      for (const { p, wall } of doors) {
        if (!inArea([parseVector2(p.position)])) continue;
        out.push({ type, node_id: p.node_id, asset: short(p.texture), at: gridOf(p.position), extra: `${p.closed ? 'closed' : 'open'}, ${(p.radius * 2) / PX_PER_SQUARE} wide${wall ? `, wall ${wall}` : ', freestanding'}` });
      }
    } else {
      for (const el of (level[type] ?? []) as { node_id: string; texture: string; points?: string; edit_points?: string; position?: string; loop?: boolean }[]) {
        const pts = polyPx(type, el);
        if (!pts.length || !inArea(pts)) continue;
        out.push({ type, node_id: el.node_id, asset: short(el.texture), at: [round(pts[0][0] / PX_PER_SQUARE, 3), round(pts[0][1] / PX_PER_SQUARE, 3)], points: pts.length, ...(el.loop ? { extra: 'loop' } : {}) });
      }
    }
  }
  return out;
}

export function removeElements(ed: MapEditor, levelRef: string | number | undefined, types: ElementType[], area?: GridRect, nodeIds?: string[]) {
  if (!area && !nodeIds?.length) throw new Error('Give an area or node_ids; refusing to remove every element of a type.');
  const [key, level] = ed.level(levelRef);
  const ids = nodeIds?.length ? new Set(nodeIds.map((s) => s.toLowerCase())) : null;
  const matches = new Set(listElements(level, types, area).filter((e) => !ids || ids.has(e.node_id)).map((e) => `${e.type}:${e.node_id}`));
  const removed: ElementSummary[] = listElements(level, types, area).filter((e) => matches.has(`${e.type}:${e.node_id}`));
  const hit = (type: ElementType, id: string) => matches.has(`${type}:${id}`);

  const counts: Partial<Record<ElementType, number>> = {};
  const drop = <T extends { node_id: string }>(type: ElementType, arr: T[] | undefined): T[] | undefined => {
    if (!arr) return arr;
    const kept = arr.filter((el) => !hit(type, el.node_id));
    if (kept.length !== arr.length) {
      counts[type] = (counts[type] ?? 0) + arr.length - kept.length;
      ed.touch(key, type === 'doors' ? 'portals' : type);
    }
    return kept;
  };

  for (const type of ['objects', 'lights', 'texts', 'paths', 'patterns'] as const) {
    if (types.includes(type) && level[type]) (level as Record<string, unknown>)[type] = drop(type, level[type] as { node_id: string }[]);
  }
  if (types.includes('doors')) {
    for (const w of level.walls ?? []) {
      const before = w.portals.length;
      w.portals = w.portals.filter((p) => !hit('doors', p.node_id));
      if (w.portals.length !== before) {
        counts.doors = (counts.doors ?? 0) + before - w.portals.length;
        ed.touch(key, 'walls');
      }
    }
    if (level.portals) level.portals = drop('doors', level.portals)!;
  }
  if (types.includes('walls')) {
    const gone = level.walls.filter((w) => hit('walls', w.node_id));
    if (gone.length) {
      const goneDoors = gone.reduce((n, w) => n + w.portals.length, 0);
      level.walls = level.walls.filter((w) => !hit('walls', w.node_id));
      counts.walls = gone.length;
      counts.doors = (counts.doors ?? 0) + goneDoors;
      ed.touch(key, 'walls');
      // Building outlines reference their wall by decimal node id; keep the parallel arrays in sync.
      const goneDec = new Set(gone.map((w) => parseInt(w.node_id, 16)));
      const s = level.shapes;
      if (s?.walls?.some((id) => goneDec.has(Number(id)))) {
        const keep = s.walls.map((id) => !goneDec.has(Number(id)));
        s.polygons = s.polygons.filter((_, i) => keep[i]);
        s.walls = s.walls.filter((_, i) => keep[i]);
        ed.touch(key, 'shapes');
      }
    }
  }
  for (const [t, n] of Object.entries(counts)) ed.delta(key, t as ElementType, -n!);
  return { level: key, counts, removed };
}
