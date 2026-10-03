// Builds a demo variant of a map through the MCP server, for checking edits in Dungeondraft.
// Usage: node scripts/demo.mjs <folder> <map file name>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [folder, mapName] = process.argv.slice(2);
if (!folder || !mapName) throw new Error('usage: node scripts/demo.mjs <folder> <map>');
const here = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: 'demo', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, '../dist/index.js')], env: { ...process.env, DD_MCP_ROOTS: folder } }));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const data = r.isError ? null : JSON.parse(r.content[0].text);
  console.log(`${name}: ${r.isError ? r.content[0].text : 'ok'}`);
  if (r.isError) process.exit(1);
  return data;
};
const first = async (query, category) => (await call('list-assets', { query, category, limit: 1 })).items[0].path;

const demo = mapName.replace(/\.dungeondraft_map$/, '') + '_claude_demo.dungeondraft_map';
await call('duplicate-map', { path: mapName, new_name: demo });

const table = await first('table', 'objects');
const chair = await first('chair', 'objects');
const barrel = await first('barrel', 'objects');
const road = await first('road', 'paths').catch(() => null);
const pathAsset = road ?? (await call('list-assets', { category: 'paths', limit: 1 })).items[0].path;

// A 6x5 stone room (squares 14..20 x 7..12) with a door in the south wall and one on the east.
await call('add-walls', { path: demo, walls: [{ points: [[14, 7], [20, 7], [20, 12], [14, 12]], loop: true, doors: [{ at: [17, 12] }, { at: [20, 9.5], asset: 'res://textures/portals/door_02.png', open: true }] }] });
await call('add-objects', {
  path: demo,
  objects: [
    { asset: table, at: [17, 9.5] },
    { asset: chair, at: [16, 9.5], rotation: 90 },
    { asset: chair, at: [18, 9.5], rotation: -90 },
    { asset: barrel, at: [14.5, 7.5] },
    { asset: barrel, at: [19.5, 7.5], scale: 0.8 },
  ],
});
await call('add-lights', { path: demo, lights: [{ at: [17, 9.5], range: 5 }, { at: [17, 14], range: 3, color: '#ff9944' }] });
await call('add-paths', { path: demo, paths: [{ asset: pathAsset, points: [[17, 12.5], [17, 16], [25, 18]], width: 1 }] });
await call('set-terrain', { path: demo, paint: [{ area: { x: 22, y: 2, width: 6, height: 4 }, slot: 3 }] });
const info = await call('inspect-map', { path: demo });
console.log(JSON.stringify({ map: info.path, counts: info.levels[0].counts, assets: { table, chair, barrel, path: pathAsset } }, null, 1));
await client.close();
