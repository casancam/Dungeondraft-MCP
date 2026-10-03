import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AssetCatalog } from '../src/assets/catalog.js';
import { readPckIndex, readPckText } from '../src/assets/pck.js';
import { MapEditor } from '../src/map/editor.js';
import { loadMap } from '../src/map/mapfile.js';
import { addFloors, addObjects, addWalls } from '../src/map/operations.js';
import { tempCopy, USER_MAP } from './helpers.js';

/** Writes a Godot 3 PCK the way Dungeondraft's packer does (paths NUL-padded to 4 bytes). */
function writePck(file: string, files: Record<string, string | Buffer>) {
  const entries = Object.entries(files).map(([p, data]) => ({ p: Buffer.from(p), data: Buffer.isBuffer(data) ? data : Buffer.from(data) }));
  const header = Buffer.alloc(4 + 4 + 12 + 64 + 4);
  header.writeUInt32LE(0x43504447, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(3, 8);
  header.writeUInt32LE(4, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(entries.length, 84);
  const padded = (b: Buffer) => Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]);
  const indexSize = entries.reduce((n, e) => n + 4 + padded(e.p).length + 8 + 8 + 16, 0);
  let offset = header.length + indexSize;
  const index: Buffer[] = [];
  for (const e of entries) {
    const name = padded(e.p);
    const meta = Buffer.alloc(4 + name.length + 32);
    meta.writeUInt32LE(name.length, 0);
    name.copy(meta, 4);
    meta.writeBigUInt64LE(BigInt(offset), 4 + name.length);
    meta.writeBigUInt64LE(BigInt(e.data.length), 12 + name.length);
    crypto.createHash('md5').update(e.data).digest().copy(meta, 20 + name.length);
    index.push(meta);
    offset += e.data.length;
  }
  fs.writeFileSync(file, Buffer.concat([header, ...index, ...entries.map((e) => e.data)]));
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function makePacks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddmcp-packs-'));
  const id = 'TESTPK01';
  writePck(path.join(dir, 'Test Pack.dungeondraft_pack'), {
    [`res://packs/${id}/pack.json`]: JSON.stringify({ name: 'Test Pack', id, version: '1.2', author: 'Tester', keywords: 'desert, tomb', custom_color_overrides: { enabled: false, min_redness: 0.1, min_saturation: 0, red_tolerance: 0.04 } }),
    [`res://packs/${id}/textures/objects/furniture/table_oak.png`]: PNG,
    [`res://packs/${id}/textures/objects/statues/sphinx_gold.png`]: PNG,
    [`res://packs/${id}/textures/walls/sandstone_wall.png`]: PNG,
    [`res://packs/${id}/textures/walls/sandstone_wall_end.png`]: PNG,
    [`res://packs/${id}/textures/patterns/normal/sand_tiles.png`]: PNG,
    [`res://packs/${id}/thumbnails/abc123.png`]: PNG,
    [`res://packs/${id}/data/default.dungeondraft_tags`]: JSON.stringify({ tags: { Statue: [`res://packs/${id}/textures/objects/statues/sphinx_gold.png`] }, sets: {} }),
  });
  fs.mkdirSync(path.join(dir, 'sub'));
  writePck(path.join(dir, 'sub', 'Private.dungeondraft_pack'), {
    'res://packs/PRIV0001/pack.json': JSON.stringify({ name: 'Private Pack', id: 'PRIV0001', version: '3', author: 'Studio', allow_3rd_party_mapping_software_to_read: false }),
    'res://packs/PRIV0001/textures/objects/secret.png': PNG,
  });
  fs.writeFileSync(path.join(dir, 'broken.dungeondraft_pack'), 'not a pack');
  return { dir, id };
}

