import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AssetCatalog, CATEGORIES } from './assets/catalog.js';
import type { Config } from './config.js';
import { MapEditor, ELEMENT_TYPES } from './map/editor.js';
import { summariseMap } from './map/inspect.js';
import { loadMap, MAP_EXT } from './map/mapfile.js';
import {
  addDoors,
  addFloors,
  addLights,
  addObjects,
  addPaths,
  addWalls,
  AMBIENT_PRESETS,
  buildRooms,
  listElements,
  removeElements,
  setEnvironment,
  setTerrain,
} from './map/operations.js';
import { Sandbox } from './sandbox.js';
import { uvttToFoundryScene } from './vtt/foundry.js';
import { buildUvtt, imageInfo, readUvtt } from './vtt/uvtt.js';

const COORDS =
  'Coordinates are GRID SQUARES from the map\'s top-left corner (x right, y down). (3, 4) is the corner between squares; (3.5, 4.5) is the centre of square column 3, row 4. Fractions are allowed. The server converts to Dungeondraft pixels (256 per square).';
const CLOSE_MAP =
  'Close the map in Dungeondraft first (or reopen it afterwards without saving), otherwise Dungeondraft will overwrite the change on its next save. A timestamped .bak copy is written before every change.';

const point = z.tuple([z.number(), z.number()]).describe('[x, y] in grid squares');
const mapPath = z.string().describe(`Path to a ${MAP_EXT} file, absolute or relative to the first configured folder`);
const levelRef = z.union([z.string(), z.number()]).optional().describe('Level key ("0"), index or label ("Ground"). Default: first level');
const dryRun = z.boolean().optional().describe('Validate and report without writing');
const rect = z
  .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
  .describe('Rectangle in grid squares: x,y = top-left corner');

type Json = Record<string, unknown>;
const ok = (data: Json) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }] });

