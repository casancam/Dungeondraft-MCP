# Dungeondraft file formats: research notes

Notes behind this server: how `.dungeondraft_map`, `.dd2vtt` and asset packs are structured, and how each claim was checked.

Status legend:
- **[VERIFIED]**: confirmed against real files in `test/fixtures/external/` or official source code/docs.
- **[SOURCE]**: read in third-party source code or docs, not checked against a real file.
- **[GUESS]**: inferred. Needs confirmation before code depends on it.

Sample files used as test fixtures (the public ones are downloaded by `npm run fixtures`, not redistributed):

| Fixture | Origin | DD build | `world.format` | Notes |
|---|---|---|---|---|
| `crescent_shack.dungeondraft_map` (+ `.dd2vtt`) | Akesari12/dungeondraft_maps | 0.9.4.2 | 2 | default assets only; walls, doors, lights, water, materials, terrain |
| `ambush.dungeondraft_map` (+ `.dd2vtt`) | pleonr/dungeondraftMaps | 1.0.x | 3 | 20x20, 22 portals, 316 objects |
| `corpse_flower.dungeondraft_map` | watermelonwolverine/dungeondraft_maps | — | 2 | tiny 8x8 |
| `fort_on_hill.dungeondraft_map` | lordhaywire/dungeondraft-maps | 1.0.2.4 | 3 | 4 levels, 18 custom packs (Forgotten Adventures), 444 objects, 33 paths, texts, 14.6 MB |
| `mcp_test.dungeondraft_map` (in repo) | made for this project | **1.2.0.1 opulent kirin** | 3 | 35×20, default assets only, 6 patterns, 1 object, terrain (sand/sandstone/cracked earth/snow) |

All of them **round-trip byte-identically** with the printer in `src/godot/json.ts` **[VERIFIED]**. Edits made by this server (walls, doors, objects, paths, lights, terrain, floors, ambient light) were opened and checked in Dungeondraft 1.2.0.1.

---

## 1. `.dungeondraft_map` save format

### 1.1 Encoding **[VERIFIED]**
- Plain UTF-8 JSON, written by Godot 3's `JSON.print(data, "\t")`: tab indentation, `"key": value`, an empty array/object printed as `[` + blank line + `]`, trailing `\n`.
- Godot types that JSON can't hold are stored as **strings** in Godot `var2str` syntax:
  - `"Vector2( 7040, 5120 )"`
  - `"PoolVector2Array( x1, y1, x2, y2, ... )"` (also `"PoolVector2Array(  )"` when empty)
  - `"PoolIntArray( ... )"`, `"PoolByteArray( ... )"`
  - the literal string `"null"` for some fields (`guide_position`), separate from JSON `null` (`trace_image`).
- Colours are 8-hex-digit **ARGB** strings: `"ff726e65"`, grid `"7f000000"` = 50 % black. **[VERIFIED]** (alpha-first is consistent across all samples.)
- **Byte-identical round-trip is achievable.** I re-serialised all 4 samples with an order-preserving parse plus a Godot-style printer plus the trailing newline, and got **identical bytes** for every file. One trap: `JSON.parse` in JavaScript reorders integer-like keys (`"100"` gets hoisted before `"-400"` in `layers`/`materials`), so the real code needs a key-order-preserving parser.

### 1.2 Units and coordinates **[VERIFIED]**
- `world.width` / `world.height` are in **grid squares**.
- All positions are in **Dungeondraft pixels, 256 px per grid square**. Origin is the top-left corner of the map, +x to the right, +y downwards. For example, the 35×35 map has coordinates up to about 8960 = 35 × 256, and its dd2vtt door at square (27.5, 20) matches map px (7040, 5120).
- Rotations are in **radians** (`-1.570796`).
- Light `range` is in **squares** (map `5`, matching dd2vtt `5`).
- Portal `radius: 128` is half a square, so a standard door is 1 square wide.
- The MCP tools will take **grid coordinates** (floats allowed; `(3, 4)` is the corner of a square, `(3.5, 4.5)` its centre) and convert with ×256.