describe('custom asset packs', () => {
  const { dir, id } = makePacks();
  const cat = new AssetCatalog({ assetDirs: [dir] });

  it('reads the PCK index and small files', () => {
    const idx = readPckIndex(path.join(dir, 'Test Pack.dungeondraft_pack'));
    expect(idx.godotVersion).toBe('3.4.2');
    expect(idx.entries).toHaveLength(8);
    expect(JSON.parse(readPckText(idx, `res://packs/${id}/pack.json`)!).name).toBe('Test Pack');
  });

  it('lists packs (including subfolders) and reports broken ones without failing', () => {
    const s = cat.summary().status;
    // Sorted by file name: "Private..." before "Test Pack...".
    expect(s.packs.map((p) => [p.id, p.restricted, p.assetCount])).toEqual([
      ['PRIV0001', true, 0],
      [id, false, 5],
    ]);
    expect(s.packErrors.join()).toMatch(/broken\.dungeondraft_pack/);
  });

  it('searches pack assets by source, words and tags; skips thumbnails and hides wall end caps', () => {
    expect(cat.search({ source: id }).items.map((a) => a.name).sort()).toEqual(['sand_tiles', 'sandstone_wall', 'sandstone_wall_end', 'sphinx_gold', 'table_oak']);
    expect(cat.search({ category: 'walls', source: id }).items.map((a) => a.name)).toEqual(['sandstone_wall']);
    expect(cat.search({ tag: 'statue' }).items[0].path).toBe(`res://packs/${id}/textures/objects/statues/sphinx_gold.png`);
    expect(cat.search({ query: 'oak table' }).total).toBe(1);
    expect(cat.search({ query: 'secret' }).total).toBe(0); // restricted pack contents are never listed
  });

  it('validates pack references', () => {
    expect(cat.validate(`res://packs/${id}/textures/objects/furniture/table_oak.png`, 'objects')).toMatchObject({ ok: true });
    expect(cat.validate(`res://packs/${id}/textures/objects/nope.png`, 'objects')).toMatchObject({ ok: false, error: expect.stringMatching(/not in pack "Test Pack"/) });
    expect(cat.validate('res://packs/NOPE/textures/objects/x.png', 'objects')).toMatchObject({ ok: false, error: expect.stringMatching(/not installed/) });
    expect(cat.validate('res://packs/PRIV0001/textures/objects/anything.png', 'objects')).toMatchObject({ ok: true, warning: expect.stringMatching(/does not allow/) });
  });

  it('adds the pack to the map manifest on first use, once', () => {
    const { file } = tempCopy(USER_MAP);
    const ed = new MapEditor(file, cat);
    addObjects(ed, undefined, [
      { asset: `res://packs/${id}/textures/objects/furniture/table_oak.png`, at: [3, 3] },
      { asset: `res://packs/${id}/textures/objects/statues/sphinx_gold.png`, at: [5, 3] },
    ]);
    addWalls(ed, undefined, [{ points: [[1, 1], [6, 1]], asset: `res://packs/${id}/textures/walls/sandstone_wall.png` }]);
    addFloors(ed, undefined, [{ asset: `res://packs/${id}/textures/patterns/normal/sand_tiles.png`, area: { x: 1, y: 1, width: 5, height: 3 } }]);
    expect(ed.warnings.filter((w) => /Added asset pack/.test(w))).toHaveLength(1);
    const { saved } = ed.commit(false);
    expect(saved!.changedSections).toContain('header.asset_manifest');
    const { map } = loadMap(file);
    expect(map.header.asset_manifest).toEqual([
      { name: 'Test Pack', id, version: '1.2', author: 'Tester', keywords: 'desert, tomb', custom_color_overrides: { enabled: false, min_redness: 0.1, min_saturation: 0, red_tolerance: 0.04 } },
    ]);
    expect(map.header.uses_default_assets).toBe(true);
  });

  it('a restricted pack is still added to the manifest (with its opt-out flag) when used', () => {
    const { file } = tempCopy(USER_MAP);
    const ed = new MapEditor(file, cat);
    addObjects(ed, undefined, [{ asset: 'res://packs/PRIV0001/textures/objects/secret.png', at: [3, 3] }]);
    ed.commit(false);
    expect(loadMap(file).map.header.asset_manifest[0]).toMatchObject({ id: 'PRIV0001', allow_3rd_party_mapping_software_to_read: false });
  });
});