function handler<A>(fn: (args: A) => Json | Promise<Json>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

export function createServer(config: Config) {
  const sandbox = new Sandbox(config.roots, [config.installDir, ...config.assetDirs].filter((x): x is string => Boolean(x)));
  const catalog = new AssetCatalog({ installDir: config.installDir, assetDirs: config.assetDirs });
  const server = new McpServer({ name: 'dungeondraft-mcp', version: '0.1.0' });

  const edit = (file: string, dry: boolean | undefined, apply: (ed: MapEditor) => Json): Json => {
    const ed = new MapEditor(sandbox.resolve(file), catalog);
    const result = apply(ed);
    const { saved } = ed.commit(Boolean(dry));
    return {
      ...result,
      ...(ed.warnings.length ? { warnings: ed.warnings } : {}),
      ...(saved ? { saved: saved.path, backup: saved.backup, changedSections: saved.changedSections } : { dryRun: true, note: 'Nothing written.' }),
    };
  };

  // ---------------- read-only ----------------

  server.registerTool(
    'list-maps',
    {
      title: 'List Dungeondraft maps',
      description: `Find ${MAP_EXT} files under a folder (default: all configured folders). Returns path, size and last-modified time, newest first.`,
      inputSchema: { folder: z.string().optional().describe('Folder to search (must be inside a configured folder)'), recursive: z.boolean().optional().describe('Search subfolders (default true)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(({ folder, recursive }: { folder?: string; recursive?: boolean }) => {
      const dirs = folder ? [sandbox.resolve(folder)] : sandbox.roots;
      const found: { path: string; sizeKB: number; modified: string }[] = [];
      const walk = (d: string, depth: number) => {
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isFile() && e.name.toLowerCase().endsWith(MAP_EXT)) {
            const st = fs.statSync(p);
            found.push({ path: p, sizeKB: Math.round(st.size / 1024), modified: st.mtime.toISOString() });
          } else if (e.isDirectory() && (recursive ?? true) && depth < 6 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(p, depth + 1);
        }
      };
      dirs.forEach((d) => walk(d, 0));
      found.sort((a, b) => b.modified.localeCompare(a.modified));
      return { folders: dirs, count: found.length, maps: found };
    }),
  );

  server.registerTool(
    'inspect-map',
    {
      title: 'Inspect a Dungeondraft map',
      description: `Summarise a map: size, levels, element counts, terrain, asset packs and most-used assets. Optionally list elements (node_id, asset, grid position) of given types, filtered by area, to target edits or removals. Never returns raw file data. ${COORDS}`,
      inputSchema: {
        path: mapPath,
        list: z.array(z.enum(ELEMENT_TYPES as [string, ...string[]])).optional().describe('Element types to list for one level'),
        level: levelRef,
        area: rect.optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Max listed elements (default 100)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((a: { path: string; list?: string[]; level?: string | number; area?: z.infer<typeof rect>; offset?: number; limit?: number }) => {
      const file = sandbox.resolve(a.path);
      const { map } = loadMap(file);
      const out: Json = { path: file, ...summariseMap(map) };
      if (a.list?.length) {
        const levels = Object.entries(map.world.levels);
        const hit = a.level === undefined ? levels[0] : (levels.find(([k]) => k === String(a.level)) ?? levels.find(([, l]) => l.label?.toLowerCase() === String(a.level).toLowerCase()));
        if (!hit) throw new Error(`Level ${a.level} not found.`);
        const all = listElements(hit[1], a.list as (typeof ELEMENT_TYPES)[number][], a.area);
        const offset = a.offset ?? 0;
        const limit = a.limit ?? 100;
        out.elements = { level: hit[0], total: all.length, offset, hasMore: offset + limit < all.length, items: all.slice(offset, offset + limit) };
      }
      return out;
    }),
  );

  server.registerTool(
    'list-assets',
    {
      title: 'Browse Dungeondraft assets',
      description:
        'Search installed assets: Dungeondraft built-ins plus asset packs in the configured asset folders. Returns the exact texture path to pass to the add-* tools. Call with no filters for an overview (counts per category, packs, tags). Search matches words in the path and tags, e.g. query "table round" category "objects". Packs whose author disallows third-party tools are listed by name only.',
      inputSchema: {
        query: z.string().optional().describe('Words that must all appear in the asset path or tags'),
        category: z.enum(CATEGORIES).optional(),
        source: z.string().optional().describe('"builtin" or a pack id'),
        tag: z.string().optional().describe('Exact tag, e.g. "Table", "Barrel"'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        refresh: z.boolean().optional().describe('Re-read packs from disk'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((a: { query?: string; category?: (typeof CATEGORIES)[number]; source?: string; tag?: string; offset?: number; limit?: number; refresh?: boolean }) => {
      if (a.refresh) catalog.load(true);
      if (!a.query && !a.category && !a.source && !a.tag) return catalog.summary();
      const r = catalog.search(a);
      return { ...r, items: r.items.map((x) => ({ path: x.path, category: x.category, source: x.source, ...(x.tags.length ? { tags: x.tags } : {}) })) };
    }),
  );

  // ---------------- edits ----------------

  server.registerTool(
    'add-objects',
    {
      title: 'Add objects to a map',
      description: `Place objects (props, furniture, trees...) on a level. "at" is the object's CENTRE. Rotation in degrees clockwise. Asset paths come from list-assets (category objects) and are validated; a custom pack is added to the map's manifest automatically. ${COORDS} ${CLOSE_MAP}`,
      inputSchema: {
        path: mapPath,
        level: levelRef,
        objects: z
          .array(
            z.object({
              asset: z.string().describe('res://... texture path from list-assets'),
              at: point,
              rotation: z.number().optional().describe('Degrees clockwise (default 0)'),
              scale: z.union([z.number(), point]).optional().describe('Uniform scale or [sx, sy] (default 1)'),
              mirror: z.boolean().optional(),
              layer: z.number().int().optional().describe('Layer number (default 100 = "User Layer 1"; see inspect-map layers)'),
              shadow: z.boolean().optional().describe('Drop shadow (default true)'),
              block_light: z.boolean().optional(),
              custom_color: z.string().optional().describe('Tint for colourable assets: "#RRGGBB"'),
            }),
          )
          .min(1)
          .max(500),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; objects: Parameters<typeof addObjects>[2]; dry_run?: boolean }) => edit(a.path, a.dry_run, (ed) => addObjects(ed, a.level, a.objects))),
  );

  server.registerTool(
    'add-walls',
    {
      title: 'Add walls (and doors)',
      description: `Draw walls as polylines through grid points; set loop=true to close a room. Optional doors are placed on the wall at a grid point (door centre), default 1 square wide. To add doors to an existing wall, pass add_doors_to_wall with its node_id (from inspect-map list ["walls"]). Wall/door textures come from list-assets (categories walls / portals). ${COORDS} ${CLOSE_MAP}`,
      inputSchema: {
        path: mapPath,
        level: levelRef,
        walls: z
          .array(
            z.object({
              points: z.array(point).min(2).describe('Corner points, usually on grid lines, e.g. [[2,2],[8,2],[8,6]]'),
              loop: z.boolean().optional().describe('Close the polyline back to the first point'),
              asset: z.string().optional().describe('Wall texture (default res://textures/walls/stone.png)'),
              color: z.string().optional().describe('Tint "#RRGGBB" (default white = untinted)'),
              shadow: z.boolean().optional(),
              doors: z
                .array(
                  z.object({
                    at: point.describe('Door centre, on the wall'),
                    width: z.number().positive().optional().describe('Squares (default 1)'),
                    asset: z.string().optional().describe('Portal texture (default res://textures/portals/door_00.png); windows are portals too'),
                    open: z.boolean().optional(),
                  }),
                )
                .optional(),
            }),
          )
          .optional(),
        add_doors_to_wall: z
          .object({ wall_id: z.string(), doors: z.array(z.object({ at: point, width: z.number().positive().optional(), asset: z.string().optional(), open: z.boolean().optional() })).min(1) })
          .optional(),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; walls?: Parameters<typeof addWalls>[2]; add_doors_to_wall?: { wall_id: string; doors: Parameters<typeof addDoors>[3] }; dry_run?: boolean }) => {
      if (!a.walls?.length && !a.add_doors_to_wall) throw new Error('Give walls and/or add_doors_to_wall.');
      return edit(a.path, a.dry_run, (ed) => ({
        ...(a.walls?.length ? { walls: addWalls(ed, a.level, a.walls) } : {}),
        ...(a.add_doors_to_wall ? { doors: addDoors(ed, a.level, a.add_doors_to_wall.wall_id, a.add_doors_to_wall.doors) } : {}),
      }));
    }),
  );

  server.registerTool(
    'add-lights',
    {
      title: 'Add lights',
      description: `Add point lights. "range" is the radius in grid squares (default 5), intensity 0-1+ (default 1), colour "#RRGGBB" (default warm ffeccd8b, as Dungeondraft uses). Lights only show in Dungeondraft when the level's lighting is not fully bright. ${COORDS} ${CLOSE_MAP}`,
      inputSchema: {
        path: mapPath,
        level: levelRef,
        lights: z
          .array(z.object({ at: point, range: z.number().positive().optional(), intensity: z.number().min(0).optional(), color: z.string().optional(), shadows: z.boolean().optional(), asset: z.string().optional().describe('Light texture (default point.png)') }))
          .min(1)
          .max(500),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; lights: Parameters<typeof addLights>[2]; dry_run?: boolean }) => edit(a.path, a.dry_run, (ed) => addLights(ed, a.level, a.lights))),
  );

  server.registerTool(
    'add-paths',
    {
      title: 'Add paths',
      description: `Draw path assets (roads, rivers' edges, fences, cliffs, cave walls...) along grid points. Width in squares (default 1). smooth=false gives sharp corners. Path textures come from list-assets (category paths). ${COORDS} ${CLOSE_MAP}`,
      inputSchema: {
        path: mapPath,
        level: levelRef,
        paths: z
          .array(
            z.object({
              asset: z.string(),
              points: z.array(point).min(2),
              width: z.number().positive().optional(),
              smooth: z.boolean().optional(),
              loop: z.boolean().optional(),
              layer: z.number().int().optional(),
              fade_in: z.boolean().optional(),
              fade_out: z.boolean().optional(),
              grow: z.boolean().optional(),
              shrink: z.boolean().optional(),
              block_light: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(200),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; paths: Parameters<typeof addPaths>[2]; dry_run?: boolean }) => edit(a.path, a.dry_run, (ed) => addPaths(ed, a.level, a.paths))),
  );

  const doorSchema = z.object({
    at: point.describe('Door centre, on the wall'),
    width: z.number().positive().optional().describe('Squares (default 1)'),
    asset: z.string().optional().describe('Portal texture (default res://textures/portals/door_00.png); windows are portals too'),
    open: z.boolean().optional(),
  });

  server.registerTool(
    'add-floors',
    {
      title: 'Add floor patterns',
      description: `Add floor patterns (wood planks, cobble, tiles...) over a rectangle or polygon. Built-in floors are res://textures/tilesets/simple/... (list-assets category "tilesets", query "simple"); pack floors are category "patterns". Floors are drawn above terrain and below objects. ${COORDS} ${CLOSE_MAP}`,
      inputSchema: {
        path: mapPath,
        level: levelRef,
        floors: z
          .array(
            z.object({
              asset: z.string(),
              area: rect.optional(),
              points: z.array(point).min(3).optional().describe('Polygon instead of area'),
              color: z.string().optional().describe('Tint "#RRGGBB" (default white = untinted)'),
              outline: z.boolean().optional(),
              layer: z.number().int().optional(),
            }),
          )
          .min(1)
          .max(200),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; floors: Parameters<typeof addFloors>[2]; dry_run?: boolean }) => edit(a.path, a.dry_run, (ed) => addFloors(ed, a.level, a.floors))),
  );

  server.registerTool(
    'build-room',
    {
      title: 'Build rooms',
      description: `Build complete rooms in one step: a closed wall around a rectangle (or polygon) plus a matching floor and doors. Doors go at grid points on the outline, e.g. the middle of the south wall of area {x:10,y:5,width:6,height:4} is [13, 9]. ${COORDS} ${CLOSE_MAP}`,
      inputSchema: {
        path: mapPath,
        level: levelRef,
        rooms: z
          .array(
            z.object({
              area: rect.optional(),
              points: z.array(point).min(3).optional().describe('Polygon instead of area (L-shaped rooms etc.)'),
              wall_asset: z.string().optional().describe('Default res://textures/walls/stone.png'),
              wall_color: z.string().optional(),
              floor_asset: z.string().optional().describe('Omit for no floor, e.g. res://textures/tilesets/simple/tileset_cut_stone.png'),
              floor_color: z.string().optional(),
              doors: z.array(doorSchema).optional(),
            }),
          )
          .min(1)
          .max(50),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; rooms: Parameters<typeof buildRooms>[2]; dry_run?: boolean }) => edit(a.path, a.dry_run, (ed) => buildRooms(ed, a.level, a.rooms))),
  );

  server.registerTool(
    'set-environment',
    {
      title: 'Set ambient light (day/night)',
      description: `Change a level's ambient light, e.g. to make a night variant after duplicate-map. Presets: ${Object.entries(AMBIENT_PRESETS)
        .map(([k, v]) => `${k} (#${v.slice(2)})`)
        .join(', ')}. Or pass ambient_light "#RRGGBB". Placed lights only show when ambient is darker than white. ${CLOSE_MAP}`,
      inputSchema: {
        path: mapPath,
        level: levelRef,
        preset: z.enum(Object.keys(AMBIENT_PRESETS) as [string, ...string[]]).optional(),
        ambient_light: z.string().optional(),
        baked_lighting: z.boolean().optional().describe("Dungeondraft's baked lighting flag (leave unset unless you know you need it)"),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; preset?: string; ambient_light?: string; baked_lighting?: boolean; dry_run?: boolean }) =>
      edit(a.path, a.dry_run, (ed) => setEnvironment(ed, a.level, a)),
    ),
  );

  server.registerTool(
    'set-terrain',
    {
      title: 'Set or paint terrain',
      description: `Change a level's terrain: assign textures to slots 1-8 (list-assets category terrain), fill the whole level with one slot, and/or paint rectangles with a slot (hard edges, 1/4-square resolution). Slots 5-8 enable Dungeondraft's expanded slots. ${COORDS} ${CLOSE_MAP}`,
      inputSchema: {
        path: mapPath,
        level: levelRef,
        slots: z.record(z.string()).optional().describe('e.g. {"1": "res://textures/terrain/terrain_sand.png"}'),
        fill: z.number().int().min(1).max(8).optional(),
        paint: z.array(z.object({ area: rect, slot: z.number().int().min(1).max(8) })).optional(),
        enabled: z.boolean().optional(),
        smooth_blending: z.boolean().optional(),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; dry_run?: boolean } & Parameters<typeof setTerrain>[2]) => edit(a.path, a.dry_run, (ed) => setTerrain(ed, a.level, a))),
  );

  server.registerTool(
    'remove-elements',
    {
      title: 'Remove elements',
      description: `Remove elements of the given types that lie entirely inside an area, and/or by node_id (from inspect-map). Walls take their doors with them. Requires an area or node_ids. Use dry_run first to see what would go. ${COORDS} ${CLOSE_MAP}`,
      inputSchema: {
        path: mapPath,
        level: levelRef,
        types: z.array(z.enum(ELEMENT_TYPES as [string, ...string[]])).min(1),
        area: rect.optional(),
        node_ids: z.array(z.string()).optional(),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; types: string[]; area?: z.infer<typeof rect>; node_ids?: string[]; dry_run?: boolean }) =>
      edit(a.path, a.dry_run, (ed) => {
        const r = removeElements(ed, a.level, a.types as (typeof ELEMENT_TYPES)[number][], a.area, a.node_ids);
        return { ...r, removed: r.removed.slice(0, 200), removedListed: Math.min(200, r.removed.length) };
      }),
    ),
  );

  server.registerTool(
    'duplicate-map',
    {
      title: 'Duplicate a map',
      description: 'Copy a map to a new file in the same folder (or a given path) to start a variant, e.g. a night version. Never overwrites an existing file.',
      inputSchema: { path: mapPath, new_name: z.string().describe(`New file name or path; ${MAP_EXT} is added if missing`) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((a: { path: string; new_name: string }) => {
      const src = sandbox.resolve(a.path);
      loadMap(src); // must parse
      let name = a.new_name.endsWith(MAP_EXT) ? a.new_name : `${a.new_name}${MAP_EXT}`;
      if (!path.isAbsolute(name) && !/[\\/]/.test(name)) name = path.join(path.dirname(src), name);
      const dest = sandbox.resolve(name);
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
      loadMap(dest);
      return { source: src, copy: dest };
    }),
  );

  // ---------------- VTT ----------------

  server.registerTool(
    'export-dd2vtt',
    {
      title: 'Build a Universal VTT file',
      description:
        'Dungeondraft is needed to render map images, so this cannot export on its own. It builds a .dd2vtt from the map\'s walls, doors and lights plus an image you exported from Dungeondraft (File > Export > PNG/WEBP of the whole map, no grid if you want Foundry\'s). Useful when you changed walls/doors/lights after exporting. The simplest route is still Dungeondraft\'s own File > Export > Universal VTT.',
      inputSchema: {
        path: mapPath,
        level: levelRef,
        image: z.string().describe('PNG/WEBP/JPEG exported from Dungeondraft for this map (inside a configured folder)'),
        output: z.string().optional().describe('Output .dd2vtt path (default: next to the map)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler((a: { path: string; level?: string | number; image: string; output?: string }) => {
      const file = sandbox.resolve(a.path);
      const { map } = loadMap(file);
      const levels = Object.entries(map.world.levels);
      const lvl = a.level === undefined ? levels[0] : (levels.find(([k]) => k === String(a.level)) ?? levels.find(([, l]) => l.label?.toLowerCase() === String(a.level).toLowerCase()));
      if (!lvl) throw new Error(`Level ${a.level} not found.`);
      const img = fs.readFileSync(sandbox.resolve(a.image));
      const { uvtt, warnings } = buildUvtt(map, lvl[1], img);
      const out = sandbox.resolve(a.output ?? file.replace(/\.dungeondraft_map$/i, levels.length > 1 ? `.${lvl[1].label}.dd2vtt` : '.dd2vtt'));
      if (fs.existsSync(out)) fs.copyFileSync(out, `${out}.bak-${Date.now()}`);
      fs.writeFileSync(out, JSON.stringify(uvtt));
      return { output: out, pixelsPerGrid: uvtt.resolution.pixels_per_grid, wallPolylines: uvtt.line_of_sight.length, portals: uvtt.portals.length, lights: uvtt.lights.length, ...(warnings.length ? { warnings } : {}) };
    }),
  );

  server.registerTool(
    'dd2vtt-to-foundry-scene',
    {
      title: 'Convert Universal VTT to a Foundry scene',
      description:
        'Convert a .dd2vtt/.uvtt into Foundry VTT v13 scene data: grid, walls, doors and lights, plus the map image extracted to a file. Writes <name>.<png|webp> and <name>.foundry-scene.json. Upload the image to Foundry (e.g. The Forge Assets Library), then in Foundry create a scene and use "Import Data" with the JSON, or pass the JSON to a Foundry MCP tool. Set image_src to the uploaded image path so background.src is right.',
      inputSchema: {
        path: z.string().describe('.dd2vtt or .uvtt file inside a configured folder'),
        output_dir: z.string().optional().describe('Default: next to the input'),
        scene_name: z.string().optional(),
        image_src: z.string().optional().describe('background.src as Foundry will see it, e.g. "maps/amonkhet/tomb.webp" (default: the image file name)'),
        grid_distance: z.number().positive().optional().describe('Distance per square (default 5)'),
        grid_units: z.string().optional().describe('Default "ft"'),
        padding: z.number().min(0).max(0.5).optional().describe('Scene padding (default 0)'),
        include_lights: z.boolean().optional().describe('Default true'),
        include_object_walls: z.boolean().optional().describe('Add objects_line_of_sight as walls (default false)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(
      (a: {
        path: string;
        output_dir?: string;
        scene_name?: string;
        image_src?: string;
        grid_distance?: number;
        grid_units?: string;
        padding?: number;
        include_lights?: boolean;
        include_object_walls?: boolean;
      }) => {
        const file = sandbox.resolve(a.path);
        const uvtt = readUvtt(file);
        const base = path.basename(file).replace(/\.(dd2vtt|uvtt|df2vtt)$/i, '');
        const outDir = sandbox.resolve(a.output_dir ?? path.dirname(file));
        fs.mkdirSync(outDir, { recursive: true });
        const img = Buffer.from(uvtt.image, 'base64');
        const info = imageInfo(img);
        const imageFile = path.join(outDir, `${base}.${info.type}`);
        sandbox.resolve(imageFile);
        if (!fs.existsSync(imageFile) || !fs.readFileSync(imageFile).equals(img)) fs.writeFileSync(imageFile, img);
        const { scene, stats, warnings } = uvttToFoundryScene(uvtt, {
          name: a.scene_name ?? base,
          imageSrc: a.image_src ?? path.basename(imageFile),
          gridDistance: a.grid_distance,
          gridUnits: a.grid_units,
          padding: a.padding,
          includeLights: a.include_lights,
          includeObjectWalls: a.include_object_walls,
        });
        const sceneFile = sandbox.resolve(path.join(outDir, `${base}.foundry-scene.json`));
        fs.writeFileSync(sceneFile, JSON.stringify(scene, null, 2));
        return { sceneFile, imageFile, image: `${info.width}x${info.height} ${info.type}`, ...stats, ...(warnings.length ? { warnings } : {}) };
      },
    ),
  );

  return { server, sandbox, catalog };
}
