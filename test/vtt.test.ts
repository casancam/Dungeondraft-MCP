import { describe, expect, it } from 'vitest';
import { loadMap } from '../src/map/mapfile.js';
import { uvttToFoundryScene, paddingOffset } from '../src/vtt/foundry.js';
import { buildUvtt, imageInfo, levelGeometry, readUvtt, type XY } from '../src/vtt/uvtt.js';
import { external } from './helpers.js';

const crescentMap = external('crescent_shack.dungeondraft_map');
const crescentVtt = external('crescent_shack.dd2vtt');
const ambushMap = external('ambush.dungeondraft_map');
const ambushVtt = external('ambush.dd2vtt');

const segs = (lines: XY[][]) => lines.flatMap((l) => l.slice(1).map((p, i) => [l[i], p] as const));
const totalLength = (lines: XY[][]) => segs(lines).reduce((n, [a, b]) => n + Math.hypot(b.x - a.x, b.y - a.y), 0);

describe('map geometry -> Universal VTT, checked against Dungeondraft\'s own export', () => {
  for (const [name, mapFile, vttFile] of [
    ['crescent_shack', crescentMap, crescentVtt],
    ['ambush', ambushMap, ambushVtt],
  ] as const) {
    it.runIf(mapFile && vttFile)(`${name}: same portals, lights and wall length`, () => {
      const { map } = loadMap(mapFile!);
      const real = readUvtt(vttFile!);
      const geo = levelGeometry(Object.values(map.world.levels)[0]);

      expect(geo.portals).toHaveLength(real.portals.length);
      const key = (p: { position: XY }) => `${p.position.x.toFixed(2)},${p.position.y.toFixed(2)}`;
      expect(geo.portals.map(key).sort()).toEqual(real.portals.map(key).sort());
      for (const p of geo.portals) {
        const r = real.portals.find((x) => key(x) === key(p))!;
        const pts = (q: typeof p) => q.bounds.map((b) => `${b.x.toFixed(2)},${b.y.toFixed(2)}`).sort();
        expect(pts(p)).toEqual(pts(r));
        expect(p.closed).toBe(r.closed);
      }

      expect(geo.lights).toHaveLength(real.lights.length);
      for (const [a, b] of geo.lights.map((l, i) => [l, real.lights[i]] as const)) {
        expect(a.position.x).toBeCloseTo(b.position.x, 3);
        expect(a.range).toBe(b.range);
        expect(a.color).toBe(b.color);
      }

      // Dungeondraft may split/merge polylines differently; total wall length must agree.
      expect(totalLength(geo.line_of_sight)).toBeCloseTo(totalLength(real.line_of_sight), 1);
    });
  }

  it.runIf(crescentMap && crescentVtt)('buildUvtt derives pixels_per_grid from the image', () => {
    const { map } = loadMap(crescentMap!);
    const img = Buffer.from(readUvtt(crescentVtt!).image, 'base64');
    const { uvtt } = buildUvtt(map, Object.values(map.world.levels)[0], img);
    expect(uvtt.resolution).toEqual({ map_origin: { x: 0, y: 0 }, map_size: { x: 35, y: 35 }, pixels_per_grid: 256 });
    expect(uvtt.image.length).toBeGreaterThan(1000);
  });
});

describe('Universal VTT -> Foundry v13 scene', () => {
  it.runIf(ambushVtt)('converts walls, doors and grid', () => {
    const uvtt = readUvtt(ambushVtt!);
    const { scene, stats } = uvttToFoundryScene(uvtt, { name: 'Ambush', imageSrc: 'maps/ambush.png' });
    const ppg = uvtt.resolution.pixels_per_grid;
    expect(scene.grid).toMatchObject({ type: 1, size: ppg, distance: 5, units: 'ft' });
    expect(scene.width).toBe(uvtt.resolution.map_size.x * ppg);
    expect(stats.doors).toBe(uvtt.portals.length);
    expect(stats.walls).toBe(segs(uvtt.line_of_sight).length);
    const door = scene.walls.find((w) => w.door === 1)!;
    const p = uvtt.portals[0];
    expect(door.c).toEqual([Math.round(p.bounds[0].x * ppg), Math.round(p.bounds[0].y * ppg), Math.round(p.bounds[1].x * ppg), Math.round(p.bounds[1].y * ppg)]);
    expect(scene.background.src).toBe('maps/ambush.png');
  });

  it.runIf(crescentVtt)('converts lights to Foundry radii in grid units', () => {
    const uvtt = readUvtt(crescentVtt!);
    const { scene } = uvttToFoundryScene(uvtt, { name: 'Shack', imageSrc: 'x.png', padding: 0.25 });
    const l = scene.lights[0];
    const off = paddingOffset(scene.width, scene.height, 256, 0.25);
    expect(l.x).toBe(Math.round(uvtt.lights[0].position.x * 256 + off.x));
    expect(l.config).toMatchObject({ dim: 25, bright: 12.5, color: '#eccd8b' });
    expect(scene.walls.every((w) => w.c.every((n) => Number.isInteger(n)))).toBe(true);
  });

  it('reads PNG and WEBP image headers', () => {
    const png = Buffer.alloc(32);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(1000, 16);
    png.writeUInt32BE(500, 20);
    expect(imageInfo(png)).toEqual({ type: 'png', width: 1000, height: 500 });
    const webp = Buffer.alloc(32);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(4479, 24, 3);
    webp.writeUIntLE(2559, 27, 3);
    expect(imageInfo(webp)).toEqual({ type: 'webp', width: 4480, height: 2560 });
    expect(() => imageInfo(Buffer.from('nope'))).toThrow();
  });
});
