# dungeondraft-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) read, edit and export [Dungeondraft](https://dungeondraft.net/) maps. It works directly on `.dungeondraft_map` files, so Dungeondraft doesn't need to be running. It also converts Universal VTT exports (`.dd2vtt`) into Foundry VTT v13 scenes.

Ask things like *"build a small tavern in the north-east corner of my crossroads map"*, *"make a night version of this map"*, or *"turn this dd2vtt into a Foundry scene"*.

> Not affiliated with Dungeondraft or Megasploot. For live editing inside a running Dungeondraft, see [battlemap-mcp](https://github.com/thekannen/battlemap-mcp). The two work well side by side.

## Tools

| Tool | What it does |
|---|---|
| `list-maps` | Finds `.dungeondraft_map` files in the configured folders |
| `inspect-map` | Summary: size, levels, element counts, terrain, packs, most-used assets. Can list elements (node id, asset, grid position) by type and area |
| `list-assets` | Searches built-in assets and installed asset packs by words, category, tag or pack |
| `add-objects` | Places props at grid positions (rotation, scale, mirror, layer, shadow, tint) |
| `add-walls` | Adds wall polylines or closed rooms, with doors and windows; can also add doors to an existing wall |
| `add-floors` | Adds floor patterns (planks, cobble, tiles) over a rectangle or polygon |
| `build-room` | Builds a closed wall, a matching floor and doors in one step |
| `add-lights` | Adds point lights (range in squares, colour, intensity) |
| `add-paths` | Adds path assets along grid points |
| `set-terrain` | Sets terrain slot textures (1–8), fills a level, or paints rectangles, circles and lines with soft edges |
| `set-environment` | Sets ambient light (presets: day, overcast, dusk, night, dark) for day/night variants |
| `remove-elements` | Removes elements by type within an area, or by node id (supports `dry_run`) |
| `duplicate-map` | Copies a map to start a variant |
| `export-dd2vtt` | Builds a `.dd2vtt` from the map's walls, doors and lights plus an image exported from Dungeondraft |
| `dd2vtt-to-foundry-scene` | Turns a `.dd2vtt` into a Foundry v13 scene JSON (grid, walls, doors, lights) and extracts the image |

Every edit tool accepts `level` (key, index or label; the default is the first level) and `dry_run`.

### Coordinates

All tools use **grid squares** measured from the map's top-left corner, with x to the right and y down. `(3, 4)` is a grid intersection, and `(3.5, 4.5)` is the centre of the square in column 3, row 4. Fractions are allowed. Dungeondraft stores 256 px per square internally, and the server converts for you. Object positions are object **centres**. Rotation is in **degrees clockwise**. Light range, path width and terrain feather are in **squares**.

## Safety

- **Allowed folders only.** Maps are read and written only inside `DD_MCP_ROOTS`, which defaults to your `Documents` folder. `..` paths and links that point outside are rejected. The Dungeondraft install and asset folders are read-only.
- **Backup first.** Before every change the original is copied to `<map>.bak-YYYYMMDD-HHMMSS` (UTC).
- **Verified writes.** The new map is written to a temp file, re-parsed and checked: it must round-trip byte for byte, element counts must match what the edit added or removed, and every section the edit didn't declare must be **byte-identical** to before. Only then is the temp file renamed over the original. If any check fails, nothing is written.
- **Conflict check.** If the file changed on disk after it was read (for example Dungeondraft saved it), the edit is refused.
- **Close the map in Dungeondraft before editing it here**, or reopen it afterwards *without saving*. Otherwise Dungeondraft overwrites the change on its next save.
- **Asset pack licences.** No image data is ever read from any pack. Packs whose `pack.json` sets `allow_3rd_party_mapping_software_to_read: false` are listed by name only: their contents aren't indexed, and only `pack.json` is read, to fill in the map's asset manifest when you use them.

## Install

Requires [Node.js](https://nodejs.org) 20 or newer.

### Claude Code

```sh
claude mcp add dungeondraft -s user -e DD_MCP_ROOTS="/path/to/your/maps" -- npx -y dungeondraft-mcp
```

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "dungeondraft": {
      "command": "npx",
      "args": ["-y", "dungeondraft-mcp"],
      "env": {
        "DD_MCP_ROOTS": "C:\\Users\\you\\Documents\\Dungeondraft"
      }
    }
  }
}
```

On Windows, if Node isn't on your PATH, use the full path, e.g. `"command": "C:\\Program Files\\nodejs\\npx.cmd"`.

### From source

```sh
git clone <this repo> && cd dungeondraft-mcp
npm install && npm run build
claude mcp add dungeondraft -s user -e DD_MCP_ROOTS="/path/to/maps" -- node "$PWD/dist/index.js"
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DD_MCP_ROOTS` | your `Documents` folder | Folders the server may read and write maps in, separated by `;` |
| `DUNGEONDRAFT_DIR` | auto-detected (see below) | Dungeondraft install folder (the one containing `Dungeondraft.pck`), used to list and validate built-in assets |
| `DD_ASSET_DIRS` | none | Your Dungeondraft asset folder(s) with `*.dungeondraft_pack` files, separated by `;`. Set this to use custom packs |

`DUNGEONDRAFT_DIR` is auto-detected at `C:\Program Files\Dungeondraft` (verified), and also at `/opt/Dungeondraft` and `/Applications/Dungeondraft.app/Contents/Resources` (both unverified). Without it the server still works, but built-in asset names aren't checked before they're written.

## Dungeondraft → Foundry VTT

1. In Dungeondraft: **File → Export → Universal VTT**, saved into a configured folder.
2. Run `dd2vtt-to-foundry-scene` on it. Set `image_src` to the path the image will have in Foundry, e.g. `maps/tomb.png`.
3. Upload the extracted image to Foundry (or The Forge Assets Library) at that path.
4. In Foundry, create a scene, right-click it, choose **Import Data**, and pick `<name>.foundry-scene.json`.

Light radii use `dim = range × grid distance` and `bright = dim / 2`. Dungeondraft bakes lighting into the image, so pass `include_lights: false` if the Foundry lights look doubled. Windows are exported as doors, because `.dd2vtt` doesn't tell them apart.

`export-dd2vtt` is for when you changed walls, doors or lights after exporting. Dungeondraft is needed to render the map image, so export a PNG/WEBP of the whole map from Dungeondraft and point the tool at it. [docs/foundry-import.md](docs/foundry-import.md) describes what a live in-Foundry importer would need.

## Known limits

- Water, caves, painted materials, roofs and text are preserved but can't be edited. Text and floor patterns can be listed and removed.
- Floor patterns are drawn over terrain. `set-terrain` warns when a stroke is hidden under one.
- `export-dd2vtt` doesn't write `objects_line_of_sight`.
- Tested with Dungeondraft 0.9.4 to 1.2.0.1 map files (formats 2 and 3), on Windows.

## Development

```sh
npm install
npm run fixtures       # download public sample maps used by some tests (not redistributed)
npm test               # vitest
npm run build
node scripts/smoke.mjs # end-to-end over MCP stdio on a temp copy of the test map
```

The tests use a real Dungeondraft 1.2.0.1 map (`test/fixtures/mcp_test.dungeondraft_map`), public sample maps (formats 2 and 3, up to 14 MB and 4 levels), and synthetic asset packs. They check:
- byte-identical round-trips
- door placement against every door in the samples
- that untouched sections stay identical after each edit
- map → UVTT geometry against Dungeondraft's own `.dd2vtt` exports
- pack listing, validation and the opt-out flag

Tests that need a Dungeondraft install or the downloaded samples are skipped when those are missing. File-format notes and how each claim was verified are in [docs/research.md](docs/research.md).

## Credits

- Format research built on [Ryex/Dungeondraft-GoPackager](https://github.com/Ryex/Dungeondraft-GoPackager) (pack format) and the [Arkenforge Universal VTT notes](https://arkenforge.com/universal-vtt-files/).
- Sample maps for the tests come from Akesari12, pleonr, watermelonwolverine and lordhaywire on GitHub. They are downloaded at test time, not included.

## License

MIT
