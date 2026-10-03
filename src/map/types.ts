/**
 * Shapes of a .dungeondraft_map as observed in real files (formats 2 and 3, DD 0.9.4 to 1.2.0.1).
 * See docs/research.md. Godot types are stored as var2str strings (see godot/variant.ts).
 * Only fields this server reads or writes are typed; everything else is preserved untouched.
 */

export type GodotVec2 = string; // "Vector2( x, y )"
export type GodotVec2Array = string; // "PoolVector2Array( ... )"
export type Argb = string; // "ff726e65"

export interface DDMap {
  header: Header;
  world: World;
  [k: string]: unknown;
}

export interface PackManifestEntry {
  name: string;
  id: string;
  version: string;
  author: string;
  keywords?: unknown;
  allow_3rd_party_mapping_software_to_read?: boolean;
  custom_color_overrides?: unknown;
  [k: string]: unknown;
}

export interface Header {
  creation_build: string;
  uses_default_assets: boolean;
  asset_manifest: PackManifestEntry[];
  editor_state?: { current_level?: number; [k: string]: unknown };
  [k: string]: unknown;
}

export interface World {
  format: number;
  width: number;
  height: number;
  next_node_id: string; // hex
  levels: Record<string, Level>;
  [k: string]: unknown;
}

export interface Portal {
  position: GodotVec2;
  rotation: number;
  scale: GodotVec2;
  direction: GodotVec2;
  texture: string;
  radius: number;
  wall_id?: number | string; // decimal int in format 2, hex string in format 3
  wall_distance?: number;
  closed: boolean;
  node_id: string;
  [k: string]: unknown;
}

export interface Wall {
  points: GodotVec2Array;
  texture: string;
  color: Argb;
  loop: boolean;
  type: number;
  joint: number;
  normalize_uv: boolean;
  shadow: boolean;
  node_id: string;
  portals: Portal[];
  [k: string]: unknown;
}

export interface MapObject {
  position: GodotVec2;
  rotation: number;
  scale: GodotVec2;
  mirror: boolean;
  texture: string;
  layer: number;
  shadow: boolean;
  block_light?: boolean;
  custom_color?: Argb;
  node_id: string;
  [k: string]: unknown;
}

export interface PathElement {
  position: GodotVec2;
  rotation: number;
  scale: GodotVec2;
  edit_points: GodotVec2Array;
  smoothness: number;
  texture: string;
  width: number;
  layer: number;
  fade_in: boolean;
  fade_out: boolean;
  grow: boolean;
  shrink: boolean;
  block_light?: boolean;
  loop: boolean;
  node_id: string;
  [k: string]: unknown;
}

export interface Light {
  position: GodotVec2;
  range: number;
  intensity: number;
  color: Argb;
  texture: string;
  shadows: boolean;
  node_id: string;
  [k: string]: unknown;
}

export interface Pattern {
  position: GodotVec2;
  points: GodotVec2Array;
  layer: number;
  color: Argb;
  texture: string;
  node_id: string;
  [k: string]: unknown;
}

export interface Terrain {
  enabled: boolean;
  expand_slots?: boolean;
  smooth_blending?: boolean;
  splat: string; // PoolByteArray, RGBA, 4x4 texels per square
  splat2?: string; // slots 5..8
  [k: string]: unknown; // texture_1 .. texture_8
}

export interface Level {
  label: string;
  environment: { baked_lighting: boolean; ambient_light: Argb };
  layers: Record<string, string>;
  shapes: { polygons: GodotVec2Array[]; walls: number[] };
  walls: Wall[];
  portals: Portal[];
  terrain: Terrain;
  paths: PathElement[];
  objects: MapObject[];
  lights: Light[];
  patterns: Pattern[];
  texts?: { text: string; position: GodotVec2; node_id: string; [k: string]: unknown }[];
  [k: string]: unknown;
}
