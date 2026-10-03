# dungeondraft-mcp

An MCP server that lets Claude read, edit and export [Dungeondraft](https://dungeondraft.net/) maps by working directly on `.dungeondraft_map` files, and turn Universal VTT exports (`.dd2vtt`) into Foundry VTT v13 scenes.

It works on files, so Dungeondraft doesn't need to be running. For live editing inside a running Dungeondraft, see [battlemap-mcp](https://github.com/thekannen/battlemap-mcp); the two can be used side by side.

## Tools

| Tool | What it does |
|---|---|
| `list-maps` | Finds `.dungeondraft_map` files in the configured folders |
| `inspect-map` | Summary: size, levels, element counts, terrain, packs, most-used assets. Can list elements (node id, asset, grid position) by type and area |
| `list-assets` | Searches built-in assets and installed asset packs by words, category, tag or pack |
| `add-objects` | Places props at grid positions (rotation, scale, mirror, layer, shadow, tint) |
| `add-walls` | Adds wall polylines or closed rooms, with doors and windows; can also add doors to an existing wall |
| `add-lights` | Adds point lights (range in squares, colour, intensity) |
| `add-paths` | Adds path assets along grid points |
| `add-floors` | Adds floor patterns (planks, cobble, tiles) over a rectangle or polygon |
| `build-room` | Builds a closed wall, a matching floor and doors in one step |
| `set-environment` | Sets a level's ambient light (presets: day, overcast, dusk, night, dark) for day/night variants |
| `set-terrain` | Sets terrain slot textures (1–8), fills a level, or paints rectangles. Warns when floor patterns would hide the painted terrain |
| `remove-elements` | Removes elements by type within an area, or by node id (supports `dry_run`) |
| `duplicate-map` | Copies a map to start a variant (day/night...) |
| `export-dd2vtt` | Builds a `.dd2vtt` from the map's walls, doors and lights plus an image you exported from Dungeondraft |
| `dd2vtt-to-foundry-scene` | Turns a `.dd2vtt` into a Foundry v13 scene JSON (grid, walls, doors, lights) and extracts the image |

Every edit tool accepts `level` (key, index or label; the default is the first level) and `dry_run`.

### Coordinates

All tools use **grid squares** measured from the map's top-left corner, with x to the right and y down. `(3, 4)` is a grid intersection, and `(3.5, 4.5)` is the centre of the square in column 3, row 4. Fractions are allowed. Internally Dungeondraft uses 256 px per square, and the server converts for you. Object positions are object **centres**. Rotation is in **degrees clockwise**. Light range and path width are in **squares**.

## Safety

- **Allowed folders only.** Maps are read and written only inside `DD_MCP_ROOTS`, which defaults to your `Documents` folder. `..` paths and links that point outside are rejected. The Dungeondraft install and asset folders are read-only.
- **Backup first.** Before every change the original is copied to `<map>.bak-YYYYMMDD-HHMMSS` (UTC).
- **Verified writes.** The new map is written to a temp file, re-parsed and checked: it must round-trip byte for byte, element counts must match what the edit added or removed, and every section the edit didn't declare must be **byte-identical** to before. Only then is the temp file renamed over the original. If any check fails, nothing is written.
- **Conflict check.** If the file changed on disk after it was read (for example Dungeondraft saved it), the edit is refused.
- **Close the map in Dungeondraft before editing it here**, or reopen it afterwards *without saving*. Otherwise Dungeondraft overwrites the change on its next save.
- **Pack licences.** Asset packs whose `pack.json` sets `allow_3rd_party_mapping_software_to_read: false` are listed by name only, and their contents aren't read. Only file indexes and small metadata files are ever read from packs, never image data.

## Setup

Requires Node 20+. On this machine Node is in `C:\Program Files\nodejs`, which isn't on PATH, so the commands below use full paths.

```powershell
cd C:\Users\Casancam\Desktop\code\dungeondraft-mcp
& "C:\Program Files\nodejs\npm.cmd" install
& "C:\Program Files\nodejs\npm.cmd" run build
```

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DD_MCP_ROOTS` | `%USERPROFILE%\Documents` | Folders the server may read and write maps in, separated by `;` |
| `DUNGEONDRAFT_DIR` | `C:\Program Files\Dungeondraft` if present | Install folder, used to list built-in assets from `Dungeondraft.pck` |
| `DD_ASSET_DIRS` | none | Your Dungeondraft asset folder(s) containing `*.dungeondraft_pack`, separated by `;` |

### Claude Code

```powershell
claude mcp add dungeondraft -s user `
  -e DD_MCP_ROOTS="C:\Users\Casancam\Documents" `
  -- "C:\Program Files\nodejs\node.exe" "C:\Users\Casancam\Desktop\code\dungeondraft-mcp\dist\index.js"
```

Add `-e DD_ASSET_DIRS="D:\Dungeondraft Assets"` (your asset folder) to make custom packs searchable. Check the server with `claude mcp list`.

### Claude Desktop

Add this to `%APPDATA%\Claude\claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "dungeondraft": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\Casancam\\Desktop\\code\\dungeondraft-mcp\\dist\\index.js"],
      "env": {
        "DD_MCP_ROOTS": "C:\\Users\\Casancam\\Documents"
      }
    }
  }
}
```

## Dungeondraft → Foundry (The Forge)

1. In Dungeondraft: **File → Export → Universal VTT**, saved into a configured folder.
2. Ask Claude to run `dd2vtt-to-foundry-scene` on it. Set `image_src` to the path the image will have in Foundry, e.g. `maps/amonkhet/tomb.png`.
3. Upload the extracted image to The Forge Assets Library at that path.
4. In Foundry, create a scene, right-click it, choose **Import Data**, and pick `<name>.foundry-scene.json`.

Light radii use `dim = range × grid distance` and `bright = dim / 2`. Dungeondraft bakes lighting into the image, so pass `include_lights: false` if the Foundry lights look doubled.

`export-dd2vtt` is for when you changed walls, doors or lights after exporting. Dungeondraft is needed to render the map image, so export a PNG/WEBP of the whole map from Dungeondraft and point the tool at it. See [docs/foundry-import.md](docs/foundry-import.md) for what a native `import-dd2vtt` tool in foundry-vtt-mcp would need.

## Development

```powershell
& "C:\Program Files\nodejs\npm.cmd" run fixtures   # download public sample maps for the tests
& "C:\Program Files\nodejs\npm.cmd" test           # vitest
& "C:\Program Files\nodejs\node.exe" scripts/smoke.mjs   # end-to-end over MCP stdio on a temp copy
```

Tests run against a real Dungeondraft 1.2.0.1 map (`test/fixtures/mcp_test.dungeondraft_map`) plus public sample maps (formats 2 and 3, up to 14 MB and 4 levels). They check byte-identical round-trips, door placement recomputed against every door in the samples, untouched sections staying identical after each edit, and map→UVTT geometry against Dungeondraft's own `.dd2vtt` exports. Format notes are in [docs/research.md](docs/research.md).

### Known limits

- Terrain painting has hard edges at quarter-square resolution, with no soft brush.
- Water, caves, materials (painted lava, cobble...), roofs and text are preserved but can't be edited. Text and patterns can be listed and removed.
- New walls aren't added to building `shapes`. That's what Dungeondraft's building tool does; plain walls don't need it.
- `export-dd2vtt` doesn't write `objects_line_of_sight`.
