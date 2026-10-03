import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseVector2, parseVector2Array, parseByteArray } from '../src/godot/variant.js';
import { closestOnPolyline } from '../src/map/geometry.js';
import { MapEditor } from '../src/map/editor.js';
import { loadMap, sectionFingerprints } from '../src/map/mapfile.js';
import {
  addFloors,
  addLights,
  addObjects,
  addPaths,
  addWalls,
  buildRooms,
  listElements,
  removeElements,
  setEnvironment,
  setTerrain,
} from '../src/map/operations.js';
import { catalog, external, HAS_DUNGEONDRAFT, sampleMaps, tempCopy, USER_MAP } from './helpers.js';

const GLOBE = 'res://textures/objects/activities/administration/atlas_globe_01.png';

function editOnCopy(src = USER_MAP) {
  const { dir, file } = tempCopy(src);
  return { dir, file, original: fs.readFileSync(file, 'utf8'), ed: new MapEditor(file, catalog()) };
}

/** Sections that differ between two map texts. */
function changedSections(a: string, b: string): string[] {
  const fa = sectionFingerprints(loadMapText(a));
  const fb = sectionFingerprints(loadMapText(b));
  return [...new Set([...fa.keys(), ...fb.keys()])].filter((k) => fa.get(k) !== fb.get(k)).sort();
}
function loadMapText(t: string) {
  const { file } = tempCopyText(t);
  return loadMap(file).map;
}
function tempCopyText(t: string) {
  const { dir, file } = tempCopy(USER_MAP);
  fs.writeFileSync(file, t);
  return { dir, file };
}

describe('door placement matches real Dungeondraft data', () => {
  // wall_distance = segment index + fraction along the segment; direction = segment unit vector.
  for (const file of sampleMaps()) {
    it(`recomputes wall_distance for every door in ${file.split(/[\\/]/).pop()}`, () => {
      const { map } = loadMap(file);
      let checked = 0;
      for (const level of Object.values(map.world.levels)) {
        for (const w of level.walls) {
          for (const p of w.portals) {
            const hit = closestOnPolyline(parseVector2Array(w.points), w.loop, parseVector2(p.position))!;
            expect(hit.segment + hit.t).toBeCloseTo(p.wall_distance!, 3);
            const [dx, dy] = parseVector2(p.direction);
            expect(hit.direction[0]).toBeCloseTo(dx, 3);
            expect(hit.direction[1]).toBeCloseTo(dy, 3);
            expect(String(p.wall_id)).toBe(map.world.format >= 3 ? w.node_id : String(parseInt(w.node_id, 16)));
            checked++;
          }
        }
      }
      if (!checked) expect(map.world.levels).toBeDefined();
    });
  }
});

