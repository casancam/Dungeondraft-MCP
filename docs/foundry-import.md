# Importing into Foundry: notes for a live import tool

`dd2vtt-to-foundry-scene` (`src/vtt/foundry.ts`) produces Foundry v13 scene data that you import by hand ("Import Data"). A live import, from `.dd2vtt` straight to a scene in a running Foundry, needs code running *inside* Foundry. That means a Foundry module, for example in an MCP server that already has one, such as [foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp). These notes describe what such a tool would need.

## Where it fits in foundry-vtt-mcp

- The MCP server already builds a `Scene.create()` payload for generated maps (`packages/mcp-server/src/backend.ts`, around line 1066). It sets `background.src`, `width`/`height`, `padding`, `grid {type: 1, size, distance: 5, units: 'ft'}`, `tokenVision`, `navigation`, `permission`, and `walls: []` with a comment "Could add wall detection here later". The converter here fills exactly that `walls` array and adds `lights`.
- The Foundry module creates the scene in `packages/foundry-module/src/socket-bridge.ts` (around line 343) and already handles the **v14** change where the background moved from `Scene#background` to the scene's first `Level`. Imported scenes go through the same path.

## The tool

```
import-dd2vtt {
  file: string            // path or base64 of the .dd2vtt (or the JSON produced by dd2vtt-to-foundry-scene)
  scene_name?: string
  upload_path?: string    // Data/Forge folder for the image, e.g. "maps/amonkhet"
  grid_distance?: number  // default 5
  padding?: number        // default 0.25 (Foundry default); walls/lights are offset to match
  include_lights?: boolean
  activate?: boolean
}
```

## Steps it needs

1. **Upload the image.** Decode `image` (base64 PNG/WEBP) and upload it with `FilePicker.upload(source, path, file)`. On **The Forge**, `source` is `"forgevtt"` (Assets Library) instead of `"data"`. The returned path becomes `background.src`. This is the one thing the MCP server can't do from outside: it has to run in the Foundry module (socket handler), because only the browser client has the upload API and Forge credentials.
2. **Create the scene** with the converted data: `width/height = map_size × pixels_per_grid`, `grid.size = pixels_per_grid`.
3. **Walls.** One wall document per `line_of_sight` segment: `{c: [x1,y1,x2,y2], move: 20, sight: 20, light: 20, sound: 20}`. Doors come from `portals[].bounds`, with `door: 1` and `ds: 0` when closed or `1` when open. All coordinates are `squares × pixels_per_grid + paddingOffset`, where `paddingOffset = ceil(width × padding / grid) × grid`. Embedding `walls` in the `Scene.create` payload works, and so does `scene.createEmbeddedDocuments('Wall', [...])` afterwards. The latter is better for large maps (thousands of walls) because it can be batched.
4. **Lights.** AmbientLight `{x, y, config: {dim: range × distance, bright: dim/2, color: '#rrggbb', alpha, angle: 360}, walls: true}`. Colours in `.dd2vtt` are ARGB hex, so drop the first two digits.
5. **Environment.** In v13 this is `environment: {darknessLevel, globalLight: {enabled}}`. The current foundry-vtt-mcp payload uses the older top-level `globalLight` / `darkness` keys. v13 still migrates those, but v14 may not.
6. **Permissions.** `ownership: {default: 2}` (v13 name; foundry-vtt-mcp still sends `permission`).
7. **Return** the scene id plus counts (walls, doors, lights) so Claude can report them.

## Open questions

- Windows: Dungeondraft exports windows as portals too, so they become doors. A window could be a wall with `sight: 0` (see-through) and `move: 20`, but the `.dd2vtt` doesn't distinguish windows from doors.
- `objects_line_of_sight` (light-blocking objects) could become walls with `move: 0`. The Dungeondraft 1.0 samples don't include it, so this needs a 1.2 export to check.