### 1.3 Top-level structure **[VERIFIED]**
```
header
  creation_build        "1.0.2.4 carnal cambion"
  creation_date         {year, month, day, weekday, dst, hour, minute, second}
  uses_default_assets   bool
  asset_manifest[]      packs this map depends on:
                          {name, id, version, author, keywords, custom_color_overrides{...},
                           allow_3rd_party_mapping_software_to_read}
  editor_state          camera, current_level, library panel memory, colour palettes (UI state only)
world
  format                2 (DD 0.9.x) | 3 (DD 1.0+)
  width, height         squares
  next_node_id          HEX string, e.g. "790": the next id to allocate
  next_prefab_id        (format 3)
  msi                   {offset_map_size, max_offset_distance, cell_size, seed}  (material noise)
  grid                  {color, texture?}
  wall_shadow, object_shadow, building_wear, trace_image_visible   (format 3)
  embedded              {}  (always empty in samples) [GUESS: embedded custom textures]
  levels                { "0": Level, "1": Level, ... }  (string keys)
```

### 1.4 Level **[VERIFIED]** unless marked
| Key | Shape | Notes |
|---|---|---|
| `label` | string | "Ground", "Fourth Floor" |
| `environment` | `{baked_lighting, ambient_light}` | ambient is ARGB |
| `layers` | `{"-400": "Below Ground", "-100": "Below Water", "100": "User Layer 1", ...}` | the `layer` field on objects/paths/patterns points here |
| `shapes` | `{polygons: [PoolVector2Array...], walls: [int...]}` | parallel arrays: room/building outline polygons and the **decimal** node id of the wall each one generated |
| `tiles` | `{cells: PoolIntArray(w*h), colors: [ARGB × w*h], lookup?: {"0": "res://...tileset.png"}}` | `-1` means empty. `lookup` (format 3) maps cell values to tileset textures. **[GUESS]** In format 2, values index a built-in tileset list. |
| `patterns[]` | `{position, shape_rotation?, scale?, points: PoolVector2Array, layer, color, outline, texture, rotation, node_id}` | floor-pattern polygons |
| `walls[]` | `{points: PoolVector2Array, texture, color, loop, type, joint, normalize_uv, shadow, node_id, portals[]}` | `type`/`joint` are 0 or 1. **[GUESS]** type 0 = normal, 1 = battlement/thin; joint = sharp/rounded. |
| `walls[].portals[]` | `{position, rotation, scale, direction: Vector2, texture, radius, wall_id, wall_distance, closed, node_id}` | doors and windows attached to a wall. `wall_id` is a **decimal int in format 2** and a **hex string in format 3**. **[VERIFIED]** `wall_distance` = **segment index + fraction along that segment** (the closing segment of a loop counts), e.g. `48.3` on a 54-segment loop. `direction` is the segment unit vector, `rotation = atan2(direction)`, and `radius` is half the door width in px. This was checked against every door in all samples. |
| `portals[]` | same shape | **freestanding** portals (not attached to a wall). Empty in samples. **[GUESS]** that fields are identical. |
| `cave` | `{bitmap: PoolByteArray, ground_color, wall_color, entrance_bitmap}` | about (2w+3)·h bytes. **[GUESS]** at the layout. Treated as opaque, never edited. |
| `terrain` | `{enabled, expand_slots?, smooth_blending?, texture_1..4 (5..8 if expanded), splat, splat2?}` | `splat` = RGBA bytes on a **4×4 sub-grid per square**, i.e. (4w × 4h × 4) bytes. **[VERIFIED]** sizes: 8×8 → 4096, 35×35 → 78400, 100×100 → 640000. Channel R/G/B/A = weight of texture 1/2/3/4; `splat2` covers 5–8. |
| `water` | `{disable_border?, tree: {ref, polygon, join, end, is_open, deep_color, shallow_color, blend_distance, children[]}}` | a nested polygon tree (islands/lakes). Treated as opaque in Phase 1. |
| `materials` | `{"<layer>": [{bitmap: PoolByteArray, texture}]}` | painted materials (lava, cobble). Treated as opaque. |
| `paths[]` | `{position, rotation, scale, edit_points: PoolVector2Array (relative to position), smoothness, texture, width (px), layer, fade_in, fade_out, grow, shrink, block_light, loop, node_id}` | |
| `objects[]` | `{position, rotation, scale: Vector2, mirror, texture, layer, shadow, block_light, custom_color?, node_id}` | |
| `lights[]` | `{position, range (squares), intensity, color, texture: "res://textures/lights/point.png", shadows, node_id}` | |
| `roofs` | `{shade, shade_contrast, sun_direction, roofs[]}` | format 3 |
| `texts[]` | `{text, position, font_name, font_size, font_color, box_shape, node_id}` | format 3 |