describe('editing the user map (mcp_test, Dungeondraft 1.2.0.1)', () => {
  it('adds objects, writes a backup, and leaves every other section byte-identical', () => {
    const { file, original, ed } = editOnCopy();
    const r = addObjects(ed, undefined, [
      { asset: GLOBE, at: [5.5, 5.5] },
      { asset: GLOBE, at: [6.5, 5.5], rotation: 90, scale: 1.5 },
    ]);
    const { saved } = ed.commit(false);
    expect(r.added.map((a) => a.node_id)).toEqual(['1e', '1f']);
    expect(saved!.backup).toMatch(/\.bak-\d{8}-\d{6}$/);
    expect(fs.readFileSync(saved!.backup!, 'utf8')).toBe(original);

    const after = fs.readFileSync(file, 'utf8');
    expect(changedSections(original, after)).toEqual(['level.0.objects', 'world.next_node_id']);
    const { map } = loadMap(file);
    const objs = map.world.levels['0'].objects;
    expect(objs).toHaveLength(3);
    expect(objs[1]).toMatchObject({ position: 'Vector2( 1408, 1408 )', rotation: 0, scale: 'Vector2( 1, 1 )', texture: GLOBE, layer: 100, node_id: '1e' });
    expect(objs[2]).toMatchObject({ rotation: 1.570796, scale: 'Vector2( 1.5, 1.5 )' });
    expect(map.world.next_node_id).toBe('20');
    // Untouched original object is unchanged.
    expect(objs[0].position).toBe('Vector2( -512, 2560 )');
  });

  it('builds a room with a door; wall and portal fields match Dungeondraft format 3', () => {
    const { file, original, ed } = editOnCopy();
    addWalls(ed, 'Ground', [{ points: [[10, 5], [16, 5], [16, 10], [10, 10]], loop: true, doors: [{ at: [13, 10] }] }]);
    ed.commit(false);
    const { map } = loadMap(file);
    const [wall] = map.world.levels['0'].walls;
    expect(wall).toMatchObject({ points: 'PoolVector2Array( 2560, 1280, 4096, 1280, 4096, 2560, 2560, 2560 )', loop: true, node_id: '1e', normalize_uv: true });
    const [door] = wall.portals;
    // Bottom edge runs (16,10) -> (10,10): segment 2, halfway.
    expect(door).toMatchObject({ position: 'Vector2( 3328, 2560 )', direction: 'Vector2( -1, 0 )', rotation: 3.141593, radius: 128, wall_id: '1e', wall_distance: 2.5, closed: true, node_id: '1f' });
    expect(changedSections(original, fs.readFileSync(file, 'utf8'))).toEqual(['level.0.walls', 'world.next_node_id']);
  });

  it('rejects a door that is not on the wall, and writes nothing', () => {
    const { file, original, ed } = editOnCopy();
    expect(() => addWalls(ed, undefined, [{ points: [[0, 0], [4, 0]], doors: [{ at: [2, 2] }] }])).toThrow(/must be on the wall/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it.runIf(HAS_DUNGEONDRAFT)('rejects assets that do not exist or are the wrong category', () => {
    const { ed } = editOnCopy();
    expect(() => addObjects(ed, undefined, [{ asset: 'res://textures/objects/nope.png', at: [1, 1] }])).toThrow(/does not exist/);
    expect(() => addObjects(ed, undefined, [{ asset: 'res://textures/walls/stone.png', at: [1, 1] }])).toThrow(/walls asset/);
    expect(() => addObjects(ed, undefined, [{ asset: 'res://packs/ABCD/textures/objects/x.png', at: [1, 1] }])).toThrow(/not installed/);
  });

  it('adds lights and paths', () => {
    const { file, ed } = editOnCopy();
    addLights(ed, 0, [{ at: [3, 3], range: 4, color: '#ff8800' }]);
    addPaths(ed, 0, [{ asset: 'res://textures/paths/battlements.png', points: [[1, 1], [4, 1], [4, 3]], width: 0.5 }]);
    ed.commit(false);
    const level = loadMap(file).map.world.levels['0'];
    expect(level.lights[0]).toMatchObject({ position: 'Vector2( 768, 768 )', range: 4, intensity: 1, color: 'ffff8800', texture: 'res://textures/lights/point.png', shadows: true });
    expect(level.paths[0]).toMatchObject({ position: 'Vector2( 256, 256 )', edit_points: 'PoolVector2Array( 0, 0, 768, 0, 768, 512 )', width: 128, block_light: false });
  });

  it('paints terrain on the 4x4-per-square splat grid', () => {
    const { file, original, ed } = editOnCopy();
    const before = parseByteArray(ed.map.world.levels['0'].terrain.splat);
    setTerrain(ed, undefined, { slots: { '2': 'res://textures/terrain/terrain_dirt.png' }, paint: [{ area: { x: 1, y: 2, width: 2, height: 1 }, slot: 2 }] });
    ed.commit(false);
    const { map } = loadMap(file);
    const t = map.world.levels['0'].terrain;
    const splat = parseByteArray(t.splat);
    const w = map.world.width * 4;
    const at = (s: Uint8Array, sx: number, sy: number) => Array.from(s.slice((sy * w + sx) * 4, (sy * w + sx) * 4 + 4));
    expect(t.texture_2).toBe('res://textures/terrain/terrain_dirt.png');
    expect(at(splat, 4, 8)).toEqual([0, 255, 0, 0]); // top-left texel of square (1,2)
    expect(at(splat, 11, 11)).toEqual([0, 255, 0, 0]); // bottom-right texel of square (2,2)
    // Neighbours outside the area keep their original weights.
    for (const [x, y] of [[12, 8], [3, 8], [4, 12], [4, 7]]) expect(at(splat, x, y)).toEqual(at(before, x, y));
    let changedTexels = 0;
    for (let i = 0; i < splat.length; i += 4) if (splat.slice(i, i + 4).some((v, k) => v !== before[i + k])) changedTexels++;
    expect(changedTexels).toBeLessThanOrEqual(2 * 4 * 4); // at most the 2x1 squares painted
    expect(changedSections(original, fs.readFileSync(file, 'utf8'))).toEqual(['level.0.terrain']);
  });

  it('warns when painted terrain is hidden under floor patterns (the user map is covered by them)', () => {
    const { ed } = editOnCopy();
    setTerrain(ed, undefined, { paint: [{ area: { x: 22, y: 2, width: 6, height: 4 }, slot: 3 }] });
    expect(ed.warnings.join('\n')).toMatch(/Floor patterns cover the area at \(22,2\).*19 \(tilesets\/simple\/tileset_cobble\.png\)/s);
  });

  it('adds a floor pattern in the same shape Dungeondraft writes (format 3)', () => {
    const { file, original, ed } = editOnCopy();
    addFloors(ed, undefined, [{ asset: 'res://textures/tilesets/simple/tileset_cut_stone.png', area: { x: 2, y: 3, width: 4, height: 2 } }]);
    ed.commit(false);
    const p = loadMap(file).map.world.levels['0'].patterns.at(-1)!;
    // Same keys, same order as the patterns the user drew in Dungeondraft 1.2.0.1.
    expect(Object.keys(p)).toEqual(Object.keys(loadMap(USER_MAP).map.world.levels['0'].patterns[0]));
    expect(p).toMatchObject({ position: 'Vector2( 0, 0 )', points: 'PoolVector2Array( 512, 768, 1536, 768, 1536, 1280, 512, 1280 )', layer: 100, color: 'ffffffff', outline: false, rotation: 0 });
    expect(changedSections(original, fs.readFileSync(file, 'utf8'))).toEqual(['level.0.patterns', 'world.next_node_id']);
  });

  it.runIf(HAS_DUNGEONDRAFT)('rejects smart tilesets and non-floor assets as floors', () => {
    const { ed } = editOnCopy();
    expect(() => addFloors(ed, undefined, [{ asset: 'res://textures/tilesets/smart/tileset_wood_vertical.png', area: { x: 0, y: 0, width: 1, height: 1 } }])).toThrow(/smart tileset|does not exist/);
    expect(() => addFloors(ed, undefined, [{ asset: GLOBE, area: { x: 0, y: 0, width: 1, height: 1 } }])).toThrow(/objects asset/);
  });

  it('builds a room: looped wall, matching floor and a door, in one save', () => {
    const { file, original, ed } = editOnCopy();
    const r = buildRooms(ed, undefined, [{ area: { x: 10, y: 5, width: 6, height: 4 }, floor_asset: 'res://textures/tilesets/simple/tileset_cut_stone.png', doors: [{ at: [13, 9] }] }]);
    ed.commit(false);
    expect(r.rooms[0].doors).toHaveLength(1);
    const level = loadMap(file).map.world.levels['0'];
    expect(level.walls[0]).toMatchObject({ loop: true, points: 'PoolVector2Array( 2560, 1280, 4096, 1280, 4096, 2304, 2560, 2304 )' });
    expect(level.patterns.at(-1)!.points).toBe(level.walls[0].points);
    expect(level.walls[0].portals[0]).toMatchObject({ position: 'Vector2( 3328, 2304 )', wall_distance: 2.5 });
    expect(changedSections(original, fs.readFileSync(file, 'utf8'))).toEqual(['level.0.patterns', 'level.0.walls', 'world.next_node_id']);
  });

  it('sets ambient light by preset or colour', () => {
    const { file, original, ed } = editOnCopy();
    const r = setEnvironment(ed, 'Ground', { preset: 'night' });
    expect(r.before.ambient_light).toBe('ffffffff');
    ed.commit(false);
    expect(loadMap(file).map.world.levels['0'].environment).toEqual({ baked_lighting: true, ambient_light: 'ff3c4664' });
    expect(changedSections(original, fs.readFileSync(file, 'utf8'))).toEqual(['level.0.environment']);
    const ed2 = new MapEditor(file, catalog());
    setEnvironment(ed2, undefined, { ambient_light: '#202030' });
    expect(ed2.map.world.levels['0'].environment.ambient_light).toBe('ff202030');
    expect(() => setEnvironment(ed2, undefined, { preset: 'midnight' })).toThrow(/Unknown preset/);
  });

  it('slots 5-8 turn on expanded slots and create splat2', () => {
    const { file, ed } = editOnCopy();
    setTerrain(ed, undefined, { slots: { '5': 'res://textures/terrain/terrain_grass.png' }, paint: [{ area: { x: 0, y: 0, width: 1, height: 1 }, slot: 5 }] });
    ed.commit(false);
    const t = loadMap(file).map.world.levels['0'].terrain;
    expect(t.expand_slots).toBe(true);
    const s2 = parseByteArray(t.splat2!);
    expect(s2.length).toBe(parseByteArray(t.splat).length);
    expect(Array.from(s2.slice(0, 4))).toEqual([255, 0, 0, 0]);
    expect(Array.from(parseByteArray(t.splat).slice(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it('removes elements by area and by id; walls take their doors', () => {
    const { file, ed } = editOnCopy();
    addWalls(ed, undefined, [{ points: [[10, 5], [16, 5]], doors: [{ at: [12, 5] }] }]);
    addObjects(ed, undefined, [{ asset: GLOBE, at: [11, 6] }, { asset: GLOBE, at: [30, 15] }]);
    ed.commit(false);

    const ed2 = new MapEditor(file, catalog());
    const r = removeElements(ed2, undefined, ['walls', 'objects'], { x: 9, y: 4, width: 8, height: 4 });
    expect(r.counts).toEqual({ objects: 1, walls: 1, doors: 1 });
    ed2.commit(false);
    const level = loadMap(file).map.world.levels['0'];
    expect(level.walls).toHaveLength(0);
    expect(level.objects.map((o) => o.position)).toEqual(['Vector2( -512, 2560 )', 'Vector2( 7680, 3840 )']);

    const ed3 = new MapEditor(file, catalog());
    removeElements(ed3, undefined, ['objects'], undefined, [level.objects[1].node_id]);
    ed3.commit(false);
    expect(loadMap(file).map.world.levels['0'].objects).toHaveLength(1);
  });

  it('refuses to remove without an area or ids', () => {
    const { ed } = editOnCopy();
    expect(() => removeElements(ed, undefined, ['objects'])).toThrow(/area or node_ids/);
  });

  it('dry run validates without writing', () => {
    const { dir, file, original, ed } = editOnCopy();
    addObjects(ed, undefined, [{ asset: GLOBE, at: [1, 1] }]);
    const { saved } = ed.commit(true);
    expect(saved).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('refuses to write if the file changed on disk after loading (e.g. saved from Dungeondraft)', () => {
    const { file, ed } = editOnCopy();
    addObjects(ed, undefined, [{ asset: GLOBE, at: [1, 1] }]);
    fs.appendFileSync(file, ' ');
    expect(() => ed.commit(false)).toThrow(/changed on disk/);
  });

  it('refuses to save an undeclared change', () => {
    const { ed } = editOnCopy();
    ed.map.world.levels['0'].label = 'Hacked';
    expect(() => ed.commit(false)).toThrow(/section "level.0.label" changed/);
  });

  it('lists elements with grid coordinates', () => {
    const { ed } = editOnCopy();
    const items = listElements(ed.level()[1], ['objects', 'patterns']);
    expect(items[0]).toMatchObject({ type: 'objects', at: [-2, 10], asset: 'objects/activities/administration/atlas_globe_01.png' });
    expect(items.filter((i) => i.type === 'patterns')).toHaveLength(6);
  });
});

describe('editing other formats', () => {
  const crescent = external('crescent_shack.dungeondraft_map');
  it.runIf(crescent)('format 2 maps get decimal wall_id on new doors', () => {
    const { file, ed } = editOnCopy(crescent!);
    addWalls(ed, undefined, [{ points: [[1, 1], [3, 1]], doors: [{ at: [2, 1] }] }]);
    ed.commit(false);
    const walls = loadMap(file).map.world.levels['0'].walls;
    const w = walls[walls.length - 1];
    expect(w.portals[0].wall_id).toBe(parseInt(w.node_id, 16));
  });

  const fort = external('fort_on_hill.dungeondraft_map');
  it.runIf(fort)('edits one level of a 4-level, 14 MB map without touching the others', () => {
    const { file, original, ed } = editOnCopy(fort!);
    addLights(ed, 'Fourth Floor', [{ at: [50, 50] }]);
    ed.commit(false);
    const changed = changedSections(original, fs.readFileSync(file, 'utf8'));
    expect(changed).toHaveLength(2);
    expect(changed[1]).toBe('world.next_node_id');
    expect(changed[0]).toMatch(/^level\.\d\.lights$/);
  });
});
