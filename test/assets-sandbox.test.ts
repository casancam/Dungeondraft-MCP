import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Sandbox } from '../src/sandbox.js';
import { catalog, HAS_DUNGEONDRAFT } from './helpers.js';

describe('sandbox', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddmcp-root-'));
  const sb = new Sandbox([root]);

  it('resolves relative paths inside the root', () => {
    expect(sb.resolve('a/b.dungeondraft_map')).toBe(path.join(fs.realpathSync.native(root), 'a', 'b.dungeondraft_map'));
  });

  it('rejects paths outside the root, including traversal', () => {
    expect(() => sb.resolve('../escape.dungeondraft_map')).toThrow(/outside the allowed folders/);
    expect(() => sb.resolve(path.join(os.homedir(), 'x.dungeondraft_map'))).toThrow(/outside/);
    expect(() => sb.resolve(`${root}-sibling/x.dungeondraft_map`)).toThrow(/outside/);
  });

  it('allows read-only roots only for reading', () => {
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'ddmcp-ro-'));
    const sb2 = new Sandbox([root], [ro]);
    expect(sb2.resolveReadable(path.join(ro, 'pack.dungeondraft_pack'))).toContain('ddmcp-ro-');
    expect(() => sb2.resolve(path.join(ro, 'pack.dungeondraft_pack'))).toThrow(/outside/);
  });
});

describe.runIf(HAS_DUNGEONDRAFT)('built-in asset catalog (reads Dungeondraft.pck index only)', () => {
  const cat = catalog();

  it('loads all built-in objects with tags', () => {
    const s = cat.summary();
    expect(s.status.builtinLoaded).toBe(true);
    expect(s.byCategory.objects).toBe(1792);
    expect(s.byCategory.walls).toBeGreaterThan(10);
    expect(s.tags.some((t) => t.startsWith('Barrel'))).toBe(true);
  });

  it('searches by words and tag, hides wall end caps', () => {
    const r = cat.search({ query: 'globe', category: 'objects' });
    expect(r.items.map((i) => i.path)).toContain('res://textures/objects/activities/administration/atlas_globe_01.png');
    expect(cat.search({ tag: 'Administration' }).total).toBeGreaterThan(3);
    expect(cat.search({ category: 'walls' }).items.some((i) => i.path.includes('_end'))).toBe(false);
  });

  it('validates references used by real maps', () => {
    expect(cat.validate('res://textures/walls/battlements.png', 'walls')).toEqual({ ok: true });
    expect(cat.validate('res://textures/portals/door_00.png', 'portals')).toEqual({ ok: true });
    expect(cat.validate('res://textures/terrain/terrain_sand.png', 'terrain')).toEqual({ ok: true });
  });
});