### 1.5 Node ids **[VERIFIED]**
Every element has a unique `node_id` (hex string), allocated from `world.next_node_id` (hex). The id is shared across levels. Cross-references use the same number: `shapes.walls` stores it in decimal (`614` = `"266"`), and `portal.wall_id` stores it in decimal (format 2) or hex (format 3). The editor will allocate ids from `next_node_id` and bump it.

### 1.6 Asset references **[VERIFIED]**
- Built-in assets: `res://textures/<category>/...png`, e.g. `res://textures/walls/battlements.png`, `res://textures/portals/door_00.png`, `res://textures/terrain/terrain_moss.png`.
- Custom packs: `res://packs/<PACK_ID>/textures/<category>/...`, e.g. `res://packs/FA30DD03/textures/objects/Structures/Stairs_and_Ladders/...webp`. `<PACK_ID>` matches `header.asset_manifest[].id`.
- Categories seen: `objects`, `paths`, `walls`, `portals`, `patterns/normal`, `tilesets/{simple,smart}`, `terrain`, `materials`, `lights`.
- **[SOURCE]** A map only loads a custom asset if its pack is in `asset_manifest`. Installed packs alone aren't enough (battlemap-mcp documents this). So adding an object from a new pack means adding that pack's manifest entry too.

### 1.7 Version differences to support
Format 2 (0.9.x) and format 3 (1.0.x and **1.2.0.1, yours**) seen. **[VERIFIED]** 1.2.0.1 still writes `format: 3`, adding a few fields:
- top-level **`mod: {".node_table": {}}`**: per-map storage for mods (the modding API's per-item data). Kept untouched.
- `level.texts_vis` (bool), `level.cave.texture`, `world.building_wear` can be `null`.
- Objects may sit outside the map bounds (yours has one at x = -512), so validation must allow it rather than reject it.

---

## 2. Universal VTT export (`.dd2vtt`) **[VERIFIED]** on 2 samples, plus the [Arkenforge spec](https://arkenforge.com/universal-vtt-files/)

```
format            0.2 (DD output) — Arkenforge spec also documents 0.3
resolution        {map_origin:{x,y}, map_size:{x,y} (squares), pixels_per_grid (export setting: 128, 256…)}
line_of_sight     [[{x,y}, {x,y}, ...], ...]    wall polylines, in SQUARES
objects_line_of_sight  [...]                    (spec; absent in DD 0.9 samples) light-blocking objects
portals           [{position{x,y}, bounds:[{x,y},{x,y}], rotation (rad), closed, freestanding}]
environment       {baked_lighting, ambient_light (ARGB)}
lights            [{position{x,y}, range (squares), intensity, color (ARGB), shadows}]
image             base64 PNG (or WEBP) of the rendered map
```
- Everything is in **squares**. Multiply by `pixels_per_grid` to get image pixels.
- The geometry maps one-to-one onto map-file data: wall `points`/256 → `line_of_sight`; wall portals → `portals` (`bounds` = position ± radius along the wall direction); `lights` maps directly.
- **Producing a `.dd2vtt` without Dungeondraft:** the geometry is easy, but the **image** needs Dungeondraft's renderer (textures from packed assets, lighting, shadows, water and terrain shaders). That isn't feasible outside the app. So **`export-dd2vtt` can't be fully offline.** Options:
  - (a) You export from Dungeondraft (File → Export → Universal VTT), and the MCP does the rest (Foundry conversion).
  - (b) A hybrid: the MCP writes geometry from the map file and embeds a PNG/WEBP you exported from DD. This is useful when you edited walls or lights after exporting the image.
  - (c) The live bridge (section 3) can trigger DD's own exporter.

## 3. Modding API: can a mod run a server? **Yes [SOURCE]**, proven by two existing projects

- Official docs: [megasploot.github.io/DungeondraftModdingAPI](https://megasploot.github.io/DungeondraftModdingAPI/). A mod is a folder with a `.ddmod` JSON file plus `.gd` scripts. Each script's `start()` runs on map load, and `update(delta)` runs every frame. There are 70+ reference classes (`Editor`, `World`, `Level`, `Walls`, `Objects`, `Lights`, `Pathways`, `Exporter`, `AssetPack`, ...). The docs say nothing about networking.
- **But mods run unsandboxed Godot 3 GDScript.** [brann-dev/dungeondraft-mcp](https://github.com/brann-dev/dungeondraft-mcp) (MIT, June 2026) opens a Godot `TCP_Server` on `127.0.0.1:8787` from a mod, polls it in `update()`, and reports: "raw TCP from the modding sandbox works … confirmed end-to-end on Godot 3.4.2."
- **[thekannen/battlemap-mcp](https://github.com/thekannen/battlemap-mcp) (MIT, actively released: v1.1.1 on 2026-10-01)** is a polished version of the same idea for **Dungeondraft 1.2.0.1**: a mod plus a local companion, authenticated localhost messages, one-click Claude Code setup, asset browsing, building, screenshots/exports so the model can see its work, separate undo, and bundled map-making skills. Its known limitations include: it needs DD running with a map open, packs must be in the map's manifest, and the 16384 px export cap.

**What this means for this project:** a live bridge already exists and is maintained, so this server doesn't build one. It focuses on what a live bridge doesn't cover: offline and batch file editing, map variants (day/night), and the **dd2vtt → Foundry** pipeline.

## 4. Asset packs: storage and listing

- **[VERIFIED]** on `Dungeondraft.pck` (Godot 3.4.2, 4,857 files); **[SOURCE]** for packs (Ryex/Dungeondraft-GoPackager). A `.dungeondraft_pack` is a **Godot 3 PCK** file: little-endian, magic `GDPC` (0x43504447), format version, Godot major/minor/patch, 16 reserved u32, file count, then per file `{u32 path_len, path, u64 offset, u64 size, md5[16]}`. Paths look like `res://packs/<ID>/...`. **Listing a pack only needs the index at the start of the file**, without decompressing or reading any images, which is fast and cheap.
- **[SOURCE]** Inside a pack: `pack.json` (`name, id, version, author, keywords, allow_3rd_party_mapping_software_to_read, custom_color_overrides`), `textures/{objects,paths,walls,portals,tilesets,terrain,materials,patterns,lights}/...`, `data/default.dungeondraft_tags` (tag → asset lists, used for search), plus `data/walls/*.dungeondraft_wall` and `data/tilesets/*.dungeondraft_tileset`, and `thumbnails/`.
- **Location:** packs live in the **"Asset Folder" chosen in Dungeondraft's settings**, not in a fixed location, so the server takes it from `DD_ASSET_DIRS`. **[VERIFIED]** with synthetic packs in `test/packs.test.ts`: index listing, tags, validation, manifest entry.
- **Built-in assets: [VERIFIED]** `C:\Program Files\Dungeondraft\Dungeondraft.pck` lists them as `res://textures/<category>/<name>.png.import` entries: 1,792 objects, 44 paths, 39 portals, 20 walls (plus `_end` caps), 13 terrain, 24 tilesets, 25 materials, 3 lights. `res://data/default.dungeondraft_tags` is plain JSON `{tags: {Tag: [paths]}, sets: {Set: [tags]}}` with 81 tags and 15 sets. The server reads only the index and this tags file.
- **Licensing flag:** `pack.json` has `allow_3rd_party_mapping_software_to_read`, and some commercial packs (e.g. Forgotten Adventures, per the fixture's manifest) set it to **false**. The server never reads image data from any pack. For packs that set the flag to `false` it reads only `pack.json` (needed for the map's asset manifest) and does not list or index their contents.

## 5. Foundry side (for `dd2vtt-to-foundry-scene`)
- Foundry v13 core has no built-in UVTT import. The community modules are "Universal Battlemap Importer" and [moo-man/FVTT-DD-Import](https://github.com/moo-man/FVTT-DD-Import). Conversion basics: wall segment = `c: [x1,y1,x2,y2]` in scene pixels (squares × `pixels_per_grid` + scene padding offset); door = wall with `door: 1`, `ds: 0/1` (closed/open); light → AmbientLight `{x, y, config: {dim, bright, color, alpha}}` where `dim`/`bright` are in grid units.
- The output follows the `Scene.create()` payload shape used by foundry-vtt-mcp, with `walls` and `lights` filled in. See `docs/foundry-import.md`.

## 6. Not covered (yet)
- Editing water, caves, painted materials, roofs and text (preserved as-is).
- `objects_line_of_sight` in `export-dd2vtt` (no Dungeondraft 1.2 `.dd2vtt` sample to check against).
- macOS/Linux install paths for the built-in asset index are unverified; set `DUNGEONDRAFT_DIR`.
